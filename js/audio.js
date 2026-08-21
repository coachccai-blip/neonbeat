// AudioContext, synthèse des morceaux, lecture et horloge de référence.
//
// Règle d'or (§7.2 du brief) : toute position temporelle en jeu se calcule à
// partir de audioCtx.currentTime. Jamais Date.now(), jamais l'accumulation de
// deltas de requestAnimationFrame — qui dérivent de plusieurs centaines de
// millisecondes sur deux minutes de musique.

import { renderSong } from './synth.js';
import { SONGS_BY_ID } from './songs/index.js';
import * as storage from './storage.js';

let ctx = null;
let musicGain = null;
let sfxGain = null;
const buffers = new Map();   // id → AudioBuffer
const waveforms = new Map(); // id → { peaks: Float32Array, rate }
const gains = new Map();     // id → gain de normalisation de volume

let current = null;          // { source, startAt, seek, rate, perfAtStart }

export function context() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: 'interactive' });
    musicGain = ctx.createGain();
    musicGain.gain.value = storage.get('volume');
    musicGain.connect(ctx.destination);
    sfxGain = ctx.createGain();
    sfxGain.gain.value = 0.35;
    sfxGain.connect(ctx.destination);
  }
  return ctx;
}

/**
 * À appeler DANS le handler d'un vrai geste utilisateur (un tap), sinon iOS
 * laisse le contexte suspendu et le jeu reste muet.
 */
export function unlock() {
  const c = context();
  if (c.state === 'suspended') c.resume();
  // Un buffer d'un échantillon suffit à « amorcer » la sortie sur iOS.
  const b = c.createBuffer(1, 1, c.sampleRate);
  const s = c.createBufferSource();
  s.buffer = b;
  s.connect(c.destination);
  s.start(0);
  return c.state;
}

export function setVolume(v) {
  if (musicGain) musicGain.gain.value = v;
}

export function isReady(trackId) {
  return buffers.has(trackId);
}

/**
 * Prépare le morceau : synthèse pour les pistes internes, téléchargement +
 * décodage pour les pistes audio importées. Résultat mis en cache.
 * @param {string} trackId
 * @param {(p:number)=>void} onProgress
 * @param {string} [audioUrl]  chemin du fichier audio (pistes importées)
 */
export async function prepare(trackId, onProgress, audioUrl) {
  if (buffers.has(trackId)) {
    if (onProgress) onProgress(1);
    return buffers.get(trackId);
  }
  // Un même morceau peut être demandé deux fois en parallèle (la préversion
  // télécharge encore quand le joueur appuie sur JOUER) : on partage la même
  // promesse au lieu de lancer deux téléchargements concurrents.
  const pending = inflight.get(trackId);
  if (pending) {
    if (onProgress) pending.listeners.push(onProgress);
    return pending.promise;
  }
  const entry = { listeners: onProgress ? [onProgress] : [], promise: null };
  const fanout = (p) => { for (const fn of entry.listeners) { try { fn(p); } catch { /* ignore */ } } };
  entry.promise = decodeTrack(trackId, fanout, audioUrl).finally(() => inflight.delete(trackId));
  inflight.set(trackId, entry);
  return entry.promise;
}

const inflight = new Map();  // id → { listeners, promise }

async function decodeTrack(trackId, onProgress, audioUrl) {
  const c = context();
  const song = SONGS_BY_ID[trackId];
  let buf;
  if (song) {
    const { left, right, sampleRate } = await renderSong(song, c.sampleRate, onProgress);
    buf = c.createBuffer(2, left.length, sampleRate);
    buf.copyToChannel(left, 0);
    buf.copyToChannel(right, 1);
  } else {
    if (!audioUrl) throw new Error(`morceau inconnu : ${trackId}`);
    const data = await fetchWithProgress(audioUrl, onProgress);
    // decodeAudioData veut un ArrayBuffer « frais » sur certains Safari.
    buf = await c.decodeAudioData(data);
  }
  evictIfNeeded(trackId);
  buffers.set(trackId, buf);
  computeWaveform(trackId, buf);
  computeGain(trackId, buf);
  if (onProgress) onProgress(1);
  return buf;
}

/* ─── Normalisation de volume ────────────────────────────────────────
   Les pistes importées sont masterisées bien plus fort que les pistes
   synthétisées : sans compensation, il faudrait toucher le volume à chaque
   changement de morceau. On mesure le niveau des passages forts (90e
   percentile du RMS par fenêtres de 400 ms) et on applique un gain pour
   ramener toutes les pistes au même niveau perçu.                       */

const TARGET_LEVEL = 0.16;          // ≈ −16 dBFS sur les passages forts

function computeGain(id, buf) {
  const d = buf.getChannelData(0);
  const win = Math.floor(buf.sampleRate * 0.4);
  const levels = [];
  let peak = 0;
  for (let start = 0; start + win <= d.length; start += win) {
    let sum = 0;
    for (let i = start; i < start + win; i += 4) {
      const v = d[i];
      sum += v * v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sum / (win / 4));
    if (rms > 0.008) levels.push(rms);   // on ignore les silences
  }
  if (!levels.length || peak === 0) { gains.set(id, 1); return; }
  levels.sort((a, b) => a - b);
  const loud = levels[Math.floor(levels.length * 0.9)];
  const want = Math.max(0.3, Math.min(TARGET_LEVEL / loud, 10));
  if (want <= 0.97 / peak) {
    // Assez de marge de crête : un simple gain suffit.
    gains.set(id, want);
    return;
  }
  // Le gain nécessaire dépasserait la crête (piste au niveau faible mais aux
  // pics hauts, ex. « Laissez aller ») : on applique le gain directement dans
  // les échantillons avec un limiteur doux — les rares crêtes sont arrondies
  // sans saturation et le niveau perçu rejoint celui des autres pistes.
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      d[i] = Math.tanh(d[i] * want) * 0.97;
    }
  }
  gains.set(id, 1);
}

export function trackGain(id) {
  return gains.get(id) || 1;
}

/** Téléchargement avec progression (le décodage compte pour les 15 % restants). */
async function fetchWithProgress(url, onProgress) {
  // Le pré-téléchargement (main.js) et le service worker remplissent un cache
  // permanent : on le consulte d'abord pour un chargement instantané, même
  // quand le service worker n'est pas (encore) actif.
  if ('caches' in window) {
    try {
      const hit = await caches.match(new URL(url, location.href).href);
      if (hit && hit.ok) return await hit.arrayBuffer();
    } catch { /* navigation privée ou entrée illisible : on passe au réseau */ }
  }
  // Une connexion mobile peut « caler » sans jamais échouer : fetch n'a aucun
  // délai d'expiration natif, l'écran de chargement resterait figé pour
  // toujours. On abandonne après 20 s sans le moindre octet, et on retente
  // une fois avant d'abandonner pour de bon.
  try {
    return await downloadOnce(url, onProgress);
  } catch (e) {
    if (e && e.name === 'AbortError') return await downloadOnce(url, onProgress);
    throw e;
  }
}

const STALL_MS = 20000;   // aucun octet reçu pendant ce délai → on abandonne

async function downloadOnce(url, onProgress) {
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), STALL_MS);
  const keepAlive = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(), STALL_MS);
  };
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`audio introuvable : ${url}`);
    const total = parseInt(res.headers.get('content-length') || '0', 10);
    if (!res.body || !total) { const b = await res.arrayBuffer(); return b; }
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      keepAlive();
      chunks.push(value);
      got += value.length;
      if (onProgress) onProgress((got / total) * 0.85);
    }
    const out = new Uint8Array(got);
    let off = 0;
    for (const ch of chunks) { out.set(ch, off); off += ch.length; }
    return out.buffer;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Un AudioBuffer stéréo de 2 minutes pèse ~40 Mo : on ne garde que les
 * 3 morceaux les plus récents pour ne pas saturer la mémoire d'un iPhone.
 */
const lru = [];
function evictIfNeeded(incoming) {
  const i = lru.indexOf(incoming);
  if (i >= 0) lru.splice(i, 1);
  lru.push(incoming);
  while (lru.length > 3) {
    const old = lru.shift();
    buffers.delete(old);
  }
}

/* ─── Enveloppe d'amplitude, pour la soundwave animée en jeu ─── */

function computeWaveform(id, buf) {
  const rate = 60;
  const d = buf.getChannelData(0);
  const win = Math.floor(buf.sampleRate / rate);
  const n = Math.ceil(d.length / win);
  const peaks = new Float32Array(n);
  let max = 0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    const s = i * win, e = Math.min(d.length, s + win);
    for (let j = s; j < e; j += 4) {
      const a = Math.abs(d[j]);
      if (a > m) m = a;
    }
    peaks[i] = m;
    if (m > max) max = m;
  }
  // Normalisation + courbe de contraste : un master très compressé (tout
  // proche de la crête) garderait sinon une silhouette plate et terne.
  if (max > 0) {
    for (let i = 0; i < n; i++) peaks[i] = Math.pow(peaks[i] / max, 1.8);
  }
  waveforms.set(id, { peaks, rate });
}

/** Enveloppe du morceau (null si pas encore synthétisé). */
export function waveform(trackId) {
  const w = waveforms.get(trackId);
  if (!w && buffers.has(trackId)) computeWaveform(trackId, buffers.get(trackId));
  return waveforms.get(trackId) || null;
}

/**
 * Lance le morceau.
 * @param {string} trackId
 * @param {object} opts { delay: secondes avant le départ (temps réel),
 *                        silent: bool, seek: position dans le morceau,
 *                        rate: vitesse de lecture (nightcore = 1.25) }
 * @returns {{startAt:number, perfAtStart:number}}
 */
export function start(trackId, { delay = 0.12, silent = false, seek = 0, rate = 1 } = {}) {
  const c = context();
  stop();
  const startAt = c.currentTime + Math.max(0.02, delay);

  let source = null;
  if (!silent) {
    const buf = buffers.get(trackId);
    if (!buf) throw new Error('morceau non préparé');
    source = c.createBufferSource();
    source.buffer = buf;
    source.playbackRate.value = rate;
    const norm = c.createGain();
    norm.gain.value = trackGain(trackId);
    source.connect(norm).connect(musicGain);
    source.start(startAt, seek);
  }

  current = { source, startAt, seek, rate, perfAtStart: perfTimeOf(startAt) - (seek / rate) * 1000 };
  return { startAt, perfAtStart: current.perfAtStart };
}

/**
 * Conversion horloge audio → performance.now(), par simple capture jointe.
 * IMPORTANT : pas de getOutputTimestamp ici. Il compense la latence de sortie,
 * mais la calibration la mesure déjà — les deux corrections s'additionnaient
 * et décalaient le jugement, d'où des MISS sur des frappes à l'heure.
 * perfAtStart ne sert plus qu'aux tests : le jugement passe par songTime().
 */
function perfTimeOf(ctxTime) {
  const c = context();
  const p1 = performance.now();
  const ctxNow = c.currentTime;
  const p2 = performance.now();
  return (p1 + p2) / 2 + (ctxTime - ctxNow) * 1000;
}

/* ─── Préversion (écran de sélection) ─────────────────────────────── */

let preview = null;

/** Joue en boucle ~18 s du morceau à partir de previewStart, avec fondu. */
export function startPreview(trackId, previewStart = 0) {
  const c = context();
  stopPreview();
  const buf = buffers.get(trackId);
  if (!buf || current) return;             // jamais par-dessus une partie
  const source = c.createBufferSource();
  source.buffer = buf;
  const from = Math.min(previewStart, Math.max(0, buf.duration - 20));
  source.loop = true;
  source.loopStart = from;
  source.loopEnd = Math.min(buf.duration, from + 18);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.85 * trackGain(trackId), c.currentTime + 0.6);
  source.connect(g).connect(musicGain);
  source.start(c.currentTime, from);
  preview = { source, gain: g };
}

export function stopPreview() {
  if (!preview) return;
  const c = context();
  const { source, gain } = preview;
  preview = null;
  try {
    gain.gain.setValueAtTime(gain.gain.value, c.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.25);
    source.stop(c.currentTime + 0.3);
  } catch { /* déjà arrêtée */ }
}

export function stop() {
  stopPreview();
  if (current && current.source) {
    try { current.source.stop(); } catch { /* déjà arrêtée */ }
    current.source.disconnect();
  }
  current = null;
}

/** Position dans le morceau, en secondes. Négative pendant le décompte. */
export function songTime() {
  if (!current) return 0;
  return current.seek + (context().currentTime - current.startAt) * current.rate;
}

/** Vitesse de lecture courante (1 = normale, 1.25 = nightcore). */
export function playRate() {
  return current ? current.rate : 1;
}

export function perfAtStart() {
  return current ? current.perfAtStart : 0;
}

export function isPlaying() {
  return current !== null;
}

/* ─── Bruitages ─────────────────────────────────────────────────────── */

let clickBuffer = null;

function makeClick() {
  const c = context();
  const len = Math.floor(c.sampleRate * 0.05);
  const b = c.createBuffer(1, len, c.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < len; i++) {
    const t = i / c.sampleRate;
    d[i] = Math.sin(2 * Math.PI * 1400 * t) * Math.exp(-t / 0.006);
  }
  return b;
}

/** Clic sec du métronome de calibration, programmé sur l'horloge audio. */
export function scheduleClick(at) {
  const c = context();
  if (!clickBuffer) clickBuffer = makeClick();
  const s = c.createBufferSource();
  s.buffer = clickBuffer;
  const g = c.createGain();
  g.gain.value = 0.6;
  s.connect(g).connect(c.destination);
  s.start(at);
}

/** Riser de montée de fever : balayage ascendant + ping final, par palier. */
export function feverSound(level) {
  const c = context();
  const t = c.currentTime;
  const base = 200 * Math.pow(1.26, level);

  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.5, t + 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
  g.connect(sfxGain);

  const o1 = c.createOscillator();
  o1.type = 'sawtooth';
  o1.frequency.setValueAtTime(base, t);
  o1.frequency.exponentialRampToValueAtTime(base * 2, t + 0.3);
  o1.connect(g);
  o1.start(t); o1.stop(t + 0.45);

  const o2 = c.createOscillator();
  o2.type = 'square';
  o2.frequency.setValueAtTime(base * 1.5, t);
  o2.frequency.exponentialRampToValueAtTime(base * 3, t + 0.3);
  const g2 = c.createGain();
  g2.gain.value = 0.28;
  o2.connect(g2).connect(g);
  o2.start(t); o2.stop(t + 0.45);

  // ping de confirmation en haut du balayage
  const ping = c.createOscillator();
  const gp = c.createGain();
  ping.type = 'sine';
  ping.frequency.value = base * 4;
  gp.gain.setValueAtTime(0.0001, t + 0.26);
  gp.gain.exponentialRampToValueAtTime(0.4, t + 0.28);
  gp.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
  ping.connect(gp).connect(sfxGain);
  ping.start(t + 0.26); ping.stop(t + 0.6);
}

export function hitSound() {
  const c = context();
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = 'square';
  o.frequency.setValueAtTime(1100, c.currentTime);
  g.gain.setValueAtTime(0.22, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0005, c.currentTime + 0.035);
  o.connect(g).connect(sfxGain);
  o.start();
  o.stop(c.currentTime + 0.05);
}
