// Incrémente la version de 0.01 partout où elle vit :
//   js/version.js · version.json · sw.js (nom du cache)
// Usage : node tools/bump-version.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vPath = join(root, 'js/version.js');
const cur = readFileSync(vPath, 'utf8').match(/APP_VERSION = '([\d.]+)'/)[1];
const next = (Math.round(parseFloat(cur) * 100) + 1) / 100;
const nextStr = next.toFixed(2);

writeFileSync(vPath, readFileSync(vPath, 'utf8').replace(`'${cur}'`, `'${nextStr}'`));
writeFileSync(join(root, 'version.json'), `{ "version": "${nextStr}" }\n`);
const swPath = join(root, 'sw.js');
writeFileSync(swPath, readFileSync(swPath, 'utf8').replace(/const VERSION = 'neonbeat-[^']+';/, `const VERSION = 'neonbeat-${nextStr}';`));
console.log(`version ${cur} → ${nextStr}`);
