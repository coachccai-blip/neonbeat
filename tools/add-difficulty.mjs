// Ajoute (ou régénère) UNE difficulté sur des morceaux déjà importés, sans
// toucher au reste du fichier.
//
//   node tools/add-difficulty.mjs "HARD+"            → tout le catalogue
//   node tools/add-difficulty.mjs "HARD+" guerrier   → un seul morceau
//   node tools/add-difficulty.mjs "HARD+" --verify   → ne rien écrire, vérifier
//
// Pourquoi un outil dédié plutôt que relancer import-audio ? Parce que
// l'import écrase les métadonnées travaillées à la main (titre, artiste,
// couleur, tier, point de préversion) par ses valeurs par défaut. Ici on
// réanalyse l'audio, on ne génère QUE la difficulté demandée, et on l'insère
// dans le JSON existant en laissant tout le reste intact.
//
// Le mode --verify régénère AUSSI les difficultés déjà présentes et les
// compare à celles du fichier : c'est la preuve que l'analyse est
// reproductible et qu'ajouter une difficulté n'altère pas les charts
// existantes — donc qu'aucun score déjà réalisé ne devient incohérent.
//
// Nécessite Playwright + Chromium (comme import-audio) ; le jeu n'en dépend pas.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, chooseBpm, buildCandidates, place, DIFFS } from './import-audio.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tracksDir = join(root, 'tracks');

const args = process.argv.slice(2);
const verify = args.includes('--verify');
const cible = args.filter((a) => !a.startsWith('--'));
const diffName = cible[0];
const seulement = cible.slice(1);
if (!diffName) {
  console.error('usage: node tools/add-difficulty.mjs "<DIFFICULTÉ>" [id…] [--verify]');
  process.exit(1);
}
const profil = DIFFS.find((d) => d.name === diffName);
if (!profil) {
  console.error(`difficulté inconnue : ${diffName} (connues : ${DIFFS.map((d) => d.name).join(', ')})`);
  process.exit(1);
}

/** Une seule difficulté, avec exactement la logique de génération de l'import. */
function genererUne(analysis, bpm, phase, tier, diff) {
  const cands = buildCandidates(analysis, bpm, phase);
  const stepDur = 60 / bpm / 4;
  const duration = analysis.duration;
  const target = Math.round(diff.nps(tier) * duration);
  let lo = 0, hi = 1, best = null;
  for (let it = 0; it < 22; it++) {
    const mid = (lo + hi) / 2;
    const placed = place(cands, diff, mid, stepDur, duration);
    if (!best || Math.abs(placed.length - target) < Math.abs(best.length - target)) best = placed;
    if (placed.length > target) hi = mid; else lo = mid;
  }
  best.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const nps = best.length / duration;
  return { name: diff.name, level: Math.max(1, Math.min(15, Math.round(nps * 1.55 + tier * 0.45))), notes: best };
}

/** Le morceau garde l'ordre des difficultés du profil de référence. */
function ranger(difficultes) {
  const rang = (n) => { const i = DIFFS.findIndex((d) => d.name === n); return i < 0 ? 99 : i; };
  return [...difficultes].sort((a, b) => rang(a.name) - rang(b.name));
}

const fichiers = readdirSync(tracksDir)
  .filter((f) => f.endsWith('.json') && f !== 'index.json')
  .filter((f) => !seulement.length || seulement.includes(f.replace('.json', '')));

let ecrits = 0, ecarts = 0;
for (const f of fichiers) {
  const chemin = join(tracksDir, f);
  const track = JSON.parse(readFileSync(chemin, 'utf8'));
  if (!track.audio) { console.log(`— ${track.id} : pas d'audio, ignoré`); continue; }

  const analysis = await analyze(join(root, track.audio));
  // Le BPM et le tier du fichier font foi : ils ont pu être corrigés à la main.
  const bpm = chooseBpm(analysis.bpmCandidates, track.bpm);
  const phaseKey = Object.keys(analysis.phaseFor).map(Number).reduce((a, b) =>
    Math.abs(b - bpm) < Math.abs(a - bpm) ? b : a, Number(Object.keys(analysis.phaseFor)[0]));
  const phase = Math.abs(phaseKey - bpm) < 1 ? analysis.phaseFor[phaseKey] : 0;
  const tier = track.tier;

  if (verify) {
    // Régénérer TOUTES les difficultés déjà présentes et les comparer.
    let ok = 0, ko = [];
    for (const d of track.difficulties) {
      const p = DIFFS.find((x) => x.name === d.name);
      if (!p) continue;
      const re = genererUne(analysis, bpm, phase, tier, p);
      const pareil = JSON.stringify(re.notes) === JSON.stringify(d.notes) && re.level === d.level;
      if (pareil) ok++; else ko.push(`${d.name} (${d.notes.length}→${re.notes.length} notes, lvl ${d.level}→${re.level})`);
    }
    if (ko.length) { ecarts++; console.log(`✗ ${track.id} : ${ko.join(', ')}`); }
    else console.log(`✓ ${track.id} : ${ok} difficultés régénérées à l'identique`);
    continue;
  }

  const gen = genererUne(analysis, bpm, phase, tier, profil);
  const autres = track.difficulties.filter((d) => d.name !== diffName);
  track.difficulties = ranger([...autres, gen]);
  writeFileSync(chemin, JSON.stringify(track) + '\n');
  ecrits++;
  console.log(`${track.id.padEnd(20)} ${diffName} lvl${String(gen.level).padStart(2)} ${String(gen.notes.length).padStart(4)} notes  ${(gen.notes.length / analysis.duration).toFixed(2)} n/s`);
}

if (verify) {
  console.log(ecarts ? `\n${ecarts} morceau(x) avec un écart` : `\n${fichiers.length} morceaux : régénération identique, l'analyse est reproductible`);
  process.exit(ecarts ? 1 : 0);
}
console.log(`\n${ecrits} morceaux mis à jour ; relancer "node tools/build-charts.mjs" pour l'index.`);
