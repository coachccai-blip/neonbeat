// Effets optionnels façon DJ Max : chacun multiplie le score final.
// Le grade, lui, reste basé sur la précision pure (le SS exige 100 %).

export const MODS = [
  { id: 'MIRROR',    name: 'MIROIR',    desc: 'couloirs inversés',            mult: 1.05 },
  { id: 'FADE',      name: 'FADE',      desc: 'les notes s’effacent avant la ligne', mult: 1.15 },
  { id: 'SUDDEN',    name: 'SUDDEN',    desc: 'les notes apparaissent tard',  mult: 1.15 },
  { id: 'NIGHTCORE', name: 'NIGHTCORE', desc: 'musique accélérée ×1,25', mult: 1.25 }
];

export function multiplierFor(ids) {
  let m = 1;
  for (const id of ids || []) {
    const mod = MODS.find((x) => x.id === id);
    if (mod) m *= mod.mult;
  }
  return Math.round(m * 1000) / 1000;
}

/** Libellé compact pour les leaderboards : « NC·FD » ou « — ». */
export function modsLabel(ids) {
  if (!ids || !ids.length) return '—';
  return ids.map((id) => ({ MIRROR: 'MI', FADE: 'FD', SUDDEN: 'SU', NIGHTCORE: 'NC' }[id] || id)).join('·');
}
