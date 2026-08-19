// Génération de partitions jouables à partir de la partition musicale.
//
// Le principe fondateur du projet : la chart n'est pas « posée à l'oreille »
// sur un fichier audio, elle est DÉRIVÉE de la même structure de données que
// celle qui produit le son. La synchronisation est donc exacte par
// construction, à la milliseconde, sur tous les appareils.
//
// Ce module tourne à l'identique dans le navigateur et dans Node
// (tools/build-charts.mjs).

import { unfold, stepTime } from './songs/theory.js';

const LANES = 4;

/** PRNG déterministe : deux exécutions produisent exactement la même chart. */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Profils de difficulté.
 * - `grid`    : plus petite subdivision autorisée (2 = croches, 1 = doubles).
 * - `minGap`  : écart minimal EN SECONDES entre deux instants joués. En
 *               secondes et non en pas : sinon un morceau à 174 BPM devient
 *               mécaniquement deux fois plus dense qu'un morceau à 100 BPM.
 * - `maxChord`: nombre maximal de notes simultanées.
 * - `holdMin` : longueur minimale (en pas) pour convertir une note en hold.
 * - `nps`     : densité visée, en notes par seconde, fonction du tier du
 *               morceau. C'est elle qui pilote réellement la difficulté.
 */
export const DIFFICULTIES = [
  { name: 'EASY',    grid: 2, minGap: 0.26,  maxChord: 1, holdMin: 6, nps: (t) => 0.70 + 0.26 * t },
  { name: 'EASY+',   grid: 2, minGap: 0.20,  maxChord: 1, holdMin: 6, nps: (t) => (0.70 + 0.26 * t) * 1.50 },
  { name: 'NORMAL',  grid: 1, minGap: 0.14,  maxChord: 2, holdMin: 5, nps: (t) => (0.70 + 0.26 * t) * 2.05 },
  { name: 'NORMAL+', grid: 1, minGap: 0.11,  maxChord: 2, holdMin: 5, nps: (t) => (0.70 + 0.26 * t) * 2.65 },
  { name: 'HARD',    grid: 1, minGap: 0.085, maxChord: 3, holdMin: 4, nps: (t) => (0.70 + 0.26 * t) * 3.30 }
];

// Hiérarchie musicale : ce qu'on garde en premier quand il faut alléger.
// Le chant passe avant la caisse claire, qui passe avant le charley.
const PRIORITY = {
  lead: 10, pluck: 8.5, snare: 8, clap: 7.5, crash: 7, kick: 6.5, ohat: 5, arp: 4, bass: 3, hat: 1
};

// Couloirs préférés des percussions : le pied aux extrémités, la caisse claire
// au centre. Le corps prend l'habitude, la lecture devient instinctive.
const DRUM_LANES = {
  kick: [0, 3], snare: [1, 2], clap: [2, 1], ohat: [3, 0], crash: [0, 3], hat: [1, 2]
};

function buildCandidates(song) {
  const { drums, notes: melodic, totalBars } = unfold(song);
  const rng = makeRng(hashString(song.id));
  const out = [];

  // Jitter déterministe : départage les événements de même priorité sans
  // produire deux fois le même motif d'allègement.
  const scoreOf = (prio, step, vel) => {
    const beat = step % 16 === 0 ? 3 : step % 4 === 0 ? 2 : step % 2 === 0 ? 1 : 0;
    return prio + beat * 1.1 + vel * 0.8 + rng() * 1.6;
  };

  for (const d of drums) {
    out.push({
      step: d.step, kind: d.inst, len: 0,
      score: scoreOf(PRIORITY[d.inst] ?? 1, d.step, d.vel)
    });
  }

  const pitched = melodic.filter((n) => n.part !== 'chord');
  let lo = Infinity, hi = -Infinity;
  for (const n of pitched) { if (n.midi < lo) lo = n.midi; if (n.midi > hi) hi = n.midi; }
  const span = Math.max(1, hi - lo);

  for (const n of pitched) {
    out.push({
      step: n.step, kind: n.part, len: n.len,
      pitchPos: (n.midi - lo) / span,
      score: scoreOf(PRIORITY[n.part] ?? 3, n.step, n.vel)
    });
  }

  out.sort((a, b) => a.step - b.step || b.score - a.score);

  // Rang relatif LOCAL : chaque candidat est classé parmi ceux de sa fenêtre
  // de 2 mesures. La sélection filtrera sur ce rang plutôt que sur le score
  // brut : ainsi une section calme (sans lead) garde ses meilleures notes au
  // lieu d'être entièrement vidée par les sections denses — sans quoi la
  // chart alternerait déluges et silences de plusieurs secondes.
  const byWindow = new Map();
  for (const c of out) {
    const w = Math.floor(c.step / 32);
    if (!byWindow.has(w)) byWindow.set(w, []);
    byWindow.get(w).push(c);
  }
  for (const group of byWindow.values()) {
    group.sort((a, b) => b.score - a.score);
    group.forEach((c, i) => { c.rank = (i + 0.5) / group.length; });
  }
  return { candidates: out, totalBars };
}

/** Place les candidats retenus (score >= seuil) dans les 4 couloirs. */
function place(candidates, song, diff, threshold) {
  const laneFreeAt = new Array(LANES).fill(-Infinity);
  const placed = [];
  let lastTime = -999;
  let lastLane = -1;
  const toggle = {};

  let i = 0;
  while (i < candidates.length) {
    const step = candidates[i].step;
    let j = i;
    while (j < candidates.length && candidates[j].step === step) j++;
    const group = candidates.slice(i, j).filter((c) => c.rank <= threshold);
    i = j;

    if (!group.length) continue;
    if (step % diff.grid !== 0) continue;

    const time = stepTime(step, song.bpm, song.swing);
    if (time - lastTime < diff.minGap - 1e-6) continue;

    let chord = 0;
    let any = false;
    for (const c of group) {
      if (chord >= diff.maxChord) break;

      let want;
      if (c.kind in DRUM_LANES) {
        const opts = DRUM_LANES[c.kind];
        toggle[c.kind] = (toggle[c.kind] || 0) + 1;
        want = opts[toggle[c.kind] % opts.length];
      } else {
        want = Math.min(LANES - 1, Math.floor(c.pitchPos * LANES));
        // Deux notes de même hauteur collées : on décale d'un couloir pour
        // produire un trille jouable plutôt qu'un martèlement du même pouce.
        if (want === lastLane && time - lastTime <= 0.19) {
          want = want === LANES - 1 ? want - 1 : want + 1;
        }
      }

      const lane = findLane(laneFreeAt, want, step);
      if (lane < 0) continue;

      const isHold = c.len >= diff.holdMin;
      // +1 pas de respiration après un hold : le relâchement ne doit jamais
      // tomber exactement sur la note suivante du même couloir.
      laneFreeAt[lane] = isHold ? step + c.len + 1 : step + 1;
      placed.push({ lane, step, len: isHold ? c.len : 0 });
      chord++;
      any = true;
      lastLane = lane;
    }
    if (any) lastTime = time;
  }

  return placed;
}

function findLane(laneFreeAt, want, step) {
  if (laneFreeAt[want] <= step) return want;
  for (let d = 1; d < LANES; d++) {
    for (const l of [want - d, want + d]) {
      if (l >= 0 && l < LANES && laneFreeAt[l] <= step) return l;
    }
  }
  return -1;
}

/**
 * Construit la partition jouable d'un morceau pour une difficulté donnée.
 * Le seuil de sélection est trouvé par dichotomie pour atteindre la densité
 * visée : la chart reste musicale (on retire d'abord ce qui compte le moins)
 * tout en étant calibrée en difficulté.
 */
export function generateChart(song, diff) {
  const { candidates, totalBars } = buildCandidates(song);
  const duration = (totalBars * 4 * 60) / song.bpm;
  const target = Math.round(diff.nps(song.tier) * duration);

  // Dichotomie sur le rang local (0 = ne garder que le meilleur de chaque
  // fenêtre, 1 = tout garder) pour atteindre la densité visée.
  let lo = 0, hi = 1, best = null;
  for (let it = 0; it < 24; it++) {
    const mid = (lo + hi) / 2;
    const placed = place(candidates, song, diff, mid);
    if (best === null || Math.abs(placed.length - target) < Math.abs(best.length - target)) {
      best = placed;
    }
    if (placed.length > target) hi = mid; else lo = mid;
  }

  best.sort((a, b) => a.step - b.step || a.lane - b.lane);
  const notes = best.map((p) => {
    // On arrondit les bornes AVANT de faire la différence : sinon
    // t + durée peut dépasser d'une milliseconde la fin réelle du hold.
    const t = round3(stepTime(p.step, song.bpm, song.swing));
    const end = round3(stepTime(p.step + p.len, song.bpm, song.swing));
    return [p.lane, t, p.len > 0 ? round3(end - t) : 0];
  });

  const nps = notes.length / duration;
  const level = Math.max(1, Math.min(15, Math.round(nps * 1.55 + song.tier * 0.45)));
  return { name: diff.name, level, notes };
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

/** Construit l'objet chart complet (format documenté au §6.4 du brief). */
export function buildTrack(song) {
  const { totalBars } = unfold(song);
  const duration = (totalBars * 4 * 60) / song.bpm;
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    license: song.license,
    sourceUrl: '',
    synth: true,                 // audio généré par js/synth.js : aucun fichier
    audio: null,
    bpm: song.bpm,
    audioOffset: 0,
    previewStart: round3(((song.previewBar || 8) * 4 * 60) / song.bpm),
    duration: round3(duration),
    color: song.color,
    tier: song.tier,
    difficulties: DIFFICULTIES.map((d) => generateChart(song, d))
  };
}
