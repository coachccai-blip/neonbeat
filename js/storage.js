// Accès typé au localStorage. Toutes les préférences joueur transitent par ici.

import { perfectCombo } from './engine.js';

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
  travelMs: 625,      // temps de chute visé : c'est LUI que le joueur règle
  volume: 0.8,
  hitsound: true,     // « pop » de papier bulle à chaque note
  hitsoundPop: false, // marqueur de migration (voir read())
  vibrate: false,
  uisound: true,      // bruitages de navigation dans les menus
  skin: 'neon',       // habillage de la zone de jeu (voir js/skins.js)
  avatar: 'nb_avatar01', // pastille affichée avant le pseudo (js/avatars.js)
  plShuffle: false,   // mode écoute : lecture aléatoire
  plRepeat: 'all',    // mode écoute : 'all' | 'one' | 'off'
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
  // Le son de frappe était muet par défaut tant que c'était un « bip » de
  // console ; il devient un « pop » de papier bulle et s'active d'office.
  // Une seule fois : le joueur qui le coupe ensuite le retrouve coupé.
  if (!cache.hitsoundPop) {
    cache.hitsound = true;
    cache.hitsoundPop = true;
    try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* privé */ }
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
/* Le pas était d'un quart de point, la convention du genre. Mais le
   réglage vise désormais une DURÉE : à ×1,75 un quart de point déplace le
   temps de chute de 14 %, bien trop pour honorer une cible en
   millisecondes. Un vingtième de point tombe toujours à moins de 1 % près. */
export const SPEED_STEP = 0.05;

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

/* ─── Temps de chute ──────────────────────────────────────────────────
   Le repère n'est plus « combien de notes tiennent à l'écran » mais le
   TEMPS que met une note à descendre. C'est lui que l'œil et la main
   ressentent : à densité égale, deux morceaux de tempos différents se
   jouent pareil s'ils ont le même temps de chute, et pas du tout s'ils ont
   le même multiplicateur.

   Le multiplicateur reste l'unité affichée — c'est la convention du genre —
   mais il n'est plus qu'une conséquence du temps visé et du tempo.        */

export const TRAVEL_MIN = 550;      // ms
export const TRAVEL_MAX = 700;
export const TRAVEL_DEFAULT = 625;  // milieu de la fenêtre

/** Multiplicateur donnant ce temps de chute sur ce tempo, borné et arrondi. */
export function speedForTravel(bpm, ms) {
  if (!bpm) return 2.5;
  return clampSpeed(240 / (bpm * (ms / 1000)));
}

/**
 * Vitesse conseillée : celle dont le temps de chute tombe dans la fenêtre
 * 550–700 ms. L'arrondi au quart de point peut faire sortir de la fenêtre
 * la valeur visant son milieu ; on rentre alors d'un cran.
 */
export function suggestSpeed(bpm) {
  if (!bpm) return 2.5;
  let v = speedForTravel(bpm, TRAVEL_DEFAULT);
  const ms = () => travelTime(bpm, v) * 1000;
  if (ms() > TRAVEL_MAX && v < SPEED_MAX) v = clampSpeed(v + SPEED_STEP);
  else if (ms() < TRAVEL_MIN && v > SPEED_MIN) v = clampSpeed(v - SPEED_STEP);
  return v;
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
  migrerCombo(scoresCache);
  return scoresCache;
}

/* ─── Combos pondérés par le fever (v1.35) ───────────────────────────
   Avant, le combo comptait les notes ; désormais chaque note en vaut
   autant que le fever en cours. Les valeurs déjà enregistrées sont donc
   dans l'ANCIENNE échelle : les laisser telles quelles ferait passer tous
   les records historiques pour ridicules à côté de la première partie
   jouée après la mise à jour.

   `perfectCombo` traduit un nombre de notes enchaînées en combo pondéré —
   exactement la conversion qu'il faut, puisque l'ancienne valeur ÉTAIT ce
   nombre de notes.                                                       */

function migrerCombo(store) {
  if (store.comboV2) return;
  for (const e of Object.values(store.scores || {})) {
    if (e && e.comboMax) e.comboMax = perfectCombo(e.comboMax);
  }
  for (const liste of Object.values(store.board || {})) {
    for (const e of liste || []) if (e && e.comboMax) e.comboMax = perfectCombo(e.comboMax);
  }
  store.comboV2 = true;
  writeScores();
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

/* ─── Statistiques de trophées ───────────────────────────────────────
   Rangées à part (comme les scores) : une mise à jour du jeu ne doit jamais
   effacer la progression du joueur.                                      */

const STATS_KEY = 'neonbeat.stats';
let statsCache = null;

export function readStats() {
  if (statsCache) return statsCache;
  try {
    statsCache = JSON.parse(localStorage.getItem(STATS_KEY) || '{}');
  } catch {
    statsCache = {};
  }
  if (!Array.isArray(statsCache.unlocked)) statsCache.unlocked = [];
  // Même conversion que pour les scores (voir migrerCombo).
  if (!statsCache.comboV2) {
    if (statsCache.maxCombo) statsCache.maxCombo = perfectCombo(statsCache.maxCombo);
    statsCache.comboV2 = true;
    writeStats(statsCache);
  }
  return statsCache;
}

export function writeStats(next) {
  statsCache = next;
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(next));
  } catch { /* stockage plein ou privé : la progression reste en mémoire */ }
  return statsCache;
}

/** Tous les meilleurs scores, pour le calcul des compteurs de grades. */
export function allScores() {
  return readScores().scores;
}

export function bestFor(trackId, diffName, keysMode = '4') {
  return readScores().scores[scoreKey(trackId, diffName, keysMode)] || null;
}

export function boardFor(trackId, diffName, keysMode = '4') {
  return readScores().board[scoreKey(trackId, diffName, keysMode)] || [];
}
