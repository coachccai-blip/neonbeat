// Petit moteur de synthèse logicielle.
//
// Pourquoi ne pas utiliser le graphe Web Audio pour le rendu ? Parce qu'un
// morceau contient plusieurs milliers de notes : instancier autant
// d'OscillatorNode dans un OfflineAudioContext prend des dizaines de secondes,
// y compris sur une machine de bureau. Écrire les échantillons à la main est
// ici un ordre de grandeur plus rapide, entièrement déterministe, et testable
// hors navigateur.

/* --------------------------- Oscillateurs --------------------------- */

// PolyBLEP : corrige la discontinuité des formes d'onde à dents de scie et
// carrées. Sans lui, les leads aigus « crissent » (repliement de spectre).
function polyBlep(t, dt) {
  if (t < dt) { const x = t / dt; return x + x - x * x - 1; }
  if (t > 1 - dt) { const x = (t - 1) / dt; return x * x + x + x + 1; }
  return 0;
}

export function makeOsc(type) {
  switch (type) {
    case 'saw':
      return (phase, dt) => 2 * phase - 1 - polyBlep(phase, dt);
    case 'square':
      return (phase, dt) => {
        let v = phase < 0.5 ? 1 : -1;
        v += polyBlep(phase, dt);
        v -= polyBlep((phase + 0.5) % 1, dt);
        return v;
      };
    case 'triangle':
      return (phase) => 1 - 4 * Math.abs(((phase + 0.75) % 1) - 0.5);
    default:
      return (phase) => Math.sin(phase * Math.PI * 2);
  }
}

/* ------------------------- Filtres ---------------------------------- */

/** Filtre à variable d'état (Chamberlin) : stable et modulable par échantillon. */
export class SVF {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.low = 0;
    this.band = 0;
  }
  process(input, cutoff, q) {
    const f = 2 * Math.sin(Math.PI * Math.min(cutoff, this.sr * 0.45) / this.sr);
    const damp = 1 / Math.max(0.5, q);
    const high = input - this.low - damp * this.band;
    this.band += f * high;
    this.low += f * this.band;
    return { low: this.low, band: this.band, high };
  }
}

/** Biquad RBJ, coefficients figés : utilisé pour les percussions. */
export class Biquad {
  constructor(type, freq, q, sampleRate) {
    const w = 2 * Math.PI * freq / sampleRate;
    const cw = Math.cos(w), sw = Math.sin(w);
    const alpha = sw / (2 * q);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'highpass') {
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
    } else if (type === 'bandpass') {
      b0 = alpha; b1 = 0; b2 = -alpha;
    } else {
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
    }
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = a1 / a0; this.a2 = a2 / a0;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

/* ------------------------- Utilitaires ------------------------------ */

export function makeNoise(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return (s / 2147483648) - 1;
  };
}

/** Décroissance exponentielle atteignant −60 dB au bout de `time` secondes. */
export function decayCoef(time, sampleRate) {
  return Math.exp(-6.9078 / Math.max(1e-4, time * sampleRate));
}

/** Limiteur doux : évite la saturation numérique sans écraser la dynamique. */
export function softClip(x) {
  if (x > 1.2 || x < -1.2) return Math.tanh(x);
  return x - (x * x * x) / 9;
}
