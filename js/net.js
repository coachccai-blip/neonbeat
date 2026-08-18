// Multijoueur : PeerJS en topologie étoile, l'hôte est le hub (§7.5).
// Si le broker est injoignable, le jeu reste entièrement jouable en solo :
// le multijoueur est une couche, pas un prérequis.

/* Configuration du serveur de signalisation. Par défaut le broker public de
   PeerJS (gratuit, sans garantie). Pour basculer sur une instance
   auto-hébergée, remplacer uniquement cet objet. */
let SIGNALING = {
  // host: 'mon-instance.example.com', port: 443, secure: true,
};
// Surcharge locale (tests, instance auto-hébergée) :
// localStorage['neonbeat.signaling'] = '{"host":"...","port":443,"secure":true}'
try {
  const o = localStorage.getItem('neonbeat.signaling');
  if (o) SIGNALING = JSON.parse(o);
} catch { /* stockage indisponible : broker par défaut */ }

const PREFIX = 'neonbeat-v1-';
const CODE_ALPHABET = 'ABCDEFGHJKMNPRSTVWXYZ';   // sans I O Q U L 0 1
export const MAX_PLAYERS = 4;

export function randomCode() {
  let c = '';
  for (let i = 0; i < 4; i++) c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return c;
}

export function normalizeCode(raw) {
  const c = (raw || '').toUpperCase().replace(/[^A-Z]/g, '');
  return c.length === 4 ? c : null;
}

function newPeer(id) {
  return new window.Peer(id, { ...SIGNALING, debug: 0 });
}

/* ─────────────────────────── HÔTE ─────────────────────────── */

export class Host {
  /**
   * @param {{onOpen:(code:string)=>void, onError:(err:string)=>void,
   *          onMessage:(peerId:string, msg:object)=>void,
   *          onJoin:(peerId:string, conn:object)=>void,
   *          onLeave:(peerId:string)=>void}} cb
   */
  constructor(cb) {
    this.cb = cb;
    this.conns = new Map();     // peerId → DataConnection
    this.closed = false;
  }

  open(attempt = 0) {
    const code = randomCode();
    const peer = newPeer(PREFIX + code);
    let settled = false;

    peer.on('open', () => {
      if (this.closed) { peer.destroy(); return; }
      settled = true;
      this.peer = peer;
      this.code = code;
      peer.on('connection', (conn) => this._accept(conn));
      peer.on('disconnected', () => {
        // Signalisation perdue : les DataConnections existantes survivent,
        // on retente pour pouvoir accueillir de nouveaux joueurs.
        if (!this.closed) peer.reconnect();
      });
      this.cb.onOpen(code);
    });

    peer.on('error', (err) => {
      if (settled) return;
      peer.destroy();
      if (err.type === 'unavailable-id' && attempt < 5) {
        this.open(attempt + 1);          // collision de code : on retire
      } else {
        this.cb.onError(err.type || 'network');
      }
    });
  }

  _accept(conn) {
    conn.on('open', () => {
      if (this.conns.size >= MAX_PLAYERS - 1) {
        conn.send({ t: 'KICK', reason: 'full' });
        setTimeout(() => conn.close(), 300);
        return;
      }
      this.conns.set(conn.peer, conn);
      this.cb.onJoin(conn.peer, conn);
    });
    conn.on('data', (msg) => {
      if (!msg || typeof msg.t !== 'string') return;
      // Les PING sont répondus ici même : la précision de la sync d'horloge
      // dépend directement de la latence de cette réponse.
      if (msg.t === 'PING') {
        conn.send({ t: 'PONG', t0: msg.t0, t1: performance.now() });
        return;
      }
      this.cb.onMessage(conn.peer, msg);
    });
    const drop = () => {
      if (this.conns.delete(conn.peer)) this.cb.onLeave(conn.peer);
    };
    conn.on('close', drop);
    conn.on('error', drop);
  }

  send(peerId, msg) {
    const c = this.conns.get(peerId);
    if (c && c.open) c.send(msg);
  }

  broadcast(msg) {
    for (const c of this.conns.values()) if (c.open) c.send(msg);
  }

  kick(peerId, reason) {
    const c = this.conns.get(peerId);
    if (c) {
      if (c.open) c.send({ t: 'KICK', reason });
      setTimeout(() => c.close(), 300);
    }
  }

  close() {
    this.closed = true;
    if (this.peer) this.peer.destroy();
    this.conns.clear();
  }
}

/* ─────────────────────────── CLIENT ─────────────────────────── */

export class Client {
  /**
   * @param {{onOpen:()=>void, onMessage:(msg:object)=>void,
   *          onClose:()=>void, onError:(err:string)=>void}} cb
   */
  constructor(cb) {
    this.cb = cb;
    this.closed = false;
    this.attempts = 0;
  }

  connect(code) {
    this.code = code;
    this._dial();
  }

  _dial() {
    const peer = newPeer(undefined);
    this.peer = peer;
    let opened = false;

    peer.on('open', () => {
      const conn = peer.connect(PREFIX + this.code, { reliable: true });
      this.conn = conn;
      const dialTimeout = setTimeout(() => {
        if (!opened) this._fail('timeout');
      }, 8000);

      conn.on('open', () => {
        opened = true;
        this.attempts = 0;
        clearTimeout(dialTimeout);
        this.cb.onOpen();
      });
      conn.on('data', (msg) => {
        if (msg && typeof msg.t === 'string') this.cb.onMessage(msg);
      });
      conn.on('close', () => { clearTimeout(dialTimeout); this._fail('closed'); });
      conn.on('error', () => { clearTimeout(dialTimeout); this._fail('network'); });
    });
    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') this._fail('not-found');
      else if (!opened) this._fail(err.type || 'network');
    });
  }

  _fail(reason) {
    if (this.closed || this._failed) return;
    this._failed = true;
    if (this.peer) this.peer.destroy();
    // Reconnexion automatique : 3 tentatives espacées de 2 s (§7.6) —
    // sauf refus explicite (room introuvable / pleine).
    if (reason !== 'not-found' && this.attempts < 3) {
      this.attempts++;
      setTimeout(() => {
        if (this.closed) return;
        this._failed = false;
        this._dial();
      }, 2000);
    } else if (reason === 'not-found') {
      this.cb.onError('not-found');
    } else {
      this.cb.onClose();
    }
  }

  send(msg) {
    if (this.conn && this.conn.open) this.conn.send(msg);
  }

  close() {
    this.closed = true;
    if (this.peer) this.peer.destroy();
  }
}
