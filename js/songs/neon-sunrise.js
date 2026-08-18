// NEON SUNRISE — 100 BPM, La mineur. Synthwave lent, morceau d'initiation.
// Composition originale NEONBEAT, placée en CC0.
export default {
  id: 'neon-sunrise',
  title: 'Neon Sunrise',
  artist: 'NEONBEAT',
  license: 'CC0-1.0',
  bpm: 100,
  root: 57,               // La3
  scale: 'minor',
  swing: 0,
  tier: 1,
  color: '#ff7ab8',
  previewBar: 12,
  mix: { style: 'synthwave', pump: 0.15 },

  patterns: {
    drums: {
      A: {
        kick:  'x.......x.......',
        snare: '....x.......x...',
        hat:   '..o.o.o.o.o.o.o.'
      },
      B: {
        kick:  ['x.......x.......', 'x.......x.....x.'],
        snare: '....x.......x...',
        hat:   'o.o.o.o.o.o.o.o.',
        ohat:  ['..............o.', '................'],
        clap:  '....x.......x...'
      },
      C: {
        kick:  'x...............',
        snare: '............x...',
        hat:   '....o.......o...',
        crash: 'x...............'
      }
    },

    bass: {
      A: [[0, 0, 6], [6, 0, 2], [8, 0, 4], [12, 4, 2], [14, 2, 2]],
      B: [
        [[0, 0, 4], [4, 0, 2], [6, 4, 2], [8, 0, 4], [12, 2, 2], [14, 4, 2]],
        [[0, 0, 4], [4, 0, 2], [6, 4, 2], [8, 0, 6], [14, 6, 2]]
      ]
    },

    chord: {
      A: [[0, 0, 16]],
      B: [[0, 0, 8], [8, 0, 8]],
      C: [[0, 0, 12], [12, 0, 4]]
    },

    arp: {
      A: [
        [[0, 0, 2], [2, 2, 2], [4, 4, 2], [6, 2, 2], [8, 0, 2], [10, 2, 2], [12, 4, 2], [14, 7, 2]],
        [[0, 7, 2], [2, 4, 2], [4, 2, 2], [6, 4, 2], [8, 0, 2], [10, 2, 2], [12, 4, 2], [14, 2, 2]]
      ]
    },

    lead: {
      // Le refrain : phrase de 4 mesures, la mémoire mélodique du morceau.
      A: [
        [[0, 4, 3], [4, 2, 3], [8, 0, 5], [14, 2, 2]],
        [[0, 4, 3], [4, 5, 3], [8, 4, 5], [13, 2, 3]],
        [[0, 2, 2], [2, 4, 2], [6, 5, 2], [8, 7, 5], [14, 4, 2]],
        [[0, 4, 6], [8, 2, 2], [10, 0, 6]]
      ],
      // Contre-chant, plus aéré.
      B: [
        [[0, 7, 4], [8, 4, 4]],
        [[0, 5, 4], [8, 2, 6]],
        [[0, 4, 4], [6, 2, 2], [8, 0, 4], [12, 2, 4]],
        [[0, 0, 12]]
      ],
      // Pont : montée en tension.
      C: [
        [[0, 0, 2], [4, 2, 2], [8, 4, 2], [12, 5, 2]],
        [[0, 7, 2], [4, 5, 2], [8, 4, 2], [12, 2, 2]],
        [[0, 4, 2], [2, 5, 2], [4, 7, 2], [6, 9, 2], [8, 7, 4], [12, 4, 4]],
        [[0, 5, 2], [2, 4, 2], [4, 2, 2], [6, 0, 2], [8, 2, 8]]
      ]
    }
  },

  oct: { bass: -2, chord: 0, arp: 1, lead: 1 },

  arrangement: [
    { bars: 4,  prog: [0, 0, 5, 5],    chord: 'A', arp: 'A', drums: 'C' },
    { bars: 8,  prog: [0, 5, 3, 4],    chord: 'A', arp: 'A', bass: 'A', drums: 'A' },
    { bars: 8,  prog: [0, 5, 3, 4],    chord: 'B', bass: 'B', drums: 'B', lead: 'A' },
    { bars: 8,  prog: [0, 5, 3, 4],    chord: 'A', arp: 'A', bass: 'A', drums: 'A', lead: 'B' },
    { bars: 4,  prog: [5, 5, 4, 4],    chord: 'C', bass: 'A', drums: 'C', lead: 'C' },
    { bars: 12, prog: [0, 5, 3, 4],    chord: 'B', bass: 'B', drums: 'B', lead: 'A', arp: 'A' },
    { bars: 4,  prog: [0, 0, 5, 0],    chord: 'A', arp: 'A', drums: 'C' }
  ]
};
