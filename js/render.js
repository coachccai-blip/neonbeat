// Boucle de rendu Canvas 2D.
//
// Contraintes tenues ici (§8 du brief) :
//  - canvas dimensionné en devicePixelRatio plafonné à 2 ;
//  - aucun objet ni dégradé créé dans la boucle : tout est préparé dans
//    resize() et réutilisé à chaque frame ;
//  - itération sur une fenêtre glissante de notes, jamais sur tout le tableau.

import { travelTime } from './storage.js';

const LANES = 4;
const JUDGE_Y = 0.82;            // ligne de jugement à 18 % du bas
const LANE_COLORS = ['#22e0c8', '#8b5cff', '#ff3d8b', '#ffb020'];
const LANE_KEYS = ['Z', 'E', 'I', 'O'];
const JUDGE_COLORS = { PERFECT: '#22e0c8', GREAT: '#7ce0ff', GOOD: '#ffb020', MISS: '#ff4d4d' };
const JUDGE_LABELS = { PERFECT: 'PERFECT', GREAT: 'GREAT', GOOD: 'GOOD', MISS: 'MISS' };

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.notes = [];
    this.headIndex = 0;
    this.travel = 0.9;
    this.pressed = [false, false, false, false];
    this.flashes = [];           // { lane, t0, judgment }
    this.labels = [];            // { text, color, t0 }
    this.particles = [];
    this.comboPop = 0;
    this.combo = 0;
    this.failed = false;
    // Sur PC (souris + clavier) : lettres ZEIO sur les notes et les récepteurs.
    this.showKeys = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    this.wave = null;            // { peaks, rate } — soundwave de fond
    this.waveColor = '#8b5cff';
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
  }

  setWaveform(wave, color) {
    this.wave = wave;
    if (color) this.waveColor = color;
  }

  setChart(notes, bpm, speed) {
    this.notes = notes;
    this.headIndex = 0;
    this.travel = travelTime(bpm, speed);
    this.flashes.length = 0;
    this.labels.length = 0;
    this.particles.length = 0;
    this.combo = 0;
    this.failed = false;
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w;
    this.h = h;
    this.laneW = w / LANES;
    this.judgeY = h * JUDGE_Y;
    this.noteH = Math.max(14, Math.min(26, this.laneW * 0.18));
    this.keyFont = `800 ${Math.round(this.noteH * 0.78)}px Bahnschrift, 'Roboto Condensed', sans-serif`;
    this.receptorFont = `700 ${Math.round(Math.min(20, this.laneW * 0.14))}px Bahnschrift, 'Roboto Condensed', sans-serif`;

    // Dégradés pré-calculés (piège n°8 : ne jamais les recréer par frame).
    this.bgGrad = this.ctx.createLinearGradient(0, 0, 0, h);
    this.bgGrad.addColorStop(0, '#07070f');
    this.bgGrad.addColorStop(0.75, '#0b0b1a');
    this.bgGrad.addColorStop(1, '#12122a');

    this.laneGrads = [];
    this.holdGrads = [];
    for (let l = 0; l < LANES; l++) {
      const x = l * this.laneW;
      const g = this.ctx.createLinearGradient(x, 0, x, this.judgeY);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(1, hexA(LANE_COLORS[l], 0.16));
      this.laneGrads.push(g);
      const hg = this.ctx.createLinearGradient(x, 0, x + this.laneW, 0);
      hg.addColorStop(0, hexA(LANE_COLORS[l], 0.14));
      hg.addColorStop(0.5, hexA(LANE_COLORS[l], 0.42));
      hg.addColorStop(1, hexA(LANE_COLORS[l], 0.14));
      this.holdGrads.push(hg);
    }
  }

  /* Événements venus du moteur / de la saisie */
  flash(lane, judgment) {
    this.flashes.push({ lane, t0: performance.now(), judgment });
    if (judgment && judgment !== 'MISS') {
      const cx = (lane + 0.5) * this.laneW;
      for (let i = 0; i < 6; i++) {
        this.particles.push({
          x: cx, y: this.judgeY,
          vx: (Math.random() - 0.5) * 260,
          vy: -80 - Math.random() * 240,
          t0: performance.now(),
          color: JUDGE_COLORS[judgment]
        });
      }
    }
  }

  label(judgment) {
    this.labels.push({ text: JUDGE_LABELS[judgment], color: JUDGE_COLORS[judgment], t0: performance.now() });
    if (this.labels.length > 3) this.labels.splice(0, this.labels.length - 3);
  }

  setCombo(c) {
    if (c > this.combo && c > 0 && c % 10 === 0) this.comboPop = performance.now();
    this.combo = c;
  }

  /**
   * Dessine une frame.
   * @param {number} songT  position dans le morceau (secondes)
   */
  draw(songT) {
    const { ctx, w, h, laneW, judgeY, travel } = this;
    const now = performance.now();

    ctx.fillStyle = this.bgGrad;
    ctx.fillRect(0, 0, w, h);

    // ─── Soundwave : enveloppe du morceau autour de la position courante ───
    if (this.wave && songT > -1) {
      const { peaks, rate } = this.wave;
      const half = 1.9;                      // fenêtre affichée : ±1,9 s
      const cy = h * 0.30;
      const amp = h * 0.085;
      const steps = 90;
      ctx.beginPath();
      for (let k = 0; k <= steps; k++) {
        const tt = songT - half + (k / steps) * half * 2;
        const idx = Math.floor(tt * rate);
        const v = idx >= 0 && idx < peaks.length ? peaks[idx] : 0;
        // atténuation vers les bords, accent au centre (le « maintenant »)
        const edge = 1 - Math.abs(k / steps - 0.5) * 1.6;
        const y = v * amp * Math.max(0.12, edge);
        const x = (k / steps) * w;
        if (k === 0) ctx.moveTo(x, cy - y);
        else ctx.lineTo(x, cy - y);
      }
      for (let k = steps; k >= 0; k--) {
        const tt = songT - half + (k / steps) * half * 2;
        const idx = Math.floor(tt * rate);
        const v = idx >= 0 && idx < peaks.length ? peaks[idx] : 0;
        const edge = 1 - Math.abs(k / steps - 0.5) * 1.6;
        const y = v * amp * Math.max(0.12, edge);
        ctx.lineTo((k / steps) * w, cy + y);
      }
      ctx.closePath();
      ctx.fillStyle = hexA(this.waveColor, 0.13);
      ctx.fill();
      ctx.strokeStyle = hexA(this.waveColor, 0.3);
      ctx.lineWidth = 1;
      ctx.stroke();
      // trait vertical du « maintenant », pulsé par l'amplitude courante
      const nowIdx = Math.floor(songT * rate);
      const nowV = nowIdx >= 0 && nowIdx < peaks.length ? peaks[nowIdx] : 0;
      ctx.fillStyle = hexA(this.waveColor, 0.22 + nowV * 0.3);
      ctx.fillRect(w / 2 - 1, cy - amp * 1.15, 2, amp * 2.3);
    }

    // Couloirs
    for (let l = 0; l < LANES; l++) {
      if (this.pressed[l]) {
        ctx.fillStyle = this.laneGrads[l];
        ctx.fillRect(l * laneW, 0, laneW, judgeY);
      }
    }
    ctx.strokeStyle = 'rgba(139,92,255,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let l = 1; l < LANES; l++) {
      ctx.moveTo(l * laneW + 0.5, 0);
      ctx.lineTo(l * laneW + 0.5, h);
    }
    ctx.stroke();

    // Ligne de jugement + flashs
    for (const f of this.flashes) {
      const age = (now - f.t0) / 180;
      if (age >= 1) continue;
      const a = (1 - age) * 0.55;
      ctx.fillStyle = hexA(JUDGE_COLORS[f.judgment] || LANE_COLORS[f.lane], a);
      ctx.fillRect(f.lane * laneW, judgeY - 26, laneW, 52);
    }
    this.flashes = this.flashes.filter((f) => now - f.t0 < 180);

    ctx.fillStyle = '#eef0ff';
    ctx.fillRect(0, judgeY - 1.5, w, 3);
    for (let l = 0; l < LANES; l++) {
      ctx.fillStyle = this.pressed[l] ? LANE_COLORS[l] : 'rgba(238,240,255,0.35)';
      ctx.beginPath();
      ctx.arc((l + 0.5) * laneW, judgeY, this.pressed[l] ? 9 : 6, 0, Math.PI * 2);
      ctx.fill();
    }
    if (this.showKeys) {
      ctx.font = this.receptorFont;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let l = 0; l < LANES; l++) {
        ctx.fillStyle = this.pressed[l] ? LANE_COLORS[l] : 'rgba(143,147,184,0.55)';
        ctx.fillText(LANE_KEYS[l], (l + 0.5) * laneW, judgeY + 28);
      }
      ctx.textBaseline = 'alphabetic';
    }

    // ─── Notes : fenêtre glissante ───
    // headIndex avance sur les notes définitivement sorties de l'écran ;
    // on s'arrête dès qu'une note est au-dessus du bord haut.
    const notes = this.notes;
    const appearT = songT + travel;               // temps de la note au bord haut
    const pxPerSec = judgeY / travel;

    while (
      this.headIndex < notes.length &&
      notes[this.headIndex].end < songT - 0.15 // gardée un peu après la ligne
    ) this.headIndex++;

    for (let i = this.headIndex; i < notes.length; i++) {
      const n = notes[i];
      if (n.time > appearT) break;
      if (n.state === 'done' && n.judgment !== 'MISS' && n.dur === 0) continue;

      const y = judgeY - (n.time - songT) * pxPerSec;
      const x = n.lane * laneW + laneW * 0.08;
      const nw = laneW * 0.84;
      const color = LANE_COLORS[n.lane];

      if (n.dur > 0) {
        // Corps du hold
        const yEnd = judgeY - (n.end - songT) * pxPerSec;
        const top = Math.max(-40, yEnd);
        const bottom = n.state === 'held' ? judgeY : Math.min(judgeY + 40, y);
        if (bottom > top) {
          ctx.fillStyle = n.state === 'done' && n.judgment === 'GOOD'
            ? 'rgba(139,146,184,0.25)' : this.holdGrads[n.lane];
          ctx.fillRect(x + nw * 0.22, top, nw * 0.56, bottom - top);
        }
        if (n.state !== 'held') this._noteRect(x, y, nw, color, n);
        this._noteRect(x, yEnd, nw, color, n, true);
      } else {
        this._noteRect(x, y, nw, color, n);
      }
    }

    // Particules
    if (this.particles.length) {
      for (const p of this.particles) {
        const age = (now - p.t0) / 380;
        if (age >= 1) continue;
        const t = age * 0.38;
        ctx.globalAlpha = 1 - age;
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x + p.vx * t - 2.5, p.y + p.vy * t + 320 * t * t, 5, 5);
      }
      ctx.globalAlpha = 1;
      this.particles = this.particles.filter((p) => now - p.t0 < 380);
    }

    // Libellé de jugement, centré au-dessus de la ligne
    const lab = this.labels[this.labels.length - 1];
    if (lab) {
      const age = (now - lab.t0) / 420;
      if (age < 1) {
        ctx.globalAlpha = age < 0.7 ? 1 : (1 - age) / 0.3;
        ctx.font = `800 ${Math.round(w * 0.065)}px Bahnschrift, 'Roboto Condensed', sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = lab.color;
        const rise = Math.min(1, age * 3) * 10;
        ctx.fillText(lab.text, w / 2, judgeY - 66 - rise);
        ctx.globalAlpha = 1;
      }
    }

    // Combo au centre
    if (this.combo >= 2) {
      const pop = this.comboPop ? Math.max(0, 1 - (now - this.comboPop) / 200) : 0;
      const size = w * 0.13 * (1 + pop * 0.22);
      ctx.font = `800 ${Math.round(size)}px Bahnschrift, 'Roboto Condensed', sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = pop > 0 ? '#ffffff' : 'rgba(238,240,255,0.92)';
      ctx.fillText(String(this.combo), w / 2, h * 0.38);
      ctx.font = `700 ${Math.round(w * 0.03)}px Bahnschrift, 'Roboto Condensed', sans-serif`;
      ctx.fillStyle = 'rgba(143,147,184,0.9)';
      ctx.fillText('COMBO', w / 2, h * 0.38 + w * 0.045);
    }

    if (this.failed) {
      ctx.fillStyle = 'rgba(255,77,77,0.09)';
      ctx.fillRect(0, 0, w, h);
      ctx.font = `800 ${Math.round(w * 0.05)}px Bahnschrift, 'Roboto Condensed', sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,77,77,0.85)';
      ctx.fillText('FAILED — SCORE FIGÉ', w / 2, h * 0.3);
    }

    // Décompte avant le début du morceau
    if (songT < 0) {
      ctx.fillStyle = 'rgba(7,7,15,0.45)';
      ctx.fillRect(0, 0, w, h);
    }
  }

  _noteRect(x, y, nw, color, n, isHoldHead = false) {
    const ctx = this.ctx;
    const hh = this.noteH;
    if (y < -hh || y > this.h + hh) return;
    const missed = n.judgment === 'MISS';
    ctx.fillStyle = missed ? 'rgba(143,147,184,0.4)' : color;
    roundRect(ctx, x, y - hh / 2, nw, hh, hh * 0.4);
    ctx.fill();
    if (missed || isHoldHead) return;
    if (this.showKeys) {
      // Sur PC : la lettre à presser, écrite sur la note elle-même.
      ctx.font = this.keyFont;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(7,7,15,0.82)';
      ctx.fillText(LANE_KEYS[n.lane], x + nw / 2, y + 1);
      ctx.textBaseline = 'alphabetic';
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      roundRect(ctx, x + nw * 0.1, y - hh / 2 + 2.5, nw * 0.8, 3.5, 2);
      ctx.fill();
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const hexCache = new Map();
function hexA(hex, a) {
  const key = hex + a;
  let v = hexCache.get(key);
  if (!v) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    v = `rgba(${r},${g},${b},${a})`;
    hexCache.set(key, v);
  }
  return v;
}
