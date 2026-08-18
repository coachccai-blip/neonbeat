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

let current = null;          // { source, startAt, perfAtStart, duration, silent }

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
 * Synthétise le morceau (ou le récupère du cache).
 * @param {string} trackId
 * @param {(p:number)=>void} onProgress
 */
export async function prepare(trackId, onProgress) {
  if (buffers.has(trackId)) {
    if (onProgress) onProgress(1);
    return buffers.get(trackId);
  }
  const song = SONGS_BY_ID[trackId];
  if (!song) throw new Error(`morceau inconnu : ${trackId}`);
  const c = context();
  const { left, right, sampleRate } = await renderSong(song, c.sampleRate, onProgress);
  const buf = c.createBuffer(2, left.length, sampleRate);
  buf.copyToChannel(left, 0);
  buf.copyToChannel(right, 1);
  buffers.set(trackId, buf);
  computeWaveform(trackId, buf);
  return buf;
}

/* ─── Enveloppe d'amplitude, pour la soundwave animée en jeu ─── */

function computeWaveform(id, buf) {
  const rate = 40;                       // 40 points par seconde suffisent
  const d = buf.getChannelData(0);
  const win = Math.floor(buf.sampleRate / rate);
  const n = Math.ceil(d.length / win);
  const peaks = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    const s = i * win, e = Math.min(d.length, s + win);
    for (let j = s; j < e; j += 4) {
      const a = Math.abs(d[j]);
      if (a > m) m = a;
    }
    peaks[i] = m;
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
 * @param {object} opts { delay: secondes avant le départ, silent: bool,
 *                        seek: position de départ dans le morceau }
 * @returns {{startAt:number, perfAtStart:number}}
 */
export function start(trackId, { delay = 0.12, silent = false, seek = 0 } = {}) {
  const c = context();
  stop();
  const startAt = c.currentTime + Math.max(0.02, delay);

  let source = null;
  if (!silent) {
    const buf = buffers.get(trackId);
    if (!buf) throw new Error('morceau non préparé');
    source = c.createBufferSource();
    source.buffer = buf;
    source.connect(musicGain);
    source.start(startAt, seek);
  }

  current = {
    source,
    startAt: startAt - seek,     // instant (horloge audio) du temps 0 du morceau
    perfAtStart: perfTimeOf(startAt - seek),
    silent
  };
  return { startAt: current.startAt, perfAtStart: current.perfAtStart };
}

/**
 * Convertit un instant de l'horloge audio en instant performance.now().
 * getOutputTimestamp donne le couple exact quand il existe ; sinon on prend
 * les deux horloges le plus près possible l'une de l'autre.
 */
function perfTimeOf(ctxTime) {
  const c = context();
  let ctxNow = c.currentTime;
  let perfNow = performance.now();
  if (typeof c.getOutputTimestamp === 'function') {
    const ts = c.getOutputTimestamp();
    if (ts && ts.contextTime && ts.performanceTime) {
      ctxNow = ts.contextTime;
      perfNow = ts.performanceTime;
    }
  }
  return perfNow + (ctxTime - ctxNow) * 1000;
}

export function stop() {
  if (current && current.source) {
    try { current.source.stop(); } catch { /* déjà arrêtée */ }
    current.source.disconnect();
  }
  current = null;
}

/** Position dans le morceau, en secondes. Négative pendant le décompte. */
export function songTime() {
  if (!current) return 0;
  return context().currentTime - current.startAt;
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
