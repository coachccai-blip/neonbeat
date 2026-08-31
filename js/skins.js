// Habillages de la zone de jeu.
//
// Tout est PROCÉDURAL : un skin ne décrit que des couleurs et un style de
// note, et le moteur de rendu recuit ses sprites à partir de ça. Aucun
// fichier image n'est nécessaire — un skin coûte une dizaine de lignes.
//
// `unlock` désigne le trophée qui le débloque (voir trophies.js) ; null =
// disponible d'emblée.

export const SKINS = [
  {
    id: 'neon',
    unlock: null,
    lanes4: ['#2fd8ff', '#7a5cff', '#ff4bd8', '#ffb020'],
    lanes2: ['#2fd8ff', '#ff4bd8'],
    note: 'gloss',
    line: '#dfe4ff',
    glow: 1
  },
  {
    id: 'prisme',
    unlock: 'combo250',
    lanes4: ['#ff4d6d', '#ffb020', '#5cff9d', '#4b8bff'],
    lanes2: ['#ff4d6d', '#4b8bff'],
    note: 'gloss',
    line: '#ffffff',
    glow: 1.25
  },
  {
    id: 'or',
    unlock: 'ss5',
    lanes4: ['#ffd76a', '#ffab3d', '#fff0b8', '#e08a20'],
    lanes2: ['#ffd76a', '#e08a20'],
    note: 'chrome',
    line: '#fff3cc',
    glow: 1.35
  },
  {
    id: 'retro',
    unlock: 'fc10',
    lanes4: ['#4dff88', '#c8ff4d', '#4dffd2', '#ffe14d'],
    lanes2: ['#4dff88', '#ffe14d'],
    note: 'outline',
    line: '#8dff9f',
    glow: 0.8
  },
  {
    id: 'glace',
    unlock: 'ap1',
    lanes4: ['#bff0ff', '#7fd4ff', '#e8fbff', '#5ab4ff'],
    lanes2: ['#bff0ff', '#5ab4ff'],
    note: 'gloss',
    line: '#eafaff',
    glow: 1.15
  },
  {
    id: 'magma',
    unlock: 'hardfc',
    lanes4: ['#ff7a1a', '#ff3b30', '#ffc247', '#ff5470'],
    lanes2: ['#ff7a1a', '#ff3b30'],
    note: 'gloss',
    line: '#ffd2a8',
    glow: 1.3
  },
  {
    id: 'minimal',
    unlock: 'tracks25',
    lanes4: ['#f2f4ff', '#c3c8e6', '#9aa0c4', '#e2e6f7'],
    lanes2: ['#f2f4ff', '#9aa0c4'],
    note: 'flat',
    line: '#ffffff',
    glow: 0.55
  },
  {
    id: 'brasier',
    unlock: 'fever8',
    lanes4: ['#ffdd55', '#ff8a1f', '#ff4d17', '#ffb347'],
    lanes2: ['#ffdd55', '#ff4d17'],
    note: 'chrome',
    line: '#ffe6b0',
    glow: 1.4
  },
  {
    id: 'nova',
    unlock: 'fever12',
    lanes4: ['#ffffff', '#9df0ff', '#ff9ae8', '#c9b6ff'],
    lanes2: ['#ffffff', '#ff9ae8'],
    note: 'outline',
    line: '#ffffff',
    glow: 1.6
  },
  {
    id: 'void',
    unlock: 'ss15',
    lanes4: ['#b06bff', '#6b3dff', '#e07aff', '#4a2bd0'],
    lanes2: ['#b06bff', '#4a2bd0'],
    note: 'outline',
    line: '#d9b6ff',
    glow: 1.45
  },

  // v1.56 : quatre habillages du panthéon, adossés aux défis de Perséphone,
  // Poséidon, Némésis et Cerbère — ces défis offrent donc l'avatar ET le skin.
  {
    id: 'floral',                    // Perséphone : le printemps qui remonte
    unlock: 'floraison',
    lanes4: ['#ff8ac2', '#7be37c', '#ffe9f2', '#ff4b96'],
    lanes2: ['#ff8ac2', '#ff4b96'],
    note: 'gloss',
    line: '#ffd8ea',
    glow: 1.2
  },
  {
    id: 'abysse',                    // Poséidon : la fosse océane
    unlock: 'vague',
    lanes4: ['#39e6c8', '#1f8fff', '#a8f4ff', '#155bd6'],
    lanes2: ['#39e6c8', '#155bd6'],
    note: 'chrome',
    line: '#c9f3ff',
    glow: 1.3
  },
  {
    id: 'lame',                      // Némésis : l'acier et le sang
    unlock: 'vengeance',
    lanes4: ['#e6ecf5', '#ff2d55', '#98a4bd', '#c21237'],
    lanes2: ['#e6ecf5', '#ff2d55'],
    note: 'outline',
    line: '#ffccd5',
    glow: 1.2
  },
  {
    id: 'enfers',                    // Cerbère : braises et ombre violette
    unlock: 'gardien',
    lanes4: ['#ff6a3d', '#d92638', '#ffb35c', '#9a3dff'],
    lanes2: ['#ff6a3d', '#9a3dff'],
    note: 'gloss',
    line: '#ffb8a0',
    glow: 1.35
  }
];

export const DEFAULT_SKIN = SKINS[0];

export function skinById(id) {
  return SKINS.find((s) => s.id === id) || DEFAULT_SKIN;
}

/** Couleurs de couloirs du skin, pour le mode de touches demandé. */
/** Moyenne de deux couleurs hex — sert aux couloirs médians du 6 keys. */
function mixHex(a, b) {
  const va = parseInt(a.slice(1), 16), vb = parseInt(b.slice(1), 16);
  const c = (sh) => Math.round((((va >> sh) & 255) + ((vb >> sh) & 255)) / 2);
  return '#' + ((c(16) << 16) | (c(8) << 8) | c(0)).toString(16).padStart(6, '0');
}

export function laneColors(skin, lanes) {
  if (lanes === 2) return skin.lanes2;
  if (lanes === 6) {
    // Six teintes déduites des quatre : les couloirs médians prennent un
    // mélange de leurs voisins. Chaque skin reste cohérent sans qu'on ait à
    // écrire dix palettes de plus, et la géographie 4K se retrouve (les
    // extrêmes gardent leur couleur).
    const [c0, c1, c2, c3] = skin.lanes4;
    return [c0, mixHex(c0, c1), c1, c2, mixHex(c2, c3), c3];
  }
  return skin.lanes4;
}
