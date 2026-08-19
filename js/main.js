// Bootstrap et orchestration : navigation, partie solo, hôte et client.

import * as storage from './storage.js';
import * as audio from './audio.js';
import * as ui from './ui.js';
import { loadIndex, loadTrack, getDifficulty, density } from './chart.js';
import { Engine } from './engine.js';
import { Renderer } from './render.js';
import { Input } from './input.js';
import { Calibration } from './calibration.js';
import { ClockSync } from './clock.js';
import { Host, Client, normalizeCode, MAX_PLAYERS } from './net.js';
import { MODS, multiplierFor, modsLabel } from './mods.js';
import * as i18n from './i18n.js';
const { t } = i18n;

const $ = (id) => document.getElementById(id);

/* ══════════════════ État de session ══════════════════ */

const S = {
  tracks: [],              // index des morceaux
  mode: 'solo',            // solo | host | client
  selectedTrack: null,     // entrée de l'index choisie
  myDiff: storage.get('lastDiff'),
  audioMode: 'shared',
  selectPurpose: 'solo',   // solo | lobby (l'hôte choisit pour le salon)

  net: null,               // Host ou Client
  clock: new ClockSync(),
  roomCode: null,
  players: new Map(),      // id → {name,color,ready,difficulty,off,progress,result}
  myId: 'me',
  hostLeft: false,

  game: null,              // contrôleur de partie en cours
  pendingCalibReturn: null // écran à réafficher après calibration
};

const HOST_ID = 'host';

function displayName() {
  return storage.get('name') || 'JOUEUR';
}

/* ══════════════════ Navigation & boutons ══════════════════ */

function boot() {
  i18n.init();
  // Précharge la police embarquée : le canvas ne participe pas au chargement
  // automatique des @font-face, il faut la demander explicitement.
  if (document.fonts && document.fonts.load) {
    document.fonts.load('800 40px Inter');
    document.fonts.load('700 20px Inter');
  }

  // Service worker : cache des assets pour le mode installé.
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  document.querySelectorAll('[data-back]').forEach((b) => {
    b.addEventListener('click', () => {
      if (b.dataset.back === 'home') leaveRoom();
      ui.show(b.dataset.back);
    });
  });

  $('btn-solo').addEventListener('click', () => {
    audio.unlock();
    S.mode = 'solo';
    S.selectPurpose = 'solo';
    if (!storage.get('calibrated')) return goCalibrate('select-solo');
    openSelect();
  });

  $('btn-create').addEventListener('click', () => {
    audio.unlock();
    if (!window.Peer) return ui.toast(t('net_nopeer'));
    if (!storage.get('calibrated')) return goCalibrate('create');
    createRoom();
  });

  $('btn-join').addEventListener('click', () => {
    audio.unlock();
    if (!window.Peer) return ui.toast(t('net_nopeer'));
    ui.show('join');
    $('join-code').focus();
  });

  $('btn-settings').addEventListener('click', () => { audio.unlock(); ui.show('settings'); });
  $('btn-credits').addEventListener('click', () => { openCredits(); });
  $('btn-calib-home').addEventListener('click', () => { audio.unlock(); goCalibrate('home'); });

  // Rejoindre
  $('join-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  });
  $('btn-join-go').addEventListener('click', joinRoom);

  // Lobby
  $('btn-change-track').addEventListener('click', () => {
    S.selectPurpose = 'lobby';
    openSelect();
  });
  $('select-back').addEventListener('click', () => {
    closeSheet();
    ui.show(S.selectPurpose === 'lobby' ? 'lobby' : 'home');
  });
  $('sheet-close').addEventListener('click', closeSheet);
  $('sheet-backdrop').addEventListener('click', closeSheet);
  document.querySelectorAll('#audio-mode-row .seg-btn').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#audio-mode-row .seg-btn').forEach((x) => x.classList.remove('is-on'));
      b.classList.add('is-on');
      S.audioMode = b.dataset.mode;
      if (S.mode === 'host') hostBroadcastLobby();
    });
  });
  $('btn-ready').addEventListener('click', toggleReady);
  $('btn-start').addEventListener('click', hostStartGame);

  // Sélection
  $('btn-play').addEventListener('click', () => {
    if (!S.selectedTrack) return;
    if (S.selectPurpose === 'lobby') {
      hostPickTrack(S.selectedTrack.id);
      ui.show('lobby');
    } else {
      startSolo();
    }
  });
  $('speed-slider').addEventListener('input', (e) => {
    const v = storage.clampSpeed(parseFloat(e.target.value));
    storage.set('speed', v);
    updateSpeedHint();
    ui.refreshSettings();
  });

  // Calibration
  $('btn-calib-start').addEventListener('click', startCalibration);
  $('btn-calib-skip').addEventListener('click', () => {
    storage.set('calibrated', true);       // « plus tard » = accepté à 0 ms
    afterCalibration();
  });

  // Jeu
  $('btn-pause').addEventListener('click', () => S.game && S.game.pause());
  $('btn-resume').addEventListener('click', () => S.game && S.game.resume());
  $('btn-quit').addEventListener('click', () => S.game && S.game.quit());

  // Résultats
  $('btn-again').addEventListener('click', () => {
    if (S.mode === 'solo') startSolo();
    else ui.show('lobby');
  });
  $('btn-back-select').addEventListener('click', () => {
    if (S.mode === 'solo') { S.selectPurpose = 'solo'; openSelect(); }
    else ui.show('lobby');
  });

  // Réglages
  ui.bindSettings((key) => {
    if (key === 'volume') audio.setVolume(storage.get('volume'));
  });
  $('btn-recalib').addEventListener('click', () => goCalibrate('settings'));

  // Langue : FR / EN / 中文, appliquée immédiatement à toute l'interface.
  const langBox = $('set-lang');
  const renderLangs = () => {
    langBox.innerHTML = '';
    for (const l of i18n.LANGS) {
      const b = document.createElement('button');
      b.className = 'seg-btn' + (i18n.current() === l.id ? ' is-on' : '');
      b.textContent = l.name;
      b.addEventListener('click', () => {
        i18n.setLang(l.id);
        renderLangs();
      });
      langBox.appendChild(b);
    }
  };
  renderLangs();

  ui.onScreenChange((name) => {
    if (name === 'settings') ui.startSpeedPreview();
    else ui.stopSpeedPreview();
    if (name !== 'select') {
      previewToken++;                      // invalide les préversions en attente
      audio.stopPreview();
    }
  });

  // Orientation : en paysage pendant le jeu, on affiche l'écran « tourne ».
  const checkRotate = () => {
    const landscape = window.innerWidth > window.innerHeight && window.innerHeight < 480;
    $('rotate').hidden = !(landscape && ui.screen() === 'game');
  };
  window.addEventListener('resize', checkRotate);
  ui.onScreenChange(checkRotate);

  // Onglet en arrière-plan : pause en solo, rattrapage en multi.
  document.addEventListener('visibilitychange', () => {
    if (!S.game) return;
    if (document.hidden) {
      S.game.onHidden();
    } else {
      // Le navigateur libère le wake lock quand l'onglet passe en arrière-plan
      // (appel, notification…) : il faut le redemander au retour.
      S.game.acquireWakeLock();
    }
  });

  // Code de room dans le hash : #KYRO
  const hashCode = normalizeCode(location.hash.slice(1));
  if (hashCode && window.Peer) {
    ui.show('join');
    $('join-code').value = hashCode;
  } else {
    ui.show('home');
  }

  if (!window.Peer) {
    $('net-note').textContent = t('net_unavailable');
    $('btn-create').disabled = true;
    $('btn-join').disabled = true;
  }

  loadIndex().then((tracks) => {
    S.tracks = tracks;
    const last = tracks.find((t) => t.id === storage.get('lastTrack'));
    S.selectedTrack = last || tracks[0];
  }).catch(() => {
    ui.toast(t('tracks_error'));
  });
}

/* ══════════════════ Sélection de morceau ══════════════════ */

function openSelect() {
  ui.show('select');
  closeSheet();
  $('btn-play').textContent = S.selectPurpose === 'lobby' ? t('select_pick') : t('select_play');
  ui.renderTrackList(S.tracks, S.selectedTrack && S.selectedTrack.id, (t) => {
    S.selectedTrack = t;
    storage.set('lastTrack', t.id);
    openSheet(t);
  }, (trackId, diffName) => {
    const best = storage.bestFor(trackId, diffName);
    return best ? best.grade : null;
  });
}

/** Fenêtre de paramétrage : réglages + JOUER, préversion à l'ouverture. */
function openSheet(t) {
  $('sheet-title').textContent = t.title;
  $('sheet-meta').textContent = `${t.artist} · ${t.bpm} BPM · ${Math.floor(t.duration / 60)}:${String(Math.round(t.duration % 60)).padStart(2, '0')}`;
  $('sheet-backdrop').hidden = false;
  $('select-sheet').hidden = false;
  $('speed-slider').value = storage.get('speed');
  renderSelectDiff();
  renderSelectMods();
  applyAutoSpeed();
  previewTrack(t);
}

function closeSheet() {
  $('sheet-backdrop').hidden = true;
  $('select-sheet').hidden = true;
  previewToken++;
  audio.stopPreview();
}

function renderSelectMods() {
  ui.renderModsSeg($('select-mods'), MODS, storage.get('mods') || [], (id, on) => {
    const mods = new Set(storage.get('mods') || []);
    if (on) mods.add(id); else mods.delete(id);
    storage.set('mods', [...mods]);
    ui.setModsSummary($('mods-mult'), multiplierFor([...mods]));
  });
  ui.setModsSummary($('mods-mult'), multiplierFor(storage.get('mods') || []));
}

function renderSelectDiff() {
  const t = S.selectedTrack;
  if (!t) return;
  if (!t.levels.some((l) => l.name === S.myDiff)) S.myDiff = t.levels[0].name;
  ui.renderDiffSeg($('select-diff'), t.levels, S.myDiff, (name) => {
    S.myDiff = name;
    storage.set('lastDiff', name);
    applyAutoSpeed();
  }, (diffName) => {
    const best = storage.bestFor(t.id, diffName);
    return best ? best.grade : null;
  });
}

function updateSpeedHint() {
  const t = S.selectedTrack;
  const speed = storage.get('speed');
  if (!t) return ui.describeSpeed(speed, null);
  loadTrack(t.id).then((track) => {
    ui.describeSpeed(speed, { bpm: track.bpm, nps: density(track, S.myDiff) });
  }).catch(() => ui.describeSpeed(speed, null));
}

/**
 * À chaque sélection de morceau ou de difficulté, la vitesse de chute est
 * recalée d'office pour n'afficher qu'entre 1 et 1,5 note à la fois.
 * Le joueur peut ensuite l'ajuster au slider : son choix tient jusqu'à la
 * prochaine sélection.
 */
function applyAutoSpeed() {
  const t = S.selectedTrack;
  if (!t) return;
  loadTrack(t.id).then((track) => {
    const nps = density(track, S.myDiff);
    const v = storage.suggestSpeed(track.bpm, nps);
    storage.set('speed', v);
    const slider = $('speed-slider');
    if (slider) slider.value = v;
    ui.refreshSettings();
    ui.describeSpeed(v, { bpm: track.bpm, nps });
  }).catch(() => {});
}

let previewToken = 0;
function previewTrack(t) {
  // Prépare la piste puis joue son refrain en boucle tant qu'on est sur
  // l'écran de sélection (le bouton JOUER devient instantané au passage).
  const token = ++previewToken;
  loadTrack(t.id)
    .then((track) => audio.prepare(t.id, null, track.audio).then(() => track))
    .then((track) => {
      if (token !== previewToken || ui.screen() !== 'select') return;
      audio.startPreview(t.id, track.previewStart || 0);
    })
    .catch(() => {});
}

/* ══════════════════ Calibration ══════════════════ */

let calib = null;

function goCalibrate(returnTo) {
  S.pendingCalibReturn = returnTo;
  $('calib-result').textContent = '';
  $('calib-count').innerHTML = '0<span>/20</span>';
  $('btn-calib-start').textContent = t('calib_start');
  ui.show('calib');
}

function startCalibration() {
  audio.unlock();
  $('calib-result').textContent = '';
  $('btn-calib-start').disabled = true;
  const pulse = $('calib-pulse');
  const stage = $('calib-stage');

  calib = new Calibration({
    onTick: () => {
      pulse.classList.add('hit');
      setTimeout(() => pulse.classList.remove('hit'), 90);
    },
    onTap: (n) => {
      $('calib-count').innerHTML = `${n}<span>/20</span>`;
      if (storage.get('vibrate') && navigator.vibrate) navigator.vibrate(8);
    },
    onDone: (r) => {
      stage.removeEventListener('pointerdown', onTapDown);
      $('btn-calib-start').disabled = false;
      if (r.unstable) {
        $('calib-result').textContent = t('calib_unstable', { off: r.offset, dev: r.deviation });
        $('btn-calib-start').textContent = t('calib_retry');
        return;
      }
      storage.set('offset', r.offset);
      storage.set('calibrated', true);
      $('calib-result').textContent = t('calib_done', { off: r.offset, dev: r.deviation });
      ui.refreshSettings();
      setTimeout(afterCalibration, 1100);
    }
  });

  const onTapDown = (e) => {
    e.preventDefault();
    calib.tap(e.timeStamp);
  };
  // Sur PC, la calibration s'effectue aussi au clavier : la latence clavier
  // diffère de la latence tactile, il faut mesurer avec ce qui servira à jouer.
  const onKeyDown = (e) => {
    if (e.repeat || !calib) return;
    if (['z', 'e', 'i', 'o', 'd', 'f', 'j', 'k', ' '].includes((e.key || '').toLowerCase())) {
      e.preventDefault();
      calib.tap(e.timeStamp);
    }
  };
  stage.addEventListener('pointerdown', onTapDown, { passive: false });
  window.addEventListener('keydown', onKeyDown);
  const oldStop = calib.stop.bind(calib);
  calib.stop = () => { window.removeEventListener('keydown', onKeyDown); oldStop(); };
  calib.start();
}

function afterCalibration() {
  if (calib) { calib.stop(); calib = null; }
  const dest = S.pendingCalibReturn;
  S.pendingCalibReturn = null;
  if (dest === 'select-solo') openSelect();
  else if (dest === 'create') createRoom();
  else if (dest === 'join') clientEnterLobby();
  else if (dest === 'settings') ui.show('settings');
  else ui.show('home');
}

/* ══════════════════ Partie (contrôleur commun) ══════════════════ */

class Game {
  /**
   * @param {object} track      chart complète
   * @param {string} diffName
   * @param {object} opts { multi:bool, silent:bool, startPerf:number|null,
   *                        seek:number }
   */
  constructor(track, diffName, opts = {}) {
    this.track = track;
    this.diffName = diffName;
    this.opts = opts;
    this.diff = getDifficulty(track, diffName);

    // Effets actifs. En multijoueur, NIGHTCORE est neutralisé : en mode salon
    // la musique accélérée d'un joueur se désynchroniserait de ce que la
    // pièce entend, et le départ commun suppose la même durée pour tous.
    this.mods = (storage.get('mods') || []).filter((m) => !opts.multi || m !== 'NIGHTCORE');
    this.rate = this.mods.includes('NIGHTCORE') ? 1.25 : 1;
    this.mult = multiplierFor(this.mods);

    let notes = this.diff.notes;
    if (this.mods.includes('MIRROR')) {
      notes = notes.map(([lane, t, d]) => [3 - lane, t, d]);
    }
    this.engine = new Engine(notes);
    this.renderer = new Renderer($('game-canvas'));
    this.finished = false;
    this.paused = false;
    this.userOffset = storage.get('offset') / 1000;
    this.lastProgressSend = 0;

    this.input = new Input($('game-canvas'), {
      onPress: (lane, ts) => this.onPress(lane, ts),
      onRelease: (lane, ts) => this.onRelease(lane, ts)
    });

    $('hud-song').textContent = `${track.title} — ${diffName}`;
    $('hud-score').textContent = '0';
    $('life-bar').style.width = '70%';
    $('pause-overlay').hidden = true;
    $('btn-pause').style.display = opts.multi ? 'none' : '';
    $('rivals').innerHTML = '';
    ui.show('game');

    this.renderer.setChart(this.engine.notes, track.bpm, storage.get('speed'));
    this.renderer.setWaveform(audio.waveform(track.id), track.color);
    this.renderer.mods = { fade: this.mods.includes('FADE'), sudden: this.mods.includes('SUDDEN') };
    this.renderer.failedText = t('game_failed');

    // Échap : pause / reprise (solo uniquement, comme le bouton II).
    this._onEsc = (e) => {
      if (e.key !== 'Escape' || this.finished || this.opts.multi) return;
      e.preventDefault();
      if (this.paused) this.resume();
      else this.pause();
    };
    window.addEventListener('keydown', this._onEsc);

    // L'écran ne doit pas s'éteindre pendant un morceau.
    this.wakeLock = null;
    this.acquireWakeLock();

    this.start();
  }

  acquireWakeLock() {
    if (!navigator.wakeLock || this.finished) return;
    navigator.wakeLock.request('screen')
      .then((l) => { this.wakeLock = l; })
      .catch(() => {});
  }

  start() {
    const { silent = false, startPerf = null, seek = 0 } = this.opts;
    let delay = 3.2;                       // décompte 3‑2‑1 par défaut
    let actualSeek = seek;
    if (startPerf !== null) {
      // Départ programmé (multi) : startPerf est déjà en temps local.
      delay = (startPerf - performance.now()) / 1000;
      if (delay < 0.05) {
        // Client trop lent : on démarre tout de suite en sautant la portion
        // écoulée, plutôt que de jouer en décalé (§7.4).
        actualSeek = seek - delay + 0.15;
        delay = 0.15;
      }
    }
    const { perfAtStart } = audio.start(this.track.id, { delay, silent, seek: actualSeek, rate: this.rate });
    this.perfAtStart = perfAtStart;
    this.input.enabled = true;
    this.loop();
  }

  songTime() {
    return audio.songTime();
  }

  onPress(lane, timeStampMs) {
    if (this.finished || this.paused) return;
    const age = (performance.now() - timeStampMs) / 1000;
    const t = this.songTime() - (age + this.userOffset) * this.rate;
    const res = this.engine.press(lane, t);
    this.renderer.pressed[lane] = true;
    if (res) {
      this.renderer.flash(lane, res.judgment);
      this.renderer.label(res.judgment);
      this.renderer.setCombo(this.engine.combo);
      if (storage.get('hitsound')) audio.hitSound();
      if (storage.get('vibrate') && navigator.vibrate && res.judgment !== 'MISS') navigator.vibrate(10);
    } else {
      this.renderer.flash(lane, null);
    }
  }

  onRelease(lane, timeStampMs) {
    if (this.finished) return;
    const age = (performance.now() - timeStampMs) / 1000;
    const t = this.songTime() - (age + this.userOffset) * this.rate;
    const j = this.engine.release(lane, t);
    this.renderer.pressed[lane] = false;
    if (j === 'GOOD') this.renderer.label('GOOD');
  }

  loop() {
    this.raf = requestAnimationFrame(() => this.loop());
    if (this.paused) return;
    const t = this.songTime();

    this.engine.update(t);
    // Événements du moteur : MISS détectés par l'avancée du temps (les autres
    // jugements ont déjà eu leur feedback à la frappe) et montées de fever.
    for (const ev of this.engine.events.splice(0)) {
      if (ev.type === 'judge' && ev.judgment === 'MISS') {
        this.renderer.label('MISS');
        this.renderer.setCombo(0);
      } else if (ev.type === 'fever') {
        this.renderer.feverUp(ev.level);
        audio.feverSound(ev.level);
        if (storage.get('vibrate') && navigator.vibrate) navigator.vibrate([25, 30, 25]);
      }
    }
    // Le badge suit le niveau réel (retombe à ×1 quand le combo casse).
    this.renderer.feverLevel = this.engine.fever;

    this.renderer.pressed = this.input.pressedLanes();
    this.renderer.setCombo(this.engine.combo);
    this.renderer.failed = this.engine.failed;
    this.renderer.draw(t);

    // HUD
    $('hud-score').textContent = Math.round(this.engine.score * this.mult).toLocaleString('fr-FR');
    if (t - (this.lastProgressUi || -1) >= 0.25) {
      this.lastProgressUi = t;
      $('song-progress-fill').style.width =
        Math.min(100, Math.max(0, (t / this.track.duration) * 100)) + '%';
    }
    const life = $('life-bar');
    life.style.width = this.engine.life + '%';
    life.classList.toggle('low', this.engine.life < 30);

    // Décompte
    const cd = $('countdown');
    if (t < 0) {
      cd.hidden = false;
      const n = Math.ceil(-t);
      if (n <= 3) {
        cd.textContent = n;
        cd.classList.remove('go');
      } else {
        cd.textContent = '';
      }
    } else if (!cd.hidden) {
      if (t < 0.6) { cd.textContent = 'GO'; cd.classList.add('go'); }
      else { cd.hidden = true; cd.classList.remove('go'); }
    }

    // Progression réseau, 4 fois par seconde
    if (this.opts.multi && t - this.lastProgressSend >= 0.25) {
      this.lastProgressSend = t;
      const snap = this.engine.snapshot();
      snap.score = Math.round(snap.score * this.mult);
      sendProgress(snap);
    }

    if (t > this.track.duration + 1.2 && !this.finished) this.finish();
  }

  pause() {
    if (this.opts.multi || this.finished) return;
    this.paused = true;
    this.pausedAt = this.songTime();
    audio.stop();
    this.input.enabled = false;
    $('pause-overlay').hidden = false;
  }

  onHidden() {
    if (this.finished) return;
    if (!this.opts.multi) this.pause();
    else ui.toast(t('game_hidden'));
  }

  resume() {
    $('pause-overlay').hidden = true;
    // Reprise 2 s en arrière, avec décompte, pour se remettre dans le rythme.
    const seek = Math.max(0, this.pausedAt - 2);
    const { perfAtStart } = audio.start(this.track.id, { delay: 1.2, silent: this.opts.silent, seek, rate: this.rate });
    this.perfAtStart = perfAtStart;
    this.paused = false;
    this.input.enabled = true;
  }

  quit() {
    this.dispose();
    audio.stop();
    if (S.mode === 'solo') { S.selectPurpose = 'solo'; openSelect(); }
    else ui.show('lobby');
  }

  finish() {
    this.finished = true;
    this.input.enabled = false;
    const res = this.engine.results();
    res.score = Math.round(res.score * this.mult);
    res.diffName = this.diffName;
    res.mods = this.mods;
    this.dispose();
    onGameFinished(res);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this._onEsc);
    this.input.dispose();
    this.renderer.dispose();
    if (this.wakeLock) { this.wakeLock.release().catch(() => {}); this.wakeLock = null; }
    S.game = null;
  }
}

/* ══════════════════ Solo ══════════════════ */

async function startSolo() {
  const t = S.selectedTrack;
  if (!t) return;
  storage.set('lastTrack', t.id);
  try {
    const track = await withLoading(t.id);
    S.game = new Game(track, S.myDiff, { multi: false });
  } catch (e) {
    ui.toast(t('loading_error'));
    ui.show('select');
  }
}

async function withLoading(trackId) {
  ui.show('loading');
  $('loader-bar').style.width = '0%';
  const track = await loadTrack(trackId);
  const imported = !!track.audio;
  $('loading-title').textContent = t(imported ? 'loading_load' : 'loading_synth');
  $('loading-hint').textContent = t(imported ? 'loading_load_hint' : 'loading_synth_hint');
  await audio.prepare(trackId, (p) => {
    $('loader-bar').style.width = Math.round(p * 100) + '%';
  }, track.audio);
  return track;
}

function onGameFinished(res) {
  audio.stop();
  // Record local : pour tous les modes, on garde le meilleur par morceau +
  // difficulté (le grade reste basé sur la précision, effets ou non).
  let recordInfo = null;
  if (S.selectedTrack) {
    recordInfo = storage.saveScore(S.selectedTrack.id, res.diffName, {
      score: res.score,
      grade: res.failed ? 'D' : res.grade,
      precision: Math.round(res.precision * 10000) / 10000,
      comboMax: res.comboMax,
      mods: res.mods || []
    });
  }
  if (S.mode === 'solo') {
    ui.renderResults({ title: S.selectedTrack.title }, res, null, S.myId);
    ui.renderLocalBoard(
      storage.boardFor(S.selectedTrack.id, res.diffName),
      recordInfo && recordInfo.record,
      res.score
    );
    ui.show('results');
  } else if (S.mode === 'client') {
    S.net.send({ t: 'FINISHED', ...publicResult(res) });
    S.myResult = res;
    ui.renderResults({ title: S.selectedTrack.title }, res, null, S.myId);
    ui.renderLocalBoard([], false, 0);
    ui.show('results');
    ui.toast(t('res_waiting_rank'));
  } else if (S.mode === 'host') {
    S.myResult = res;
    const me = S.players.get(HOST_ID);
    if (me) me.result = publicResult(res);
    // D'abord ses propres résultats, PUIS le classement quand tout le monde a
    // fini (hostMaybeSendResults re-peint l'écran avec le ranking). Si un
    // joueur ne rend jamais sa copie, on publie quand même au bout de 12 s.
    ui.renderResults({ title: S.selectedTrack.title }, res, null, S.myId);
    ui.renderLocalBoard([], false, 0);
    ui.show('results');
    clearTimeout(S.resultsDeadline);
    S.resultsDeadline = setTimeout(() => hostMaybeSendResults(true), 12000);
    hostMaybeSendResults();
  }
}

function publicResult(res) {
  return {
    score: res.score, precision: res.precision, comboMax: res.comboMax,
    counts: res.counts, grade: res.failed ? 'FAILED' : res.grade
  };
}

/* ══════════════════ Multijoueur : commun ══════════════════ */

function sendProgress(snap) {
  if (S.mode === 'client' && S.net) {
    S.net.send({ t: 'PROGRESS', ...snap });
  } else if (S.mode === 'host' && S.net) {
    const me = S.players.get(HOST_ID);
    if (me) me.progress = snap;
    hostBroadcastScores();
  }
}

function updateRivals(scores) {
  if (!S.game) return;
  const list = [];
  for (const [id, p] of S.players) {
    if (id === S.myId) continue;
    const prog = scores[id] || p.progress || {};
    list.push({ name: p.name, color: p.color, score: prog.score || 0, off: p.off });
  }
  ui.renderRivals(list);
}

function leaveRoom() {
  if (S.net) { S.net.close(); S.net = null; }
  S.players.clear();
  S.roomCode = null;
  S.mode = 'solo';
  S.hostLeft = false;
  document.body.classList.remove('is-host');
  history.replaceState(null, '', location.pathname + location.search);
}

function lobbyPlayersArray() {
  return [...S.players.entries()].map(([id, p]) => ({ id, ...p, isHost: id === HOST_ID }));
}

/* ══════════════════ Hôte ══════════════════ */

function createRoom() {
  leaveRoom();
  S.mode = 'host';
  S.myId = HOST_ID;
  document.body.classList.add('is-host');
  ui.show('lobby');
  $('lobby-status').textContent = t('lobby_opening');
  $('room-code').textContent = '····';

  S.players.set(HOST_ID, {
    name: displayName(), color: storage.get('color'),
    ready: false, difficulty: S.myDiff, off: false
  });
  refreshLobby();

  S.net = new Host({
    onOpen: (code) => {
      S.roomCode = code;
      $('room-code').textContent = code;
      const url = location.origin + location.pathname + '#' + code;
      ui.drawQr($('qr-canvas'), url);
      history.replaceState(null, '', '#' + code);
      $('lobby-status').textContent = t('lobby_share');
      hostPickTrack((S.selectedTrack || S.tracks[0]).id);
    },
    onError: (err) => {
      $('lobby-status').textContent = t('lobby_open_fail', { err });
      ui.toast(t('net_broker'));
    },
    onJoin: (peerId) => {
      // Le joueur enverra JOIN {name,color} ; on l'inscrit dès sa connexion
      // pour que la room affiche quelque chose immédiatement.
      S.players.set(peerId, { name: '…', color: '#8f93b8', ready: false, difficulty: 'NORMAL', off: false });
      refreshLobby();
      hostBroadcastLobby();
    },
    onLeave: (peerId) => {
      if (S.game) {
        const p = S.players.get(peerId);
        if (p) { p.off = true; refreshLobby(); }
      } else {
        S.players.delete(peerId);
        refreshLobby();
      }
      hostBroadcastLobby();
    },
    onMessage: hostOnMessage
  });
  S.net.open();
}

function hostOnMessage(peerId, msg) {
  const p = S.players.get(peerId);
  if (!p) return;
  p.lastSeen = performance.now();
  switch (msg.t) {
    case 'JOIN':
      p.name = String(msg.name || 'JOUEUR').slice(0, 10);
      p.color = /^#[0-9a-f]{6}$/i.test(msg.color) ? msg.color : '#8b5cff';
      p.off = false;
      refreshLobby();
      hostBroadcastLobby();
      ui.toast(t('lobby_joined', { name: p.name }));
      break;
    case 'READY':
      p.ready = !!msg.ready;
      if (typeof msg.difficulty === 'string') p.difficulty = msg.difficulty;
      refreshLobby();
      hostBroadcastLobby();
      break;
    case 'LOADED':
      p.loaded = true;
      hostMaybeLaunch();
      break;
    case 'PROGRESS':
      p.progress = { score: msg.score, combo: msg.combo, precision: msg.precision, life: msg.life };
      break;
    case 'FINISHED':
      p.result = {
        score: msg.score, precision: msg.precision, comboMax: msg.comboMax,
        counts: msg.counts, grade: msg.grade
      };
      hostMaybeSendResults();
      break;
  }
}

function hostPickTrack(trackId) {
  const t = S.tracks.find((x) => x.id === trackId) || S.tracks[0];
  S.selectedTrack = t;
  applyAutoSpeed();
  loadTrack(t.id).then((track) => ui.setLobbyTrack(track));
  S.net.broadcast({ t: 'TRACK', trackId: t.id });
  hostBroadcastLobby();
  loadTrack(t.id).then((tr) => audio.prepare(t.id, null, tr.audio)).catch(() => {});
  refreshLobby();
}

function hostBroadcastLobby() {
  if (S.mode !== 'host' || !S.net) return;
  S.net.broadcast({
    t: 'LOBBY',
    players: lobbyPlayersArray().map(({ id, name, color, ready, difficulty, off }) =>
      ({ id, name, color, ready, difficulty, off })),
    trackId: S.selectedTrack ? S.selectedTrack.id : null,
    audioMode: S.audioMode,
    hostName: displayName(),
    state: S.game ? 'playing' : 'lobby'
  });
}

let scoreTimer = 0;
function hostBroadcastScores() {
  const now = performance.now();
  if (now - scoreTimer < 240) return;
  scoreTimer = now;
  const scores = {};
  for (const [id, p] of S.players) {
    // Un client fantôme (Wi‑Fi coupé) peut mettre >15 s à déclencher 'close' :
    // pendant la partie, 4 s sans aucun message suffisent à le déclarer parti.
    if (id !== HOST_ID && !p.off && !p.result && p.lastSeen
        && now - p.lastSeen > 4000) {
      p.off = true;
      hostMaybeSendResults();
    }
    if (p.progress && !p.off) scores[id] = p.progress;
  }
  S.net.broadcast({ t: 'SCORES', scores });
  updateRivals(scores);
}

async function hostStartGame() {
  if (S.mode !== 'host' || !S.selectedTrack || S.game) return;
  const others = [...S.players.entries()].filter(([id]) => id !== HOST_ID);
  const notReady = others.filter(([, p]) => !p.ready && !p.off);
  if (notReady.length) return ui.toast(t('lobby_all_ready'));

  // Phase de chargement : chacun synthétise le morceau, puis LOADED.
  S.resultsSent = false;
  S.myResult = null;
  for (const [, p] of S.players) { p.loaded = false; p.result = null; p.progress = null; p.lastSeen = 0; }
  S.net.broadcast({ t: 'LOAD', trackId: S.selectedTrack.id, audioMode: S.audioMode });

  try {
    await withLoading(S.selectedTrack.id);
    $('loading-hint').textContent = t('loading_others');
  } catch {
    ui.toast(t('loading_error'));
    return ui.show('lobby');
  }
  const me = S.players.get(HOST_ID);
  me.loaded = true;

  // Timeout : au bout de 15 s on démarre sans les retardataires (§7.6).
  S.loadDeadline = setTimeout(() => hostMaybeLaunch(true), 15000);
  hostMaybeLaunch();
}

function hostMaybeLaunch(force = false) {
  if (S.mode !== 'host' || S.game || !S.players.get(HOST_ID)?.loaded) return;
  const waiting = [...S.players.values()].filter((p) => !p.loaded && !p.off);
  if (waiting.length && !force) return;
  clearTimeout(S.loadDeadline);

  const startAtHostTime = performance.now() + 3500;    // décompte 3‑2‑1 partout
  S.net.broadcast({
    t: 'START',
    trackId: S.selectedTrack.id,
    audioMode: S.audioMode,
    startAtHostTime
  });

  loadTrack(S.selectedTrack.id).then((track) => {
    S.game = new Game(track, S.players.get(HOST_ID).difficulty || S.myDiff, {
      multi: true,
      silent: false,                        // l'hôte diffuse toujours le son
      startPerf: startAtHostTime,
      seek: 0
    });
    hostBroadcastLobby();                   // état « partie en cours »
  });
}

function hostMaybeSendResults(force = false) {
  if (S.mode !== 'host' || S.resultsSent || !S.myResult) return;
  const entries = [...S.players.entries()];
  if (!force && entries.some(([, p]) => !p.result && !p.off)) return;
  const ranking = entries
    .filter(([, p]) => p.result || p.progress)     // jamais joué → pas classé
    .map(([id, p]) => ({
      id, name: p.name, color: p.color,
      off: !p.result,
      // Déconnecté en cours de morceau : classé sur son dernier score connu.
      ...(p.result || { score: (p.progress && p.progress.score) || 0, grade: '—' })
    }))
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  S.resultsSent = true;
  clearTimeout(S.resultsDeadline);
  S.liveScores = null;
  S.net.broadcast({ t: 'RESULTS', ranking });
  ui.renderResults({ title: S.selectedTrack.title }, { ...S.myResult, diffName: '' }, ranking, S.myId);
  for (const [, p] of S.players) { p.ready = false; }
  hostBroadcastLobby();
  refreshLobby();
}

/* ══════════════════ Client ══════════════════ */

function joinRoom() {
  const code = normalizeCode($('join-code').value);
  if (!code) return ui.toast(t('join_code4'));
  audio.unlock();
  S.joinCode = code;
  if (!storage.get('calibrated')) return goCalibrate('join');
  clientEnterLobby();
}

function clientEnterLobby() {
  leaveRoom();
  S.mode = 'client';
  S.myId = null;
  $('join-status').textContent = t('join_connecting');
  ui.show('join');

  S.net = new Client({
    onOpen: () => {
      S.myId = S.net.peer.id;
      S.net.send({ t: 'JOIN', name: displayName(), color: storage.get('color') });
      ui.show('lobby');
      $('room-code').textContent = S.joinCode;
      const url = location.origin + location.pathname + '#' + S.joinCode;
      ui.drawQr($('qr-canvas'), url);
      $('lobby-status').textContent = t('lobby_connected');
      // Sync d'horloge : indispensable au mode salon, relancée toutes les 15 s.
      S.clock = new ClockSync();
      const sync = () => S.clock.run((m) => S.net && S.net.send(m));
      sync();
      S.syncTimer = setInterval(() => { if (!S.game) sync(); }, 15000);
    },
    onMessage: clientOnMessage,
    onError: (err) => {
      $('join-status').textContent = t(err === 'not-found' ? 'join_notfound' : 'join_failed');
      ui.show('join');
    },
    onClose: () => {
      clearInterval(S.syncTimer);
      if (S.game) {
        // L'hôte a quitté : la partie se termine en solo (§7.6).
        S.hostLeft = true;
        ui.toast(t('host_left'));
      } else if (ui.screen() === 'lobby' || ui.screen() === 'results') {
        ui.toast(t('lobby_lost'));
        leaveRoom();
        ui.show('home');
      }
    }
  });
  S.net.connect(S.joinCode);
}

function clientOnMessage(msg) {
  switch (msg.t) {
    case 'PONG':
      S.clock.handlePong(msg);
      break;
    case 'LOBBY': {
      S.players.clear();
      for (const p of msg.players) S.players.set(p.id, p);
      S.roomState = msg.state || 'lobby';
      refreshLobby();
      const t = S.tracks.find((x) => x.id === msg.trackId);
      if (t) {
        S.selectedTrack = t;
        loadTrack(t.id).then((track) => ui.setLobbyTrack(track));
      }
      S.audioMode = msg.audioMode;
      break;
    }
    case 'TRACK': {
      const t = S.tracks.find((x) => x.id === msg.trackId);
      if (t) {
        S.selectedTrack = t;
        applyAutoSpeed();
        loadTrack(t.id).then((track) => {
          ui.setLobbyTrack(track);
          audio.prepare(t.id, null, track.audio).catch(() => {});
        });
      }
      break;
    }
    case 'LOAD':
      clientLoad(msg);
      break;
    case 'START':
      clientStart(msg);
      break;
    case 'SCORES':
      if (S.game) {
        updateRivals(msg.scores || {});
      } else if (ui.screen() === 'lobby') {
        // Partie en cours vue depuis le lobby : scores en direct des joueurs.
        S.liveScores = msg.scores || {};
        refreshLobby();
      }
      break;
    case 'RESULTS':
      ui.renderResults(
        { title: S.selectedTrack ? S.selectedTrack.title : '' },
        { ...(S.myResult || emptyResult()), diffName: '' },
        msg.ranking, S.myId
      );
      ui.show('results');
      break;
    case 'KICK':
      ui.toast(t(msg.reason === 'full' ? 'room_full' : 'room_kicked'));
      leaveRoom();
      ui.show('home');
      break;
  }
}

function emptyResult() {
  return { score: 0, precision: 0, comboMax: 0, grade: 'D', failed: false,
           counts: { PERFECT: 0, GREAT: 0, GOOD: 0, MISS: 0 } };
}

async function clientLoad(msg) {
  S.audioMode = msg.audioMode;
  try {
    await withLoading(msg.trackId);
    S.net.send({ t: 'LOADED' });
    $('loading-hint').textContent = t('loading_waiting');
  } catch {
    ui.toast(t('loading_error'));
  }
}

function clientStart(msg) {
  loadTrack(msg.trackId).then((track) => {
    const silent = msg.audioMode === 'shared';   // seul l'hôte diffuse le son
    let startPerf = null;
    if (silent && S.clock.synced) {
      // Timeline de l'hôte → temps local, à ±20 ms (mode salon).
      startPerf = S.clock.toLocal(msg.startAtHostTime);
    } else if (!silent) {
      // Mode casque : départ à réception, sans compensation fine.
      startPerf = performance.now() + 3200;
    } else {
      startPerf = performance.now() + 3200;
      ui.toast(t('sync_warn'));
    }
    const me = S.players.get(S.myId);
    S.game = new Game(track, (me && me.difficulty) || S.myDiff, {
      multi: true, silent, startPerf, seek: 0
    });
  });
}

/* ══════════════════ Lobby (rendu commun) ══════════════════ */

function refreshLobby() {
  const playing = S.mode === 'host' ? !!S.game : S.roomState === 'playing';
  const players = lobbyPlayersArray().map((p) => {
    if (playing && S.liveScores && S.liveScores[p.id]) {
      return { ...p, liveScore: S.liveScores[p.id].score };
    }
    return p;
  });
  ui.renderPlayers(players, S.myId);
  if (playing && S.mode === 'client' && !S.game) {
    $('lobby-status').textContent = t('lobby_playing');
  }
  const t = S.selectedTrack;
  if (t) {
    if (!t.levels.some((l) => l.name === S.myDiff)) S.myDiff = t.levels[0].name;
    ui.renderDiffSeg($('lobby-diff'), t.levels, S.myDiff, ((name) => {
      S.myDiff = name;
      storage.set('lastDiff', name);
      applyAutoSpeed();
      if (S.mode === 'client' && S.net) {
        const me = S.players.get(S.myId);
        S.net.send({ t: 'READY', ready: !!(me && me.ready), difficulty: name });
      } else if (S.mode === 'host') {
        const me = S.players.get(HOST_ID);
        if (me) me.difficulty = name;
        hostBroadcastLobby();
        refreshLobby();
      }
    }), (diffName) => {
      const best = storage.bestFor(t.id, diffName);
      return best ? best.grade : null;
    });
  }
  if (S.mode === 'host') {
    const others = [...S.players.entries()].filter(([id]) => id !== HOST_ID);
    const allReady = others.every(([, p]) => p.ready || p.off);
    $('btn-start').disabled = !allReady && others.length > 0;
    $('btn-ready').style.display = 'none';
  } else {
    $('btn-ready').style.display = '';
    const me = S.players.get(S.myId);
    $('btn-ready').textContent = t(me && me.ready ? 'lobby_unready' : 'lobby_ready');
  }
}

function toggleReady() {
  if (S.mode !== 'client' || !S.net) return;
  const me = S.players.get(S.myId);
  const ready = !(me && me.ready);
  if (me) me.ready = ready;
  S.net.send({ t: 'READY', ready, difficulty: S.myDiff });
  refreshLobby();
}

/* ══════════════════ Crédits ══════════════════ */

async function openCredits() {
  ui.show('credits');
  const box = $('credits-body');
  try {
    const md = await fetch('./tracks/CREDITS.md').then((r) => r.text());
    box.innerHTML = md
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/^### (.*)$/gm, '<h3>$1</h3>')
      .replace(/^## (.*)$/gm, '<h3>$1</h3>')
      .replace(/^# (.*)$/gm, '<h3>$1</h3>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n\n/g, '<br><br>');
  } catch {
    box.textContent = t('credits_offline');
  }
}

/* ══════════════════ Démarrage ══════════════════ */

boot();

// Crochet de debug/test : accès en lecture à l'état de session depuis la
// console (et depuis les tests automatisés). Aucune logique ne doit y écrire.
window.__NB = S;
