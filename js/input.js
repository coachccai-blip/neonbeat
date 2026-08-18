// Saisie tactile / clavier.
//
// Pièges tenus (§7.3 du brief) :
//  - event.timeStamp (daté par le navigateur au moment réEL de l'événement)
//    et non l'horloge lue dans le handler, qui peut arriver une frame après ;
//  - listeners en { passive:false } + preventDefault pour tuer scroll et zoom ;
//  - suivi des pointerId : un accord à 4 doigts = 4 pointers simultanés.

const KEY_LANES = { KeyD: 0, KeyF: 1, KeyJ: 2, KeyK: 3 };

export class Input {
  /**
   * @param {HTMLElement} surface
   * @param {{onPress:(lane:number, timeStampMs:number)=>void,
   *          onRelease:(lane:number, timeStampMs:number)=>void}} handlers
   */
  constructor(surface, handlers) {
    this.surface = surface;
    this.handlers = handlers;
    this.pointers = new Map();     // pointerId → lane
    this.keys = new Map();         // code → lane (clavier, pour le test desktop)
    this.enabled = false;

    this._down = (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      const lane = this._laneOf(e);
      if (lane < 0) return;
      this.pointers.set(e.pointerId, lane);
      handlers.onPress(lane, e.timeStamp);
    };
    this._up = (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      e.preventDefault();
      const lane = this.pointers.get(e.pointerId);
      this.pointers.delete(e.pointerId);
      handlers.onRelease(lane, e.timeStamp);
    };
    this._keydown = (e) => {
      if (!this.enabled || e.repeat) return;
      const lane = KEY_LANES[e.code];
      if (lane === undefined) return;
      e.preventDefault();
      this.keys.set(e.code, lane);
      handlers.onPress(lane, e.timeStamp);
    };
    this._keyup = (e) => {
      const lane = this.keys.get(e.code);
      if (lane === undefined) return;
      this.keys.delete(e.code);
      handlers.onRelease(lane, e.timeStamp);
    };

    surface.addEventListener('pointerdown', this._down, { passive: false });
    surface.addEventListener('pointerup', this._up, { passive: false });
    surface.addEventListener('pointercancel', this._up, { passive: false });
    window.addEventListener('keydown', this._keydown);
    window.addEventListener('keyup', this._keyup);
  }

  _laneOf(e) {
    const r = this.surface.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    if (x < 0 || x > 1) return -1;
    return Math.min(3, Math.floor(x * 4));
  }

  /** Couloirs actuellement enfoncés (pour l'éclairage des couloirs). */
  pressedLanes() {
    const out = [false, false, false, false];
    for (const lane of this.pointers.values()) out[lane] = true;
    for (const lane of this.keys.values()) out[lane] = true;
    return out;
  }

  reset() {
    this.pointers.clear();
    this.keys.clear();
  }

  dispose() {
    this.surface.removeEventListener('pointerdown', this._down);
    this.surface.removeEventListener('pointerup', this._up);
    this.surface.removeEventListener('pointercancel', this._up);
    window.removeEventListener('keydown', this._keydown);
    window.removeEventListener('keyup', this._keyup);
  }
}
