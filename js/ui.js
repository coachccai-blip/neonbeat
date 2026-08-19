// Écrans DOM : routeur, lobby, sélection, réglages, résultats, toasts.
// Toute la logique de partie vit dans main.js ; ici on ne fait que peindre.

import * as storage from './storage.js';
import { travelTime, notesOnScreen, clampSpeed } from './storage.js';
import { t } from './i18n.js';

const $ = (id) => document.getElementById(id);

/* ─── Routeur d'écrans ─── */

let currentScreen = 'home';
const listeners = [];

export function show(name) {
  document.querySelectorAll('.screen').forEach((s) => {
    s.classList.toggle('is-active', s.dataset.screen === name);
  });
  currentScreen = name;
  document.body.classList.toggle('in-game', name === 'game');
  for (const fn of listeners) fn(name);
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

/* ─── Sélecteurs segmentés (difficulté) ─── */

const DIFF_CLASS = { EASY: 'e', NORMAL: 'n', HARD: 'h' };

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
      <span class="track-num">${i + 1}</span>
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
export function renderPlayers(players, myId) {
  const box = $('players');
  box.innerHTML = '';
  for (const p of players) {
    const div = document.createElement('div');
    div.className = 'player'
      + (p.ready ? ' is-ready' : '')
      + (p.isHost ? ' is-host' : '')
      + (p.off ? ' is-off' : '');
    div.style.borderLeftColor = p.color;
    div.innerHTML = `
      <span class="dot" style="background:${p.color}"></span>
      <span class="pname">${esc(p.name)}${p.id === myId ? t('player_you') : ''}</span>
      <span class="pdiff">${p.difficulty || ''}</span>
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

export function renderResults(track, res, ranking, myId) {
  $('res-grade').textContent = res.failed ? 'FAILED' : res.grade;
  $('res-grade').style.fontSize = res.failed ? 'clamp(48px,16vw,80px)' : '';
  $('res-song').textContent = `${track.title} — ${res.diffName || ''}`;
  $('res-score').textContent = res.score.toLocaleString('fr-FR');
  $('res-stats').innerHTML = `
    <div class="stat perfect"><div class="v">${res.counts.PERFECT}</div><div class="k">PERFECT</div></div>
    <div class="stat great"><div class="v">${res.counts.GREAT}</div><div class="k">GREAT</div></div>
    <div class="stat good"><div class="v">${res.counts.GOOD}</div><div class="k">GOOD</div></div>
    <div class="stat miss"><div class="v">${res.counts.MISS}</div><div class="k">MISS</div></div>
    <div class="stat"><div class="v">${res.comboMax}</div><div class="k">${t('res_combo_max')}</div></div>
    <div class="stat"><div class="v">${(res.precision * 100).toFixed(1)}%</div><div class="k">${t('res_precision')}</div></div>`;

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
  if (ranking && ranking.length > 1) {
    ranking.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'rank-row' + (i === 0 ? ' p1' : '');
      row.innerHTML = `
        <span class="pos">${i + 1}</span>
        <span class="dot" style="width:10px;height:10px;border-radius:50%;background:${r.color};flex:none"></span>
        <span class="rn">${esc(r.name)}${r.id === myId ? t('player_you') : ''}${r.off ? t('rank_off') : ''}</span>
        <span class="rs">${(r.score || 0).toLocaleString('fr-FR')}</span>
        <span class="rg">${r.grade || ''}</span>`;
      box.appendChild(row);
    });
  }
}

/* ─── Rivaux (barres latérales en jeu) ─── */

export function renderRivals(list) {
  const box = $('rivals');
  box.innerHTML = '';
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

  const offEl = $('set-offset');
  const offVal = $('set-offset-val');
  offEl.value = storage.get('offset');
  offVal.textContent = `${storage.get('offset')} ms`;
  offEl.addEventListener('input', () => {
    const v = parseInt(offEl.value, 10) || 0;
    storage.set('offset', v);
    offVal.textContent = `${v} ms`;
    onChange('offset');
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

  for (const [id, key] of [['set-hitsound', 'hitsound'], ['set-vibrate', 'vibrate']]) {
    const el = $(id);
    el.checked = storage.get(key);
    el.addEventListener('change', () => {
      storage.set(key, el.checked);
      onChange(key);
    });
  }
}

/** Rafraîchit les champs des réglages depuis le stockage (après calibration). */
export function refreshSettings() {
  $('set-offset').value = storage.get('offset');
  $('set-offset-val').textContent = `${storage.get('offset')} ms`;
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
