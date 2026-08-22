// Écrans DOM : routeur, lobby, sélection, réglages, résultats, toasts.
// Toute la logique de partie vit dans main.js ; ici on ne fait que peindre.

import * as storage from './storage.js';
import { travelTime, notesOnScreen, clampSpeed } from './storage.js';
import { t } from './i18n.js';
import * as audio from './audio.js';
import { avatarFile, DEFAULT_AVATAR } from './avatars.js';

const $ = (id) => document.getElementById(id);

/* ─── Routeur d'écrans ─── */

let currentScreen = null;    // null tant qu'aucun écran n'a été affiché
const listeners = [];
let wiping = false;
let pendingTimer = null;     // basculement différé pendant un wipe
let pendingName = null;      // écran vers lequel ce wipe est en route
let wipeGen = 0;

function switchScreens(name) {
  document.querySelectorAll('.screen').forEach((s) => {
    s.classList.toggle('is-active', s.dataset.screen === name);
  });
  currentScreen = name;
  document.body.classList.toggle('in-game', name === 'game');
  for (const fn of listeners) fn(name);
}

function clearPending() {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = null;
  pendingName = null;
}

export function show(name) {
  // La cible réelle, c'est l'écran vers lequel un wipe est déjà en route —
  // sinon l'écran courant. Sans ça, un affichage instantané (morceau déjà en
  // cache : chargement → jeu en moins de 120 ms) se faisait recouvrir par le
  // basculement différé du wipe précédent, et l'écran de chargement restait
  // affiché par-dessus la partie en cours, définitivement.
  const target = pendingName !== null ? pendingName : currentScreen;
  if (name === target) return;
  clearPending();            // toute demande plus récente annule la précédente
  // Wipe diagonal express entre les menus. Jamais autour de l'écran de jeu ni
  // au premier affichage : le timing du canvas n'attend aucune animation.
  const wipe = document.getElementById('wipe');
  const skip = name === 'game' || target === 'game' || currentScreen === null || wiping;
  if (skip || !wipe) {
    switchScreens(name);
    return;
  }
  const gen = ++wipeGen;
  wiping = true;
  pendingName = name;
  wipe.classList.add('run');
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    pendingName = null;
    switchScreens(name);
  }, 120);
  setTimeout(() => {
    if (gen !== wipeGen) return;
    wipe.classList.remove('run');
    wiping = false;
  }, 270);
}

export function screen() {
  return currentScreen;
}

export function onScreenChange(fn) {
  listeners.push(fn);
}

/* ─── Toast ─── */

let toastTimer = null;
export function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* ─── Vitesse (façon DJ Max : multiplicateur ×1 → ×6) ─── */

export function fmtSpeed(v) {
  return '×' + v.toFixed(2).replace(/\.?0+$/, '').replace('.', ',');
}

/**
 * Met à jour le libellé + l'estimation de lisibilité d'un slider de vitesse.
 * @param {number} speed
 * @param {{bpm:number, nps:number}|null} chartInfo densité de la chart choisie
 */
export function describeSpeed(speed, chartInfo) {
  const el = $('speed-hint');
  $('speed-val').textContent = fmtSpeed(speed);
  if (!el) return;
  if (!chartInfo) { el.textContent = ''; return; }
  const on = notesOnScreen(chartInfo.bpm, speed, chartInfo.nps);
  const ms = Math.round(travelTime(chartInfo.bpm, speed) * 1000);
  const verdict = on > 7 ? t('speed_v_packed') : on > 4.5 ? t('speed_v_dense')
    : on > 2 ? t('speed_v_comfy') : t('speed_v_airy');
  el.textContent = t('speed_hint', { n: on.toFixed(1), ms, verdict });
}

/**
 * Combo maximal théorique : ce que rapporte la chaîne complète pour la
 * difficulté ET le mode de touches choisis. Le fever multipliant le combo,
 * il dépasse largement le nombre de notes. Le mode 2 touches fusionne des
 * notes, son total diffère.
 */
export function showMaxCombo(n) {
  const el = $('sheet-maxcombo');
  if (!el) return;
  el.innerHTML = n
    ? `${t('maxcombo_label')} <strong>${n.toLocaleString('fr-FR')}</strong>`
    : '';
}

/* ─── Sélecteurs segmentés (difficulté) ─── */

const DIFF_CLASS = { EASY: 'e', 'EASY+': 'e', NORMAL: 'n', 'NORMAL+': 'n', HARD: 'h' };

/**
 * @param {(diffName:string)=>string|null} [gradeOf] grade local à afficher
 */
export function renderDiffSeg(container, levels, active, onPick, gradeOf) {
  container.innerHTML = '';
  for (const d of levels) {
    const b = document.createElement('button');
    b.className = 'seg-btn' + (d.name === active ? ' is-on' : '');
    b.dataset.diff = d.name;
    const grade = gradeOf ? gradeOf(d.name) : null;
    b.innerHTML = `${d.name}<small>${t('level_abbr')} ${d.level}${grade ? ` · <b class="gr">${grade}</b>` : ''}</small>`;
    b.addEventListener('click', () => {
      container.querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('is-on'));
      b.classList.add('is-on');
      onPick(d.name);
    });
    container.appendChild(b);
  }
}

/* ─── Liste des morceaux ─── */

const coverCache = new Map();

/** Pochette générée : dégradé de la couleur du morceau + silhouette d'onde. */
export function coverFor(t) {
  let url = coverCache.get(t.id);
  if (url) return url;
  const size = 96;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, size, size);
  g.addColorStop(0, t.color || '#22e0c8');
  g.addColorStop(1, '#0a0a16');
  x.fillStyle = g;
  x.fillRect(0, 0, size, size);
  // barres pseudo-waveform déterministes (hash du titre)
  let seed = 0;
  for (const ch of t.id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  x.fillStyle = 'rgba(255,255,255,0.55)';
  const n = 11;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const v = 0.2 + (seed / 4294967296) * 0.8;
    const bh = v * size * 0.52;
    x.fillRect(8 + i * ((size - 16) / n), size / 2 - bh / 2, (size - 16) / n * 0.55, bh);
  }
  x.fillStyle = 'rgba(7,7,15,0.35)';
  x.fillRect(0, size - 26, size, 26);
  url = c.toDataURL();
  coverCache.set(t.id, url);
  return url;
}

export function renderTrackList(tracks, activeId, onPick, gradeOf) {
  const list = $('track-list');
  list.innerHTML = '';
  tracks.forEach((t, i) => {
    const b = document.createElement('button');
    b.className = 'track-item' + (t.id === activeId ? ' is-on' : '');
    b.style.setProperty('--accent', t.color || '#22e0c8');
    const lv = t.levels.map((l) => {
      const grade = gradeOf ? gradeOf(t.id, l.name) : null;
      return `<span class="lv ${DIFF_CLASS[l.name] || ''}">${l.level}${grade ? `<b>${grade}</b>` : ''}</span>`;
    }).join('');
    b.innerHTML = `
      <img class="track-cover" src="${coverFor(t)}" alt="" width="46" height="46">
      <span class="track-info">
        <span class="t">${t.title}</span>
        <span class="m">${t.artist} · ${t.bpm} BPM · ${fmtDur(t.duration)}</span>
      </span>
      <span class="track-levels">${lv}</span>`;
    b.addEventListener('click', () => {
      list.querySelectorAll('.track-item').forEach((x) => x.classList.remove('is-on'));
      b.classList.add('is-on');
      onPick(t);
    });
    list.appendChild(b);
  });
}

function fmtDur(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ─── Lobby ─── */

/**
 * @param {Array<{id,name,color,ready,difficulty,isHost,off}>} players
 */
export const TEAM_R = '#ff4d6d';
export const TEAM_B = '#3d9bff';

export function renderPlayers(players, myId) {
  const box = $('players');
  box.innerHTML = '';
  // Au-delà de quatre, la liste passe en version compacte pour qu'un salon
  // complet tienne à l'écran d'un téléphone sans défilement.
  box.classList.toggle('is-crowded', players.length > 4);
  for (const p of players) {
    const div = document.createElement('div');
    div.className = 'player'
      + (p.ready ? ' is-ready' : '')
      + (p.isHost ? ' is-host' : '')
      + (p.off ? ' is-off' : '')
      + (p.bot ? ' is-bot' : '')
      + (p.team === 'R' ? ' team-r' : p.team === 'B' ? ' team-b' : '');
    div.style.borderLeftColor = p.team === 'R' ? TEAM_R : p.team === 'B' ? TEAM_B : p.color;
    div.innerHTML = `
      <span class="dot" style="background:${p.color}"></span>
      <span class="pname">${p.bot ? '🤖 ' : ''}${esc(p.name)}${p.id === myId ? t('player_you') : ''}</span>
      <span class="pdiff">${p.bot ? t('bot_level', { n: p.bot }) : (p.difficulty || '')}</span>
      <span class="pready">${p.off ? t('player_off')
        : p.liveScore !== undefined ? p.liveScore.toLocaleString('fr-FR')
        : p.ready ? t('player_ready') : t('player_wait')}</span>`;
    box.appendChild(div);
  }
}

export function setLobbyTrack(track) {
  $('lobby-track-title').textContent = track ? track.title : '—';
  $('lobby-track-meta').textContent = track
    ? `${track.artist} · ${track.bpm} BPM · ${fmtDur(track.duration)}` : '';
}

export function drawQr(canvas, text) {
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const ctx = canvas.getContext('2d');
  const size = canvas.width;
  const cell = size / (n + 2);            // marge d'un module autour
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#07070f';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) {
        ctx.fillRect(Math.floor((c + 1) * cell), Math.floor((r + 1) * cell), Math.ceil(cell), Math.ceil(cell));
      }
    }
  }
}

/* ─── Mode de touches (4 keys / 2 keys) ─── */

export function renderKeysSeg(container, active, onPick) {
  container.innerHTML = '';
  for (const k of ['4', '2']) {
    const b = document.createElement('button');
    b.className = 'seg-btn' + (k === active ? ' is-on' : '');
    b.innerHTML = `${k} KEYS<small>${k === '4' ? 'Z E I O' : 'E I'}</small>`;
    b.addEventListener('click', () => {
      container.querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('is-on'));
      b.classList.add('is-on');
      onPick(k);
    });
    container.appendChild(b);
  }
}

/* ─── Effets (mods) ─── */

export function renderModsSeg(container, mods, activeIds, onToggle) {
  container.innerHTML = '';
  for (const m of mods) {
    const b = document.createElement('button');
    b.className = 'seg-btn mod-btn' + (activeIds.includes(m.id) ? ' is-on' : '');
    b.innerHTML = `${m.name}<small>×${String(m.mult).replace('.', ',')}</small>`;
    b.title = m.desc;
    b.addEventListener('click', () => {
      b.classList.toggle('is-on');
      onToggle(m.id, b.classList.contains('is-on'));
    });
    container.appendChild(b);
  }
}

export function setModsSummary(el, mult) {
  el.textContent = mult > 1 ? `score ×${String(mult).replace('.', ',')}` : '';
}

/* ─── Leaderboard local ─── */

export function renderLocalBoard(entries, isNewRecord, myScore) {
  const banner = $('res-record');
  const box = $('res-board');
  if (!banner || !box) return;
  banner.hidden = !isNewRecord;
  box.innerHTML = '';
  if (!entries.length) return;
  const title = document.createElement('div');
  title.className = 'board-title';
  title.textContent = t('board_title');
  box.appendChild(title);
  entries.slice(0, 5).forEach((e, i) => {
    const row = document.createElement('div');
    row.className = 'board-row' + (e.score === myScore ? ' is-me' : '');
    row.innerHTML = `
      <span class="pos">${i + 1}</span>
      <span class="bs">${e.score.toLocaleString('fr-FR')}</span>
      <span class="bg">${e.grade}</span>
      <span class="bm">${modsShort(e.mods)}</span>`;
    box.appendChild(row);
  });
}

function modsShort(ids) {
  if (!ids || !ids.length) return t('board_nomods');
  return t('board_mods') + ids.map((id) => ({ MIRROR: 'MI', FADE: 'FD', SUDDEN: 'SU', NIGHTCORE: 'NC' }[id] || id)).join('·');
}

/* ─── Résultats ─── */

let scoreRaf = 0;
let jingleTimer = 0;
let badgeTimer = 0;

/**
 * Abat la bannière de performance ~1 s après le grade : les deux fanfares
 * ne se marchent pas dessus et l'œil a le temps de lire le grade d'abord.
 */
function playBadge(tier) {
  const el = $('res-badge');
  if (!el) return;
  clearTimeout(badgeTimer);
  el.hidden = true;
  if (!tier) return;
  badgeTimer = setTimeout(() => {
    el.dataset.tier = tier;
    el.querySelector('.pb-txt').textContent = t('badge_' + tier);
    el.hidden = false;
    // Redémarre les animations CSS même si la bannière était déjà à l'écran.
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    audio.badgeSound(tier);
  }, 1050);
}

/**
 * Palier de performance, du plus rare au plus commun :
 *  ap — aucune note en dessous de PERFECT
 *  fc — aucun MISS (des GREAT/GOOD sont tolérés)
 *  sb — un seul MISS, « single break »
 * Une partie échouée n'en obtient aucun.
 */
function perfTier(res) {
  const c = res.counts || {};
  const juges = (c.PERFECT || 0) + (c.GREAT || 0) + (c.GOOD || 0);
  if (res.failed || !juges) return null;
  if (!c.MISS && !c.GREAT && !c.GOOD) return 'ap';
  if (!c.MISS) return 'fc';
  if (c.MISS === 1) return 'sb';
  return null;
}

/** Palier visuel du grade : pilote couleurs, ondes et étincelles. */
function tierOf(grade, failed) {
  if (failed) return 'failed';
  if (grade === 'SS') return 'ss';
  if (grade === 'S+' || grade === 'S') return 's';
  if (grade === 'A') return 'a';
  if (grade === 'B') return 'b';
  return 'c';
}

// Intensité de la fête selon le palier : nombre d'ondes et d'étincelles.
const FX = {
  ss:     { rings: 3, sparks: 22, spread: 190 },
  s:      { rings: 2, sparks: 14, spread: 165 },
  a:      { rings: 2, sparks: 10, spread: 145 },
  b:      { rings: 1, sparks: 7,  spread: 130 },
  c:      { rings: 1, sparks: 5,  spread: 115 },
  failed: { rings: 1, sparks: 0,  spread: 0 }
};

/**
 * Ondes de choc + étincelles autour du grade. Les éléments sont créés puis
 * effacés : rien ne subsiste une fois l'animation terminée.
 */
function playGradeFx(tier) {
  const box = $('res-grade-fx');
  if (!box) return;
  box.innerHTML = '';
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const cfg = FX[tier] || FX.c;

  const flash = document.createElement('div');
  flash.className = 'g-flash';
  box.appendChild(flash);

  for (let i = 0; i < cfg.rings; i++) {
    const r = document.createElement('div');
    r.className = 'g-ring';
    r.style.setProperty('--delay', `${i * 130}ms`);
    r.style.setProperty('--dur', `${900 + i * 160}ms`);
    box.appendChild(r);
  }
  // Angles régulièrement répartis, légèrement décalés d'une couronne à
  // l'autre : dense sans jamais paraître aléatoire ni s'agglutiner.
  for (let i = 0; i < cfg.sparks; i++) {
    const sp = document.createElement('div');
    sp.className = 'g-spark';
    const a = (i * 360) / cfg.sparks + (i % 2) * (180 / cfg.sparks);
    sp.style.setProperty('--a', `${a}deg`);
    sp.style.setProperty('--d', `${cfg.spread * (i % 3 === 0 ? 1 : i % 3 === 1 ? 0.78 : 0.92)}px`);
    sp.style.setProperty('--delay', `${60 + (i % 4) * 45}ms`);
    sp.style.setProperty('--dur', `${820 + (i % 3) * 220}ms`);
    box.appendChild(sp);
  }
  clearTimeout(fxTimer);
  fxTimer = setTimeout(() => { box.innerHTML = ''; }, 3200);
}
let fxTimer = 0;

/**
 * @param {boolean} [celebrate=true]  false quand on redessine le même
 *        résultat pour y ajouter le classement : la fête ne se rejoue pas.
 */
export function renderResults(track, res, ranking, myId, celebrate = true, teams = null) {
  const gradeEl = $('res-grade');
  const stage = $('res-grade-stage');
  const tier = tierOf(res.grade, res.failed);
  if (stage) stage.dataset.tier = tier;
  gradeEl.textContent = res.failed ? 'FAILED' : res.grade;
  gradeEl.style.fontSize = res.failed ? 'clamp(48px,16vw,80px)' : '';
  if (celebrate) {
    // re-déclenche l'animation de claquage du grade
    gradeEl.classList.remove('slam');
    void gradeEl.offsetWidth;
    gradeEl.classList.add('slam');
    playGradeFx(tier);
    // Le son arrive avec l'impact du grade, pas avant.
    clearTimeout(jingleTimer);
    jingleTimer = setTimeout(() => audio.gradeJingle(res.grade, res.failed), 160);
    playBadge(perfTier(res));
  }
  $('res-song').textContent = `${track.title} — ${res.diffName || ''}`;
  // score compté en montée (1,1 s, freiné en fin de course)
  cancelAnimationFrame(scoreRaf);
  const scoreEl = $('res-score');
  const target = res.score;
  const t0 = performance.now();
  const count = () => {
    const p = Math.min(1, (performance.now() - t0) / 1100);
    const e = 1 - Math.pow(1 - p, 3);
    scoreEl.textContent = Math.round(target * e).toLocaleString('fr-FR');
    if (p < 1) scoreRaf = requestAnimationFrame(count);
  };
  count();
  $('res-stats').innerHTML = `
    <div class="stat perfect"><div class="v">${res.counts.PERFECT}</div><div class="k">PERFECT</div></div>
    <div class="stat great"><div class="v">${res.counts.GREAT}</div><div class="k">GREAT</div></div>
    <div class="stat good"><div class="v">${res.counts.GOOD}</div><div class="k">GOOD</div></div>
    <div class="stat miss"><div class="v">${res.counts.MISS}</div><div class="k">MISS</div></div>
    <div class="stat"><div class="v">${(res.comboMax || 0).toLocaleString('fr-FR')}</div><div class="k">${t('res_combo_max')}</div></div>
    <div class="stat"><div class="v">${(res.precision * 100).toFixed(1)}%</div><div class="k">${t('res_precision')}</div></div>`;
  // apparition en cascade des tuiles
  $('res-stats').querySelectorAll('.stat').forEach((el, i) => {
    el.style.animationDelay = `${120 + i * 70}ms`;
    el.classList.add('pop-in');
  });

  const timingEl = $('res-timing');
  if (timingEl) {
    const tm = res.timing;
    if (tm && (tm.earlyPct || tm.latePct)) {
      const avg = (tm.avgMs > 0 ? '+' : '') + tm.avgMs;
      let txt = t('res_timing', { early: tm.earlyPct, late: tm.latePct, avg });
      if (Math.abs(tm.avgMs) >= 25) {
        txt += `<br><strong>${t(tm.avgMs > 0 ? 'res_advice_late' : 'res_advice_early', { avg })}</strong>`;
      }
      timingEl.innerHTML = txt;
    } else {
      timingEl.textContent = '';
    }
  }

  const box = $('res-ranking');
  box.innerHTML = '';
  // Bandeau d'équipes : il passe AVANT le classement individuel, parce que
  // c'est lui qui dit qui a gagné la manche.
  if (teams) {
    const gagne = (c) => (teams.winner === c ? ' is-win' : teams.winner ? ' is-lose' : '');
    const ban = document.createElement('div');
    ban.className = 'team-score';
    ban.innerHTML = `
      <div class="ts r${gagne('R')}">
        <div class="tl">${esc(t('team_r'))}</div>
        <div class="tv">${(teams.R || 0).toLocaleString('fr-FR')}</div>
        <div class="tn">${t('team_members', { n: teams.nR || 0 })}</div>
      </div>
      <div class="tvs">${esc(teams.winner ? t('team_wins', { team: t(teams.winner === 'R' ? 'team_r' : 'team_b') }) : t('team_draw'))}</div>
      <div class="ts b${gagne('B')}">
        <div class="tl">${esc(t('team_b'))}</div>
        <div class="tv">${(teams.B || 0).toLocaleString('fr-FR')}</div>
        <div class="tn">${t('team_members', { n: teams.nB || 0 })}</div>
      </div>`;
    box.appendChild(ban);
  }
  if (ranking && ranking.length > 1) {
    ranking.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'rank-row' + (i === 0 ? ' p1' : '')
        + (r.team === 'R' ? ' team-r' : r.team === 'B' ? ' team-b' : '');
      const etat = r.left ? t('rank_left') : r.off ? t('rank_off') : '';
      row.innerHTML = `
        <span class="pos">${i + 1}</span>
        <span class="dot" style="width:10px;height:10px;border-radius:50%;background:${r.team === 'R' ? TEAM_R : r.team === 'B' ? TEAM_B : r.color};flex:none"></span>
        <span class="rn">${r.bot ? '🤖 ' : ''}${esc(r.name)}${r.id === myId ? t('player_you') : ''}${esc(etat)}</span>
        <span class="rs">${(r.score || 0).toLocaleString('fr-FR')}</span>
        <span class="rg">${r.grade || ''}</span>`;
      box.appendChild(row);
    });
  }
}

/* ─── Classements en ligne ─── */

/** État de chargement / d'erreur, partagé par les deux classements. */
function boardMessage(el, key) {
  el.innerHTML = `<p class="board-msg">${esc(t(key))}</p>`;
}

/**
 * Classement d'un morceau. `me` met en évidence la ligne du joueur, pour
 * qu'il se retrouve sans avoir à lire tous les pseudos.
 */
/**
 * Pastille d'avatar précédant le pseudo. `avatarFile` ne rend un chemin que
 * pour un identifiant connu : une valeur fantaisiste venue de la base ne
 * peut donc pas se transformer en URL d'image.
 *
 * Rien de connu — un score publié avant que les avatars existent, un joueur
 * qui n'en a jamais choisi — donne le premier avatar : une ligne de
 * classement sans pastille laisserait un trou dans la colonne.
 */
function avatarTag(id) {
  const src = avatarFile(id) || avatarFile(DEFAULT_AVATAR.id);
  return `<img class="bav" src="${src}" alt="" loading="lazy">`;
}

export function renderTrackBoard(rows, me) {
  const el = $('board-list');
  if (!rows) return boardMessage(el, 'board_error');
  if (!rows.length) return boardMessage(el, 'board_empty');
  el.innerHTML = rows.map((r, i) => `
    <div class="board-row${r.player_id === me ? ' is-me' : ''}${i === 0 ? ' p1' : ''}">
      <span class="pos">${i + 1}</span>
      ${avatarTag(r.avatar)}
      <span class="bn">${esc(r.name || '—')}</span>
      <span class="bg">${esc(r.grade || '')}</span>
      <span class="bs">${(r.score || 0).toLocaleString('fr-FR')}</span>
    </div>`).join('');
}

/** Classement général : SS, S+, S et meilleur combo, tous joueurs confondus. */
export function renderGlobalBoard(rows, me) {
  const el = $('ranking-list');
  if (!rows) return boardMessage(el, 'board_error');
  if (!rows.length) return boardMessage(el, 'board_empty');
  el.innerHTML = `
    <div class="board-row head">
      <span class="pos"></span><span class="bav is-none"></span><span class="bn"></span>
      <span class="bc ss">SS</span><span class="bc sp">S+</span>
      <span class="bc sg">S</span><span class="bc mc">${esc(t('trophies_maxcombo'))}</span>
    </div>` + rows.map((r, i) => `
    <div class="board-row${r.player_id === me ? ' is-me' : ''}${i === 0 ? ' p1' : ''}">
      <span class="pos">${i + 1}</span>
      ${avatarTag(r.avatar)}
      <span class="bn">${esc(r.name || '—')}</span>
      <span class="bc ss">${r.ss || 0}</span>
      <span class="bc sp">${r.splus || 0}</span>
      <span class="bc sg">${r.s || 0}</span>
      <span class="bc mc">${r.max_combo || 0}</span>
    </div>`).join('');
}

export function boardLoading(id) {
  boardMessage($(id), 'board_loading');
}

/**
 * « Mes scores » : l'historique LOCAL du joueur sur ce morceau, cette
 * difficulté et ce mode — ses propres tentatives, de la meilleure à la
 * moins bonne. Aucune requête réseau : ces données sont déjà sur l'appareil.
 */
export function renderMyScores(rows, rank) {
  const el = $('board-list');
  if (!rows || !rows.length) return boardMessage(el, 'board_mine_empty');
  const tete = rank
    ? `<p class="board-rank">${esc(t('board_rank', { n: rank.pos, total: rank.total }))}</p>`
    : '';
  el.innerHTML = tete + rows.map((r, i) => `
    <div class="board-row${i === 0 ? ' p1' : ''}">
      <span class="pos">${i + 1}</span>
      <span class="bn">${esc(modsLabelOf(r.mods))}</span>
      <span class="bp">${((r.precision || 0) * 100).toFixed(1)} %</span>
      <span class="bg">${esc(r.grade || '')}</span>
      <span class="bs">${(r.score || 0).toLocaleString('fr-FR')}</span>
    </div>`).join('');
}

function modsLabelOf(mods) {
  if (!mods || !mods.length) return t('board_nomods');
  return mods.map((id) => ({ MIRROR: 'MI', FADE: 'FD', SUDDEN: 'SU', NIGHTCORE: 'NC' }[id] || id)).join('·');
}

/**
 * Panneau des bots, côté hôte : niveau, équipe, retrait.
 *
 * Chez un client, la liste est en lecture seule — les bots appartiennent à
 * l'hôte, qui seul les simule.
 * @param {Array} list        [{ id, name, level, team }]
 * @param {boolean} host      l'utilisateur est-il l'hôte ?
 * @param {boolean} teamMode  affiche le choix d'équipe
 * @param {(id:string, champ:string, valeur:*)=>void} onChange
 */
export function renderBots(list, host, teamMode, onChange) {
  const box = $('bots');
  box.innerHTML = '';
  const bloc = box.closest('.bots-block');
  if (bloc) bloc.hidden = !host && !list.length;
  for (const b of list) {
    const div = document.createElement('div');
    div.className = 'bot' + (b.team === 'R' ? ' team-r' : b.team === 'B' ? ' team-b' : '');
    div.innerHTML = `
      <span class="bn">🤖 ${esc(b.name)}</span>
      <span class="blv">${esc(t('bot_level', { n: b.level }))}</span>`;
    if (host) {
      const moins = document.createElement('button');
      moins.className = 'bot-btn'; moins.textContent = '−';
      moins.setAttribute('aria-label', t('bot_down'));
      moins.addEventListener('click', () => onChange(b.id, 'level', b.level - 1));
      const plus = document.createElement('button');
      plus.className = 'bot-btn'; plus.textContent = '+';
      plus.setAttribute('aria-label', t('bot_up'));
      plus.addEventListener('click', () => onChange(b.id, 'level', b.level + 1));
      div.append(moins, plus);
      if (teamMode) {
        for (const [code, couleur] of [['R', TEAM_R], ['B', TEAM_B]]) {
          const e = document.createElement('button');
          e.className = 'team-btn' + (b.team === code ? ' is-on' : '');
          e.style.setProperty('--tc', couleur);
          e.textContent = t(code === 'R' ? 'team_r_short' : 'team_b_short');
          e.addEventListener('click', () => onChange(b.id, 'team', code));
          div.appendChild(e);
        }
      }
      const x = document.createElement('button');
      x.className = 'bot-btn bot-del'; x.textContent = '✕';
      x.setAttribute('aria-label', t('bot_remove'));
      x.addEventListener('click', () => onChange(b.id, 'remove'));
      div.appendChild(x);
    }
    box.appendChild(div);
  }
}

/** Choix d'équipe du joueur local, sous la liste des joueurs. */
export function renderTeamPick(team, onPick) {
  const box = $('team-pick');
  box.hidden = false;
  box.innerHTML = '';
  for (const [code, couleur, cle] of [['R', TEAM_R, 'team_r'], ['B', TEAM_B, 'team_b']]) {
    const b = document.createElement('button');
    b.className = 'seg-btn team-choice' + (team === code ? ' is-on' : '');
    b.style.setProperty('--tc', couleur);
    b.textContent = t(cle);
    b.addEventListener('click', () => onPick(code));
    box.appendChild(b);
  }
}

export function hideTeamPick() {
  const box = $('team-pick');
  if (box) box.hidden = true;
}

/* ─── Trophées & skins ─── */

/**
 * Peint l'écran des trophées.
 * @param {object} d { counts, stats, progress, skins, activeSkin }
 * @param {(id:string)=>void} onPickSkin
 */
export function renderTrophies(d, onPickSkin) {
  // Compteurs de tête : ce que le joueur veut voir en un coup d'œil.
  $('tr-stats').innerHTML = [
    ['SS', d.counts.SS, 'ss'],
    ['S+', d.counts['S+'], 'splus'],
    ['S', d.counts.S, 's'],
    [t('trophies_maxcombo'), d.stats.maxCombo, 'combo']
  ].map(([k, v, cls]) => `
    <div class="stat-tile ${cls}"><div class="v">${v || 0}</div><div class="k">${esc(String(k))}</div></div>`
  ).join('');

  const box = $('tr-skins');
  box.innerHTML = '';
  for (const sk of d.skins) {
    const locked = !d.unlocked.includes(sk.id);
    const b = document.createElement('button');
    b.className = 'skin-card' + (sk.id === d.activeSkin ? ' is-on' : '') + (locked ? ' is-locked' : '');
    b.disabled = locked;
    const swatch = sk.lanes4.map((c) => `<i style="background:${c}"></i>`).join('');
    const need = sk.unlock ? t('trophy_' + sk.unlock) : '';
    b.innerHTML = `
      <div class="sw">${swatch}</div>
      <div class="sn">${esc(t('skin_' + sk.id))}</div>
      <div class="sl">${locked ? '🔒 ' + esc(need) : (sk.id === d.activeSkin ? t('skin_active') : t('skin_use'))}</div>`;
    if (!locked) b.addEventListener('click', () => onPickSkin(sk.id));
    box.appendChild(b);
  }

  $('tr-list').innerHTML = d.progress.map((tr) => {
    const pct = Math.round((100 * tr.current) / tr.target);
    const skin = d.skinFor[tr.id];
    const avatar = (d.avatarFor || {})[tr.id];
    // Un trophée offre au plus une récompense : skin OU avatar.
    const reward = skin ? ` <em>· ${esc(t('skin_' + skin))}</em>`
      : avatar ? ` <em>· ${esc(t('av_' + avatar))}</em>` : '';
    return `
      <div class="trophy${tr.done ? ' is-done' : ''}">
        <span class="ti">${tr.icon}</span>
        <span class="tb">
          <span class="tn">${esc(t('trophy_' + tr.id))}${reward}</span>
          <span class="tp"><span style="width:${pct}%"></span></span>
        </span>
        <span class="tv">${tr.done ? '✓' : `${tr.current}/${tr.target}`}</span>
      </div>`;
  }).join('');
}

/* ─── Rivaux (barres latérales en jeu) ─── */

export function renderRivals(list) {
  const box = $('rivals');
  box.innerHTML = '';
  // Jusqu'à sept rivaux : au-delà de trois, on resserre pour ne jamais
  // empiéter sur les couloirs de jeu.
  box.classList.toggle('is-crowded', list.length > 3);
  for (const r of list) {
    const div = document.createElement('div');
    div.className = 'rival' + (r.off ? ' is-off' : '');
    div.innerHTML = `
      <div class="rn"><span>${esc(r.name)}</span><span>${r.off ? '✕' : compactScore(r.score)}</span></div>
      <div class="rb"><div class="rf" style="width:${Math.min(100, (r.score || 0) / 10000)}%;background:${r.color}"></div></div>`;
    box.appendChild(div);
  }
}

function compactScore(s) {
  if (!s) return '0';
  if (s >= 1000000) return '1M';
  if (s >= 1000) return Math.round(s / 1000) + 'k';
  return String(s);
}

/* ─── Réglages ─── */

export function bindSettings(onChange) {
  const nameEl = $('set-name');
  nameEl.value = storage.get('name');
  nameEl.addEventListener('input', () => {
    storage.set('name', nameEl.value.trim());
    onChange('name');
  });

  const colorsBox = $('set-colors');
  colorsBox.innerHTML = '';
  for (const c of storage.COLORS) {
    const dot = document.createElement('button');
    dot.className = 'color-dot' + (storage.get('color') === c ? ' is-on' : '');
    dot.style.background = c;
    dot.setAttribute('aria-label', 'couleur ' + c);
    dot.addEventListener('click', () => {
      storage.set('color', c);
      colorsBox.querySelectorAll('.color-dot').forEach((x) => x.classList.remove('is-on'));
      dot.classList.add('is-on');
      onChange('color');
    });
    colorsBox.appendChild(dot);
  }

  const speedEl = $('set-speed');
  const speedVal = $('set-speed-val');
  speedEl.value = storage.get('speed');
  speedVal.textContent = fmtSpeed(storage.get('speed'));
  speedEl.addEventListener('input', () => {
    const v = clampSpeed(parseFloat(speedEl.value));
    storage.set('speed', v);
    speedVal.textContent = fmtSpeed(v);
    onChange('speed');
  });

  const volEl = $('set-volume');
  const volVal = $('set-vol-val');
  volEl.value = Math.round(storage.get('volume') * 100);
  volVal.textContent = `${volEl.value} %`;
  volEl.addEventListener('input', () => {
    const v = parseInt(volEl.value, 10) / 100;
    storage.set('volume', v);
    volVal.textContent = `${volEl.value} %`;
    onChange('volume');
  });

  for (const [id, key] of [['set-hitsound', 'hitsound'], ['set-vibrate', 'vibrate'], ['set-uisound', 'uisound']]) {
    const el = $(id);
    el.checked = storage.get(key);
    el.addEventListener('change', () => {
      storage.set(key, el.checked);
      onChange(key);
    });
  }
}

/** Rafraîchit les champs des réglages depuis le stockage (après calibration). */
/**
 * Grille des avatars, dans les réglages.
 * @param {{id:string, unlock:?string, locked:boolean}[]} list
 * @param {string} active
 * @param {(a:object)=>void} onPick  appelé aussi pour un avatar verrouillé,
 *   afin d'annoncer le trophée qui le débloque plutôt que de rester muet.
 */
export function renderAvatars(list, active, onPick) {
  const box = $('set-avatars');
  if (!box) return;
  box.innerHTML = '';
  for (const a of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'avatar-card' + (a.id === active ? ' is-on' : '') + (a.locked ? ' is-locked' : '');
    const label = t('av_' + a.id);
    b.setAttribute('aria-label', a.locked ? `${label} — ${t('trophy_' + a.unlock)}` : label);
    b.setAttribute('aria-pressed', String(a.id === active));
    b.innerHTML = `<img src="${avatarFile(a.id)}" alt="" loading="lazy">`
      + (a.locked ? '<span class="lk">🔒</span>' : '');
    b.addEventListener('click', () => onPick(a));
    box.appendChild(b);
  }
  const cur = list.find((a) => a.id === active);
  $('set-avatar-name').textContent = cur ? t('av_' + cur.id) : '';
}

export function refreshSettings() {
  $('set-speed').value = storage.get('speed');
  $('set-speed-val').textContent = fmtSpeed(storage.get('speed'));
}

/* ─── Aperçu animé de la vitesse (dans les réglages) ─── */

let previewRaf = 0;
export function startSpeedPreview() {
  const canvas = $('speed-preview');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const judge = H * 0.82;
  const laneW = W / 4;
  const pattern = [0, 2, 1, 3, 2, 0, 3, 1];

  const frame = () => {
    const speed = storage.get('speed');
    const travel = travelTime(120, speed);      // aperçu calé sur 120 BPM
    const t = (performance.now() / 1000) % 8;
    ctx.fillStyle = '#0b0b18';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(139,92,255,0.25)';
    ctx.beginPath();
    for (let l = 1; l < 4; l++) { ctx.moveTo(l * laneW, 0); ctx.lineTo(l * laneW, H); }
    ctx.stroke();
    ctx.fillStyle = '#eef0ff';
    ctx.fillRect(0, judge, W, 2);
    const colors = ['#22e0c8', '#8b5cff', '#ff3d8b', '#ffb020'];
    const interval = 0.5;                        // une note par croche à 120 BPM
    for (let k = -2; k < 20; k++) {
      const noteT = k * interval;
      const dt = (noteT - t % 4);
      const y = judge - (dt / travel) * judge;
      if (y < -10 || y > H + 10) continue;
      const lane = pattern[((k % 8) + 8) % 8];
      ctx.fillStyle = colors[lane];
      ctx.fillRect(lane * laneW + laneW * 0.12, y - 5, laneW * 0.76, 10);
    }
    previewRaf = requestAnimationFrame(frame);
  };
  cancelAnimationFrame(previewRaf);
  previewRaf = requestAnimationFrame(frame);
}

export function stopSpeedPreview() {
  cancelAnimationFrame(previewRaf);
  previewRaf = 0;
}

function esc(s) {
  return String(s || '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}
