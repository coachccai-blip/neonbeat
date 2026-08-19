// Saisie tactile / clavier.
//
// Pièges tenus (§7.3 du brief) :
//  - event.timeStamp (daté par le navigateur au moment réEL de l'événement)
//    et non l'horloge lue dans le handler, qui peut arriver une frame après ;
//  - listeners en { passive:false } + preventDefault pour tuer scroll et zoom ;
//  - suivi des pointerId : un accord à 4 doigts = 4 pointers simultanés.

// Mapping par LETTRE (event.key) et non par position physique (event.code) :
// « Z » désigne ainsi la touche marquée Z, sur AZERTY comme sur QWERTY.
// 4 keys : Z E I O (ou D F J K). 2 keys : E I (tout le bloc gauche/droit marche).
const KEY_MAPS = {
  4: { z: 0, e: 1, i: 2, o: 3, d: 0, f: 1, j: 2, k: 3 },
  2: { z: 0, e: 0, d: 0, f: 0, i: 1, o: 1, j: 1, k: 1 }
};

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
    this.keys = new Map();         // lettre → lane (jeu au clavier sur PC)
    this.enabled = false;
    this.lanes = 4;

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
      const key = (e.key || '').toLowerCase();
      const lane = KEY_MAPS[this.lanes][key];
      if (lane === undefined) return;
      e.preventDefault();
      this.keys.set(key, lane);
      handlers.onPress(lane, e.timeStamp);
    };
    this._keyup = (e) => {
      const key = (e.key || '').toLowerCase();
      const lane = this.keys.get(key);
      if (lane === undefined) return;
      this.keys.delete(key);
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
    return Math.min(this.lanes - 1, Math.floor(x * this.lanes));
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
