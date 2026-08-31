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

/* Depuis la v1.35, le fever ne multiplie plus seulement les points : il
   multiplie AUSSI le combo. À ×2 chaque note en vaut deux, à ×3 elle en
   vaut trois, et ainsi de suite sans plafond.

   Les paliers restent EXACTEMENT les mêmes en nombre de notes qu'avant
   (25 notes pour ×2, 25 de plus pour ×3, puis 50 notes par palier) — c'est
   leur traduction en combo qui change :

     ×2 à 25 · ×3 à 75 · ×4 à 225 · ×5 à 425 · ×6 à 675 · ×7 à 975 …

   Fermé, le palier N (celui qui fait passer à ×(N+1)) tombe à
   25·N·(N+1) − 75, sauf le premier qui vaut 25. La série se poursuit
   indéfiniment : il n'y a pas de dernier fever.                          */

export const FEVER_FIRST = 25;   // combo du premier palier (passage à ×2)

/**
 * Combo auquel bascule le N-ième palier de fever (N ≥ 1 → ×(N+1)).
 * N = 0 renvoie 0 : le début de partie, à ×1.
 */
export function comboAtStep(n) {
  if (n <= 0) return 0;
  if (n === 1) return FEVER_FIRST;
  return 25 * n * (n + 1) - 75;
}

/**
 * Nombre de paliers franchis pour ce combo. L'inverse de `comboAtStep` :
 * on part de la solution exacte de 25·N·(N+1) − 75 ≤ combo, puis on
 * recale d'un cran — la racine carrée peut tomber juste à côté d'un
 * palier, et un fever qui clignote à cause d'un arrondi se verrait.
 */
function stepsPassed(combo) {
  if (combo < FEVER_FIRST) return 0;
  if (combo < comboAtStep(2)) return 1;
  let n = Math.floor((Math.sqrt(1 + (4 * (combo + 75)) / 25) - 1) / 2);
  while (comboAtStep(n + 1) <= combo) n++;
  while (n > 1 && comboAtStep(n) > combo) n--;
  return n;
}

/**
 * Multiplicateur de fever, SANS PLAFOND : ×1 au départ, ×2 à 25 de combo,
 * puis ×3, ×4, ×5… à chaque palier.
 *
 * Conséquence assumée : sur une chart longue, les dernières notes valent
 * bien plus que les premières. Le score reste sur 1 000 000 (le
 * dénominateur simule la même chaîne), mais casser son combo tard coûte
 * désormais très cher — c'est précisément ce qui rend la chaîne palpitante.
 */
export function feverLevel(combo) {
  return stepsPassed(combo) + 1;
}

/**
 * Bornes du palier de fever courant : de quel combo il part, à quel combo
 * bascule le suivant. Sert à la jauge d'énergie du HUD.
 * @returns {{level:number, from:number, to:number}}
 */
export function feverBounds(combo) {
  const n = stepsPassed(combo);
  return { level: n + 1, from: comboAtStep(n), to: comboAtStep(n + 1) };
}

/**
 * Combo d'une chaîne parfaite de `notes` notes — le « combo max théorique ».
 *
 * Il se simule note à note plutôt que par une formule fermée : c'est la
 * MÊME boucle que celle du moteur, donc le chiffre annoncé au joueur ne
 * peut pas diverger de celui qu'il obtiendra réellement.
 */
export function perfectCombo(notes) {
  let c = 0;
  for (let i = 0; i < notes; i++) c += feverLevel(c);
  return c;
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
  constructor(rawNotes, opts = {}) {
    this.noFail = !!opts.noFail;   // effet NO FAIL : la vie plancher à 0 sans mourir
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
    // Le nombre de couloirs vient de la chart elle-même (4 d'office, 6 en
    // mode 6 keys) : le moteur n'a pas à connaître le mode de jeu.
    const nLanes = Math.max(4, 1 + this.notes.reduce((m, n) => (n.lane > m ? n.lane : m), 0));
    this.byLane = Array.from({ length: nLanes }, () => []);
    for (const n of this.notes) this.byLane[n.lane].push(n);
    this.cursor = new Array(nLanes).fill(0);

    this.counts = { PERFECT: 0, GREAT: 0, GOOD: 0, MISS: 0 };
    this.weightSum = 0;
    this.feverSum = 0;
    this.fever = 1;
    this.feverMax = 1;           // plus haut multiplicateur atteint (trophées)
    // Chaîne parfaite simulée une fois pour toutes : elle sert de
    // dénominateur au score (somme des fevers) et de combo de référence.
    // Depuis que le fever multiplie le combo, celui-ci n'est plus le
    // numéro de la note — il faut vraiment dérouler la chaîne.
    this.maxFeverSum = 0;
    let cRef = 0;
    for (let i = 0; i < this.total; i++) {
      cRef += feverLevel(cRef);
      this.maxFeverSum += feverLevel(cRef);
    }
    this.comboPerfect = cRef;
    this.combo = 0;
    this.comboMax = 0;
    this.life = 70;
    this.failed = false;
    this.holding = new Array(this.byLane.length).fill(null);
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
      // Le fever multiplie le combo : à ×3, la note en vaut trois. Le
      // multiplicateur appliqué est celui EN COURS avant la note — sinon
      // le calcul se mordrait la queue.
      this.combo += feverLevel(this.combo);
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
    if (this.life <= 0 && !this.failed && !this.noFail) this.failed = true;

    this.events.push({ type: 'judge', lane, judgment, t: note.time, combo: this.combo });
  }

  /**
   * Applique un jugement décidé AILLEURS que par une frappe : c'est ce qui
   * permet aux bots (js/bots.js) de marquer dans ce moteur-ci, donc avec
   * exactement le barème des humains. Les événements de rendu sont vidés
   * au passage — personne ne les consomme sur un moteur de bot.
   */
  applySynthetic(note, judgment) {
    this._apply(judgment, note, note.lane);
    this.events.length = 0;
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
    // Le combo étant pondéré, c'est la chaîne parfaite — et non le nombre
    // de notes — qui vaut 100 % de cette part.
    const comboPart = this.comboPerfect ? this.comboMax / this.comboPerfect : 0;
    return Math.round(900000 * feverPart + 100000 * Math.min(1, comboPart));
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
