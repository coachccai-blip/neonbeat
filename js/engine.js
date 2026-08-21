// État de partie : jugement des frappes, combo, score, jauge de vie.
// Aucune dépendance au rendu ni au réseau : ce module est testable seul.

// Fenêtres très permissives (demande d'équilibrage) : le PERFECT couvre
// l'ancien GOOD (±160 ms), et toute l'échelle suit.
export const WINDOWS = { PERFECT: 0.160, GREAT: 0.200, GOOD: 0.240 };
export const WEIGHTS = { PERFECT: 1, GREAT: 0.75, GOOD: 0.40, MISS: 0 };
const LIFE_DELTA = { PERFECT: 0.6, GREAT: 0.6, GOOD: 0, MISS: -3 };
/* Les holds demandent de viser la tête ET de tenir jusqu'au bout : deux
   occasions de se tromper là où une note simple n'en offre qu'une. Toutes
   leurs fenêtres sont donc élargies d'une fois et demie par rapport aux
   notes simples — tête, jugement et relâchement.                          */
export const HOLD_SCALE = 1.5;
const HOLD_TOLERANCE = 0.1 * HOLD_SCALE;   // relâchement anticipé toléré, en s

/** Facteur de fenêtre d'une note : 1,5 pour un hold, 1 pour une note simple. */
const wScale = (note) => (note.dur > 0 ? HOLD_SCALE : 1);

/* ─── Fever ───────────────────────────────────────────────────────────
   Façon DJ Max : enchaîner les combos monte automatiquement un
   multiplicateur ×2 → ×5. Chaque note jugée rapporte poids × fever, et le
   score est normalisé par le maximum atteignable (chaîne parfaite) : il
   reste sur 1 000 000 et comparable entre joueurs — mais casser son combo
   tôt coûte la rampe de fever, pas seulement le bonus de combo.          */

export const FEVER_STEPS = [0, 25, 50, 100, 150];   // combo requis pour ×1…×5
export const FEVER_EXTRA = 50;     // puis un palier tous les 50 de combo

/**
 * Multiplicateur de fever, SANS PLAFOND : ×1…×5 aux paliers historiques,
 * puis ×6, ×7, ×8… tous les 50 de combo supplémentaires.
 *
 * Conséquence assumée : sur une chart longue, les dernières notes valent
 * bien plus que les premières. Le score reste sur 1 000 000 (le
 * dénominateur emprunte la même formule), mais casser son combo tard coûte
 * désormais très cher — c'est précisément ce qui rend la chaîne palpitante.
 */
export function feverLevel(combo) {
  const last = FEVER_STEPS[FEVER_STEPS.length - 1];
  if (combo >= last) return FEVER_STEPS.length + Math.floor((combo - last) / FEVER_EXTRA);
  let lv = 1;
  for (let i = 1; i < FEVER_STEPS.length; i++) {
    if (combo >= FEVER_STEPS[i]) lv = i + 1;
  }
  return lv;
}

/**
 * Bornes du palier de fever courant : de quel combo il part, à quel combo
 * bascule le suivant. Sert à la jauge d'énergie du HUD.
 * @returns {{level:number, from:number, to:number}}
 */
export function feverBounds(combo) {
  const last = FEVER_STEPS[FEVER_STEPS.length - 1];
  const lv = feverLevel(combo);
  if (combo >= last) {
    const from = last + (lv - FEVER_STEPS.length) * FEVER_EXTRA;
    return { level: lv, from, to: from + FEVER_EXTRA };
  }
  return { level: lv, from: FEVER_STEPS[lv - 1], to: FEVER_STEPS[lv] };
}

export const GRADES = [
  ['SS', 0.9995], ['S+', 0.99], ['S', 0.95], ['A', 0.90], ['B', 0.80], ['C', 0.70], ['D', 0]
];

export function gradeFor(precision) {
  for (const [g, min] of GRADES) if (precision >= min) return g;
  return 'D';
}

export class Engine {
  /**
   * @param {number[][]} rawNotes  [[lane, time, duration], …] triées par time
   */
  constructor(rawNotes) {
    this.notes = rawNotes.map(([lane, time, dur], i) => ({
      i, lane, time, dur,
      end: time + dur,
      state: 'pending',        // pending | held | done
      judgment: null,
      hitAt: 0
    }));
    this.total = this.notes.length;

    // Une file par couloir : le moteur n'inspecte jamais tout le tableau, il
    // avance un curseur. Sans ça, une chart de 2000 notes coûte 2000
    // itérations par frame et le framerate s'effondre en fin de morceau.
    this.byLane = [[], [], [], []];
    for (const n of this.notes) this.byLane[n.lane].push(n);
    this.cursor = [0, 0, 0, 0];

    this.counts = { PERFECT: 0, GREAT: 0, GOOD: 0, MISS: 0 };
    this.weightSum = 0;
    this.feverSum = 0;
    this.fever = 1;
    this.feverMax = 1;           // plus haut multiplicateur atteint (trophées)
    // Somme de fever d'une partie parfaite : sert de dénominateur au score.
    this.maxFeverSum = 0;
    for (let i = 1; i <= this.total; i++) this.maxFeverSum += feverLevel(i);
    this.combo = 0;
    this.comboMax = 0;
    this.life = 70;
    this.failed = false;
    this.holding = [null, null, null, null];
    this.events = [];            // pour le rendu : flashs et libellés
    this.deltaSum = 0;           // somme des écarts signés (s) — stats early/late
    this.deltaCount = 0;
    this.earlyCount = 0;
    this.lateCount = 0;
  }

  /* ─── Frappes ───────────────────────────────────────────────────── */

  /**
   * @param {number} lane
   * @param {number} t  instant de la frappe, en secondes du morceau,
   *                    offset de calibration déjà appliqué
   * @returns {{judgment:string, delta:number, note:object}|null}
   */
  press(lane, t) {
    const queue = this.byLane[lane];
    let best = null;
    let bestAbs = Infinity;

    // La borne de sortie prend la fenêtre la PLUS large (celle des holds),
    // sinon on s'arrêterait avant d'avoir vu un hold encore atteignable.
    const reach = WINDOWS.GOOD * HOLD_SCALE;
    for (let k = this.cursor[lane]; k < queue.length; k++) {
      const n = queue[k];
      if (n.state !== 'pending') continue;
      const d = n.time - t;
      if (d > reach) break;                    // trop tôt : tout le reste aussi
      const a = Math.abs(d);
      if (a > WINDOWS.GOOD * wScale(n)) continue;   // hors de SA propre fenêtre
      if (a < bestAbs) { bestAbs = a; best = n; }
    }

    if (!best) {
      // Frappe dans le vide : aucune pénalité (§4.3), trop punitif en salon.
      this.events.push({ type: 'empty', lane, t });
      return null;
    }

    const ws = wScale(best);
    const judgment = bestAbs <= WINDOWS.PERFECT * ws ? 'PERFECT'
      : bestAbs <= WINDOWS.GREAT * ws ? 'GREAT' : 'GOOD';

    best.judgment = judgment;
    best.hitAt = t;
    if (best.dur > 0) {
      best.state = 'held';
      this.holding[lane] = best;
    } else {
      best.state = 'done';
    }

    const delta = t - best.time;
    this.deltaSum += delta;
    this.deltaCount++;
    if (delta < -0.005) this.earlyCount++;
    else if (delta > 0.005) this.lateCount++;

    this._apply(judgment, best, lane);
    return { judgment, delta, note: best };
  }

  release(lane, t) {
    const n = this.holding[lane];
    if (!n) return null;
    this.holding[lane] = null;
    n.state = 'done';
    if (t < n.end - HOLD_TOLERANCE && n.judgment !== 'GOOD') {
      // Relâchement anticipé : le jugement est dégradé, le combo survit.
      this._downgrade(n, 'GOOD');
      this.events.push({ type: 'judge', lane, judgment: 'GOOD', t, early: true });
      return 'GOOD';
    }
    return n.judgment;
  }

  /* ─── Avancée du temps ──────────────────────────────────────────── */

  update(t) {
    for (let lane = 0; lane < 4; lane++) {
      const queue = this.byLane[lane];
      let k = this.cursor[lane];
      while (k < queue.length) {
        const n = queue[k];
        if (n.state === 'pending') {
          if (n.time + WINDOWS.GOOD * wScale(n) < t) {
            n.state = 'done';
            n.judgment = 'MISS';
            this._apply('MISS', n, lane);
          } else {
            break;                       // la file est triée : on peut sortir
          }
        } else if (n.state === 'held') {
          if (t >= n.end) {
            n.state = 'done';
            this.holding[lane] = null;
            this.events.push({ type: 'holdEnd', lane, t });
          } else {
            break;
          }
        }
        if (n.state === 'done') k++; else break;
      }
      this.cursor[lane] = k;
    }
  }

  /* ─── Score ─────────────────────────────────────────────────────── */

  _apply(judgment, note, lane) {
    this.counts[judgment]++;

    if (judgment === 'MISS') {
      this.combo = 0;
    } else {
      this.combo++;
      if (this.combo > this.comboMax) this.comboMax = this.combo;
    }

    // La note est payée au niveau de fever ATTEINT PAR elle (le combo qu'elle
    // vient de faire) — la chaîne parfaite colle ainsi au dénominateur.
    const lv = feverLevel(this.combo);
    if (!this.failed) {
      this.weightSum += WEIGHTS[judgment];
      this.feverSum += WEIGHTS[judgment] * lv;
    }
    const prevFever = this.fever;
    this.fever = lv;
    if (lv > this.feverMax) this.feverMax = lv;
    if (lv > prevFever) {
      this.events.push({ type: 'fever', level: lv });
    }

    this.life = Math.max(0, Math.min(100, this.life + LIFE_DELTA[judgment]));
    if (this.life <= 0 && !this.failed) this.failed = true;

    this.events.push({ type: 'judge', lane, judgment, t: note.time, combo: this.combo });
  }

  _downgrade(note, judgment) {
    if (note.judgment === judgment) return;
    this.counts[note.judgment]--;
    this.counts[judgment]++;
    if (!this.failed) {
      this.weightSum += WEIGHTS[judgment] - WEIGHTS[note.judgment];
      this.feverSum += (WEIGHTS[judgment] - WEIGHTS[note.judgment]) * this.fever;
    }
    note.judgment = judgment;
  }

  get precision() {
    return this.total ? this.weightSum / this.total : 0;
  }

  get score() {
    if (!this.total) return 0;
    const feverPart = this.maxFeverSum ? this.feverSum / this.maxFeverSum : 0;
    return Math.round(900000 * feverPart + 100000 * (this.comboMax / this.total));
  }

  get judged() {
    return this.counts.PERFECT + this.counts.GREAT + this.counts.GOOD + this.counts.MISS;
  }

  results() {
    const precision = this.precision;
    return {
      score: this.score,
      precision,
      comboMax: this.comboMax,
      counts: { ...this.counts },
      grade: this.failed ? 'D' : gradeFor(precision),
      failed: this.failed,
      total: this.total,
      feverMax: this.feverMax,
      timing: {
        avgMs: this.deltaCount ? Math.round((this.deltaSum / this.deltaCount) * 1000) : 0,
        earlyPct: this.deltaCount ? Math.round((100 * this.earlyCount) / this.deltaCount) : 0,
        latePct: this.deltaCount ? Math.round((100 * this.lateCount) / this.deltaCount) : 0
      }
    };
  }

  /** État compact diffusé aux autres joueurs 4 fois par seconde. */
  snapshot() {
    return {
      score: this.score,
      combo: this.combo,
      fever: this.fever,
      precision: Math.round(this.precision * 1000) / 1000,
      life: Math.round(this.life)
    };
  }
}
