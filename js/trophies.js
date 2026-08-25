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
  hardFullCombos: 0, keys2Plays: 0, notesHit: 0, unlocked: [],
  // Statistiques d'ensemble (v1.41). Elles ne débloquent rien : elles sont
  // là pour que le joueur mesure le chemin parcouru.
  playSeconds: 0,          // temps passé à jouer, morceaux terminés
  trackPlays: {}           // { trackId: nombre de parties }
};

/**
 * Agrège les meilleurs scores en compteurs de grades.
 * @param {object} scores  storage.allScores() — clé « id|DIFF[|2K] » → entrée
 */
/** Morceau le plus joué : { id, n } — null tant qu'aucune partie n'est finie. */
export function favori(stats) {
  let id = null, n = 0;
  for (const [k, v] of Object.entries((stats && stats.trackPlays) || {})) {
    if (v > n) { id = k; n = v; }
  }
  return id ? { id, n } : null;
}

/** Difficultés « HARD ou supérieur » — HARD+ est venu s'ajouter en v1.51. */
const DUR = new Set(['HARD', 'HARD+']);
export function estDur(diff) { return DUR.has(diff); }

export function gradeCounts(scores) {
  const out = { SS: 0, 'S+': 0, S: 0, A: 0, tracks: new Set(), hardCleared: 0, splusNormal: 0,
                ssHard: 0, ssBigCombo: 0 };
  for (const [key, e] of Object.entries(scores || {})) {
    if (!e || !e.grade) continue;
    if (out[e.grade] !== undefined) out[e.grade]++;
    const [track, diff] = key.split('|');
    out.tracks.add(track);
    if (estDur(diff) && e.grade !== 'D') out.hardCleared++;
    // Difficulté NORMAL au sens strict : « NORMAL+ » est une autre chart.
    if (diff === 'NORMAL' && (e.grade === 'S+' || e.grade === 'SS')) out.splusNormal++;
    if (e.grade === 'SS') {
      if (estDur(diff)) out.ssHard++;
      // Un SS tenu sur un très long combo : la maîtrise ET l'endurance.
      if ((e.comboMax || 0) > 8000) out.ssBigCombo++;
    }
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
  { id: 'combo100',  icon: '🔗', target: 250, value: (s) => s.maxCombo },
  { id: 'combo250',  icon: '⛓️', target: 1000, value: (s) => s.maxCombo },
  { id: 'combo500',  icon: '🌠', target: 3200, value: (s) => s.maxCombo },
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
  { id: 'tracksAll', icon: '💿', target: 52,  value: (s, g) => g.tracks },
  { id: 'keys2',     icon: '🎹', target: 5,   value: (s) => s.keys2Plays },

  // Palier « fin de jeu » : ceux-là débloquent les avatars et demandent
  // des dizaines d'heures — c'est voulu, un avatar rare doit se voir.
  { id: 'fever15',    icon: '🌟', target: 15,     value: (s) => s.maxFever },
  { id: 'ss10',       icon: '💎', target: 10,     value: (s, g) => g.SS },
  { id: 'ss25',       icon: '🥇', target: 25,     value: (s, g) => g.SS },
  { id: 'combo10k',   icon: '🚀', target: 10000,  value: (s) => s.maxCombo },
  { id: 'splusnorm30', icon: '🎯', target: 30,    value: (s, g) => g.splusNormal },
  { id: 'hardfc10',   icon: '🗻', target: 10,     value: (s) => s.hardFullCombos },
  { id: 'ap10',       icon: '🔮', target: 10,     value: (s) => s.allPerfects },
  { id: 'notes100k',  icon: '🎼', target: 100000, value: (s) => s.notesHit },
  { id: 'hades',      icon: '🏛️', target: 20,     value: (s, g) => g.ssHard },
  { id: 'zeus',       icon: '⚡', target: 5,      value: (s, g) => g.ssBigCombo }
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
  const s = { ...EMPTY_STATS, ...stats, unlocked: [...(stats.unlocked || [])],
              trackPlays: { ...(stats.trackPlays || {}) } };
  const counts = res.counts || {};
  const noMiss = !res.failed && !counts.MISS && (counts.PERFECT || counts.GREAT || counts.GOOD);
  s.plays++;
  s.maxCombo = Math.max(s.maxCombo, res.comboMax || 0);
  s.maxFever = Math.max(s.maxFever || 1, res.feverMax || 1);
  s.notesHit += (counts.PERFECT || 0) + (counts.GREAT || 0) + (counts.GOOD || 0);
  if (noMiss) {
    s.fullCombos++;
    // HARD+ compte aussi : elle est plus dure que HARD, il serait absurde
    // qu'un full combo dessus ne vaille pas celui de la difficulté inférieure.
    if (estDur(res.diffName)) s.hardFullCombos++;
    // Tout en PERFECT : le graal, distinct du simple full combo.
    if (!counts.GREAT && !counts.GOOD) s.allPerfects++;
  }
  if ((res.keysMode || '4') === '2') s.keys2Plays++;
  // Le morceau a été mené à son terme : `applyResult` n'est jamais appelé
  // sur une partie abandonnée.
  s.playSeconds += Math.max(0, Math.round(res.duration || 0));
  if (res.trackId) s.trackPlays[res.trackId] = (s.trackPlays[res.trackId] || 0) + 1;
  return s;
}
