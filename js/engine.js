// État de partie : jugement des frappes, combo, score, jauge de vie.
// Aucune dépendance au rendu ni au réseau : ce module est testable seul.

// Fenêtres très permissives (demande d'équilibrage) : le PERFECT couvre
// l'ancien GOOD (±160 ms), et toute l'échelle suit.
export const WINDOWS = { PERFECT: 0.160, GREAT: 0.200, GOOD: 0.240 };
export const WEIGHTS = { PERFECT: 1, GREAT: 0.75, GOOD: 0.40, MISS: 0 };
const LIFE_DELTA = { PERFECT: 0.6, GREAT: 0.6, GOOD: 0, MISS: -3 };
const HOLD_TOLERANCE = 0.1;    // relâchement anticipé toléré, en secondes

/* ─── Fever ───────────────────────────────────────────────────────────
   Façon DJ Max : enchaîner les combos monte automatiquement un
   multiplicateur ×2 → ×5. Chaque note jugée rapporte poids × fever, et le
   score est normalisé par le maximum atteignable (chaîne parfaite) : il
   reste sur 1 000 000 et comparable entre joueurs — mais casser son combo
   tôt coûte la rampe de fever, pas seulement le bonus de combo.          */

export const FEVER_STEPS = [0, 25, 50, 100, 150];   // combo requis pour ×1…×5

export function feverLevel(combo) {
  let lv = 1;
  for (let i = 1; i < FEVER_STEPS.length; i++) {
    if (combo >= FEVER_STEPS[i]) lv = i + 1;
  }
  return lv;
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

    for (let k = this.cursor[lane]; k < queue.length; k++) {
      const n = queue[k];
      if (n.state !== 'pending') continue;
      const d = n.time - t;
      if (d > WINDOWS.GOOD) break;             // trop tôt : tout le reste aussi
      const a = Math.abs(d);
      if (a < bestAbs) { bestAbs = a; best = n; }
    }

    if (!best || bestAbs > WINDOWS.GOOD) {
      // Frappe dans le vide : aucune pénalité (§4.3), trop punitif en salon.
      this.events.push({ type: 'empty', lane, t });
      return null;
    }

    const judgment = bestAbs <= WINDOWS.PERFECT ? 'PERFECT'
      : bestAbs <= WINDOWS.GREAT ? 'GREAT' : 'GOOD';

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
          if (n.time + WINDOWS.GOOD < t) {
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
