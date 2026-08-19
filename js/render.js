// Boucle de rendu Canvas 2D.
//
// Contraintes tenues ici (§8 du brief) :
//  - canvas dimensionné en devicePixelRatio plafonné à 2 ;
//  - aucun objet ni dégradé créé dans la boucle : tout est préparé dans
//    resize() et réutilisé à chaque frame ;
//  - itération sur une fenêtre glissante de notes, jamais sur tout le tableau.

import { travelTime } from './storage.js';

const JUDGE_Y = 0.82;            // ligne de jugement à 18 % du bas
const LANE_SETS = {
  4: { colors: ['#22e0c8', '#8b5cff', '#ff3d8b', '#ffb020'], keys: ['Z', 'E', 'I', 'O'] },
  2: { colors: ['#22e0c8', '#ff3d8b'], keys: ['E', 'I'] }
};
const JUDGE_COLORS = { PERFECT: '#22e0c8', GREAT: '#7ce0ff', GOOD: '#ffb020', MISS: '#ff4d4d' };
const FEVER_COLORS = { 2: '#22e0c8', 3: '#8b5cff', 4: '#ff3d8b', 5: '#ffb020' };
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
    this.feverLevel = 1;
    this.feverAnim = null;       // { level, t0 } — animation de montée
    this.mods = { fade: false, sudden: false };
    this.lanes = 4;
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

  setChart(notes, bpm, speed, lanes = 4) {
    this.lanes = lanes;
    this.resize();                 // recalcul de laneW et des dégradés
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
    this.laneW = w / this.lanes;
    this.judgeY = h * JUDGE_Y;
    // Hauteur de note et polices basées sur la largeur d'un couloir en mode
    // 4 keys : en mode 2 keys les couloirs sont plus LARGES, mais les notes
    // gardent exactement la même hauteur et la même lettre.
    const ref = w / 4;
    this.noteH = Math.max(20, Math.min(36, ref * 0.26));
    this.keyFont = `800 ${Math.round(this.noteH * 0.78)}px 'Inter', 'Segoe UI', Roboto, Arial, sans-serif`;
    this.receptorFont = `700 ${Math.round(Math.min(20, ref * 0.14))}px 'Inter', 'Segoe UI', Roboto, Arial, sans-serif`;

    // Dégradés pré-calculés (piège n°8 : ne jamais les recréer par frame).
    this.bgGrad = this.ctx.createLinearGradient(0, 0, 0, h);
    this.bgGrad.addColorStop(0, '#07070f');
    this.bgGrad.addColorStop(0.75, '#0b0b1a');
    this.bgGrad.addColorStop(1, '#12122a');

    const set = LANE_SETS[this.lanes];
    this.laneColors = set.colors;
    this.laneKeys = set.keys;
    this.laneGrads = [];
    this.holdGrads = [];
    for (let l = 0; l < this.lanes; l++) {
      const x = l * this.laneW;
      const g = this.ctx.createLinearGradient(x, 0, x, this.judgeY);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(1, hexA(this.laneColors[l], 0.16));
      this.laneGrads.push(g);
      const hg = this.ctx.createLinearGradient(x, 0, x + this.laneW, 0);
      hg.addColorStop(0, hexA(this.laneColors[l], 0.14));
      hg.addColorStop(0.5, hexA(this.laneColors[l], 0.42));
      hg.addColorStop(1, hexA(this.laneColors[l], 0.14));
      this.holdGrads.push(hg);
    }
  }

  /* Événements venus du moteur / de la saisie */
  flash(lane, judgment) {
    this.flashes.push({ lane, t0: performance.now(), judgment });
    if (judgment && judgment !== 'MISS') {
      const cx = (lane + 0.5) * this.laneW;
      const count = 5 + this.feverLevel * 2;
      for (let i = 0; i < count; i++) {
        this.particles.push({
          x: cx, y: this.judgeY,
          vx: (Math.random() - 0.5) * (260 + this.feverLevel * 60),
          vy: -80 - Math.random() * (240 + this.feverLevel * 70),
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

  /** Montée de fever : grosse annonce + explosion de particules. */
  feverUp(level) {
    this.feverLevel = level;
    this.feverAnim = { level, t0: performance.now() };
    const color = FEVER_COLORS[level] || '#ffb020';
    for (let i = 0; i < 26; i++) {
      this.particles.push({
        x: (i / 26) * this.w + this.laneW * 0.1,
        y: this.judgeY,
        vx: (Math.random() - 0.5) * 200,
        vy: -180 - Math.random() * 420,
        t0: performance.now(),
        color: Math.random() < 0.5 ? color : '#eef0ff'
      });
    }
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

    // ─── Soundwave : grandes barres verticales autour de la position courante ───
    if (this.wave && songT > -1) {
      const { peaks, rate } = this.wave;
      const half = 2.1;                    // fenêtre affichée : ±2,1 s
      const cy = h * 0.30;
      const nowIdx = Math.floor(songT * rate);
      const nowV = nowIdx >= 0 && nowIdx < peaks.length ? peaks[nowIdx] : 0;
      const amp = h * 0.15 * (1 + nowV * 0.18);   // respire sur les coups
      const bars = 64;
      const bw = w / bars;
      for (let k = 0; k < bars; k++) {
        const frac = k / (bars - 1);
        const tt = songT + (frac - 0.5) * half * 2;
        const idx = Math.floor(tt * rate);
        const v = idx >= 0 && idx < peaks.length ? peaks[idx] : 0;
        const dist = Math.abs(frac - 0.5) * 2;     // 0 au centre → 1 aux bords
        const edge = 1 - dist * dist * 0.8;
        const bh = Math.max(3, v * amp * edge);
        const x = k * bw + bw * 0.2;
        const alpha = 0.55 - dist * 0.38;
        // halo large puis cœur de barre : effet néon sans shadowBlur (coûteux)
        ctx.fillStyle = hexA(this.waveColor, alpha * 0.30);
        ctx.fillRect(x - bw * 0.14, cy - bh * 1.22, bw * 0.88, bh * 2.44);
        ctx.fillStyle = hexA(this.waveColor, alpha);
        ctx.fillRect(x, cy - bh, bw * 0.6, bh * 2);
      }
      // fine ligne médiane + curseur du « maintenant »
      ctx.fillStyle = hexA(this.waveColor, 0.28);
      ctx.fillRect(0, cy - 0.5, w, 1);
      ctx.fillStyle = hexA('#eef0ff', 0.35 + nowV * 0.45);
      ctx.fillRect(w / 2 - 1.5, cy - amp * 1.1, 3, amp * 2.2);
    }

    // Couloirs
    for (let l = 0; l < this.lanes; l++) {
      if (this.pressed[l]) {
        ctx.fillStyle = this.laneGrads[l];
        ctx.fillRect(l * laneW, 0, laneW, judgeY);
      }
    }
    ctx.strokeStyle = 'rgba(139,92,255,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let l = 1; l < this.lanes; l++) {
      ctx.moveTo(l * laneW + 0.5, 0);
      ctx.lineTo(l * laneW + 0.5, h);
    }
    ctx.stroke();

    // Ligne de jugement + flashs
    for (const f of this.flashes) {
      const age = (now - f.t0) / 180;
      if (age >= 1) continue;
      const a = (1 - age) * 0.55;
      ctx.fillStyle = hexA(JUDGE_COLORS[f.judgment] || this.laneColors[f.lane], a);
      ctx.fillRect(f.lane * laneW, judgeY - 34, laneW, 68);
    }
    this.flashes = this.flashes.filter((f) => now - f.t0 < 180);

    ctx.fillStyle = '#eef0ff';
    ctx.fillRect(0, judgeY - 1.5, w, 3);
    // Marqueurs de frappe : un contour de la taille EXACTE d'une note dans
    // chaque couloir — on appuie quand la note recouvre parfaitement le sien.
    const hh = this.noteH;
    for (let l = 0; l < this.lanes; l++) {
      const x = l * laneW + laneW * 0.05;
      const nw = laneW * 0.90;
      roundRect(ctx, x, judgeY - hh / 2, nw, hh, hh * 0.4);
      if (this.pressed[l]) {
        ctx.fillStyle = hexA(this.laneColors[l], 0.30);
        ctx.fill();
        ctx.strokeStyle = this.laneColors[l];
        ctx.lineWidth = 3;
      } else {
        ctx.strokeStyle = hexA(this.laneColors[l], 0.55);
        ctx.lineWidth = 2;
      }
      ctx.stroke();
    }
    ctx.lineWidth = 1;
    if (this.showKeys) {
      ctx.font = this.receptorFont;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let l = 0; l < this.lanes; l++) {
        ctx.fillStyle = this.pressed[l] ? this.laneColors[l] : 'rgba(143,147,184,0.55)';
        ctx.fillText(this.laneKeys[l], (l + 0.5) * laneW, judgeY + 34);
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

      // Effets optionnels : FADE efface la note avant la ligne, SUDDEN ne la
      // révèle qu'au dernier moment. Le jugement, lui, ne change pas.
      let modAlpha = 1;
      if (this.mods.fade) {
        const f0 = judgeY * 0.52, f1 = judgeY * 0.8;
        modAlpha = y <= f0 ? 1 : y >= f1 ? 0 : 1 - (y - f0) / (f1 - f0);
      } else if (this.mods.sudden) {
        const s0 = judgeY * 0.5, s1 = judgeY * 0.64;
        modAlpha = y <= s0 ? 0 : y >= s1 ? 1 : (y - s0) / (s1 - s0);
      }
      if (modAlpha <= 0.01) continue;
      ctx.globalAlpha = modAlpha;
      const x = n.lane * laneW + laneW * 0.05;
      const nw = laneW * 0.90;
      const color = this.laneColors[n.lane];

      if (n.dur > 0) {
        // Corps du hold
        const yEnd = judgeY - (n.end - songT) * pxPerSec;
        const top = Math.max(-40, yEnd);
        const bottom = n.state === 'held' ? judgeY : Math.min(judgeY + 40, y);
        if (bottom > top) {
          ctx.fillStyle = n.state === 'done' && n.judgment === 'GOOD'
            ? 'rgba(139,146,184,0.25)' : this.holdGrads[n.lane];
          ctx.fillRect(x + nw * 0.18, top, nw * 0.64, bottom - top);
        }
        if (n.state !== 'held') this._noteRect(x, y, nw, color, n);
        this._noteRect(x, yEnd, nw, color, n, true);
      } else {
        this._noteRect(x, y, nw, color, n);
      }
      ctx.globalAlpha = 1;
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
        ctx.font = `800 ${Math.round(w * 0.065)}px 'Inter', 'Segoe UI', Roboto, Arial, sans-serif`;
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
      ctx.font = `800 ${Math.round(size)}px 'Inter', 'Segoe UI', Roboto, Arial, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = pop > 0 ? '#ffffff' : 'rgba(238,240,255,0.92)';
      ctx.fillText(String(this.combo), w / 2, h * 0.38);
      ctx.font = `700 ${Math.round(w * 0.03)}px 'Inter', 'Segoe UI', Roboto, Arial, sans-serif`;
      ctx.fillStyle = 'rgba(143,147,184,0.9)';
      ctx.fillText('COMBO', w / 2, h * 0.38 + w * 0.045);
    }

    // ─── FEVER ───
    if (this.feverLevel >= 2) {
      const color = FEVER_COLORS[this.feverLevel];
      const pulse = 1 + 0.045 * Math.sin(now / 150);
      ctx.font = `800 ${Math.round(w * 0.052 * pulse)}px 'Inter', 'Segoe UI', Roboto, Arial, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = hexA(color, 0.28);
      ctx.fillText(`FEVER ×${this.feverLevel}`, w / 2 + 1.5, h * 0.475 + 1.5);
      ctx.fillStyle = color;
      ctx.fillText(`FEVER ×${this.feverLevel}`, w / 2, h * 0.475);
    }
    if (this.feverAnim) {
      const age = (now - this.feverAnim.t0) / 850;
      if (age >= 1) {
        this.feverAnim = null;
      } else {
        const color = FEVER_COLORS[this.feverAnim.level] || '#ffb020';
        const ease = 1 - Math.pow(1 - Math.min(1, age * 1.6), 3);
        const scale = 2.3 - 1.3 * ease;
        const alpha = age < 0.7 ? 1 : (1 - age) / 0.3;
        // onde de choc
        ctx.strokeStyle = hexA(color, (1 - age) * 0.5);
        ctx.lineWidth = 3 + (1 - age) * 5;
        ctx.beginPath();
        ctx.arc(w / 2, h * 0.42, w * (0.12 + age * 0.55), 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 1;
        // annonce
        ctx.globalAlpha = alpha;
        ctx.font = `800 ${Math.round(w * 0.11 * scale)}px 'Inter', 'Segoe UI', Roboto, Arial, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = hexA(color, 0.4);
        ctx.fillText(`FEVER ×${this.feverAnim.level}`, w / 2 + 3, h * 0.42 + 3);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(`FEVER ×${this.feverAnim.level}`, w / 2, h * 0.42);
        ctx.globalAlpha = 1;
      }
    }

    if (this.failed) {
      ctx.fillStyle = 'rgba(255,77,77,0.09)';
      ctx.fillRect(0, 0, w, h);
      ctx.font = `800 ${Math.round(w * 0.05)}px 'Inter', 'Segoe UI', Roboto, Arial, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,77,77,0.85)';
      ctx.fillText(this.failedText || 'FAILED', w / 2, h * 0.3);
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
      ctx.fillText(this.laneKeys[n.lane], x + nw / 2, y + 1);
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
