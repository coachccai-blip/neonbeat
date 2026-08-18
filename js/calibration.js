// Calibration de la latence audio + tactile — le module qui décide si le jeu
// est jouable (§5 du brief).
//
// Protocole : métronome à 120 BPM programmé sur l'horloge audio, 20 frappes,
// les 4 premières jetées, offset = MÉDIANE des écarts signés (robuste aux
// frappes ratées, contrairement à la moyenne).

import * as audio from './audio.js';

const INTERVAL = 0.5;        // 120 BPM
const TOTAL_TAPS = 20;
const DISCARD = 4;

export class Calibration {
  /**
   * @param {{onTick:()=>void, onTap:(count:number)=>void,
   *          onDone:(r:{offset:number, deviation:number, unstable:boolean})=>void}} cb
   */
  constructor(cb) {
    this.cb = cb;
    this.running = false;
  }

  start() {
    const ctx = audio.context();
    this.running = true;
    this.taps = [];
    this.clickTimes = [];            // instants des clics, horloge audio

    // Pont audio → performance.now capturé une seule fois au départ.
    this.t0Ctx = ctx.currentTime + 0.35;
    this.t0Perf = performance.now() + (this.t0Ctx - ctx.currentTime) * 1000;

    this._scheduled = 0;
    this._pump = setInterval(() => this._schedule(), 200);
    this._schedule();

    // Pulsation visuelle alignée sur les mêmes instants.
    const visual = () => {
      if (!this.running) return;
      const beat = (performance.now() - this.t0Perf) / (INTERVAL * 1000);
      const frac = beat - Math.floor(beat);
      if (beat >= 0 && frac < 0.12 && this._lastPulse !== Math.floor(beat)) {
        this._lastPulse = Math.floor(beat);
        this.cb.onTick();
      }
      this._raf = requestAnimationFrame(visual);
    };
    this._raf = requestAnimationFrame(visual);
  }

  _schedule() {
    const ctx = audio.context();
    // Toujours ~2 s de clics d'avance, programmés sur l'horloge audio.
    while (this._scheduled * INTERVAL + this.t0Ctx < ctx.currentTime + 2) {
      const at = this.t0Ctx + this._scheduled * INTERVAL;
      audio.scheduleClick(at);
      this.clickTimes.push(at);
      this._scheduled++;
    }
  }

  /** À appeler avec event.timeStamp du pointerdown. */
  tap(timeStampMs) {
    if (!this.running) return;
    // L'événement est daté en base performance.now() : on ne garde que son
    // ÂGE (quelques ms), appliqué à l'horloge audio — la même base que les
    // clics du métronome ET que le jugement en jeu.
    const age = (performance.now() - timeStampMs) / 1000;
    const t = (audio.context().currentTime - this.t0Ctx) - age;
    if (t < -0.3) return;
    // Écart signé au clic le plus proche : positif = le joueur tape après le son.
    const nearest = Math.round(t / INTERVAL) * INTERVAL;
    this.taps.push((t - nearest) * 1000);
    this.cb.onTap(this.taps.length);
    if (this.taps.length >= TOTAL_TAPS) this._finish();
  }

  _finish() {
    this.stop();
    const kept = this.taps.slice(DISCARD);
    const sorted = [...kept].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const mean = kept.reduce((a, b) => a + b, 0) / kept.length;
    const deviation = Math.sqrt(kept.reduce((a, b) => a + (b - mean) ** 2, 0) / kept.length);
    this.cb.onDone({
      offset: Math.max(-200, Math.min(200, Math.round(median))),
      deviation: Math.round(deviation),
      unstable: deviation > 45
    });
  }

  stop() {
    this.running = false;
    clearInterval(this._pump);
    cancelAnimationFrame(this._raf);
  }
}
