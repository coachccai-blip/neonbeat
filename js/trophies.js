// Trophées : objectifs de longue haleine qui débloquent les skins.
//
// Deux sources de données, volontairement séparées :
//  - les GRADES viennent des meilleurs scores locaux (storage.scores). Compter
//    les SS par chart plutôt que cumulativement évite de gonfler le compteur
//    en rejouant dix fois le même morceau facile ;
//  - le RESTE (combo maximal, full combos, parties jouées…) demande un suivi
//    explicite, tenu dans un blob isolé qui survit aux mises à jour.

/**
 * @typedef {object} Stats
 * @property {number} plays          parties terminées
 * @property {number} maxCombo       plus long combo jamais atteint
 * @property {number} maxFever       plus haut multiplicateur de fever atteint
 * @property {number} fullCombos     parties sans aucun MISS
 * @property {number} allPerfects    parties 100 % PERFECT
 * @property {number} hardFullCombos full combos en HARD
 * @property {number} keys2Plays     parties en mode 2 touches
 * @property {number} notesHit       notes touchées, tous modes confondus
 * @property {string[]} unlocked     trophées déjà notifiés
 */

export const EMPTY_STATS = {
  plays: 0, maxCombo: 0, maxFever: 1, fullCombos: 0, allPerfects: 0,
  hardFullCombos: 0, keys2Plays: 0, notesHit: 0, unlocked: []
};

/**
 * Agrège les meilleurs scores en compteurs de grades.
 * @param {object} scores  storage.allScores() — clé « id|DIFF[|2K] » → entrée
 */
export function gradeCounts(scores) {
  const out = { SS: 0, 'S+': 0, S: 0, A: 0, tracks: new Set(), hardCleared: 0 };
  for (const [key, e] of Object.entries(scores || {})) {
    if (!e || !e.grade) continue;
    if (out[e.grade] !== undefined) out[e.grade]++;
    out.tracks.add(key.split('|')[0]);
    if (key.split('|')[1] === 'HARD' && e.grade !== 'D') out.hardCleared++;
  }
  return { ...out, tracks: out.tracks.size };
}

/**
 * Chaque trophée sait mesurer sa propre progression : `value` lit l'avancement
 * courant, `target` est le palier à atteindre. L'affichage et le déblocage en
 * découlent, sans logique dupliquée.
 */
export const TROPHIES = [
  { id: 'first',     icon: '🎬', target: 1,   value: (s) => s.plays },
  { id: 'combo100',  icon: '🔗', target: 100, value: (s) => s.maxCombo },
  { id: 'combo250',  icon: '⛓️', target: 250, value: (s) => s.maxCombo },
  { id: 'combo500',  icon: '🌠', target: 500, value: (s) => s.maxCombo },
  { id: 'fever5',    icon: '🔥', target: 5,   value: (s) => s.maxFever },
  { id: 'fever8',    icon: '☄️', target: 8,   value: (s) => s.maxFever },
  { id: 'fever12',   icon: '🌌', target: 12,  value: (s) => s.maxFever },
  { id: 'fc1',       icon: '✨', target: 1,   value: (s) => s.fullCombos },
  { id: 'fc10',      icon: '📺', target: 10,  value: (s) => s.fullCombos },
  { id: 'ap1',       icon: '❄️', target: 1,   value: (s) => s.allPerfects },
  { id: 'ss1',       icon: '⭐', target: 1,   value: (s, g) => g.SS },
  { id: 'ss5',       icon: '🏆', target: 5,   value: (s, g) => g.SS },
  { id: 'ss15',      icon: '👑', target: 15,  value: (s, g) => g.SS },
  { id: 'sgrades20', icon: '🎖️', target: 20,  value: (s, g) => g.SS + g['S+'] + g.S },
  { id: 'hardfc',    icon: '🌋', target: 1,   value: (s) => s.hardFullCombos },
  { id: 'tracks10',  icon: '🎵', target: 10,  value: (s, g) => g.tracks },
  { id: 'tracks25',  icon: '🎚️', target: 25,  value: (s, g) => g.tracks },
  { id: 'tracksAll', icon: '💿', target: 42,  value: (s, g) => g.tracks },
  { id: 'keys2',     icon: '🎹', target: 5,   value: (s) => s.keys2Plays },

  // Palier « fin de jeu » : ceux-là débloquent les avatars et demandent
  // des dizaines d'heures — c'est voulu, un avatar rare doit se voir.
  { id: 'fever15',   icon: '🌟', target: 15,     value: (s) => s.maxFever },
  { id: 'ss25',      icon: '🥇', target: 25,     value: (s, g) => g.SS },
  { id: 'combo1000', icon: '🚀', target: 1000,   value: (s) => s.maxCombo },
  { id: 'hardfc10',  icon: '🗻', target: 10,     value: (s) => s.hardFullCombos },
  { id: 'ap10',      icon: '💎', target: 10,     value: (s) => s.allPerfects },
  { id: 'notes100k', icon: '🎼', target: 100000, value: (s) => s.notesHit }
];

export function trophyById(id) {
  return TROPHIES.find((t) => t.id === id) || null;
}

/** Progression de chaque trophée : [{ id, icon, current, target, done }] */
export function progress(stats, counts) {
  return TROPHIES.map((t) => {
    const current = Math.max(0, t.value(stats, counts) || 0);
    return { ...t, current: Math.min(current, t.target), done: current >= t.target };
  });
}

/** Identifiants des trophées obtenus. */
export function earned(stats, counts) {
  return progress(stats, counts).filter((t) => t.done).map((t) => t.id);
}

/**
 * Met à jour les compteurs après une partie.
 * @param {Stats} stats
 * @param {object} res  résultat de partie (engine.results() enrichi)
 * @returns {Stats} nouveaux compteurs (l'objet d'entrée n'est pas modifié)
 */
export function applyResult(stats, res) {
  const s = { ...EMPTY_STATS, ...stats, unlocked: [...(stats.unlocked || [])] };
  const counts = res.counts || {};
  const noMiss = !res.failed && !counts.MISS && (counts.PERFECT || counts.GREAT || counts.GOOD);
  s.plays++;
  s.maxCombo = Math.max(s.maxCombo, res.comboMax || 0);
  s.maxFever = Math.max(s.maxFever || 1, res.feverMax || 1);
  s.notesHit += (counts.PERFECT || 0) + (counts.GREAT || 0) + (counts.GOOD || 0);
  if (noMiss) {
    s.fullCombos++;
    if (res.diffName === 'HARD') s.hardFullCombos++;
    // Tout en PERFECT : le graal, distinct du simple full combo.
    if (!counts.GREAT && !counts.GOOD) s.allPerfects++;
  }
  if ((res.keysMode || '4') === '2') s.keys2Plays++;
  return s;
}
