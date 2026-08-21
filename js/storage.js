// Accès typé au localStorage. Toutes les préférences joueur transitent par ici.

const KEY = 'neonbeat.v1';

// Huit teintes nettement distinctes : une par joueur d'un salon complet.
// Reprises de la palette de la mascotte (cyan, bleu, violet, rose néon).
export const COLORS = [
  '#2fd8ff', '#2f7dff', '#7a5cff', '#ff4bd8',
  '#ff5470', '#ffb020', '#7cff6b', '#31e0a8'
];

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
  keys: '4',          // mode de jeu : '4' (ZEIO) ou '2' (EI)
  mods: []            // effets actifs : 'MIRROR' | 'FADE' | 'SUDDEN' | 'NIGHTCORE'
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

/* ─── Records locaux ─────────────────────────────────────────────────────
   Les scores vivent dans LEUR PROPRE clé localStorage, séparée des réglages :
   ils survivent aux mises à jour du jeu (qui ne purgent que les caches de
   fichiers), aux évolutions de schéma des réglages, et à une éventuelle
   corruption du blob principal.                                            */

const SCORES_KEY = 'neonbeat.scores';
const GRADE_ORDER = ['D', 'C', 'B', 'A', 'S', 'S+', 'SS'];

let scoresCache = null;

function readScores() {
  if (scoresCache) return scoresCache;
  try {
    scoresCache = { scores: {}, board: {}, ...JSON.parse(localStorage.getItem(SCORES_KEY) || '{}') };
  } catch {
    scoresCache = { scores: {}, board: {} };
  }
  // Migration depuis l'ancien emplacement (blob des réglages, ≤ v1.01).
  const legacy = read();
  if (legacy.scores && Object.keys(legacy.scores).length) {
    scoresCache.scores = { ...legacy.scores, ...scoresCache.scores };
    scoresCache.board = { ...(legacy.board || {}), ...scoresCache.board };
    delete legacy.scores;
    delete legacy.board;
    try { localStorage.setItem(KEY, JSON.stringify(legacy)); } catch { /* tant pis */ }
    writeScores();
  }
  return scoresCache;
}

function writeScores() {
  try {
    localStorage.setItem(SCORES_KEY, JSON.stringify(scoresCache));
  } catch { /* stockage plein ou privé : les records restent en mémoire */ }
}

/**
 * Enregistre un résultat. Retourne { record: bool, best } — record = vrai si
 * le score bat le meilleur local pour ce morceau + difficulté.
 */
/* Le mode 2 keys a ses propres records : clé suffixée « |2K ».
   Les scores 4 keys gardent la clé historique (aucune migration). */
function scoreKey(trackId, diffName, keysMode) {
  return trackId + '|' + diffName + (keysMode === '2' ? '|2K' : '');
}

export function saveScore(trackId, diffName, entry, keysMode = '4') {
  const store = readScores();
  const key = scoreKey(trackId, diffName, keysMode);
  const prev = store.scores[key];
  const record = !prev || entry.score > prev.score;
  if (record) {
    store.scores[key] = entry;
  } else if (GRADE_ORDER.indexOf(entry.grade) > GRADE_ORDER.indexOf(prev.grade)) {
    // Un meilleur grade avec un moins bon score (autres effets) : on garde le
    // meilleur des deux mondes pour l'affichage.
    store.scores[key] = { ...prev, grade: entry.grade };
  }
  store.board[key] = [...(store.board[key] || []), entry]
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  writeScores();
  return { record, best: store.scores[key] };
}

export function bestFor(trackId, diffName, keysMode = '4') {
  return readScores().scores[scoreKey(trackId, diffName, keysMode)] || null;
}

export function boardFor(trackId, diffName, keysMode = '4') {
  return readScores().board[scoreKey(trackId, diffName, keysMode)] || [];
}
