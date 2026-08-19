// Génère tracks/*.json et tracks/index.json à partir des partitions musicales
// de js/songs/. À relancer après toute modification d'un morceau :
//     node tools/build-charts.mjs
import { writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SONGS } from '../js/songs/index.js';
import { buildTrack } from '../js/chartgen.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'tracks');
mkdirSync(out, { recursive: true });

// Les 5 compositions synthétisées ont été retirées du jeu (le moteur de
// synthèse reste dans js/ si on veut les réactiver un jour).
const INCLUDE_SYNTH = false;

const index = [];
for (const song of INCLUDE_SYNTH ? SONGS : []) {
  const track = buildTrack(song);
  writeFileSync(join(out, `${track.id}.json`), JSON.stringify(track) + '\n');
  index.push({
    id: track.id,
    title: track.title,
    artist: track.artist,
    bpm: track.bpm,
    duration: track.duration,
    color: track.color,
    tier: track.tier,
    levels: track.difficulties.map((d) => ({ name: d.name, level: d.level }))
  });

  const line = track.difficulties
    .map((d) => `${d.name} lvl${String(d.level).padStart(2)} ${String(d.notes.length).padStart(4)} notes  ${(d.notes.length / track.duration).toFixed(2)} n/s`)
    .join('   |   ');
  console.log(`${track.id.padEnd(15)} ${String(track.bpm).padStart(3)}bpm ${track.duration.toFixed(1)}s   ${line}`);
}

// Pistes audio importées (tools/import-audio.mjs) : ajoutées à la suite,
// classées par tier croissant.
const synthIds = new Set(index.map((t) => t.id));
const imported = [];
for (const f of readdirSync(out)) {
  if (!f.endsWith('.json') || f === 'index.json') continue;
  const track = JSON.parse(readFileSync(join(out, f)));
  if (synthIds.has(track.id) || !track.audio) continue;
  imported.push({
    id: track.id,
    title: track.title,
    artist: track.artist,
    bpm: track.bpm,
    duration: track.duration,
    color: track.color,
    tier: track.tier,
    levels: track.difficulties.map((d) => ({ name: d.name, level: d.level }))
  });
  console.log(`+ piste importée : ${track.id} (${track.bpm} BPM, tier ${track.tier})`);
}
imported.sort((a, b) => a.tier - b.tier || a.bpm - b.bpm);
index.push(...imported);

writeFileSync(join(out, 'index.json'), JSON.stringify({ tracks: index }, null, 2) + '\n');
console.log(`\n→ ${index.length} morceaux écrits dans tracks/`);
