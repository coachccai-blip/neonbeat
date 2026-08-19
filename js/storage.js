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
  lastDiff: 'NORMAL',
  lang: 'fr',
  mods: [],           // effets actifs : 'MIRROR' | 'FADE' | 'SUDDEN' | 'NIGHTCORE'
  scores: {},         // "trackId|DIFF" → meilleur { score, grade, precision, comboMax, mods }
  board: {}           // "trackId|DIFF" → top 8 [{ score, grade, mods, name }]
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

/** Vitesse conseillée pour cette chart : vise 1,5 note affichée à la fois. */
export function suggestSpeed(bpm, notesPerSecond) {
  if (!notesPerSecond) return 2.5;
  return clampSpeed((notesPerSecond * 240) / (bpm * 1.5));
}

/* ─── Records locaux ─────────────────────────────────────────────────── */

const GRADE_ORDER = ['D', 'C', 'B', 'A', 'S', 'S+', 'SS'];

/**
 * Enregistre un résultat. Retourne { record: bool, best } — record = vrai si
 * le score bat le meilleur local pour ce morceau + difficulté.
 */
export function saveScore(trackId, diffName, entry) {
  const key = trackId + '|' + diffName;
  const scores = { ...get('scores') };
  const prev = scores[key];
  const record = !prev || entry.score > prev.score;
  if (record) {
    scores[key] = entry;
  } else if (GRADE_ORDER.indexOf(entry.grade) > GRADE_ORDER.indexOf(prev.grade)) {
    // Un meilleur grade avec un moins bon score (autres effets) : on garde le
    // meilleur des deux mondes pour l'affichage.
    scores[key] = { ...prev, grade: entry.grade };
  }
  set('scores', scores);

  const board = { ...get('board') };
  const list = [...(board[key] || []), entry]
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  board[key] = list;
  set('board', board);
  return { record, best: scores[key] };
}

export function bestFor(trackId, diffName) {
  return get('scores')[trackId + '|' + diffName] || null;
}

export function boardFor(trackId, diffName) {
  return get('board')[trackId + '|' + diffName] || [];
}
