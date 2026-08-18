// Petite bibliothèque de théorie musicale partagée par le synthétiseur et le
// générateur de charts. Aucune dépendance : elle doit tourner aussi bien dans
// le navigateur que dans Node (tools/build-charts.mjs).

export const SCALES = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  phrygian: [0, 1, 3, 5, 7, 8, 10]
};

/**
 * Convertit un degré de gamme (potentiellement négatif ou supérieur à 7) en
 * note MIDI absolue. Les octaves sont gérées par enroulement.
 */
export function degToMidi(rootMidi, scaleName, degree) {
  const scale = SCALES[scaleName] || SCALES.minor;
  const n = scale.length;
  const octave = Math.floor(degree / n);
  const idx = degree - octave * n;
  return rootMidi + octave * 12 + scale[idx];
}

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Durée d'un pas de grille (double-croche) en secondes. */
export function stepDuration(bpm) {
  return 60 / bpm / 4;
}

/**
 * Temps absolu (en secondes) d'un pas de la grille globale, avec swing.
 * `swing` : 0 = droit, 0.2 = léger shuffle sur les doubles-croches impaires.
 */
export function stepTime(step, bpm, swing = 0) {
  const sd = stepDuration(bpm);
  const t = step * sd;
  return step % 2 === 1 ? t + sd * swing : t;
}

/**
 * Déplie l'arrangement d'un morceau en une liste d'événements bruts,
 * exprimés en pas de double-croche depuis le début du morceau.
 *
 * Retourne { drums: [{step, inst, vel}], notes: [{step, len, midi, part, vel}] }
 *
 * C'est LA source de vérité unique : le rendu audio et la partition jouable
 * sont tous les deux dérivés de cette sortie, donc parfaitement synchronisés.
 */
export function unfold(song) {
  const { root, scale, patterns, arrangement } = song;
  const drums = [];
  const notes = [];
  let bar = 0;

  for (const section of arrangement) {
    const prog = section.prog || [0];
    for (let b = 0; b < section.bars; b++) {
      const chordDeg = prog[b % prog.length];
      const barStep = (bar + b) * 16;

      // --- Percussions : patterns en chaînes de 16 caractères ---
      const drumPat = section.drums ? patterns.drums[section.drums] : null;
      if (drumPat) {
        for (const inst of Object.keys(drumPat)) {
          const rows = Array.isArray(drumPat[inst]) ? drumPat[inst] : [drumPat[inst]];
          const row = rows[b % rows.length];
          for (let s = 0; s < 16; s++) {
            const c = row[s];
            if (!c || c === '.' || c === ' ') continue;
            // 'x' = accent, 'o' = normal, '-' = ghost
            const vel = c === 'x' ? 1 : c === 'o' ? 0.72 : 0.4;
            drums.push({ step: barStep + s, inst, vel });
          }
        }
      }

      // --- Parties mélodiques : [step, degréRelatif, longueurEnPas, vel?] ---
      for (const part of ['bass', 'chord', 'arp', 'lead', 'pluck']) {
        const name = section[part];
        if (!name) continue;
        const raw = patterns[part][name];
        // Un pattern = une liste d'événements ; une liste de patterns = une
        // variation par mesure. On distingue les deux par la profondeur.
        const defs = Array.isArray(raw[0]) && Array.isArray(raw[0][0]) ? raw : [raw];
        const pattern = defs[b % defs.length];
        const octave = (section.oct && section.oct[part] !== undefined)
          ? section.oct[part]
          : (song.oct && song.oct[part]) || 0;
        for (const ev of pattern) {
          const [s, deg, len, vel = 1] = ev;
          if (part === 'chord') {
            // Un accord : triade (parfois + 7e) construite sur le degré courant
            const voicing = section.voicing || [0, 2, 4];
            for (const v of voicing) {
              notes.push({
                step: barStep + s, len, part,
                midi: degToMidi(root, scale, chordDeg + deg + v) + octave * 12,
                vel: vel * 0.9
              });
            }
          } else {
            notes.push({
              step: barStep + s, len, part,
              midi: degToMidi(root, scale, chordDeg + deg) + octave * 12,
              vel
            });
          }
        }
      }
    }
    bar += section.bars;
  }

  drums.sort((a, b) => a.step - b.step);
  notes.sort((a, b) => a.step - b.step);
  return { drums, notes, totalBars: bar };
}
