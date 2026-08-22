// Bots : des adversaires simulés, pour jouer en multijoueur à deux quand on
// est seul — ou pour compléter un salon.
//
// Principe : un bot ne « rejoue » pas une partie enregistrée, il PASSE PAR
// LE VRAI MOTEUR. On lui fabrique un jugement par note (PERFECT, GREAT,
// GOOD, MISS) et on le pousse dans une instance d'Engine ordinaire. Son
// score sort donc de la même formule que celui des humains — fever, combo
// pondéré, normalisation sur 1 000 000 comprise. Rien à maintenir en
// double, et aucun barème parallèle qui dériverait.
//
// Toute la partie est simulée d'un coup au lancement, et le score est
// ensuite LU dans la frise au fil du morceau : c'est plus juste (aucune
// dérive d'horloge) et bien moins cher que de faire tourner dix moteurs
// image par image.

import { Engine } from './engine.js';

export const BOT_MIN = 1;
export const BOT_MAX = 10;

// Noms courts, faciles à distinguer d'un pseudo humain dans la liste.
const NOMS = ['VOLT', 'PIXEL', 'NOVA', 'ZÉRO', 'ECHO', 'RIFT', 'GLITCH', 'AXEL'];
export function botName(i) {
  return NOMS[i % NOMS.length];
}

/** Générateur pseudo-aléatoire déterministe : une graine, une partie. */
function alea(graine) {
  let a = graine >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Taux d'erreur moyen d'un bot sur une chart donnée.
 *
 * Calé sur la consigne : un bot 1 tourne autour de 80 % de précision sur
 * une chart de niveau 5, un bot 10 frôle le sans-faute. Entre les deux,
 * la courbe est concave — les premiers niveaux progressent vite, les
 * derniers se disputent les dixièmes, comme chez les vrais joueurs.
 *
 * `EPS` empêche le bot 10 d'être littéralement parfait : un adversaire
 * strictement imbattable n'a aucun intérêt.
 */
const EPS = 0.012;
export function tauxErreur(niveauBot, niveauChart) {
  const s = adresse(niveauBot);
  const durete = 0.55 + 0.09 * Math.max(1, Math.min(15, niveauChart || 5));
  return Math.min(0.85, (Math.pow(1 - s, 1.4) * 0.44 + EPS) * durete);
}

/** Adresse normalisée du bot, de 0 (niveau 1) à 1 (niveau 10). */
function adresse(niveauBot) {
  return (Math.max(BOT_MIN, Math.min(BOT_MAX, niveauBot)) - 1) / (BOT_MAX - 1);
}

/**
 * Simule une partie complète.
 *
 * Le bot n'est pas régulier : une « forme » lente module son taux d'erreur
 * sur la durée du morceau (deux sinusoïdes déphasées, d'autant plus amples
 * que le bot est faible), et de rares décrochages lui coûtent quelques
 * notes d'affilée. C'est ce qui donne des parties différentes à niveau
 * égal, et des combos qui cassent à des endroits crédibles.
 *
 * @param {Array} notes        notes dépliées (mêmes que celles des humains)
 * @param {number} niveauBot   1 à 10
 * @param {number} niveauChart niveau affiché de la difficulté (1 à 15)
 * @param {number} graine      pour rejouer exactement la même partie
 * @returns {{frise: number[][], result: object}} frise = [temps, score]
 */
export function simuler(notes, niveauBot, niveauChart, graine) {
  const moteur = new Engine(notes);
  const rnd = alea(graine);
  const base = tauxErreur(niveauBot, niveauChart);
  const s = adresse(niveauBot);
  const amplitude = 0.55 * (1 - s) + 0.1;
  const duree = moteur.notes.length ? moteur.notes[moteur.notes.length - 1].time || 1 : 1;
  const p1 = rnd() * 6.283, p2 = rnd() * 6.283;
  const periode1 = duree / (1.5 + rnd() * 2);
  const periode2 = duree / (4 + rnd() * 4);
  // Un décrochage est bien plus coûteux qu'une note ratée : il casse la
  // rampe de fever. Les bons bots n'en font presque jamais.
  const pDecrochage = 0.0015 * (1 - s * 0.92);

  const frise = [];
  let restant = 0;                      // notes encore dans le décrochage
  for (const note of moteur.notes) {
    const t = note.time;
    const forme = 1
      + amplitude * 0.6 * Math.sin((6.283 * t) / periode1 + p1)
      + amplitude * 0.4 * Math.sin((6.283 * t) / periode2 + p2);
    if (!restant && rnd() < pDecrochage) restant = 2 + Math.floor(rnd() * 4);
    const e = Math.min(0.95, base * Math.max(0.15, forme) * (restant ? 4.5 : 1));
    if (restant) restant--;

    // Un bon bot ne rate pas de la même façon qu'un mauvais : ses rares
    // écarts sont des GREAT, qui ne coûtent presque rien, là où un bot
    // faible enchaîne les MISS et casse sa rampe de fever. C'est ce qui
    // fait qu'un bot 10 finit à quelques milliers de points du maximum
    // sans jamais l'atteindre tout à fait.
    const pMiss = e * (0.12 - 0.10 * s);
    const pGood = pMiss + e * (0.30 - 0.24 * s);
    const r = rnd();
    let jugement = 'PERFECT';
    if (r < pMiss) jugement = 'MISS';
    else if (r < pGood) jugement = 'GOOD';
    else if (r < e) jugement = 'GREAT';
    moteur.applySynthetic(note, jugement);
    frise.push([t, moteur.score]);
  }
  return { frise, result: moteur.results() };
}

/** Score du bot à cet instant du morceau (lecture dans la frise). */
export function scoreA(frise, temps) {
  if (!frise.length || temps < frise[0][0]) return 0;
  let lo = 0, hi = frise.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frise[mid][0] <= temps) lo = mid; else hi = mid - 1;
  }
  return frise[lo][1];
}
