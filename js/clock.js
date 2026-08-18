// Synchronisation d'horloge entre appareils, façon NTP (§7.4 du brief).
//
// Nécessaire au mode « salon » : seuls le téléphone de l'hôte joue le son,
// les autres doivent aligner leur timeline sur la sienne à ±20 ms pour que
// leurs notes tombent en rythme avec ce que la pièce ENTEND.

const SAMPLES = 10;
const SPACING_MS = 100;

export class ClockSync {
  constructor() {
    this.offset = 0;        // hostPerfNow ≈ performance.now() + offset
    this.rtt = Infinity;
    this.synced = false;
  }

  /**
   * Lance une salve de PING. `send` transmet {t:'PING', t0} à l'hôte ;
   * les PONG doivent être rapportés via handlePong().
   */
  async run(send) {
    this._pending = [];
    for (let i = 0; i < SAMPLES; i++) {
      send({ t: 'PING', t0: performance.now() });
      await sleep(SPACING_MS);
    }
    await sleep(300);                     // laisse revenir les derniers PONG
    // On retient L'ÉCHANTILLON DE RTT MINIMAL — pas la moyenne : c'est celui
    // qui a le moins traîné dans les files du réseau (piège n°7).
    let best = null;
    for (const s of this._pending) {
      if (!best || s.rtt < best.rtt) best = s;
    }
    if (best) {
      this.offset = best.offset;
      this.rtt = best.rtt;
      this.synced = true;
    }
    return this.synced;
  }

  /** @param {{t0:number, t1:number}} msg  PONG de l'hôte */
  handlePong(msg) {
    const t2 = performance.now();
    const rtt = t2 - msg.t0;
    const offset = msg.t1 - (msg.t0 + t2) / 2;
    if (this._pending) this._pending.push({ rtt, offset });
  }

  /** Convertit une date de la timeline de l'hôte en performance.now() local. */
  toLocal(hostPerfTime) {
    return hostPerfTime - this.offset;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
