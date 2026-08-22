// Bootstrap et orchestration : navigation, partie solo, hôte et client.

import * as storage from './storage.js';
import * as audio from './audio.js';
import * as ui from './ui.js';
import { loadIndex, loadTrack, getDifficulty, density, to2Keys } from './chart.js';
import { Engine, feverBounds } from './engine.js';
import { Renderer } from './render.js';
import { Input } from './input.js';
import { Calibration } from './calibration.js';
import { ClockSync } from './clock.js';
import { Host, Client, normalizeCode, MAX_PLAYERS } from './net.js';
import { MODS, multiplierFor, modsLabel } from './mods.js';
import { SKINS, skinById, DEFAULT_SKIN } from './skins.js';
import * as online from './online.js';
import { TROPHIES, gradeCounts, progress, earned, applyResult, EMPTY_STATS } from './trophies.js';
import * as i18n from './i18n.js';
import { APP_VERSION } from './version.js';
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
  trackFilter: '',
  trackSort: 'tier',       // tier | az | dur

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
let renameTimer = 0;

function displayName() {
  return storage.get('name') || 'JOUEUR';
}

/* ══════════════════ Navigation & boutons ══════════════════ */

function boot() {
  i18n.init();
  initVersion();
  initInstall();
  initUiSounds();
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
  $('btn-trophies').addEventListener('click', () => { audio.unlock(); openTrophies(); });

  // Classement en ligne : les points d'entrée n'apparaissent que s'il est
  // configuré (voir js/online-config.js). Sinon le jeu ignore tout de lui.
  if (online.enabled()) {
    $('board-btns').hidden = false;
    $('btn-publish').hidden = false;
    $('btn-ranking').hidden = false;
    $('btn-ranking').addEventListener('click', openGlobalRanking);
    $('btn-board').addEventListener('click', () => openTrackBoard('global'));
    $('btn-mine').addEventListener('click', () => openTrackBoard('mine'));
    $('btn-publish').addEventListener('click', publishAllScores);
  }
  // Bascule entre le classement de tous et ses propres tentatives.
  $('board-seg').addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (b) showBoardView(b.dataset.view);
  });
  $('board-back').addEventListener('click', () => { closeSheet(); ui.show('select'); });
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
  $('track-search').addEventListener('input', (e) => {
    S.trackFilter = e.target.value;
    refreshTrackListGrades();
  });
  $('sort-az').addEventListener('click', () => {
    S.trackSort = S.trackSort === 'az' ? 'tier' : 'az';
    syncSortButtons();
    refreshTrackListGrades();
  });
  $('sort-dur').addEventListener('click', () => {
    S.trackSort = S.trackSort === 'dur' ? 'tier' : 'dur';
    syncSortButtons();
    refreshTrackListGrades();
  });
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
  // Offset manuel : pour qui connaît déjà sa latence (ou veut l'ajuster à
  // l'oreille), sans passer par le métronome.
  $('calib-offset').addEventListener('input', (e) => {
    const v = Math.max(-200, Math.min(200, parseInt(e.target.value, 10) || 0));
    storage.set('offset', v);
    $('calib-offset-val').textContent = `${v} ms`;
    ui.refreshSettings();
  });
  $('btn-calib-use').addEventListener('click', () => {
    storage.set('calibrated', true);
    afterCalibration();
  });

  // Jeu
  $('btn-loading-cancel').addEventListener('click', cancelLoading);

  $('btn-pause').addEventListener('click', () => S.game && S.game.pause());
  $('btn-resume').addEventListener('click', () => S.game && S.game.resume());
  $('btn-restart').addEventListener('click', () => S.game && S.game.restart());
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
    // Le champ du pseudo réagit à chaque frappe : on attend une pause avant
    // de renommer en ligne, sinon on enverrait une requête par caractère.
    if (key === 'name') {
      clearTimeout(renameTimer);
      renameTimer = setTimeout(async () => {
        const done = await online.syncName(displayName());
        if (done) ui.toast(t('board_renamed', { name: displayName() }), 3500);
      }, 1200);
    }
  });

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

  initFirstName();

  // Code de room dans le hash : #KYRO
  const hashCode = normalizeCode(location.hash.slice(1));
  if (!storage.get('name')) {
    // Tant qu'aucun pseudo n'est choisi, on le redemande à chaque lancement :
    // sans lui, le joueur n'est identifiable ni en salon ni au classement.
    ui.show('name');
    $('first-name').focus();
  } else if (hashCode && window.Peer) {
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
    initPrefetch();
    autoPublish();
  }).catch(() => {
    ui.toast(t('tracks_error'));
  });
}

/* ══════════════════ Pré-téléchargement des morceaux ══════════════════ */

// Cache permanent partagé avec le service worker (voir sw.js) : il survit aux
// mises à jour, donc chaque morceau n'est téléchargé qu'une seule fois.
const TRACKS_CACHE = 'neonbeat-tracks';

/**
 * Télécharge en tâche de fond tous les morceaux du catalogue, un par un, pour
 * que le chargement d'une map soit instantané. Se met en pause pendant les
 * parties (et pendant le chargement d'une map) pour ne pas voler la bande
 * passante ni le CPU au jeu.
 */
let prefetchAbort = null;

/**
 * Coupe net le téléchargement de fond en cours. Appelé dès qu'une map se
 * charge : sur une connexion mobile, un MP3 de fond monopolise la bande
 * passante et le morceau demandé mettrait une éternité à arriver.
 */
function pausePrefetch() {
  if (prefetchAbort) { prefetchAbort.abort(); prefetchAbort = null; }
}

async function initPrefetch() {
  if (!('caches' in window)) return; // navigation privée / navigateur ancien
  let cache;
  try { cache = await caches.open(TRACKS_CACHE); } catch { return; }

  const urls = S.tracks.map((tr) => new URL(`tracks/${tr.id}.mp3`, location.href).href);
  const missing = [];
  for (const u of urls) {
    try { if (!(await cache.match(u))) missing.push(u); } catch { missing.push(u); }
  }
  const total = urls.length;
  let done = total - missing.length;
  if (!missing.length) return; // tout est déjà sur l'appareil : silence total

  const el = $('dl-status');
  const paint = () => { el.textContent = t('dl_progress', { done, total }); };
  el.hidden = false;
  paint();

  const idle = () => !S.game && ui.screen() !== 'loading' && ui.screen() !== 'game';
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // On laisse d'abord l'accueil se mettre en place : personne n'attend ces
  // fichiers, autant ne pas saturer la connexion dès la première seconde.
  await wait(3000);

  // File d'attente : un fichier interrompu par une partie repart en fin de
  // file (3 tentatives max, sinon on l'abandonne pour cette session — jamais
  // de boucle infinie sur un fichier introuvable).
  const queue = missing.slice();
  const tries = new Map();
  while (queue.length) {
    const u = queue.shift();
    while (!idle()) await wait(1500);
    prefetchAbort = new AbortController();
    let ok = false;
    try {
      const res = await fetch(u, { signal: prefetchAbort.signal });
      if (res.ok) { await cache.put(u, res); ok = true; }
    } catch { /* interruption, hors-ligne ou espace plein */ }
    prefetchAbort = null;
    const n = (tries.get(u) || 0) + 1;
    tries.set(u, n);
    if (ok) { done++; paint(); }
    else if (n < 3) queue.push(u);
    // Une courte respiration entre deux fichiers : le jeu reste fluide et la
    // connexion respire si le joueur navigue dans le catalogue.
    await wait(400);
  }
  if (done < total) { el.hidden = true; return; }  // reste des manquants : on réessaiera au prochain lancement

  el.textContent = t('dl_done');
  setTimeout(() => { el.hidden = true; }, 6000);
}

/* ══════════════════ Trophées & skins ══════════════════ */

/** Skin actif, en retombant sur le skin par défaut s'il n'est pas débloqué. */
function activeSkin() {
  const skin = skinById(storage.get('skin'));
  return isSkinUnlocked(skin) ? skin : DEFAULT_SKIN;
}

function trophyState() {
  const stats = { ...EMPTY_STATS, ...storage.readStats() };
  return { stats, counts: gradeCounts(storage.allScores()) };
}

function isSkinUnlocked(skin) {
  if (!skin || !skin.unlock) return true;
  const { stats, counts } = trophyState();
  return earned(stats, counts).includes(skin.unlock);
}

/**
 * Annonce les trophées franchis depuis la dernière partie. La liste des
 * trophées déjà notifiés est mémorisée pour ne jamais répéter une annonce.
 */
function announceTrophies(stats) {
  const counts = gradeCounts(storage.allScores());
  const now = earned({ ...EMPTY_STATS, ...stats }, counts);
  const seen = new Set(stats.unlocked || []);
  const fresh = now.filter((id) => !seen.has(id));
  if (!fresh.length) return;
  storage.writeStats({ ...stats, unlocked: now });
  // Une annonce à la fois, espacées : deux toasts simultanés s'écrasent.
  fresh.forEach((id, i) => {
    const t0 = TROPHIES.find((x) => x.id === id);
    const skin = SKINS.find((sk) => sk.unlock === id);
    setTimeout(() => {
      audio.gradeJingle('S', false);
      ui.toast(skin
        ? t('trophy_new_skin', { name: t('trophy_' + id), skin: t('skin_' + skin.id) })
        : t('trophy_new', { name: t('trophy_' + id) }), 5200);
    }, 900 + i * 5600);
  });
}

/**
 * Écran de classement du morceau sélectionné, pour la difficulté et le mode
 * courants. Deux vues : le classement de tous les joueurs (en ligne) et ses
 * propres tentatives (lues en local, donc instantanées et hors ligne).
 */
function openTrackBoard(view) {
  const sel = S.selectedTrack;
  if (!sel) return;
  closeSheet();
  ui.show('board');
  const keys = storage.get('keys') || '4';
  $('board-sub').textContent = `${sel.title} — ${S.myDiff} · ${keys} ${t('mode_keys')}`;
  showBoardView(view || 'global');
}

let boardToken = 0;
async function showBoardView(view) {
  document.querySelectorAll('#board-seg .seg-btn').forEach((b) => {
    b.classList.toggle('is-on', b.dataset.view === view);
  });
  const sel = S.selectedTrack;
  if (!sel) return;
  const keys = storage.get('keys') || '4';
  const token = ++boardToken;      // une réponse tardive ne doit pas écraser la vue courante

  if (view === 'mine') {
    // L'historique des tentatives peut être vide alors qu'un meilleur score
    // existe (scores venus d'une version antérieure) : on retombe dessus
    // plutôt que d'annoncer à tort « jamais joué ».
    let rows = storage.boardFor(sel.id, S.myDiff, keys);
    if (!rows || !rows.length) {
      const best = storage.bestFor(sel.id, S.myDiff, keys);
      rows = best ? [best] : [];
    }
    // Rang en ligne, en complément : il donne du sens au meilleur score.
    ui.renderMyScores(rows, null);
    const all = await online.trackBoard(sel.id, S.myDiff, keys, 200);
    if (token !== boardToken) return;
    const me = online.playerId();
    const pos = all ? all.findIndex((r) => r.player_id === me) : -1;
    // « 1ᵉʳ » mais « 2ᵉ » : l'ordinal se construit ici, pas dans la traduction.
    const rang = pos + 1;
    ui.renderMyScores(rows, pos >= 0
      ? { pos: rang + (rang === 1 ? 'ᵉʳ' : 'ᵉ'), total: all.length }
      : null);
    return;
  }
  ui.boardLoading('board-list');
  const rows = await online.trackBoard(sel.id, S.myDiff, keys);
  if (token !== boardToken) return;
  ui.renderTrackBoard(rows, online.playerId());
}

/** Classement général de tous les joueurs, depuis l'accueil. */
async function openGlobalRanking() {
  ui.show('ranking');
  ui.boardLoading('ranking-list');
  ui.renderGlobalBoard(await online.globalBoard(), online.playerId());
}

/** Meilleurs scores locaux, mis en forme pour l'envoi. */
function localScoreList() {
  const list = [];
  for (const [key, entry] of Object.entries(storage.allScores())) {
    const [trackId, diff, k2] = key.split('|');
    if (!trackId || !diff) continue;
    list.push({ trackId, diff, keys: k2 === '2K' ? '2' : '4', entry });
  }
  return list;
}

/**
 * Synchronisation silencieuse au lancement, comme la vérification de
 * version : elle rattrape les parties jouées hors ligne et les renommages
 * en suspens. Sans rien afficher, et sans requête si rien n'a bougé.
 */
function autoPublish() {
  if (!online.enabled()) return;
  online.autoSync(displayName(), localScoreList()).catch(() => {});
}

/** Renvoie tous les meilleurs scores locaux d'un coup. */
async function publishAllScores() {
  if (!online.enabled()) return;
  const name = displayName();
  const list = localScoreList();
  if (!list.length) return ui.toast(t('board_none'));
  ui.toast(t('board_sending', { n: list.length }), 3000);
  const ok = await online.publishMany(name, list);
  ui.toast(ok ? t('board_sent', { n: list.length }) : t('board_error'), 4000);
}

function openTrophies() {
  const { stats, counts } = trophyState();
  const unlockedTrophies = earned(stats, counts);
  // Un skin est jouable si son trophée est obtenu (ou s'il n'en demande pas).
  const unlocked = SKINS.filter((sk) => !sk.unlock || unlockedTrophies.includes(sk.unlock)).map((sk) => sk.id);
  const skinFor = Object.fromEntries(SKINS.filter((sk) => sk.unlock).map((sk) => [sk.unlock, sk.id]));
  ui.show('trophies');
  ui.renderTrophies(
    { counts, stats, progress: progress(stats, counts), skins: SKINS, unlocked, skinFor, activeSkin: activeSkin().id },
    (id) => {
      storage.set('skin', id);
      audio.uiToggle(true);
      openTrophies();                 // repeint pour montrer la nouvelle sélection
    }
  );
}

/* ══════════════════ Bruitages de navigation ══════════════════ */

/**
 * Un seul écouteur en capture couvre TOUS les menus, y compris les éléments
 * créés à la volée (morceaux, difficultés, effets, couleurs, langues).
 * Aucun son pendant une partie : le canvas est exclu et l'écran de jeu aussi.
 */
function initUiSounds() {
  // Un clic sur un <label> déclenche aussi un clic sur sa case : sans ce
  // garde-fou, les interrupteurs sonneraient deux fois.
  let last = 0;

  document.addEventListener('click', (e) => {
    if (!storage.get('uisound')) return;
    const el = e.target instanceof Element ? e.target.closest('button, .track-item, .color-dot, label.switch') : null;
    if (!el || el.disabled) return;
    // En jeu, seuls les boutons du menu pause ont droit à un son.
    if (ui.screen() === 'game' && !el.closest('#pause-overlay')) return;
    const now = performance.now();
    if (now - last < 60) return;
    last = now;

    const id = el.id || '';
    const back = el.hasAttribute('data-back')
      || ['select-back', 'sheet-close', 'btn-back-select', 'btn-quit', 'btn-loading-cancel'].includes(id);
    const confirm = ['btn-solo', 'btn-create', 'btn-join-go', 'btn-play', 'btn-start',
                     'btn-again', 'btn-ready', 'btn-resume', 'btn-restart', 'btn-calib-use',
                     'btn-install'].includes(id)
      || el.classList.contains('btn-primary') || el.classList.contains('btn-host');
    const open = ['btn-settings', 'btn-calib-home', 'btn-change-track', 'btn-ranking',
                  'btn-join'].includes(id);
    const toggle = el.classList.contains('seg-btn') || el.classList.contains('sort-btn')
      || el.classList.contains('color-dot') || el.classList.contains('switch');

    if (back) audio.uiBack();
    else if (confirm) audio.uiConfirm();
    else if (open) audio.uiOpen();
    else if (el.classList.contains('track-item')) audio.uiSelect();
    else if (toggle) audio.uiToggle(!el.classList.contains('is-on'));
    else audio.uiTap();
  }, true);
}

/**
 * Écran de bienvenue : le pseudo est demandé au tout premier lancement, en
 * complément de la calibration (déclenchée, elle, au premier JOUER).
 */
function initFirstName() {
  const input = $('first-name');
  const go = $('btn-name-go');
  const valide = () => { go.disabled = !input.value.trim(); };
  input.addEventListener('input', valide);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !go.disabled) go.click(); });
  go.addEventListener('click', () => {
    const nom = input.value.trim().slice(0, 10);
    if (!nom) return;
    audio.unlock();                 // premier vrai geste : on amorce le son
    storage.set('name', nom);
    ui.refreshSettings();
    online.syncName(nom).catch(() => {});
    ui.show('home');
  });
  valide();
}

/* ══════════════════ Installation (PWA) ══════════════════ */

/** L'application tourne-t-elle depuis son icône plutôt que dans un onglet ? */
function isInstalled() {
  return ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay']
      .some((m) => window.matchMedia(`(display-mode: ${m})`).matches)
    || navigator.standalone === true;
}

/**
 * Marche à suivre quand le navigateur ne propose pas d'invite d'installation
 * (Safari, Firefox, et Chrome quand l'invite n'a pas encore été émise).
 */
function installHint() {
  const ua = navigator.userAgent;
  if (/iphone|ipad|ipod/i.test(ua)) return t('install_ios');
  // Android avant Firefox : Firefox pour Android sait installer depuis son
  // menu, contrairement à Firefox de bureau.
  if (/android/i.test(ua)) return t('install_android');
  if (/firefox/i.test(ua)) return t('install_firefox');
  // Safari de bureau : « Ajouter au Dock » (macOS Sonoma et suivants)
  if (/safari/i.test(ua) && !/chrome|chromium|edg\//i.test(ua)) return t('install_safari_mac');
  return t('install_desktop');
}

function initInstall() {
  const btn = $('btn-install');

  // Tant que le jeu n'est pas installé, l'accueil met en avant l'installation
  // à la place du bouton de mise à jour — et ce sur TOUS les navigateurs, y
  // compris ceux qui n'émettent jamais « beforeinstallprompt » (Safari,
  // Firefox). La mise à jour reste accessible depuis les réglages.
  const installed = isInstalled();
  btn.hidden = installed;
  $('btn-update-home').hidden = !installed;
  if (installed) return;

  let deferredPrompt = null;

  // Chrome / Edge / Android : le navigateur signale que l'installation est
  // possible — on capture l'invite pour la déclencher depuis notre bouton.
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
  });

  btn.addEventListener('click', async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice.catch(() => null);
      deferredPrompt = null;
      if (choice && choice.outcome === 'accepted') btn.hidden = true;
    } else {
      ui.toast(installHint(), 7000);
    }
  });

  window.addEventListener('appinstalled', () => {
    btn.hidden = true;
    $('btn-update-home').hidden = false;
    ui.toast(t('install_done'));
  });
}

/* ══════════════════ Version & mise à jour ══════════════════ */

const updateButtons = () => [$('btn-update'), $('btn-update-home')].filter(Boolean);

function initVersion() {
  $('ver-current').textContent = 'v' + APP_VERSION;
  $('btn-update-home').textContent = t('ver_update') + ' · v' + APP_VERSION;

  // Notification de version au lancement : « mis à jour ! » si elle a changé
  // depuis la dernière visite, sinon simple rappel de la version installée.
  const last = storage.get('lastVersion');
  if (last && last !== APP_VERSION) {
    ui.toast(t('ver_installed', { v: APP_VERSION }), 3500);
  } else {
    ui.toast(t('ver_hello', { v: APP_VERSION }), 1800);
  }
  storage.set('lastVersion', APP_VERSION);

  for (const b of updateButtons()) b.addEventListener('click', checkForUpdate);

  // Vérification silencieuse au lancement : si une nouvelle version est en
  // ligne, on le signale et on met le bouton des réglages en évidence.
  fetchRemoteVersion().then((remote) => {
    if (remote.version && parseFloat(remote.version) > parseFloat(APP_VERSION)) {
      ui.toast(t('ver_available', { v: remote.version }), 5000);
      for (const b of updateButtons()) {
        b.classList.add('has-update');
        b.textContent = t('ver_update') + ' → v' + remote.version;
      }
    }
  }).catch(() => {});
}

function fetchRemoteVersion() {
  // cache: 'no-store' + garde-fou côté service worker : version.json vient
  // TOUJOURS du réseau, sinon les mises à jour seraient indétectables.
  // Retourne { version, files } — files liste les fichiers de l'application
  // de la NOUVELLE version (générée par tools/bump-version.mjs).
  return fetch('./version.json', { cache: 'no-store' })
    .then((r) => { if (!r.ok) throw new Error(); return r.json(); });
}

// Repli si version.json ne liste pas encore les fichiers (vieux déploiement).
const CORE_FILES = ['./', './index.html', './css/style.css', './js/main.js', './js/version.js'];

async function checkForUpdate() {
  let remote = null;
  try {
    remote = await fetchRemoteVersion();
  } catch {
    return ui.toast(t('ver_offline'));
  }
  if (parseFloat(remote.version) <= parseFloat(APP_VERSION)) {
    return ui.toast(t('ver_uptodate', { v: APP_VERSION }));
  }
  ui.toast(t('ver_installing'), 8000);
  // Le cache des morceaux est permanent : on ne re-télécharge jamais 100 Mo
  // de musique pour une mise à jour du code.
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== TRACKS_CACHE).map((k) => caches.delete(k)));
    }
    // GitHub Pages sert les fichiers avec un cache HTTP de 10 minutes : un
    // simple reload rechargerait l'ANCIENNE version depuis ce cache (et le
    // bouton « mettre à jour » resterait affiché). cache:'reload' contourne
    // le cache HTTP et y range les fichiers frais avant de recharger.
    const files = (Array.isArray(remote.files) && remote.files.length) ? remote.files : CORE_FILES;
    await Promise.all(files.map((f) => fetch(f, { cache: 'reload' }).catch(() => {})));
    if (navigator.serviceWorker) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) await reg.update();
    }
  } catch { /* on recharge quand même */ }
  setTimeout(() => location.reload(), 300);
}

/* ══════════════════ Sélection de morceau ══════════════════ */

function openSelect() {
  ui.show('select');
  closeSheet();
  $('btn-play').textContent = S.selectPurpose === 'lobby' ? t('select_pick') : t('select_play');
  const search = $('track-search');
  search.placeholder = t('search_ph');
  search.value = S.trackFilter;
  syncSortButtons();
  refreshTrackListGrades();
}

/** A→Z et durée sont des bascules : re-cliquer revient à l'ordre par niveau. */
function syncSortButtons() {
  $('sort-az').classList.toggle('is-on', S.trackSort === 'az');
  $('sort-dur').classList.toggle('is-on', S.trackSort === 'dur');
}

/** Fenêtre de paramétrage : réglages + JOUER, préversion à l'ouverture. */
function renderKeysChips(containerId, refresh) {
  const el = $(containerId);
  if (!el) return;
  ui.renderKeysSeg(el, storage.get('keys') || '4', (k) => {
    storage.set('keys', k);
    refresh();
  });
}

function openSheet(t) {
  $('sheet-cover').src = ui.coverFor(t);
  $('sheet-title').textContent = t.title;
  $('sheet-meta').textContent = `${t.artist} · ${t.bpm} BPM · ${Math.floor(t.duration / 60)}:${String(Math.round(t.duration % 60)).padStart(2, '0')}`;
  $('sheet-backdrop').hidden = false;
  $('select-sheet').hidden = false;
  $('speed-slider').value = storage.get('speed');
  renderKeysChips('select-keys', () => { renderSelectDiff(); refreshTrackListGrades(); updateSpeedHint(); });
  renderSelectDiff();
  renderSelectMods();
  applyAutoSpeed();
  previewTrack(t);
}

/** Sans accents ni casse : « Cœur » trouve « coeur ». */
function foldText(str) {
  return (str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/œ/g, 'oe').replace(/æ/g, 'ae').toLowerCase();
}

/** Applique la recherche et le tri courants au catalogue. */
function visibleTracks() {
  let list = S.tracks;
  const q = foldText(S.trackFilter.trim());
  if (q) list = list.filter((t) => foldText(t.title).includes(q) || foldText(t.artist).includes(q));
  list = [...list];
  if (S.trackSort === 'az') {
    list.sort((a, b) => a.title.localeCompare(b.title, 'fr', { sensitivity: 'base' }));
  } else if (S.trackSort === 'dur') {
    list.sort((a, b) => a.duration - b.duration);
  }
  // 'tier' : ordre de l'index (déjà par difficulté croissante)
  return list;
}

/** Re-rend la liste des morceaux (recherche, tri, grades du mode courant). */
function refreshTrackListGrades() {
  const list = visibleTracks();
  $('search-empty').hidden = list.length > 0;
  ui.renderTrackList(list, S.selectedTrack && S.selectedTrack.id, (t) => {
    S.selectedTrack = t;
    storage.set('lastTrack', t.id);
    openSheet(t);
  }, (trackId, diffName) => {
    const best = storage.bestFor(trackId, diffName, storage.get('keys'));
    return best ? best.grade : null;
  });
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
    const best = storage.bestFor(t.id, diffName, storage.get('keys'));
    return best ? best.grade : null;
  });
}

function updateSpeedHint() {
  const sel = S.selectedTrack;
  const speed = storage.get('speed');
  if (!sel) { ui.describeSpeed(speed, null); ui.showMaxCombo(0); return; }
  loadTrack(sel.id).then((track) => {
    ui.describeSpeed(speed, { bpm: track.bpm, nps: density(track, S.myDiff) });
    ui.showMaxCombo(maxComboOf(track, S.myDiff, storage.get('keys')));
  }).catch(() => { ui.describeSpeed(speed, null); ui.showMaxCombo(0); });
}

/**
 * Combo maximal atteignable : une note jugée = un point de combo, donc
 * c'est le nombre de notes de la chart. En 2 touches, to2Keys en fusionne
 * certaines : le total est calculé sur la chart réellement jouée.
 */
function maxComboOf(track, diffName, keysMode) {
  const def = getDifficulty(track, diffName);
  if (!def || !def.notes) return 0;
  return (keysMode === '2' ? to2Keys(def.notes) : def.notes).length;
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
    ui.showMaxCombo(maxComboOf(track, S.myDiff, storage.get('keys')));
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
  $('calib-offset').value = storage.get('offset');
  $('calib-offset-val').textContent = `${storage.get('offset')} ms`;
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

    this.keysMode = storage.get('keys') || '4';
    this.laneCount = this.keysMode === '2' ? 2 : 4;

    let notes = this.diff.notes;
    if (this.mods.includes('MIRROR')) {
      notes = notes.map(([lane, t, d]) => [3 - lane, t, d]);
    }
    if (this.keysMode === '2') notes = to2Keys(notes);
    this.engine = new Engine(notes);
    this.renderer = new Renderer($('game-canvas'));
    this.renderer.setSkin(activeSkin());
    this.finished = false;
    this.paused = false;
    this.userOffset = storage.get('offset') / 1000;
    this.lastProgressSend = 0;

    this.input = new Input($('game-canvas'), {
      onPress: (lane, ts) => this.onPress(lane, ts),
      onRelease: (lane, ts) => this.onRelease(lane, ts)
    });
    this.input.lanes = this.laneCount;

    $('hud-song').textContent = `${track.title} — ${diffName}`;
    $('hud-score').textContent = '0';
    $('life-bar').style.width = '70%';
    $('pause-overlay').hidden = true;
    $('btn-pause').style.display = opts.multi ? 'none' : '';
    $('rivals').innerHTML = '';
    ui.show('game');

    this.renderer.setChart(this.engine.notes, track.bpm, storage.get('speed'), this.laneCount);
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
    if (this.finished || this.paused) return;
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

    // Le moteur juge sur la MÊME horloge que les frappes (onPress/onRelease) :
    // l'horloge audio décalée de l'offset de calibration. Sur l'horloge brute,
    // une note était retirée — donc comptée MISS — avant que la fenêtre de
    // retard du joueur ne soit épuisée : la fenêtre utile perdait exactement
    // l'offset (240 ms annoncés, 170 ms réels à 80 ms d'offset), et un hold
    // dont la tête sautait ainsi était perdu en entier.
    // Le rendu, lui, reste sur l'horloge brute : les notes se dessinent à leur
    // vraie position audio.
    const tJudge = t - this.userOffset * this.rate;
    this.engine.update(tJudge);
    // Événements du moteur : MISS détectés par l'avancée du temps (les autres
    // jugements ont déjà eu leur feedback à la frappe) et montées de fever.
    for (const ev of this.engine.events.splice(0)) {
      if (ev.type === 'judge' && ev.judgment === 'MISS') {
        this.renderer.label('MISS');
        this.renderer.setCombo(0);
        audio.missSound();
      } else if (ev.type === 'fever') {
        this.renderer.feverUp(ev.level);
        audio.feverSound(ev.level);
        if (storage.get('vibrate') && navigator.vibrate) navigator.vibrate([25, 30, 25]);
      }
    }
    // Le badge suit le niveau réel (retombe à ×1 quand le combo casse) et la
    // jauge indique où en est le joueur vers le palier suivant.
    this.renderer.feverLevel = this.engine.fever;
    const fb = feverBounds(this.engine.combo);
    this.renderer.setFeverGauge((this.engine.combo - fb.from) / (fb.to - fb.from));

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

    // Décompte : avant le début du morceau et au retour de pause, en
    // secondes réelles (le rewind de reprise compte 3-2-1 jusqu'à l'instant
    // précis où les notes redeviennent jouables).
    const cd = $('countdown');
    let remainReal = 0;
    if (t < 0) remainReal = -t / this.rate;
    else if (this.resumeTarget != null && t < this.resumeTarget) {
      remainReal = (this.resumeTarget - t) / this.rate;
    }
    if (remainReal > 0) {
      cd.hidden = false;
      const n = Math.ceil(remainReal);
      cd.textContent = n <= 3 ? String(n) : '';
      cd.classList.remove('go');
    } else {
      if (this.resumeTarget != null && t >= this.resumeTarget) {
        this.resumeTarget = null;
        this.goUntil = performance.now() + 550;
      }
      if (t >= 0 && !this.startGoDone) {
        this.startGoDone = true;
        this.goUntil = performance.now() + 550;
      }
      if (this.goUntil && performance.now() < this.goUntil) {
        cd.hidden = false;
        cd.textContent = 'GO';
        cd.classList.add('go');
      } else if (!cd.hidden) {
        cd.hidden = true;
        cd.classList.remove('go');
        this.goUntil = 0;
      }
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
    this.input.reset();
    $('pause-overlay').hidden = false;
  }

  onHidden() {
    if (this.finished) return;
    if (!this.opts.multi) this.pause();
    else ui.toast(t('game_hidden'));
  }

  resume() {
    $('pause-overlay').hidden = true;
    // Reprise 2 s en arrière : la musique déjà jouée sert d'élan, et le
    // décompte 3-2-1 vise l'instant EXACT où les nouvelles notes arrivent.
    const seek = Math.max(0, this.pausedAt - 2);
    const { perfAtStart } = audio.start(this.track.id, { delay: 1.2, silent: this.opts.silent, seek, rate: this.rate });
    this.perfAtStart = perfAtStart;
    this.resumeTarget = this.pausedAt;
    this.paused = false;
    this.input.enabled = true;
  }

  /** Recommence le morceau du début, mêmes réglages (solo uniquement). */
  restart() {
    const track = this.track;
    const diffName = this.diffName;
    this.dispose();
    audio.stop();
    S.game = new Game(track, diffName, { multi: false });
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
    res.keysMode = this.keysMode;
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
  // NB : surtout pas `const t` ici — `t` est la fonction de traduction, et
  // l'écraser faisait planter le catch (donc écran de chargement figé).
  const sel = S.selectedTrack;
  if (!sel) return;
  storage.set('lastTrack', sel.id);
  try {
    const track = await withLoading(sel.id);
    S.game = new Game(track, S.myDiff, { multi: false });
  } catch (e) {
    if (e && e.message === CANCELLED) return;   // le joueur a annulé lui-même
    ui.toast(t('loading_error'), 5000);
    ui.show('select');
  }
}

/**
 * Jeton de chargement : incrémenté à chaque nouveau chargement ET par le
 * bouton ANNULER. Un chargement dont le jeton a changé est abandonné — sans
 * ça, une partie pourrait démarrer alors que le joueur est revenu en arrière.
 */
let loadToken = 0;

const CANCELLED = 'nb-cancelled';

function cancelLoading() {
  loadToken++;
  pausePrefetch();
  $('btn-loading-cancel').hidden = true;
  ui.show(S.mode === 'solo' ? 'select' : 'lobby');
}

async function withLoading(trackId) {
  pausePrefetch();
  const token = ++loadToken;
  ui.show('loading');
  $('loader-bar').style.width = '0%';
  const cancelBtn = $('btn-loading-cancel');
  cancelBtn.hidden = true;
  // Au bout de 8 s, on propose une porte de sortie : mieux vaut un bouton
  // ANNULER qu'un écran de chargement dont on ne peut plus rien faire.
  const slowTimer = setTimeout(() => {
    if (token !== loadToken) return;
    cancelBtn.hidden = false;
    $('loading-hint').textContent = t('loading_slow');
  }, 8000);
  try {
    const track = await loadTrack(trackId);
    if (token !== loadToken) throw new Error(CANCELLED);
    const imported = !!track.audio;
    $('loading-title').textContent = t(imported ? 'loading_load' : 'loading_synth');
    $('loading-hint').textContent = t(imported ? 'loading_load_hint' : 'loading_synth_hint');
    await audio.prepare(trackId, (p) => {
      if (token === loadToken) $('loader-bar').style.width = Math.round(p * 100) + '%';
    }, track.audio);
    if (token !== loadToken) throw new Error(CANCELLED);
    return track;
  } finally {
    clearTimeout(slowTimer);
    cancelBtn.hidden = true;
  }
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
    }, res.keysMode || '4');
  }
  // Trophées : on met à jour les compteurs, puis on annonce les nouveaux
  // paliers franchis (et les skins qu'ils débloquent).
  announceTrophies(storage.writeStats(applyResult(storage.readStats(), res)));

  // Classement en ligne : on ne publie QUE si le meilleur local a changé —
  // inutile de renvoyer un score déjà connu de la base à chaque partie.
  if (online.enabled() && recordInfo && recordInfo.record && S.selectedTrack) {
    online.publishScore(displayName(), S.selectedTrack.id, res.diffName,
                        res.keysMode || '4', recordInfo.best);
  }

  if (S.mode === 'solo') {
    ui.renderResults({ title: S.selectedTrack.title }, res, null, S.myId);
    ui.renderLocalBoard(
      storage.boardFor(S.selectedTrack.id, res.diffName, res.keysMode || '4'),
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

/**
 * Attribue au joueur sa couleur si elle est encore libre, sinon la première
 * teinte disponible. À huit dans un salon, deux joueurs choisissent
 * fatalement la même : sans ça, impossible de les distinguer en jeu.
 */
function freeColor(peerId, wanted) {
  const taken = new Set();
  for (const [id, q] of S.players) if (id !== peerId && q.color) taken.add(q.color.toLowerCase());
  const ok = /^#[0-9a-f]{6}$/i.test(wanted) ? wanted : null;
  if (ok && !taken.has(ok.toLowerCase())) return ok;
  const free = storage.COLORS.find((c) => !taken.has(c.toLowerCase()));
  return free || ok || '#8f93b8';
}

function hostOnMessage(peerId, msg) {
  const p = S.players.get(peerId);
  if (!p) return;
  p.lastSeen = performance.now();
  switch (msg.t) {
    case 'JOIN':
      p.name = String(msg.name || 'JOUEUR').slice(0, 10);
      p.color = freeColor(peerId, msg.color);
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
    if (p.progress && !p.off) scores[id] = { score: p.progress.score };
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
  // Le classement arrive après coup : on redessine l'écran sans rejouer
  // l'animation ni le jingle du grade.
  ui.renderResults({ title: S.selectedTrack.title }, { ...S.myResult, diffName: '' }, ranking, S.myId, false);
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
        msg.ranking, S.myId, false
      );
      ui.show('results');
      break;
    case 'KICK':
      ui.toast(msg.reason === 'full' ? t('room_full', { n: MAX_PLAYERS }) : t('room_kicked'));
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
  renderKeysChips('lobby-keys', refreshLobby);
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
  // Surtout pas `const t` : `t` est la fonction de traduction, et l'écraser
  // cassait tout le reste de la fonction (bouton PRÊT des clients).
  const sel = S.selectedTrack;
  if (sel) {
    if (!sel.levels.some((l) => l.name === S.myDiff)) S.myDiff = sel.levels[0].name;
    ui.renderDiffSeg($('lobby-diff'), sel.levels, S.myDiff, ((name) => {
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
      const best = storage.bestFor(sel.id, diffName, storage.get('keys'));
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

/* ══════════════════ Démarrage ══════════════════ */

boot();

// Crochet de debug/test : accès en lecture à l'état de session depuis la
// console (et depuis les tests automatisés). Aucune logique ne doit y écrire.
window.__NB = S;
