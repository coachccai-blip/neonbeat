// Rendu audio des morceaux, en JavaScript pur.
//
// Chaque morceau est synthétisé à partir de la MÊME structure de données que
// celle qui produit la partition jouable (js/songs/*.js → theory.unfold).
// Les notes tombent donc exactement sur le son, sur tous les appareils, sans
// aucun calage manuel — et le dépôt ne contient aucun fichier audio.

import { unfold, midiToFreq, stepTime } from './songs/theory.js';
import { makeOsc, SVF, Biquad, makeNoise, decayCoef, softClip } from './dsp.js';

/* ------------------------------------------------------------------ */
/* Percussions : un échantillon rendu une fois, rejoué des centaines de */
/* fois par simple addition.                                           */
/* ------------------------------------------------------------------ */

function renderKick(sr, punchy) {
  const len = Math.ceil(sr * (punchy ? 0.36 : 0.48));
  const out = new Float32Array(len);
  const f0 = punchy ? 200 : 165, f1 = punchy ? 44 : 50;
  const pitchTime = punchy ? 0.055 : 0.09;
  const ampDecay = punchy ? 0.16 : 0.24;
  const noise = makeNoise(7);
  const hp = new Biquad('highpass', 1400, 0.7, sr);
  let phase = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const f = f1 + (f0 - f1) * Math.exp(-t / pitchTime);
    phase += f / sr;
    const amp = Math.exp(-t / ampDecay) * (1 - Math.exp(-t / 0.0012));
    let v = Math.sin(phase * Math.PI * 2) * amp;
    if (t < 0.02) v += hp.process(noise()) * 0.55 * Math.exp(-t / 0.004);
    out[i] = v;
  }
  return out;
}

function renderSnare(sr) {
  const len = Math.ceil(sr * 0.34);
  const out = new Float32Array(len);
  const noise = makeNoise(11);
  const bp = new Biquad('bandpass', 1900, 0.8, sr);
  const hp = new Biquad('highpass', 400, 0.7, sr);
  let phase = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const n = hp.process(bp.process(noise())) * 2.2 * Math.exp(-t / 0.075);
    const f = 150 + 70 * Math.exp(-t / 0.03);
    phase += f / sr;
    const tone = Math.sin(phase * Math.PI * 2) * 0.5 * Math.exp(-t / 0.045);
    out[i] = (n + tone) * (1 - Math.exp(-t / 0.0008));
  }
  return out;
}

function renderClap(sr) {
  const len = Math.ceil(sr * 0.34);
  const out = new Float32Array(len);
  const noise = makeNoise(23);
  const bp = new Biquad('bandpass', 1250, 1.4, sr);
  // Quatre rebonds très serrés : c'est ce qui fait « claquer » un clap.
  const bursts = [0, 0.009, 0.019, 0.03];
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    let env = 0;
    for (let b = 0; b < bursts.length; b++) {
      if (t < bursts[b]) continue;
      const dt = t - bursts[b];
      env += b === 3 ? Math.exp(-dt / 0.055) * 0.9 : Math.exp(-dt / 0.006);
    }
    out[i] = bp.process(noise()) * 2.0 * Math.min(1.4, env);
  }
  return out;
}

function renderHat(sr, decay, freq) {
  const len = Math.ceil(sr * (decay * 3.2));
  const out = new Float32Array(len);
  const noise = makeNoise(41);
  const hp = new Biquad('highpass', freq, 0.8, sr);
  const hp2 = new Biquad('highpass', freq, 0.8, sr);
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    out[i] = hp2.process(hp.process(noise())) * Math.exp(-t / decay);
  }
  return out;
}

function renderCrash(sr) {
  const len = Math.ceil(sr * 1.5);
  const out = new Float32Array(len);
  const noise = makeNoise(97);
  const hp = new Biquad('highpass', 3800, 0.7, sr);
  const bp = new Biquad('bandpass', 7000, 0.5, sr);
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const n = hp.process(noise());
    out[i] = (n * 0.7 + bp.process(n) * 0.6) * Math.exp(-t / 0.42) * (1 - Math.exp(-t / 0.002));
  }
  return out;
}

function buildKit(sr, style) {
  const punchy = style !== 'synthwave';
  return {
    kick: renderKick(sr, punchy),
    snare: renderSnare(sr),
    clap: renderClap(sr),
    hat: renderHat(sr, 0.026, 8200),
    ohat: renderHat(sr, 0.13, 7000),
    crash: renderCrash(sr)
  };
}

const DRUM_GAIN = { kick: 0.95, snare: 0.5, clap: 0.42, hat: 0.20, ohat: 0.19, crash: 0.26 };
const DRUM_PAN = { kick: 0, snare: 0, clap: 0.12, hat: -0.22, ohat: 0.3, crash: 0.18 };

/* ------------------------------------------------------------------ */
/* Voix mélodiques                                                     */
/* ------------------------------------------------------------------ */

const sawOsc = makeOsc('saw');
const sqrOsc = makeOsc('square');
const triOsc = makeOsc('triangle');

/**
 * Rend une note isolée en mono. Le résultat est mis en cache : un arpège qui
 * répète huit hauteurs pendant tout le morceau ne coûte que huit rendus.
 */
function renderVoice(part, freq, dur, sr, style) {
  const release = part === 'chord' ? 0.45 : part === 'pluck' ? 0.35 : part === 'arp' ? 0.09 : 0.18;
  const total = Math.ceil((dur + release) * sr);
  const out = new Float32Array(total);
  const dt = freq / sr;
  let p1 = 0, p2 = 0, p3 = 0;

  if (part === 'bass') {
    const svf = new SVF(sr);
    const peak = Math.min(sr * 0.4, freq * (style === 'electro' || style === 'dnb' ? 13 : 9));
    const base = Math.max(90, freq * 2.2);
    // Sinus à l'unisson (et non une octave en dessous) : sous 40 Hz un
    // téléphone ne restitue rien, l'énergie est perdue pour tout le monde.
    const d2 = freq / sr;
    for (let i = 0; i < total; i++) {
      const t = i / sr;
      const cut = base + (peak - base) * Math.exp(-t / 0.09);
      p1 += dt; if (p1 >= 1) p1 -= 1;
      p2 += d2; if (p2 >= 1) p2 -= 1;
      const raw = sawOsc(p1, dt) * 0.78 + Math.sin(p2 * Math.PI * 2) * 0.45;
      const v = svf.process(raw, cut, 1.6).low;
      out[i] = v * ampEnv(t, dur, release, 0.003);
    }
  } else if (part === 'chord') {
    const svf = new SVF(sr);
    const d2 = freq * 1.005 / sr, d3 = freq * 0.994 / sr;
    for (let i = 0; i < total; i++) {
      const t = i / sr;
      p1 += dt; if (p1 >= 1) p1 -= 1;
      p2 += d2; if (p2 >= 1) p2 -= 1;
      p3 += d3; if (p3 >= 1) p3 -= 1;
      const raw = (sawOsc(p1, dt) + sawOsc(p2, d2) + sawOsc(p3, d3)) * 0.33;
      out[i] = svf.process(raw, 2400, 0.9).low * ampEnv(t, dur, release, 0.06);
    }
  } else if (part === 'arp') {
    const svf = new SVF(sr);
    for (let i = 0; i < total; i++) {
      const t = i / sr;
      p1 += dt; if (p1 >= 1) p1 -= 1;
      const cut = 1200 + 4200 * Math.exp(-t / 0.05);
      out[i] = svf.process(sqrOsc(p1, dt), cut, 1.1).low * ampEnv(t, dur, release, 0.002);
    }
  } else if (part === 'lead') {
    const svf = new SVF(sr);
    const d2 = freq * 1.008 / sr;
    for (let i = 0; i < total; i++) {
      const t = i / sr;
      // Léger vibrato à partir de 250 ms : le lead « chante » au lieu de tenir.
      const vib = t > 0.25 ? 1 + 0.004 * Math.sin((t - 0.25) * 2 * Math.PI * 5.2) : 1;
      const a = dt * vib, b = d2 * vib;
      p1 += a; if (p1 >= 1) p1 -= 1;
      p2 += b; if (p2 >= 1) p2 -= 1;
      const raw = sawOsc(p1, a) * 0.7 + sqrOsc(p2, b) * 0.35;
      const cut = 900 + Math.min(4800, freq * 5) * (0.55 + 0.45 * Math.exp(-t / 0.12));
      out[i] = svf.process(raw, cut, 1.3).low * ampEnv(t, dur, release, 0.006);
    }
  } else {                                  // pluck
    const k = decayCoef(Math.min(dur + release, 0.45), sr);
    let a = 1;
    for (let i = 0; i < total; i++) {
      p1 += dt; if (p1 >= 1) p1 -= 1;
      p2 += dt * 2; if (p2 >= 1) p2 -= 1;
      a *= k;
      out[i] = (triOsc(p1) + Math.sin(p2 * Math.PI * 2) * 0.3 * a) * a;
    }
  }
  return out;
}

function ampEnv(t, dur, release, attack) {
  const a = t < attack ? t / attack : 1;
  if (t <= dur) return a;
  return a * Math.exp(-(t - dur) / (release * 0.4));
}

const VOICE_GAIN = { bass: 0.42, chord: 0.075, arp: 0.10, lead: 0.20, pluck: 0.13 };
const VOICE_PAN = { bass: 0, chord: 0, arp: 0.25, lead: -0.06, pluck: 0.35 };

/* ------------------------------------------------------------------ */
/* Rendu complet                                                       */
/* ------------------------------------------------------------------ */

/**
 * Synthétise un morceau.
 * @param {object} song      définition issue de js/songs/
 * @param {number} sampleRate
 * @param {(p:number)=>void} [onProgress] progression 0 → 1
 * @returns {Promise<{sampleRate:number, left:Float32Array, right:Float32Array, duration:number}>}
 */
export async function renderSong(song, sampleRate, onProgress) {
  const sr = sampleRate;
  const { drums, notes, totalBars } = unfold(song);
  const style = (song.mix && song.mix.style) || 'synthwave';
  const pumpAmount = (song.mix && song.mix.pump) || 0;
  const duration = (totalBars * 4 * 60) / song.bpm;
  const len = Math.ceil((duration + 2.2) * sr);

  const L = new Float32Array(len);
  const R = new Float32Array(len);
  const kit = buildKit(sr, style);

  const beat = 60 / song.bpm;
  const total = drums.length + notes.length;
  let done = 0;
  let lastYield = now();

  const yieldMaybe = async () => {
    // On rend la main régulièrement pour que la barre de progression reste
    // fluide : un rendu qui fige l'écran est perçu comme un plantage.
    if (now() - lastYield > 40) {
      if (onProgress) onProgress(done / total);
      await sleep(0);
      lastYield = now();
    }
  };

  // --- Enveloppe de pompage, échantillonnée à 200 Hz ---
  const pumpRate = 200;
  const pumpEnv = pumpAmount > 0 ? new Float32Array(Math.ceil((duration + 2.2) * pumpRate) + 2) : null;
  if (pumpEnv) {
    pumpEnv.fill(1);
    const recover = Math.min(0.24, beat * 0.85);
    for (const d of drums) {
      if (d.inst !== 'kick') continue;
      const t0 = stepTime(d.step, song.bpm, song.swing);
      const i0 = Math.floor(t0 * pumpRate);
      const n = Math.ceil(recover * pumpRate);
      for (let k = 0; k < n && i0 + k < pumpEnv.length; k++) {
        const v = 1 - pumpAmount * (1 - k / n);
        if (v < pumpEnv[i0 + k]) pumpEnv[i0 + k] = v;
      }
    }
  }
  const pumpAt = (t) => (pumpEnv ? pumpEnv[Math.min(pumpEnv.length - 1, (t * pumpRate) | 0)] : 1);

  // --- Percussions ---
  for (const d of drums) {
    const buf = kit[d.inst];
    if (!buf) continue;
    const t = stepTime(d.step, song.bpm, song.swing);
    const gain = (DRUM_GAIN[d.inst] || 0.3) * (0.5 + 0.5 * d.vel);
    mix(L, R, buf, Math.round(t * sr), gain, DRUM_PAN[d.inst] || 0);
    done++;
    await yieldMaybe();
  }

  // --- Parties mélodiques (avec cache de rendu) ---
  const cache = new Map();
  const sd = beat / 4;
  // Deux répétitions d'écho, synchronisées au tempo, panoramiquées à l'inverse
  // de la note : de la profondeur sans réverbération coûteuse.
  const echo = [
    { d: beat * 0.75, g: style === 'synthwave' ? 0.3 : 0.2, pan: 0.55 },
    { d: beat * 1.5, g: style === 'synthwave' ? 0.11 : 0.07, pan: -0.55 }
  ];

  for (const n of notes) {
    const gain = VOICE_GAIN[n.part];
    if (gain === undefined) { done++; continue; }
    const dur = Math.max(0.05, n.len * sd);
    const freq = midiToFreq(n.midi);
    const key = n.part + '|' + n.midi + '|' + Math.round(dur * 50);
    let buf = cache.get(key);
    if (!buf) {
      buf = renderVoice(n.part, freq, dur, sr, style);
      cache.set(key, buf);
    }
    const t = stepTime(n.step, song.bpm, song.swing);
    const i0 = Math.round(t * sr);
    const pan = VOICE_PAN[n.part] || 0;
    const g = gain * n.vel * (pumpAmount && (n.part === 'bass' || n.part === 'chord' || n.part === 'arp') ? pumpAt(t) : 1);
    mix(L, R, buf, i0, g, pan);
    if (n.part === 'lead' || n.part === 'pluck') {
      for (const e of echo) mix(L, R, buf, i0 + Math.round(e.d * sr), g * e.g, e.pan);
    }
    done++;
    await yieldMaybe();
  }

  // --- Masterisation : coupe-bas, limiteur doux, normalisation ---
  highpass30(L, sr);
  highpass30(R, sr);
  let peak = 0;
  for (let i = 0; i < len; i++) {
    const a = Math.abs(L[i]), b = Math.abs(R[i]);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  const norm = peak > 0 ? Math.min(2.4, 1.06 / peak) : 1;
  for (let i = 0; i < len; i++) {
    L[i] = softClip(L[i] * norm);
    R[i] = softClip(R[i] * norm);
  }
  if (onProgress) onProgress(1);

  return { sampleRate: sr, left: L, right: R, duration };
}

/** Coupe-bas 30 Hz : l'infra-grave ne sort d'aucun téléphone et mange la marge. */
function highpass30(x, sr) {
  const rc = 1 / (2 * Math.PI * 30);
  const a = rc / (rc + 1 / sr);
  let prevIn = 0, prevOut = 0;
  for (let pass = 0; pass < 2; pass++) {
    prevIn = 0; prevOut = 0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      prevOut = a * (prevOut + v - prevIn);
      prevIn = v;
      x[i] = prevOut;
    }
  }
}

function mix(L, R, buf, offset, gain, pan) {
  if (gain <= 0.00005) return;
  const gl = gain * (1 - Math.max(0, pan)) ;
  const gr = gain * (1 + Math.min(0, pan));
  const n = buf.length;
  const start = Math.max(0, offset);
  const end = Math.min(L.length, offset + n);
  for (let i = start; i < end; i++) {
    const v = buf[i - offset];
    L[i] += v * gl;
    R[i] += v * gr;
  }
}

const now = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
