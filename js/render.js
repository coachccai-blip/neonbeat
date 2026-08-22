// Boucle de rendu Canvas 2D — direction artistique façon DJ Max.
//
// Règles de performance tenues :
//  - canvas en devicePixelRatio plafonné à 2 ;
//  - TOUT ce qui coûte (notes glossy, halos, étoiles, dégradés, vignette)
//    est pré-dessiné dans des canvas hors-écran au resize, puis tamponné ;
//    aucune création d'objet ni shadowBlur dans la boucle ;
//  - itération sur une fenêtre glissante de notes, jamais tout le tableau.

import { travelTime } from './storage.js';
import * as audio from './audio.js';
import { DEFAULT_SKIN, laneColors } from './skins.js';

const JUDGE_Y = 0.82;            // ligne de jugement à 18 % du bas
// Les couleurs viennent désormais du skin actif (js/skins.js) ; il ne reste
// ici que le mappage des touches, qui ne dépend que du mode de jeu.
const LANE_KEYS = { 4: ['Z', 'E', 'I', 'O'], 2: ['E', 'I'] };
const JUDGE_COLORS = { PERFECT: '#22e0c8', GREAT: '#7ce0ff', GOOD: '#ffb020', MISS: '#ff4d4d' };
// Le fever n'a plus de plafond : au-delà de ×5 la palette recommence, et
// à partir de ×10 tout vire à l'or blanc — un niveau « hors barème » se
// reconnaît au premier coup d'œil.
const FEVER_CYCLE = ['#2fd8ff', '#7a5cff', '#ff4bd8', '#ffb020'];
function feverColor(level) {
  if (level >= 10) return '#fff0b8';
  return FEVER_CYCLE[(Math.max(2, level) - 2) % FEVER_CYCLE.length];
}
const FONT = "'Inter', 'Segoe UI', Roboto, Arial, sans-serif";

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    // desynchronized : sur les plateformes qui le supportent (Chrome/Android,
    // Windows), le canvas contourne une étape de composition du navigateur —
    // quelques millisecondes de latence tactile→affichage en moins. Repli
    // silencieux ailleurs.
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.notes = [];
    this.headIndex = 0;
    this.travel = 0.9;
    this.bpm = 120;
    this.beatPhase0 = 0;
    this.pressed = [false, false, false, false];
    this.flashes = [];
    this.labels = [];
    this.particles = [];
    this.pillars = [];           // colonnes de lumière { lane, t0, color }
    this.stars = [];             // éclats en étoile { lane, t0 }
    this.rings = [];             // ondes de choc de frappe { lane, t0, color }
    this.comboPop = 0;
    this.combo = 0;
    this.comboAnims = [];        // roulement des chiffres du combo
    this.comboShown = '';
    this.failed = false;
    this.feverLevel = 1;
    this.feverAnim = null;
    this.feverFrac = 0;
    this.feverTarget = 0;
    this.feverBurst = null;
    this.feverFrac = 0;          // remplissage AFFICHÉ (lissé)
    this.feverTarget = 0;        // remplissage réel visé
    this.feverBurst = null;      // { t0 } — éclat au passage d'un palier
    this.shake = null;           // { t0, mag } — secousse aux gros fevers
    this.mods = { fade: false, sudden: false };
    this.lanes = 4;
    this.scene = 0;
    this.showKeys = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    this.wave = null;
    this.waveColor = '#8b5cff';
    this.skin = DEFAULT_SKIN;
    this.bands = { bass: 0, mid: 0, high: 0 };
    this.bars = null;
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
    this.resize();               // les rails et sprites reprennent la teinte
  }

  setChart(notes, bpm, speed, lanes = 4) {
    this.lanes = lanes;
    this.bpm = bpm;
    this.scene = Math.round(bpm) % 3;
    // phase des pulsations : calée sur la première note (grille du morceau)
    this.beatPhase0 = notes.length ? notes[0].time % (60 / bpm) : 0;
    this.resize();
    this.notes = notes;
    this.headIndex = 0;
    this.travel = travelTime(bpm, speed);
    this.flashes.length = 0;
    this.labels.length = 0;
    this.particles.length = 0;
    this.pillars.length = 0;
    this.stars.length = 0;
    this.rings.length = 0;
    this.combo = 0;
    this.comboShown = '';
    this.comboAnims.length = 0;
    this.failed = false;
    this.feverLevel = 1;
    this.feverAnim = null;
    this.shake = null;
  }

  /* ════════════════ Fabrique de sprites (au resize uniquement) ═══════════ */

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dpr = dpr;
    this.w = w;
    this.h = h;
    this.laneW = w / this.lanes;
    this.judgeY = h * JUDGE_Y;

    const ref = w / 4;           // même hauteur de note en 2 et 4 keys
    this.noteH = Math.max(20, Math.min(36, ref * 0.26));
    this.receptorFont = `700 ${Math.round(Math.min(20, ref * 0.14))}px ${FONT}`;
    this.comboFont = `800 ${Math.round(w * 0.13)}px ${FONT}`;
    this.comboDigitW = 0;        // mesuré au premier draw (police chargée)

    this.laneColors = laneColors(this.skin, this.lanes);
    this.laneKeys = LANE_KEYS[this.lanes];

    // fond
    this.bgGrad = this.ctx.createLinearGradient(0, 0, 0, h);
    this.bgGrad.addColorStop(0, '#07070f');
    this.bgGrad.addColorStop(0.75, '#0b0b1a');
    this.bgGrad.addColorStop(1, '#12122a');

    // vignette pulsée (pré-rendue : radial gradient coûteux)
    this.vignette = makeCanvas(w, h, (c) => {
      const g = c.createRadialGradient(w / 2, h * 0.45, Math.min(w, h) * 0.36, w / 2, h * 0.5, Math.max(w, h) * 0.75);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.55)');
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    });

    // dégradés par couloir (éclairage à l'appui + colonnes de lumière)
    this.laneGrads = [];
    this.holdGrads = [];
    for (let l = 0; l < this.lanes; l++) {
      const x = l * this.laneW;
      const g = this.ctx.createLinearGradient(x, 0, x, this.judgeY);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(1, hexA(this.laneColors[l], 0.20));
      this.laneGrads.push(g);
      const hg = this.ctx.createLinearGradient(x, 0, x + this.laneW, 0);
      hg.addColorStop(0, hexA(this.laneColors[l], 0.10));
      hg.addColorStop(0.5, hexA(this.laneColors[l], 0.40));
      hg.addColorStop(1, hexA(this.laneColors[l], 0.10));
      this.holdGrads.push(hg);
    }

    // rails latéraux pulsés
    this.railGrad = this.ctx.createLinearGradient(0, 0, 0, h);
    this.railGrad.addColorStop(0, 'rgba(255,255,255,0)');
    this.railGrad.addColorStop(0.6, hexA(this.waveColor, 0.8));
    this.railGrad.addColorStop(1, hexA(this.waveColor, 0.25));

    // ─── Sprites de notes : glossy + halo, un par couloir + version ratée ───
    this.noteMargin = 16;
    this.noteSprites = this.laneColors.map((color) => this._makeNoteSprite(color, false));
    this.missSprite = this._makeNoteSprite('#8f93b8', true);

    // éclat en étoile (PERFECT)
    const ss = Math.round(this.noteH * 3.2);
    this.starSprite = makeCanvas(ss, ss, (c) => {
      c.translate(ss / 2, ss / 2);
      c.shadowColor = '#ffffff';
      c.shadowBlur = ss * 0.16;
      c.fillStyle = 'rgba(255,255,255,0.95)';
      starPath(c, ss * 0.46, ss * 0.10);
      c.fill();
      c.shadowBlur = 0;
      c.fillStyle = '#ffffff';
      starPath(c, ss * 0.2, ss * 0.055);
      c.fill();
    });
  }

  /** Change l'habillage : les sprites sont recuits avec les nouvelles teintes. */
  setSkin(skin) {
    this.skin = skin || DEFAULT_SKIN;
    this.resize();
  }

  _makeNoteSprite(color, missed) {
    const m = this.noteMargin;
    const nw = Math.round(this.laneW * 0.90);
    const nh = Math.round(this.noteH);
    const r = nh * 0.42;
    return makeCanvas(nw + 2 * m, nh + 2 * m, (c) => {
      const style = missed ? 'gloss' : (this.skin.note || 'gloss');
      const glow = missed ? 0 : (this.skin.glow || 1);
      // halo néon, cuit une fois pour toutes
      if (!missed && glow > 0) {
        c.shadowColor = color;
        c.shadowBlur = m * 0.85 * glow;
        c.fillStyle = color;
        rr(c, m, m, nw, nh, r);
        c.fill();
        if (glow >= 1) c.fill();
        c.shadowBlur = 0;
      }

      if (style === 'outline') {
        // Contour lumineux, cœur presque vide : lecture très nette sur les
        // charts denses, le fond reste visible à travers la note.
        c.fillStyle = mix(color, '#000000', 0.72);
        rr(c, m, m, nw, nh, r); c.fill();
        c.strokeStyle = color;
        c.lineWidth = 2.6;
        rr(c, m + 1.3, m + 1.3, nw - 2.6, nh - 2.6, r);
        c.stroke();
        c.strokeStyle = 'rgba(255,255,255,0.8)';
        c.lineWidth = 1;
        rr(c, m + 3.4, m + 3.4, nw - 6.8, nh - 6.8, r * 0.8);
        c.stroke();
        return;
      }

      // corps : dégradé selon le style
      const g = c.createLinearGradient(0, m, 0, m + nh);
      if (missed) {
        g.addColorStop(0, 'rgba(160,165,195,0.5)');
        g.addColorStop(1, 'rgba(110,115,150,0.4)');
      } else if (style === 'flat') {
        g.addColorStop(0, color);
        g.addColorStop(1, color);
      } else if (style === 'chrome') {
        // Métal poli : bandes claires et sombres alternées.
        g.addColorStop(0, mix(color, '#ffffff', 0.85));
        g.addColorStop(0.30, mix(color, '#ffffff', 0.25));
        g.addColorStop(0.52, mix(color, '#000000', 0.30));
        g.addColorStop(0.70, mix(color, '#ffffff', 0.55));
        g.addColorStop(1, mix(color, '#000000', 0.18));
      } else {
        g.addColorStop(0, mix(color, '#ffffff', 0.62));
        g.addColorStop(0.42, mix(color, '#ffffff', 0.18));
        g.addColorStop(1, mix(color, '#000000', 0.12));
      }
      c.fillStyle = g;
      rr(c, m, m, nw, nh, r);
      c.fill();
      // reflet supérieur (pas sur le style plat, qui doit rester mat)
      if (!missed && style !== 'flat') {
        const gl = c.createLinearGradient(0, m + 1, 0, m + nh * 0.5);
        gl.addColorStop(0, `rgba(255,255,255,${style === 'chrome' ? 0.9 : 0.75})`);
        gl.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = gl;
        rr(c, m + nw * 0.06, m + 2, nw * 0.88, nh * 0.44, r * 0.7);
        c.fill();
      }
      // liseré
      c.strokeStyle = missed ? 'rgba(255,255,255,0.15)'
        : style === 'flat' ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.65)';
      c.lineWidth = 1.4;
      rr(c, m + 0.7, m + 0.7, nw - 1.4, nh - 1.4, r);
      c.stroke();
    });
  }

  /* ════════════════ Événements de jeu ════════════════ */

  flash(lane, judgment) {
    const now = performance.now();
    this.flashes.push({ lane, t0: now, judgment });
    if (!judgment || judgment === 'MISS') return;

    const color = JUDGE_COLORS[judgment];
    this.pillars.push({ lane, t0: now });
    if (judgment === 'PERFECT') {
      this.stars.push({ lane, t0: now });
      this.rings.push({ lane, t0: now, color });
    }
    const cx = (lane + 0.5) * this.laneW;
    const count = 5 + Math.min(this.feverLevel, 8) * 2;
    for (let i = 0; i < count; i++) {
      this.particles.push({
        x: cx, y: this.judgeY,
        vx: (Math.random() - 0.5) * (260 + this.feverLevel * 60),
        vy: -80 - Math.random() * (240 + this.feverLevel * 70),
        t0: now,
        color: JUDGE_COLORS[judgment]
      });
    }
  }

  label(judgment) {
    this.labels.push({ text: judgment, color: JUDGE_COLORS[judgment], t0: performance.now() });
    if (this.labels.length > 3) this.labels.splice(0, this.labels.length - 3);
  }

  /**
   * Progression vers le palier suivant.
   * @param {number} frac  0..1
   */
  setFeverGauge(frac) {
    this.feverTarget = Math.max(0, Math.min(1, frac));
  }

  feverUp(level) {
    this.feverLevel = level;
    this.feverAnim = { level, t0: performance.now() };
    // La jauge se remplit d'un coup, éclate, puis se vide vers le nouveau
    // palier : on lit « l'énergie a été consommée ».
    this.feverFrac = 1;
    this.feverBurst = { t0: performance.now() };
    if (level >= 4) this.shake = { t0: performance.now(), mag: Math.min(6, 3 + (level - 4)) };
    const color = feverColor(level) || '#ffb020';
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
    if (c !== this.combo) this._rollCombo(String(c));
    this.combo = c;
  }

  /** Déclenche le roulement des chiffres qui changent. */
  _rollCombo(next) {
    const prev = this.comboShown.padStart(next.length, ' ');
    const now = performance.now();
    this.comboAnims = [];
    for (let i = 0; i < next.length; i++) {
      if (prev[prev.length - next.length + i] !== next[i]) {
        this.comboAnims.push({ pos: i, from: prev[prev.length - next.length + i] || '', t0: now });
      }
    }
    this.comboShown = next;
  }

  /* ════════════════ Frame ════════════════ */

  draw(songT) {
    const { ctx, w, h, laneW, judgeY, travel } = this;
    const now = performance.now();
    const beatDur = 60 / this.bpm;
    const beatFrac = (((songT - this.beatPhase0) % beatDur) + beatDur) % beatDur / beatDur;
    const beatPulse = Math.pow(1 - beatFrac, 2.4);
    const nowIdx = this.wave ? Math.floor(songT * this.wave.rate) : -1;
    const nowV = nowIdx >= 0 && this.wave && nowIdx < this.wave.peaks.length ? this.wave.peaks[nowIdx] : 0;
    // Spectre RÉEL du morceau en cours : une lecture, trois moyennes, aucune
    // allocation. C'est lui qui fait respirer tout le décor.
    const bnd = audio.bands();
    audio.pushLevel(now);          // alimente l'historique d'amplitude
    this.bands = bnd;
    this.bars = audio.spectrumBars(28);

    // secousse (fever ×4/×5)
    let shaken = false;
    if (this.shake) {
      const age = (now - this.shake.t0) / 500;
      if (age >= 1) {
        this.shake = null;
      } else {
        const m = this.shake.mag * (1 - age);
        ctx.save();
        ctx.translate(Math.sin(now * 0.11) * m, Math.cos(now * 0.09) * m);
        shaken = true;
      }
    }

    ctx.fillStyle = this.bgGrad;
    ctx.fillRect(-8, -8, w + 16, h + 16);

    // ─── Lueur d'horizon gonflée par les graves ───
    if (songT > -1 && bnd.bass > 0.02) {
      const gy = h * 0.56;
      const rad = Math.min(w, h) * (0.30 + bnd.bass * 0.55);
      const gl = ctx.createRadialGradient(w / 2, gy, 0, w / 2, gy, rad);
      gl.addColorStop(0, hexA(this.skin.line, Math.min(0.22, bnd.bass * 0.30)));
      gl.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gl;
      ctx.fillRect(0, gy - rad, w, rad * 2);
    }

    // ─── Scène de fond réactive ───
    if (songT > -1) this._drawScene(songT, beatFrac, nowV, bnd);

    // ─── Soundwave ───
    if (this.wave && songT > -1) this._drawWave(songT, nowV, bnd);

    // ─── Rails latéraux pulsés sur le temps ───
    {
      const railA = 0.22 + beatPulse * 0.34 + bnd.mid * 0.55 + (this.feverLevel >= 2 ? 0.12 : 0);
      ctx.globalAlpha = railA;
      ctx.fillStyle = this.feverLevel >= 2
        ? hexA(feverColor(this.feverLevel), 0.9)
        : this.railGrad;
      ctx.fillRect(0, 0, 4, h);
      ctx.fillRect(w - 4, 0, 4, h);
      ctx.globalAlpha = 1;
    }

    // couloirs éclairés à l'appui
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

    // ─── Colonnes de lumière des frappes ───
    for (const p of this.pillars) {
      const age = (now - p.t0) / 340;
      if (age >= 1) continue;
      const rise = 1 - Math.pow(1 - age, 2);
      ctx.globalAlpha = (1 - age) * 0.5;
      ctx.fillStyle = this.laneGrads[p.lane];
      ctx.fillRect(p.lane * laneW + laneW * 0.08, judgeY - rise * h * 0.55, laneW * 0.84, rise * h * 0.55);
      ctx.globalAlpha = 1;
    }
    this.pillars = this.pillars.filter((p) => now - p.t0 < 340);

    // flashs de la ligne
    for (const f of this.flashes) {
      const age = (now - f.t0) / 180;
      if (age >= 1) continue;
      ctx.fillStyle = hexA(JUDGE_COLORS[f.judgment] || this.laneColors[f.lane], (1 - age) * 0.55);
      ctx.fillRect(f.lane * laneW, judgeY - 34, laneW, 68);
    }
    this.flashes = this.flashes.filter((f) => now - f.t0 < 180);

    // ligne de jugement + marqueurs en forme de note
    ctx.fillStyle = this.skin.line;
    const lt = 3 + bnd.bass * 2.6;
    ctx.fillRect(0, judgeY - lt / 2, w, lt);
    const hh = this.noteH;
    const recScale = 1 + beatPulse * 0.04;
    for (let l = 0; l < this.lanes; l++) {
      const nw = laneW * 0.90 * recScale;
      const x = l * laneW + (laneW - nw) / 2;
      rr(ctx, x, judgeY - (hh * recScale) / 2, nw, hh * recScale, hh * 0.4);
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

    // ─── Notes (fenêtre glissante, sprites) ───
    const notes = this.notes;
    const appearT = songT + travel;
    const pxPerSec = judgeY / travel;
    while (this.headIndex < notes.length && notes[this.headIndex].end < songT - 0.15) this.headIndex++;

    const m = this.noteMargin;
    for (let i = this.headIndex; i < notes.length; i++) {
      const n = notes[i];
      if (n.time > appearT) break;
      if (n.state === 'done' && n.judgment !== 'MISS' && n.dur === 0) continue;

      const y = judgeY - (n.time - songT) * pxPerSec;

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
      const sprite = n.judgment === 'MISS' ? this.missSprite : this.noteSprites[n.lane];

      if (n.dur > 0) {
        const yEnd = judgeY - (n.end - songT) * pxPerSec;
        const top = Math.max(-40, yEnd);
        const bottom = n.state === 'held' ? judgeY : Math.min(judgeY + 40, y);
        if (bottom > top) {
          // corps du hold : dégradé + flux animé qui descend vers la ligne
          ctx.fillStyle = n.state === 'done' && n.judgment === 'GOOD'
            ? 'rgba(139,146,184,0.25)' : this.holdGrads[n.lane];
          ctx.fillRect(x + nw * 0.18, top, nw * 0.64, bottom - top);
          if (n.state !== 'done') {
            ctx.save();
            ctx.beginPath();
            ctx.rect(x + nw * 0.18, top, nw * 0.64, bottom - top);
            ctx.clip();
            const flow = (songT * pxPerSec * 0.5) % 36;
            ctx.fillStyle = n.state === 'held' ? 'rgba(255,255,255,0.30)' : 'rgba(255,255,255,0.13)';
            for (let fy = top - 36 + flow; fy < bottom; fy += 36) {
              ctx.fillRect(x + nw * 0.18, fy, nw * 0.64, 7);
            }
            ctx.restore();
          }
          // gerbe continue au récepteur pendant le maintien
          if (n.state === 'held' && Math.random() < 0.5) {
            this.particles.push({
              x: (n.lane + 0.5) * laneW + (Math.random() - 0.5) * nw * 0.5,
              y: judgeY,
              vx: (Math.random() - 0.5) * 120,
              vy: -60 - Math.random() * 160,
              t0: now,
              color: this.laneColors[n.lane]
            });
          }
        }
        if (n.state !== 'held') this._stamp(sprite, x, y, nw, m);
        this._stamp(sprite, x, yEnd, nw, m);
      } else {
        // Pas de lettre sur les notes : elles alourdissaient le visuel. Le
        // rappel des touches reste sous la ligne de jugement, là où le
        // regard le cherche avant la partie.
        this._stamp(sprite, x, y, nw, m);
      }
      ctx.globalAlpha = 1;
    }

    // ─── Effets de frappe : ondes, étoiles, particules ───
    for (const r of this.rings) {
      const age = (now - r.t0) / 300;
      if (age >= 1) continue;
      ctx.strokeStyle = hexA(r.color, (1 - age) * 0.7);
      ctx.lineWidth = 3 * (1 - age) + 1;
      ctx.beginPath();
      ctx.arc((r.lane + 0.5) * laneW, judgeY, 10 + age * laneW * 0.62, 0, Math.PI * 2);
      ctx.stroke();
    }
    this.rings = this.rings.filter((r) => now - r.t0 < 300);
    ctx.lineWidth = 1;

    for (const s of this.stars) {
      const age = (now - s.t0) / 260;
      if (age >= 1) continue;
      const size = this.starSprite.width / this.dpr;
      const sc = 0.5 + age * 1.1;
      ctx.globalAlpha = 1 - age;
      ctx.save();
      ctx.translate((s.lane + 0.5) * laneW, judgeY);
      ctx.rotate(age * 0.7);
      ctx.drawImage(this.starSprite, -size * sc / 2, -size * sc / 2, size * sc, size * sc);
      ctx.restore();
      ctx.globalAlpha = 1;
    }
    this.stars = this.stars.filter((s) => now - s.t0 < 260);

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
      if (this.particles.length > 220) this.particles.splice(0, this.particles.length - 220);
    }

    // ─── Libellé de jugement : italique penché, pop + montée ───
    const lab = this.labels[this.labels.length - 1];
    if (lab) {
      const age = (now - lab.t0) / 420;
      if (age < 1) {
        const pop = age < 0.18 ? 1.35 - (age / 0.18) * 0.35 : 1;
        ctx.globalAlpha = age < 0.7 ? 1 : (1 - age) / 0.3;
        ctx.save();
        ctx.translate(w / 2, judgeY - 66 - Math.min(1, age * 3) * 12);
        ctx.transform(pop, 0, -0.22 * pop, pop, 0, 0);   // italique + échelle
        ctx.font = `800 ${Math.round(w * 0.068)}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.fillStyle = hexA(lab.color, 0.35);
        ctx.fillText(lab.text, 2.5, 2.5);
        ctx.fillStyle = lab.color;
        ctx.fillText(lab.text, 0, 0);
        ctx.restore();
        ctx.globalAlpha = 1;
      }
    }

    // ─── Combo : chiffres roulants ───
    if (this.combo >= 2) this._drawCombo(now, w, h);

    // ─── FEVER : badge + jauge d'énergie ───
    // Affichés dès que le joueur enchaîne, même à ×1 : la jauge n'a de sens
    // que si elle apparaît AVANT le premier palier.
    if (this.feverLevel >= 2 || this.combo >= 5) {
      const color = feverColor(this.feverLevel);
      const pulse = 1 + 0.045 * Math.sin(now / 150);
      ctx.font = `800 ${Math.round(w * 0.052 * pulse)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = hexA(color, 0.28);
      ctx.fillText(`FEVER ×${this.feverLevel}`, w / 2 + 1.5, h * 0.475 + 1.5);
      ctx.fillStyle = color;
      ctx.fillText(`FEVER ×${this.feverLevel}`, w / 2, h * 0.475);
      this._drawFeverGauge(now, color);
    }
    if (this.feverAnim) {
      const age = (now - this.feverAnim.t0) / 850;
      if (age >= 1) {
        this.feverAnim = null;
      } else {
        const color = feverColor(this.feverAnim.level) || '#ffb020';
        const ease = 1 - Math.pow(1 - Math.min(1, age * 1.6), 3);
        const scale = 2.3 - 1.3 * ease;
        const alpha = age < 0.7 ? 1 : (1 - age) / 0.3;
        ctx.strokeStyle = hexA(color, (1 - age) * 0.5);
        ctx.lineWidth = 3 + (1 - age) * 5;
        ctx.beginPath();
        ctx.arc(w / 2, h * 0.42, w * (0.12 + age * 0.55), 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.globalAlpha = alpha;
        ctx.font = `800 ${Math.round(w * 0.11 * scale)}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.fillStyle = hexA(color, 0.4);
        ctx.fillText(`FEVER ×${this.feverAnim.level}`, w / 2 + 3, h * 0.42 + 3);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(`FEVER ×${this.feverAnim.level}`, w / 2, h * 0.42);
        ctx.globalAlpha = 1;
      }
    }

    // vignette pulsée sur le temps
    ctx.globalAlpha = 0.30 + beatPulse * 0.14 + nowV * 0.06;
    ctx.drawImage(this.vignette, 0, 0, w, h);
    ctx.globalAlpha = 1;

    if (this.failed) {
      ctx.fillStyle = 'rgba(255,77,77,0.09)';
      ctx.fillRect(0, 0, w, h);
      ctx.font = `800 ${Math.round(w * 0.05)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,77,77,0.85)';
      ctx.fillText(this.failedText || 'FAILED', w / 2, h * 0.3);
    }

    if (songT < 0) {
      ctx.fillStyle = 'rgba(7,7,15,0.45)';
      ctx.fillRect(0, 0, w, h);
    }

    if (shaken) ctx.restore();
  }

  _stamp(sprite, x, y, nw, m) {
    if (y < -this.noteH - m || y > this.h + this.noteH + m) return;
    const sw = nw + 2 * m;
    const sh = this.noteH + 2 * m;
    this.ctx.drawImage(sprite, x - m, y - sh / 2, sw, sh);
  }

  /**
   * Jauge d'énergie sous le badge FEVER : elle se remplit jusqu'au palier
   * suivant, éclate au passage, puis se vide. Le remplissage affiché suit
   * la valeur réelle avec un lissage — la barre glisse au lieu de sauter,
   * et la montée se lit même quand les notes s'enchaînent vite.
   */
  _drawFeverGauge(now, color) {
    const { ctx, w, h } = this;
    // Lissage : montée souple, vidage plus vif (on doit sentir la dépense).
    const d = this.feverTarget - this.feverFrac;
    this.feverFrac += d * (d < 0 ? 0.22 : 0.14);
    if (Math.abs(d) < 0.002) this.feverFrac = this.feverTarget;

    const gw = Math.round(w * 0.38);
    const gh = Math.max(7, Math.round(w * 0.021));
    // Jauge centrée sous le badge : le palier visé est déjà lisible dans le
    // « FEVER ×N » juste au-dessus, inutile de le répéter au bout de la barre.
    const x = Math.round((w - gw) / 2);
    const y = Math.round(h * 0.475 + w * 0.048);
    const r = gh / 2;

    // À l'approche du palier, la capsule respire : le joueur sent venir la
    // bascule sans quitter les notes des yeux.
    const near = this.feverFrac > 0.82 ? (this.feverFrac - 0.82) / 0.18 : 0;
    const breathe = near * (0.5 + 0.5 * Math.sin(now / 90));

    let burst = 0;
    if (this.feverBurst) {
      const age = (now - this.feverBurst.t0) / 620;
      if (age >= 1) this.feverBurst = null;
      else burst = 1 - age;
    }

    // Halo sous la capsule : discret d'ordinaire, franc à l'approche du palier
    if (near > 0.02 || burst > 0) {
      ctx.globalAlpha = Math.min(0.5, near * 0.30 + burst * 0.45);
      ctx.fillStyle = color;
      rr(ctx, x - 6, y - 5, gw + 12, gh + 10, r + 5); ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Rail creux
    ctx.fillStyle = 'rgba(255,255,255,0.09)';
    rr(ctx, x, y, gw, gh, r); ctx.fill();
    ctx.strokeStyle = hexA(color, 0.30 + burst * 0.5 + breathe * 0.45);
    ctx.lineWidth = 1 + breathe;
    rr(ctx, x + 0.5, y + 0.5, gw - 1, gh - 1, r); ctx.stroke();

    // Remplissage
    const fw = Math.max(0, this.feverFrac) * (gw - 2);
    if (fw > 1.5) {
      ctx.save();
      rr(ctx, x + 1, y + 1, gw - 2, gh - 2, r - 1);
      ctx.clip();
      ctx.fillStyle = hexA(color, 0.9);
      ctx.fillRect(x + 1, y + 1, fw, gh - 2);
      // Pointe plus claire : donne le sens de la marche.
      ctx.fillStyle = mix(color, '#ffffff', 0.55);
      ctx.fillRect(x + 1 + Math.max(0, fw - gh * 0.9), y + 1, Math.min(fw, gh * 0.9), gh - 2);
      // Reflet qui balaie la partie remplie, en boucle lente.
      const sx = x + 1 + ((now / 14) % (gw + 60)) - 30;
      ctx.fillStyle = 'rgba(255,255,255,0.28)';
      ctx.fillRect(sx, y + 1, 14, gh - 2);
      ctx.restore();
    }

    // Éclat au passage de palier : la capsule blanchit et déborde.
    if (burst > 0) {
      ctx.globalAlpha = burst * 0.85;
      ctx.fillStyle = '#ffffff';
      rr(ctx, x - burst * 5, y - burst * 4, gw + burst * 10, gh + burst * 8, r + burst * 4);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

  }

  _drawCombo(now, w, h) {
    const ctx = this.ctx;
    const pop = this.comboPop ? Math.max(0, 1 - (now - this.comboPop) / 200) : 0;
    ctx.font = this.comboFont;
    if (!this.comboDigitW) this.comboDigitW = ctx.measureText('0').width * 1.04;
    const str = this.comboShown;
    const dw = this.comboDigitW * (1 + pop * 0.22);
    const digitH = w * 0.13;
    const y0 = h * 0.38;
    const x0 = w / 2 - (str.length * dw) / 2;
    ctx.textAlign = 'center';
    ctx.fillStyle = pop > 0 ? '#ffffff' : 'rgba(238,240,255,0.92)';
    for (let i = 0; i < str.length; i++) {
      const anim = this.comboAnims.find((a) => a.pos === i);
      const cx = x0 + (i + 0.5) * dw;
      if (anim) {
        const t = Math.min(1, (now - anim.t0) / 130);
        const e = 1 - Math.pow(1 - t, 2);
        ctx.save();
        ctx.beginPath();
        ctx.rect(cx - dw / 2 - 2, y0 - digitH, dw + 4, digitH * 1.25);
        ctx.clip();
        if (anim.from && anim.from !== ' ') ctx.fillText(anim.from, cx, y0 + e * digitH);
        ctx.fillText(str[i], cx, y0 - digitH + e * digitH);
        ctx.restore();
        if (t >= 1) this.comboAnims = this.comboAnims.filter((a) => a !== anim);
      } else {
        ctx.fillText(str[i], cx, y0);
      }
    }
    ctx.font = `700 ${Math.round(w * 0.03)}px ${FONT}`;
    ctx.fillStyle = 'rgba(143,147,184,0.9)';
    ctx.fillText('COMBO', w / 2, y0 + w * 0.045);
  }

  _drawScene(songT, beatFrac, nowV, bnd) {
    const { ctx, w, h } = this;
    const tint = this.waveColor;
    // La forme d'onde pré-calculée donne la tendance, le spectre en direct
    // donne l'accent : les deux se cumulent.
    const boost = 0.45 + nowV * 0.7 + bnd.mid * 1.1;
    if (this.scene === 0) {
      // grille en perspective qui défile vers le bas de l'écran
      const horizon = h * 0.56;
      ctx.strokeStyle = hexA(tint, 0.10 * boost);
      ctx.lineWidth = 1;
      ctx.beginPath();
      const off = (songT * (0.55 + bnd.bass * 0.9)) % 1;
      for (let i = 0; i < 9; i++) {
        const p = (i + off) / 9;
        const y = horizon + p * p * (h - horizon);
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      for (let i = -4; i <= 4; i++) {
        ctx.moveTo(w / 2 + i * w * 0.09, horizon);
        ctx.lineTo(w / 2 + i * w * 0.42, h);
      }
      ctx.stroke();
    } else if (this.scene === 1) {
      // anneaux concentriques émis sur le temps
      ctx.lineWidth = 2;
      for (let k = 0; k < 3; k++) {
        const p = (beatFrac + k) / 3;
        ctx.strokeStyle = hexA(tint, (1 - p) * 0.12 * boost);
        ctx.beginPath();
        ctx.arc(w / 2, h * 0.30, 20 + p * w * (0.65 + bnd.bass * 0.45), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.lineWidth = 1;
    } else {
      // pluie de traits lumineux
      ctx.fillStyle = hexA(tint, 0.09 * boost);
      for (let i = 0; i < 22; i++) {
        const speed = 130 + ((i * 37) % 170);
        const len = (40 + ((i * 53) % 90)) * (0.6 + bnd.high * 1.5);
        const x = ((i * 271) % 997) / 997 * w;
        const y = ((songT * speed + i * 131) % (h + len)) - len;
        ctx.fillRect(x, y, 2, len);
      }
    }
  }

  /**
   * LA visualisation du morceau : l'amplitude sonore accumulée image après
   * image, qui défile de droite à gauche — le plus récent au bord droit.
   *
   * Le spectre seul donnait une silhouette stable : sa FORME change peu, un
   * mix ayant toujours à peu près la même couleur. L'amplitude n'est qu'un
   * nombre, mais empilée dans le temps elle dessine le morceau : couplets,
   * refrains, ruptures et montées deviennent lisibles à l'écran.
   */
  _drawWave(songT, nowV, bnd) {
    const { ctx, w, h } = this;
    const bars = 64;
    const src = audio.levelHistory(bars);
    if (!src || !src.length) return;
    const cy = h * 0.30;
    // Contenue : c'est un décor, la trajectoire des notes doit rester
    // parfaitement lisible par-dessus.
    const amp = h * 0.075;
    const bw = w / bars;
    for (let k = 0; k < bars; k++) {
      const bh = Math.max(2, src[k] * amp);
      const x = k * bw + bw * 0.2;
      // Le plus récent (à droite) est le plus lumineux : on lit le sens du
      // défilement sans avoir à y penser.
      const age = k / (bars - 1);
      const alpha = 0.14 + age * 0.28;
      ctx.fillStyle = hexA(this.waveColor, alpha * 0.28);
      ctx.fillRect(x - bw * 0.14, cy - bh * 1.25, bw * 0.88, bh * 2.5);
      ctx.fillStyle = hexA(this.waveColor, alpha);
      ctx.fillRect(x, cy - bh, bw * 0.6, bh * 2);
    }
    ctx.fillStyle = hexA(this.waveColor, 0.26);
    ctx.fillRect(0, cy - 0.5, w, 1);
    // Tête de lecture au bord droit, dilatée par les graves.
    const head = Math.max(2, src[bars - 1] * amp);
    ctx.fillStyle = hexA(this.skin.line, 0.35 + bnd.bass * 0.5);
    ctx.fillRect(w - 3, cy - head * (1.1 + bnd.bass * 0.4), 3, head * (2.2 + bnd.bass * 0.8));
  }
}

/* ════════════════ Aides ════════════════ */

function makeCanvas(w, h, drawFn) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * dpr));
  c.height = Math.max(1, Math.round(h * dpr));
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawFn(ctx);
  return c;
}

function rr(ctx, x, y, w, h, r) {
  const rad = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function starPath(ctx, rOut, rIn) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const r = i % 2 === 0 ? rOut : rIn;
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
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

function mix(hex, other, f) {
  const r1 = parseInt(hex.slice(1, 3), 16), g1 = parseInt(hex.slice(3, 5), 16), b1 = parseInt(hex.slice(5, 7), 16);
  const r2 = parseInt(other.slice(1, 3), 16), g2 = parseInt(other.slice(3, 5), 16), b2 = parseInt(other.slice(5, 7), 16);
  const r = Math.round(r1 + (r2 - r1) * f), g = Math.round(g1 + (g2 - g1) * f), b = Math.round(b1 + (b2 - b1) * f);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}
