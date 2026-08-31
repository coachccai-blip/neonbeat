// Chargement et validation des partitions (tracks/*.json).

const cache = new Map();
let indexPromise = null;

export function loadIndex() {
  if (!indexPromise) {
    indexPromise = fetch('./tracks/index.json')
      .then((r) => {
        if (!r.ok) throw new Error('index.json introuvable');
        return r.json();
      })
      .then((d) => d.tracks);
  }
  return indexPromise;
}

export async function loadTrack(id) {
  if (cache.has(id)) return cache.get(id);
  const p = fetch(`./tracks/${id}.json`)
    .then((r) => {
      if (!r.ok) throw new Error(`chart ${id} introuvable`);
      return r.json();
    })
    .then(validate);
  cache.set(id, p);
  return p;
}

function validate(track) {
  if (!Array.isArray(track.difficulties) || !track.difficulties.length) {
    throw new Error(`${track.id} : aucune difficulté`);
  }
  for (const d of track.difficulties) {
    let prev = -1;
    for (const n of d.notes) {
      if (!Array.isArray(n) || n.length < 3) throw new Error(`${track.id}/${d.name} : note malformée`);
      if (n[0] < 0 || n[0] > 3) throw new Error(`${track.id}/${d.name} : couloir hors bornes`);
      // Le moteur s'appuie sur cet invariant pour n'itérer que sur une
      // fenêtre glissante : une chart désordonnée ferait disparaître des notes.
      if (n[1] < prev) throw new Error(`${track.id}/${d.name} : notes non triées`);
      prev = n[1];
    }
  }
  return track;
}

export function getDifficulty(track, name) {
  return track.difficulties.find((d) => d.name === name) || track.difficulties[0];
}

/** Densité moyenne de la chart, en notes par seconde. */
export function density(track, diffName) {
  const d = getDifficulty(track, diffName);
  return d.notes.length / track.duration;
}

/**
 * Réduit une chart 4 couloirs en 2 couloirs (mode « 2 keys »).
 * Couloirs 0-1 → gauche, 2-3 → droite, avec bascule sur l'autre couloir si
 * le préféré est occupé (hold en cours ou note trop proche) : les trilles
 * gauche-gauche deviennent des alternances jouables au lieu d'un martèlement.
 */
export function to2Keys(raw) {
  const MIN_GAP = 0.09;
  const laneEnd = [-1e9, -1e9];
  const lastAt = [-1e9, -1e9];
  const out = [];
  for (const [lane, t, dur] of raw) {
    const pref = lane < 2 ? 0 : 1;
    let chosen = -1;
    for (const c of [pref, 1 - pref]) {
      if (t >= laneEnd[c] && t - lastAt[c] >= MIN_GAP) { chosen = c; break; }
    }
    if (chosen < 0) continue;               // accord à 3-4 notes : surplus retiré
    lastAt[chosen] = t;
    laneEnd[chosen] = t + dur + (dur > 0 ? 0.05 : 0);
    out.push([chosen, t, dur]);
  }
  return out;
}

/**
 * Étale une chart 4 couloirs sur 6 couloirs (mode « 6 keys »).
 *
 * Contrairement au 2 keys qui FUSIONNE, ici aucune note n'est perdue : le
 * défi vient de la lecture, plus large, pas d'un contenu différent. Chaque
 * couloir 4K a sa région préférée (0→gauche, 3→droite) pour que la
 * géographie du morceau reste reconnaissable, et un tirage DÉTERMINISTE
 * (germé sur la taille de la chart) répartit les notes dans la région —
 * la même chart donne toujours le même étalement, sinon les records ne se
 * compareraient pas d'une partie à l'autre.
 *
 * Deux passes par note : d'abord en évitant de marteler un couloir
 * fraîchement joué (les répétitions 4K deviennent des alternances), puis,
 * si tout est trop proche, n'importe quel couloir libre — on préfère un
 * martèlement à une note disparue.
 */
export function to6Keys(raw) {
  const REGIONS = [[0, 1], [1, 2], [3, 4], [4, 5]];
  const laneEnd = new Array(6).fill(-1e9);   // occupé par un hold jusqu'à…
  const lastAt = new Array(6).fill(-1e9);    // dernière note posée
  let g = (0x9e3779b9 ^ raw.length) >>> 0;   // mulberry32, germe fixe
  const rng = () => {
    g = (g + 0x6D2B79F5) >>> 0;
    let x = Math.imul(g ^ (g >>> 15), g | 1);
    x = (x + Math.imul(x ^ (x >>> 7), x | 61)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const out = [];
  let i = 0;
  while (i < raw.length) {
    const t = raw[i][1];
    let j = i;
    while (j < raw.length && raw[j][1] === t) j++;
    const accord = raw.slice(i, j);
    i = j;
    const pris = new Set();
    for (const [lane, , dur] of accord) {
      const region = REGIONS[lane] || [2, 3];
      const prefs = rng() < 0.5 ? [region[0], region[1]] : [region[1], region[0]];
      const centre = (region[0] + region[1]) / 2;
      const secours = [0, 1, 2, 3, 4, 5]
        .filter((l) => l !== region[0] && l !== region[1])
        .sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre));
      const essayer = (avecEcart) => {
        for (const c of [...prefs, ...secours]) {
          if (pris.has(c)) continue;
          if (t < laneEnd[c]) continue;
          if (avecEcart && t - lastAt[c] < 0.16) continue;
          return c;
        }
        return -1;
      };
      let c = essayer(true);
      if (c < 0) c = essayer(false);
      if (c < 0) continue;      // 6 couloirs occupés à la fois : impossible en pratique
      pris.add(c);
      lastAt[c] = t;
      laneEnd[c] = t + dur + (dur > 0 ? 0.05 : 0);
      out.push([c, t, dur]);
    }
  }
  return out;
}
