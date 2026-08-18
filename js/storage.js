// Accès typé au localStorage. Toutes les préférences joueur transitent par ici.

const KEY = 'neonbeat.v1';

export const COLORS = ['#22e0c8', '#ff3d8b', '#8b5cff', '#ffb020', '#59f0ff', '#7cff6b'];

const DEFAULTS = {
  name: '',
  color: COLORS[0],
  offset: 0,          // ms de latence mesurée à la calibration
  calibrated: false,
  speed: 2.5,         // multiplicateur de vitesse de chute, façon DJ Max
  volume: 0.8,
  hitsound: false,
  vibrate: false,
  lastTrack: null,
  lastDiff: 'NORMAL'
};

let cache = null;

function read() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function get(key) {
  return read()[key];
}

export function all() {
  return { ...read() };
}

export function set(key, value) {
  const s = read();
  s[key] = value;
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* mode navigation privée : on garde le réglage en mémoire pour la session */
  }
}

/* ─── Vitesse de chute ────────────────────────────────────────────────
   Comme dans DJ Max, la vitesse est un MULTIPLICATEUR, pas une durée :
   elle est relative au tempo, donc l'espacement des notes reste identique
   d'un morceau à l'autre. À ×1, l'écran affiche 4 temps de musique.
   Monter la vitesse fait tomber les notes plus vite ET en affiche moins à
   la fois : c'est le réglage qui rend une chart dense lisible.            */

export const SPEED_MIN = 1;
export const SPEED_MAX = 6;
export const SPEED_STEP = 0.25;

/** Temps de trajet d'une note, du haut de l'écran à la ligne de jugement. */
export function travelTime(bpm, speed) {
  return (4 / speed) * (60 / bpm);
}

/** Nombre moyen de notes visibles simultanément pour une chart donnée. */
export function notesOnScreen(bpm, speed, notesPerSecond) {
  return notesPerSecond * travelTime(bpm, speed);
}

export function clampSpeed(v) {
  const s = Math.round(v / SPEED_STEP) * SPEED_STEP;
  return Math.max(SPEED_MIN, Math.min(SPEED_MAX, Math.round(s * 100) / 100));
}

/** Vitesse conseillée pour garder ~4,5 notes à l'écran sur cette chart. */
export function suggestSpeed(bpm, notesPerSecond) {
  if (!notesPerSecond) return 2.5;
  return clampSpeed((notesPerSecond * 240) / (bpm * 4.5));
}
