// Import d'un fichier audio : analyse du signal et génération des charts.
//
// Outil de développement (nécessite Playwright + Chromium pour décoder le MP3
// et analyser le spectre) — le jeu lui-même n'en dépend pas.
//
//   node tools/import-audio.mjs <fichier.mp3> <id> "<Titre>" [--artist "..."]
//                               [--bpm 128] [--tier 3] [--color "#22e0c8"]
//
// Produit : tracks/<id>.mp3, tracks/<id>.json, et met à jour tracks/index.json.

import { readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = require(join(root, 'node_modules/playwright/index.js'));

/* ─── Arguments ─── */
const [, , srcPath, id, title, ...rest] = process.argv;
if (!srcPath || !id || !title) {
  console.error('usage: node tools/import-audio.mjs <fichier> <id> "<Titre>" [--artist ...] [--bpm N] [--tier N] [--color #hex]');
  process.exit(1);
}
const opt = {};
for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace('--', '')] = rest[i + 1];

/* ─── 1. Analyse dans Chromium (décodage + STFT + onsets) ─── */

const CHROME = process.env.CHROME_BIN || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

async function analyze(path) {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  const b64 = readFileSync(path).toString('base64');
  const result = await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ctx = new OfflineAudioContext(1, 44100, 44100);
    const buf = await ctx.decodeAudioData(bytes.buffer);
    const sr = buf.sampleRate;
    const mono = buf.getChannelData(0);

    /* STFT */
    const N = 2048, HOP = 512;
    const frames = Math.floor((mono.length - N) / HOP);
    const frameRate = sr / HOP;
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    function fft(re, im) {
      const n = re.length;
      for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
      }
      for (let len = 2; len <= n; len <<= 1) {
        const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
          let cr = 1, ci = 0;
          for (let k = 0; k < len / 2; k++) {
            const ur = re[i + k], ui = im[i + k];
            const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
            const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
            re[i + k] = ur + vr; im[i + k] = ui + vi;
            re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
            const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
          }
        }
      }
    }

    const binOf = (f) => Math.max(1, Math.min(N / 2 - 1, Math.round(f * N / sr)));
    const BANDS = { low: [binOf(25), binOf(160)], mid: [binOf(160), binOf(2200)], high: [binOf(4500), binOf(15000)] };

    const flux = { low: new Float32Array(frames), mid: new Float32Array(frames), high: new Float32Array(frames), full: new Float32Array(frames) };
    const centroid = new Float32Array(frames);
    const energy = new Float32Array(frames);
    let prev = null;
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let f = 0; f < frames; f++) {
      im.fill(0);
      const off = f * HOP;
      for (let i = 0; i < N; i++) re[i] = mono[off + i] * win[i];
      fft(re, im);
      const mag = new Float32Array(N / 2);
      let esum = 0;
      for (let k = 1; k < N / 2; k++) {
        mag[k] = Math.log1p(Math.hypot(re[k], im[k]));
        esum += mag[k];
      }
      energy[f] = esum;
      if (prev) {
        for (const b of ['low', 'mid', 'high']) {
          const [a, z] = BANDS[b];
          let s = 0;
          for (let k = a; k < z; k++) { const d = mag[k] - prev[k]; if (d > 0) s += d; }
          flux[b][f] = s;
        }
        let s = 0;
        for (let k = 1; k < N / 2; k++) { const d = mag[k] - prev[k]; if (d > 0) s += d; }
        flux.full[f] = s;
      }
      // centroïde spectral des médiums : sert à placer la mélodie sur les couloirs
      let cw = 0, cs = 0;
      for (let k = BANDS.mid[0]; k < BANDS.mid[1]; k++) { cw += mag[k] * k; cs += mag[k]; }
      centroid[f] = cs > 0 ? (cw / cs) * sr / N : 0;
      prev = mag;
    }

    /* Détection de pics par bande, seuil adaptatif */
    function pick(x, minSepS, sensitivity) {
      const out = [];
      const w = Math.round(frameRate * 0.5);
      const minSep = minSepS * frameRate;
      let last = -1e9;
      for (let f = 2; f < frames - 2; f++) {
        if (x[f] < x[f - 1] || x[f] <= x[f + 1] || x[f] < x[f - 2] || x[f] <= x[f + 2]) continue;
        let mean = 0, cnt = 0;
        for (let k = Math.max(0, f - w); k < Math.min(frames, f + w); k++) { mean += x[k]; cnt++; }
        mean /= cnt;
        let dev = 0;
        for (let k = Math.max(0, f - w); k < Math.min(frames, f + w); k++) dev += (x[k] - mean) ** 2;
        dev = Math.sqrt(dev / cnt);
        if (x[f] < mean + sensitivity * dev) continue;
        if (f - last < minSep) continue;
        last = f;
        out.push({ t: f / frameRate, s: dev > 0 ? (x[f] - mean) / dev : 1, c: centroid[f] });
      }
      return out;
    }

    const onsets = {
      low: pick(flux.low, 0.10, 1.1),
      mid: pick(flux.mid, 0.09, 1.0),
      high: pick(flux.high, 0.06, 1.2)
    };

    /* BPM : autocorrélation du flux global (lags 60 → 220 BPM) */
    const o = flux.full;
    const mean = o.reduce((a, b) => a + b, 0) / o.length;
    const d = Float32Array.from(o, (v) => v - mean);
    const cand = [];
    for (let bpm = 60; bpm <= 220; bpm += 0.25) {
      const lag = Math.round(60 / bpm * frameRate);
      let s = 0;
      // peigne sur 4 harmoniques du battement : robuste aux contretemps
      for (let h = 1; h <= 4; h++) {
        const L = lag * h;
        let c = 0;
        for (let f = 0; f < frames - L; f++) c += d[f] * d[f + L];
        s += c / (frames - L) / h;
      }
      cand.push({ bpm, s });
    }
    cand.sort((a, b) => b.s - a.s);
    const top = cand.slice(0, 12).map((c) => ({ bpm: Math.round(c.bpm * 4) / 4, s: Math.round(c.s * 1000) / 1000 }));

    /* Phase de grille pour un BPM donné : décalage qui capte le plus de flux */
    function bestPhase(bpm) {
      const beat = 60 / bpm;
      const steps = 64;
      let best = 0, bestS = -1;
      for (let k = 0; k < steps; k++) {
        const phase = (k / steps) * beat;
        let s = 0;
        for (let t = phase; t < frames / frameRate; t += beat) {
          const f = Math.round(t * frameRate);
          if (f < frames) s += o[f] + (o[f - 1] || 0) + (o[f + 1] || 0);
        }
        if (s > bestS) { bestS = s; best = phase; }
      }
      return best;
    }

    /* enveloppe d'énergie 4 Hz pour choisir le point de préversion */
    const envRate = 4;
    const env = [];
    const per = Math.round(frameRate / envRate);
    for (let f = 0; f + per < frames; f += per) {
      let s = 0;
      for (let k = f; k < f + per; k++) s += energy[k];
      env.push(Math.round(s / per));
    }

    return {
      duration: buf.duration,
      frameRate,
      bpmCandidates: top,
      bestPhase: null,        // calculée côté Node après choix du BPM
      phaseFor: Object.fromEntries(top.slice(0, 5).map((c) => [c.bpm, bestPhase(c.bpm)])),
      onsets,
      energyEnv: env
    };
  }, b64);
  await browser.close();
  return result;
}

/* ─── 2. Choix du BPM ─── */

function chooseBpm(cands, forced) {
  if (forced) return parseFloat(forced);
  // Le meilleur candidat de l'autocorrélation est généralement le tempo perçu
  // ou son double. On le garde tel quel s'il est dans une plage jouable ;
  // sinon on le ramène par octaves. (Ne PAS additionner les moitiés de
  // candidats voisins : leurs arrondis s'agglutinent et gagnent à tort.)
  let bpm = cands[0].bpm;
  while (bpm > 185) bpm /= 2;
  while (bpm < 85) bpm *= 2;
  return Math.round(bpm * 4) / 4;
}

/* ─── 3. Génération des charts à partir des onsets ─── */

const LANES = 4;
function makeRng(seed) {
  let s = seed >>> 0 || 7;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const DIFFS = [
  { name: 'EASY',   grid: 2, minGap: 0.26, maxChord: 1, nps: (t) => 0.70 + 0.26 * t },
  { name: 'NORMAL', grid: 1, minGap: 0.14, maxChord: 2, nps: (t) => (0.70 + 0.26 * t) * 2.05 },
  { name: 'HARD',   grid: 1, minGap: 0.085, maxChord: 3, nps: (t) => (0.70 + 0.26 * t) * 3.30 }
];

function buildCandidates(analysis, bpm, phase) {
  const stepDur = 60 / bpm / 4;
  const rng = makeRng(1234567);
  const cands = [];

  // centroïdes des onsets mid : percentiles → couloir (grave à gauche)
  const mids = analysis.onsets.mid.map((o) => o.c).sort((a, b) => a - b);
  const laneOfCentroid = (c) => {
    if (!mids.length) return 1;
    let lo = 0, hi = mids.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (mids[m] < c) lo = m + 1; else hi = m; }
    return Math.min(LANES - 1, Math.floor((lo / mids.length) * LANES));
  };

  const PRIO = { mid: 10, low: 7, high: 4.5 };
  for (const band of ['low', 'mid', 'high']) {
    for (const o of analysis.onsets[band]) {
      // Quantification sur la grille de doubles-croches. Un onset trop loin de
      // la grille (> 60 ms) est gardé tel quel : mieux vaut suivre la musique
      // que forcer une grille fausse.
      const raw = o.t - phase;
      const step = Math.round(raw / stepDur);
      const snapped = step * stepDur + phase;
      const offGrid = Math.abs(snapped - o.t);
      const t = offGrid <= 0.06 ? snapped : o.t;
      const beatBonus = offGrid <= 0.06 ? (step % 16 === 0 ? 2.2 : step % 4 === 0 ? 1.4 : step % 2 === 0 ? 0.6 : 0) : 0;
      cands.push({
        t: Math.round(t * 1000) / 1000,
        step: offGrid <= 0.06 ? step : Math.round(raw / stepDur),
        band,
        lane: band === 'mid' ? laneOfCentroid(o.c) : null,
        score: (PRIO[band] || 3) + Math.min(3, o.s) * 0.9 + beatBonus + rng() * 1.2
      });
    }
  }
  cands.sort((a, b) => a.t - b.t || b.score - a.score);

  // rang local par fenêtre de 2 mesures (anti-déluge / anti-désert)
  const winDur = stepDur * 32;
  const byWin = new Map();
  for (const c of cands) {
    const w = Math.floor(c.t / winDur);
    if (!byWin.has(w)) byWin.set(w, []);
    byWin.get(w).push(c);
  }
  for (const g of byWin.values()) {
    g.sort((a, b) => b.score - a.score);
    g.forEach((c, i) => { c.rank = (i + 0.5) / g.length; });
  }
  return cands;
}

function place(cands, diff, threshold, stepDur) {
  const laneFree = new Array(LANES).fill(-1e9);
  const out = [];
  let lastT = -1e9, lastLane = -1;
  const toggle = { low: 0, high: 0 };
  const LANE_PREF = { low: [0, 3], high: [3, 0] };

  let i = 0;
  while (i < cands.length) {
    const t = cands[i].t;
    let j = i;
    while (j < cands.length && cands[j].t === t) j++;
    const group = cands.slice(i, j).filter((c) => c.rank <= threshold);
    i = j;
    if (!group.length) continue;
    if (group[0].step % diff.grid !== 0) continue;
    if (t - lastT < diff.minGap - 1e-6) continue;

    let chord = 0, any = false;
    for (const c of group) {
      if (chord >= diff.maxChord) break;
      let want;
      if (c.lane !== null) {
        want = c.lane;
        if (want === lastLane && t - lastT <= 0.19) want = want === LANES - 1 ? want - 1 : want + 1;
      } else {
        const pref = LANE_PREF[c.band];
        want = pref[(toggle[c.band] = (toggle[c.band] || 0) + 1) % 2];
      }
      let lane = -1;
      if (laneFree[want] <= t) lane = want;
      else {
        for (let d = 1; d < LANES && lane < 0; d++) {
          for (const l of [want - d, want + d]) {
            if (l >= 0 && l < LANES && laneFree[l] <= t) { lane = l; break; }
          }
        }
      }
      if (lane < 0) continue;
      laneFree[lane] = t + 0.01;
      out.push([lane, t, 0]);
      chord++;
      any = true;
      lastLane = lane;
    }
    if (any) lastT = t;
  }
  return out;
}

function generate(analysis, bpm, phase, tier) {
  const cands = buildCandidates(analysis, bpm, phase);
  const stepDur = 60 / bpm / 4;
  const duration = analysis.duration;
  return DIFFS.map((diff) => {
    const target = Math.round(diff.nps(tier) * duration);
    let lo = 0, hi = 1, best = null;
    for (let it = 0; it < 22; it++) {
      const mid = (lo + hi) / 2;
      const placed = place(cands, diff, mid, stepDur);
      if (!best || Math.abs(placed.length - target) < Math.abs(best.length - target)) best = placed;
      if (placed.length > target) hi = mid; else lo = mid;
    }
    best.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const nps = best.length / duration;
    return { name: diff.name, level: Math.max(1, Math.min(15, Math.round(nps * 1.55 + tier * 0.45))), notes: best };
  });
}

/* ─── 4. Exécution ─── */

console.log(`analyse de ${srcPath}…`);
const analysis = await analyze(srcPath);
const bpm = chooseBpm(analysis.bpmCandidates, opt.bpm);
const phaseKey = Object.keys(analysis.phaseFor).map(Number).reduce((a, b) =>
  Math.abs(b - bpm) < Math.abs(a - bpm) ? b : a, Number(Object.keys(analysis.phaseFor)[0]));
const phase = Math.abs(phaseKey - bpm) < 1 ? analysis.phaseFor[phaseKey] : 0;
console.log(`durée ${analysis.duration.toFixed(1)}s · BPM retenu ${bpm} (candidats : ${analysis.bpmCandidates.slice(0, 4).map(c => c.bpm).join(', ')}) · phase ${(phase * 1000).toFixed(0)}ms`);
console.log(`onsets : low ${analysis.onsets.low.length} · mid ${analysis.onsets.mid.length} · high ${analysis.onsets.high.length}`);

// tier automatique d'après la densité brute des onsets mélodiques + tempo
const rawNps = (analysis.onsets.mid.length + analysis.onsets.low.length) / analysis.duration;
const tier = opt.tier ? parseInt(opt.tier, 10) : Math.max(1, Math.min(5, Math.round(rawNps * 0.9 + (bpm - 100) / 40)));

const difficulties = generate(analysis, bpm, phase, tier);

// point de préversion : le passage le plus énergique
let peakI = 0;
for (let i = 8; i < analysis.energyEnv.length - 8; i++) {
  if (analysis.energyEnv[i] > analysis.energyEnv[peakI]) peakI = i;
}
const previewStart = Math.max(0, peakI / 4 - 4);

const track = {
  id, title,
  artist: opt.artist || 'Piste importée',
  license: 'Fichier fourni par le propriétaire du site — droits à sa charge',
  sourceUrl: '',
  audio: `tracks/${id}.mp3`,
  bpm, audioOffset: 0,
  previewStart: Math.round(previewStart * 10) / 10,
  duration: Math.round(analysis.duration * 100) / 100,
  color: opt.color || '#59f0ff',
  tier,
  difficulties
};

copyFileSync(srcPath, join(root, 'tracks', `${id}.mp3`));
writeFileSync(join(root, 'tracks', `${id}.json`), JSON.stringify(track) + '\n');

for (const d of difficulties) {
  console.log(`  ${d.name.padEnd(6)} lvl${String(d.level).padStart(2)} ${String(d.notes.length).padStart(4)} notes  ${(d.notes.length / analysis.duration).toFixed(2)} n/s`);
}
console.log(`tier ${tier} · préversion à ${track.previewStart}s`);
console.log(`→ tracks/${id}.mp3 + tracks/${id}.json écrits ; relancer "node tools/build-charts.mjs" pour l'index.`);
