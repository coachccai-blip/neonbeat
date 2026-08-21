// Incrémente la version de 0.01 partout où elle vit :
//   js/version.js · version.json · sw.js (nom du cache)
// version.json embarque aussi la liste des fichiers de l'application : le
// bouton « mettre à jour » s'en sert pour forcer leur rafraîchissement en
// contournant le cache HTTP de GitHub Pages (max-age de 10 minutes).
// Usage : node tools/bump-version.mjs
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vPath = join(root, 'js/version.js');
const cur = readFileSync(vPath, 'utf8').match(/APP_VERSION = '([\d.]+)'/)[1];
const next = (Math.round(parseFloat(cur) * 100) + 1) / 100;
const nextStr = next.toFixed(2);

const appFiles = [
  './', './index.html', './css/style.css', './manifest.webmanifest', './sw.js',
  './tracks/index.json',
  ...readdirSync(join(root, 'js')).filter((f) => f.endsWith('.js')).map((f) => `./js/${f}`),
  ...readdirSync(join(root, 'js/songs')).filter((f) => f.endsWith('.js')).map((f) => `./js/songs/${f}`),
  ...readdirSync(join(root, 'vendor')).filter((f) => f.endsWith('.js')).map((f) => `./vendor/${f}`)
];

writeFileSync(vPath, readFileSync(vPath, 'utf8').replace(`'${cur}'`, `'${nextStr}'`));
writeFileSync(join(root, 'version.json'),
  JSON.stringify({ version: nextStr, files: appFiles }, null, 1) + '\n');
const swPath = join(root, 'sw.js');
writeFileSync(swPath, readFileSync(swPath, 'utf8').replace(/const VERSION = 'neonbeat-[^']+';/, `const VERSION = 'neonbeat-${nextStr}';`));
console.log(`version ${cur} → ${nextStr}`);
