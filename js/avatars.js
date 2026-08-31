// Avatars : l'image qui précède le pseudo dans les classements.
//
// Quatre sont offerts d'emblée (deux filles, deux garçons) ; les seize autres
// se méritent — ils sont adossés aux trophées les plus exigeants du jeu, de
// façon qu'un avatar rare en soit vraiment un.
//
// `unlock` désigne le trophée qui le débloque (voir trophies.js) ; null =
// disponible dès la première partie.
//
// L'identifiant est aussi le nom du fichier : la vignette 128 px vit dans
// assets/avatars/, l'original dans assets/avatars/source/ (jamais servi au
// navigateur — 2,4 Mo pour une pastille de 28 px n'aurait aucun sens).

export const AVATARS = [
  { id: 'nb_avatar01', unlock: null },
  { id: 'nb_avatar02', unlock: null },
  { id: 'nb_avatar03', unlock: null },
  { id: 'nb_avatar05', unlock: null },
  { id: 'nb_avatar04', unlock: 'fever15' },
  { id: 'nb_avatar06', unlock: 'notes100k' },
  { id: 'nb_avatar07', unlock: 'splusnorm30' },
  { id: 'nb_avatar08', unlock: 'ss10' },
  { id: 'nb_avatar09', unlock: 'ss25' },
  { id: 'nb_avatar10', unlock: 'combo10k' },
  { id: 'nb_avatar11', unlock: 'styx' },
  { id: 'nb_avatar12', unlock: 'olympe' },
  { id: 'nb_avatar13', unlock: 'ivresse' },
  { id: 'nb_avatar14', unlock: 'floraison' },
  { id: 'nb_avatar15', unlock: 'fauxmortel' },
  { id: 'nb_avatar16', unlock: 'vengeance' },
  { id: 'nb_avatar17', unlock: 'vague' },
  { id: 'nb_avatar18', unlock: 'eveil' },
  { id: 'nb_avatar19', unlock: 'evasion' },
  { id: 'nb_avatar20', unlock: 'gardien' }
];

export const DEFAULT_AVATAR = AVATARS[0];

/**
 * Avatar connu portant cet identifiant, ou null.
 *
 * Sert aussi de FILTRE de sécurité : les identifiants qui remontent du
 * classement viennent d'autres appareils, et rien ne garantit qu'ils soient
 * sensés. Passer par ici évite de bâtir une URL d'image à partir d'une
 * chaîne arbitraire.
 */
export function avatarById(id) {
  return AVATARS.find((a) => a.id === id) || null;
}

/** Chemin de la vignette, ou null si l'identifiant est inconnu. */
export function avatarFile(id) {
  return avatarById(id) ? `./assets/avatars/${id}.webp` : null;
}

/**
 * Grand format, pour le personnage de l'écran d'accueil : deux tailles,
 * que le navigateur choisit selon la densité de l'écran. La vignette de
 * 128 px y serait affichée à plus du double de sa taille ; 420 px suffisent
 * à un écran classique, 720 à un écran dense.
 */
export function avatarLarge(id) {
  if (!avatarById(id)) return null;
  return {
    src: `./assets/avatars/${id}-420.webp`,
    srcset: `./assets/avatars/${id}-420.webp 420w, ./assets/avatars/${id}-720.webp 720w`
  };
}
