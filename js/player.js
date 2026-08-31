// Mode écoute : le lecteur de musique de l'application.
//
// ── Pourquoi Web Audio et pas un simple <audio> ? ──
// Un élément <audio> joue en flux (léger), mais entre deux pistes il se met
// en pause, change de source, puis relance : il y a un TOUT PETIT SILENCE.
// Sur un téléphone verrouillé, c'est précisément ce silence qui pousse le
// système à geler la page — et une fois gelée, plus personne pour lancer la
// piste suivante. C'est la panne « la musique s'arrête au bout de deux
// morceaux ».
//
// Les vraies applications (Spotify, Apple Music) sont des apps natives : le
// système leur accorde un privilège de lecture en arrière-plan qu'une page
// web n'a pas. Ce qui s'en approche le plus côté web, c'est de programmer la
// piste suivante SUR LE FIL AUDIO TEMPS RÉEL. Un AudioBufferSourceNode dont
// on a fixé l'instant de départ (source.start(quand)) démarre tout seul, à
// l'échantillon près, même si le JavaScript de la page est gelé : le rendu
// audio se fait sur un thread séparé. On enchaîne donc les pistes SANS le
// moindre blanc — le son ne s'interrompt jamais, le système ne voit jamais
// de silence, et n'a aucune raison de geler la page.
//
// Le prix à payer : chaque morceau est décodé entièrement en mémoire (comme
// pour le jeu). On n'en garde que deux à la fois — celui qui joue et le
// suivant, déjà prêt — pour borner la mémoire.
//
// Les deux mondes ne se croisent jamais : lancer une partie coupe le
// lecteur, et le lecteur laisse la priorité aux préversions du jeu. On
// partage le même AudioContext que le jeu (jamais les deux en même temps).

import * as storage from './storage.js';
import * as audio from './audio.js';

const REPEATS = ['all', 'one', 'off'];

let liste = [];                // catalogue, dans l'ordre d'affichage
let ordre = [];                // indices dans l'ordre de lecture
let pos = -1;                  // position dans `ordre`
let abonnes = [];
let jeton = 0;                 // annule un décodage dépassé

let sortieGain = null;         // gain de sortie du lecteur
const bufs = new Map();        // id → AudioBuffer (borné : courant + suivant)

// Le morceau en cours : position de lecture = ctx.currentTime - baseCtx.
let cur = null;                // { id, source, baseCtx, dur }
// Le morceau suivant, DÉJÀ programmé pour démarrer pile à la fin du courant.
let nxt = null;                // { id, pos, source, startAt }

let enPause = false;
let posPause = 0;              // position figée pendant une pause
let chargement = false;
let ticker = null;             // rafraîchit la barre de progression

function ctx() { return audio.context(); }

function sortie() {
  if (!sortieGain) {
    const c = ctx();
    sortieGain = c.createGain();
    sortieGain.gain.value = clampVol(storage.get('volume'));
    sortieGain.connect(c.destination);
  }
  return sortieGain;
}

// Le volume du jeu est un gain Web Audio qui peut dépasser 1 ; on borne à 1
// pour la sortie du lecteur.
function clampVol(v) {
  return Math.max(0, Math.min(1, typeof v === 'number' ? v : 0.8));
}

function repeat() { return storage.get('plRepeat') || 'all'; }
function urlDe(id) { return `./tracks/${id}.mp3`; }

export function init(tracks) {
  liste = tracks || [];
  rebatir();
}

/** Ordre de lecture : celui du catalogue, ou tiré au sort si aléatoire. */
function rebatir(garder) {
  const idCourant = garder && ordre[pos] != null ? liste[ordre[pos]].id : null;
  ordre = liste.map((_, i) => i);
  if (storage.get('plShuffle')) {
    for (let i = ordre.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ordre[i], ordre[j]] = [ordre[j], ordre[i]];
    }
  }
  // Le morceau en cours reste en cours : changer de mode ne doit pas
  // interrompre ce qu'on écoute.
  pos = idCourant ? ordre.findIndex((i) => liste[i].id === idCourant) : -1;
}

export function onChange(cb) { abonnes.push(cb); }

function signaler() {
  const s = state();
  for (const cb of abonnes) cb(s);
}

function positionCourante() {
  if (enPause) return posPause;
  if (!cur) return 0;
  return Math.max(0, Math.min(cur.dur, ctx().currentTime - cur.baseCtx));
}

export function state() {
  const t = ordre[pos] != null ? liste[ordre[pos]] : null;
  return {
    track: t,
    playing: !!(cur && !enPause && t),
    charge: !!t,
    chargement,
    time: positionCourante(),
    duration: cur ? cur.dur : (t ? t.duration : 0),
    shuffle: !!storage.get('plShuffle'),
    repeat: repeat(),
    // Le morceau suivant, déjà en mémoire et programmé pour enchaîner sans
    // le moindre accès réseau ni silence — et son titre, pour l'afficher.
    pret: nxt ? nxt.id : null,
    pretTitle: nxt ? (liste.find((x) => x.id === nxt.id) || {}).title || null : null
  };
}

/* ─── Décodage (borné à deux morceaux en mémoire) ─────────────────── */

async function decoder(id, monJeton) {
  if (bufs.has(id)) return bufs.get(id);
  let buf;
  try {
    const res = await fetch(urlDe(id));
    const data = await res.arrayBuffer();
    buf = await ctx().decodeAudioData(data);
  } catch {
    return null;
  }
  if (monJeton !== jeton) return null;   // l'utilisateur a changé d'avis
  bufs.set(id, buf);
  borner();
  return buf;
}

/** Ne garder en mémoire que le morceau en cours et le suivant. */
function borner() {
  const garder = new Set();
  if (cur) garder.add(cur.id);
  if (nxt) garder.add(nxt.id);
  for (const id of [...bufs.keys()]) {
    if (!garder.has(id) && bufs.size > 2) bufs.delete(id);
  }
}

/* ─── Programmation temps réel ────────────────────────────────────── */

function arreterSource(s) {
  if (!s) return;
  s.onended = null;
  try { s.stop(); } catch { /* déjà arrêtée */ }
}

/** Ce qui suit le morceau en cours : { id, pos } ou null (fin en mode off). */
function apresCourant() {
  const rep = repeat();
  if (pos < 0 || !ordre.length) return null;
  if (rep === 'one') return { id: liste[ordre[pos]].id, pos };   // reboucle sans blanc
  const s = pos + 1;
  if (s >= ordre.length) return rep === 'off' ? null : { id: liste[ordre[0]].id, pos: 0 };
  return { id: liste[ordre[s]].id, pos: s };
}

/**
 * Démarre `id` à `offset` secondes. C'est le cœur du lecteur : on crée une
 * source, on la cale sur l'horloge audio, puis on prépare la suivante.
 */
async function demarrer(id, offset) {
  const c = ctx();
  if (c.state === 'suspended') { try { await c.resume(); } catch { /* ignore */ } }
  const monJeton = ++jeton;
  enPause = false;
  chargement = true;
  mediaSession();
  signaler();
  const buf = await decoder(id, monJeton);
  if (monJeton !== jeton) return;        // une autre piste a pris la main
  chargement = false;
  if (!buf) { signaler(); return; }
  arreterSource(cur && cur.source);
  arreterSource(nxt && nxt.source);
  nxt = null;
  const when = c.currentTime + 0.02;
  const src = c.createBufferSource();
  src.buffer = buf;
  src.connect(sortie());
  src.start(when, Math.max(0, Math.min(offset || 0, buf.duration - 0.02)));
  cur = { id, source: src, baseCtx: when - (offset || 0), dur: buf.duration };
  src.onended = () => surFin(src);
  demarrerTicker();
  etatSysteme('playing');
  mediaSession();
  majPosition();
  signaler();
  planifier();                           // le suivant se prépare et se programme
}

/**
 * Prépare le morceau suivant PENDANT que le courant joue, et le programme
 * pour démarrer pile à la fin du courant. C'est ce qui supprime le silence
 * — donc le gel de la page — entre deux pistes.
 */
async function planifier() {
  const info = apresCourant();
  if (!info) { arreterSource(nxt && nxt.source); nxt = null; signaler(); return; }
  if (nxt && nxt.id === info.id && nxt.pos === info.pos) return;   // déjà prêt
  arreterSource(nxt && nxt.source);
  nxt = null;
  const monJeton = jeton;
  const buf = await decoder(info.id, monJeton);
  if (monJeton !== jeton || !buf || !cur) return;
  const c = ctx();
  const startAt = cur.baseCtx + cur.dur;
  const src = c.createBufferSource();
  src.buffer = buf;
  src.connect(sortie());
  // Départ programmé à l'instant exact où le courant finit : aucun blanc.
  src.start(Math.max(startAt, c.currentTime), 0);
  src.onended = () => surFin(src);
  nxt = { id: info.id, pos: info.pos, source: src, startAt };
  borner();
  signaler();
}

/** Le morceau en cours vient de finir : le suivant joue déjà, on le promeut. */
function surFin(src) {
  if (enPause) return;
  if (!cur || src !== cur.source) return;   // source périmée
  if (nxt) {
    const buf = bufs.get(nxt.id);
    cur = { id: nxt.id, source: nxt.source, baseCtx: nxt.startAt, dur: buf ? buf.duration : cur.dur };
    pos = nxt.pos;
    nxt = null;
    borner();
    etatSysteme('playing');
    mediaSession();
    majPosition();
    signaler();
    planifier();                            // on prépare le suivant du suivant
  } else {
    // Rien de programmé (fin de liste en mode « off ») : arrêt propre.
    cur = null;
    arreterTicker();
    etatSysteme('paused');
    signaler();
  }
}

/* ─── Barre de progression (Web Audio n'a pas d'événement timeupdate) ── */

function demarrerTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    if (!cur || enPause) return;
    majPosition();
    signaler();
  }, 250);
}
function arreterTicker() {
  if (ticker) { clearInterval(ticker); ticker = null; }
}

/* ─── API publique ─────────────────────────────────────────────────── */

/** Joue ce morceau ; sans argument, reprend là où on en était. */
export async function play(id) {
  let cible = id;
  if (cible) {
    const i = ordre.findIndex((k) => liste[k].id === cible);
    if (i < 0) return;
    pos = i;
  } else if (enPause && cur) {
    return reprendre();
  } else if (pos < 0) {
    if (!ordre.length) return;
    pos = 0;
    cible = liste[ordre[0]].id;
  } else {
    cible = liste[ordre[pos]].id;
  }
  return demarrer(cible, 0);
}

/**
 * Déverrouille la sortie audio dans un geste de l'utilisateur : sur mobile,
 * un AudioContext ne démarre que déclenché par un vrai tap.
 */
export function amorcer() {
  audio.unlock();
  sortie();
}

function reprendre() {
  if (!cur) return;
  demarrer(cur.id, posPause);
}

export function toggle() {
  if (enPause) return reprendre();
  if (cur) return pause();
  return play();
}

export function pause() {
  if (!cur || enPause) return;
  posPause = positionCourante();
  enPause = true;
  arreterSource(cur.source);
  cur.source = null;
  arreterSource(nxt && nxt.source);
  nxt = null;
  arreterTicker();
  etatSysteme('paused');
  signaler();
}

/** Arrêt complet : le lecteur rend la main (partie, calibration). */
export function stop() {
  jeton++;
  chargement = false;
  enPause = false;
  pos = -1;
  arreterSource(cur && cur.source);
  arreterSource(nxt && nxt.source);
  cur = null;
  nxt = null;
  bufs.clear();
  arreterTicker();
  etatSysteme('none');
  signaler();
}

export function next() {
  if (!ordre.length) return;
  pos = (pos + 1) % ordre.length;
  play(liste[ordre[pos]].id);
}

/**
 * Précédent — ou début du morceau s'il est déjà bien entamé, comme sur
 * toutes les platines : le premier appui rembobine, le second recule.
 */
export function prev() {
  if (!ordre.length) return;
  if (cur && positionCourante() > 3) { demarrer(cur.id, 0); return; }
  pos = (pos - 1 + ordre.length) % ordre.length;
  play(liste[ordre[pos]].id);
}

export function seekFrac(f) {
  if (!cur) return;
  const off = Math.max(0, Math.min(cur.dur - 0.05, f * cur.dur));
  if (enPause) { posPause = off; majPosition(); signaler(); return; }
  demarrer(cur.id, off);
}

export function setShuffle(on) {
  storage.set('plShuffle', !!on);
  rebatir(true);
  planifier();          // le suivant a changé : on le reprogramme
  signaler();
}

/** Fait tourner les modes de répétition : toutes → une → aucune. */
export function cycleRepeat() {
  const i = REPEATS.indexOf(repeat());
  storage.set('plRepeat', REPEATS[(i + 1) % REPEATS.length]);
  planifier();          // le morceau à préparer dépend du mode
  signaler();
}

export function setVolume(v) {
  if (sortieGain) sortieGain.gain.value = clampVol(v);
}

/* ─── Media Session : contrôles sur l'écran verrouillé ─────────────── */

let pochette = null;
export function setCoverMaker(fn) { pochette = fn; }

function etatSysteme(s) {
  if ('mediaSession' in navigator) {
    try { navigator.mediaSession.playbackState = s; } catch { /* ignore */ }
  }
}

function majPosition() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  if (!cur) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: cur.dur || 0,
      position: Math.max(0, Math.min(cur.dur || 0, positionCourante())),
      playbackRate: 1
    });
  } catch { /* ignore */ }
}

function mediaSession() {
  if (!('mediaSession' in navigator)) return;
  const t = ordre[pos] != null ? liste[ordre[pos]] : null;
  if (!t) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist || 'NEONBEAT',
      album: 'NEONBEAT',
      artwork: pochette ? [{ src: pochette(t), sizes: '96x96', type: 'image/png' }] : []
    });
    navigator.mediaSession.setActionHandler('play', () => { if (enPause) reprendre(); else play(); });
    navigator.mediaSession.setActionHandler('pause', () => pause());
    navigator.mediaSession.setActionHandler('previoustrack', () => prev());
    navigator.mediaSession.setActionHandler('nexttrack', () => next());
    navigator.mediaSession.setActionHandler('seekto', (e) => {
      if (cur && typeof e.seekTime === 'number') seekFrac(e.seekTime / (cur.dur || 1));
    });
  } catch { /* navigateur sans Media Session : le lecteur marche quand même */ }
}
