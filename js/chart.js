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
