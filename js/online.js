// Classement en ligne, volontairement rustique : aucune inscription, aucun
// mot de passe. Un identifiant est tiré au hasard sur l'appareil et sert de
// clé ; le pseudo des réglages sert d'affichage.
//
// Tout passe par l'API REST de Supabase (PostgREST) en simple `fetch` : le
// jeu reste 100 % statique, sans étape de build ni serveur à faire tourner.
//
// Limite assumée et documentée : la clé publique est forcément visible dans
// le code d'un jeu statique. Des garde-fous côté base rejettent les valeurs
// absurdes, mais un classement de ce type ne peut pas être inviolable — il
// est fait pour une bande de copains, pas pour un tournoi officiel.

import { SUPABASE } from './online-config.js';

const PLAYER_KEY = 'neonbeat.player';     // isolé : survit aux mises à jour
const OVERRIDE_KEY = 'neonbeat.online-override';

/**
 * Configuration effective. Une surcharge locale peut viser un autre serveur
 * — c'est ce dont se servent les tests automatisés, qui ne doivent SURTOUT
 * pas modifier le fichier livré : une seule fois où un test s'interrompt
 * avant de le restaurer, et c'est l'adresse d'essai qui part en production.
 */
function config() {
  try {
    const raw = localStorage.getItem(OVERRIDE_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      if (o && o.url && o.key) return o;
    }
  } catch { /* stockage illisible : configuration livrée */ }
  return SUPABASE;
}

/** Le classement est-il configuré ? Sinon, tout ce module est inerte. */
export function enabled() {
  const c = config();
  return !!(c.url && c.key);
}

/**
 * Fiche locale du joueur : { id, name }. `name` mémorise le pseudo sous
 * lequel ses lignes ont été publiées la dernière fois — c'est ce qui permet
 * de détecter un changement de pseudo et de le répercuter.
 *
 * Rétrocompatible : les versions précédentes ne rangeaient qu'une chaîne.
 */
function readPlayer() {
  try {
    const raw = localStorage.getItem(PLAYER_KEY);
    if (raw) {
      if (raw[0] === '{') return JSON.parse(raw);
      return { id: raw, name: '' };            // ancien format : un simple id
    }
  } catch { /* stockage illisible */ }
  return null;
}

function writePlayer(p) {
  try { localStorage.setItem(PLAYER_KEY, JSON.stringify(p)); } catch { /* privé */ }
  return p;
}

/**
 * Identifiant stable de l'appareil. Généré une seule fois, rangé à part des
 * réglages pour ne jamais être emporté par une mise à jour.
 */
export function playerId() {
  const p = readPlayer();
  if (p && p.id) return p.id;
  const id = (crypto.randomUUID && crypto.randomUUID()) || fallbackId();
  // Navigation privée : l'écriture échoue, l'identifiant reste en mémoire et
  // le classement fonctionne le temps de la session.
  writePlayer({ id, name: '' });
  return (memoryId ||= id);
}
let memoryId = null;

function fallbackId() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function headers(extra) {
  const key = config().key;
  const h = { apikey: key, 'Content-Type': 'application/json', ...extra };
  // Les clés « anon » historiques sont des JWT et doivent aussi voyager en
  // Authorization ; les nouvelles (sb_publishable_…) n'en sont pas, et les
  // envoyer ainsi ferait échouer l'analyse du jeton côté serveur.
  if (/^eyJ/.test(key)) h.Authorization = `Bearer ${key}`;
  return h;
}

/**
 * Requête brute. Le code HTTP est conservé : il faut pouvoir distinguer
 * « la base refuse cette colonne » (400) de « le réseau est tombé » (0).
 * @returns {Promise<{ok:boolean, status:number, data:*}>}
 */
async function request(path, options = {}, timeoutMs = 8000) {
  if (!enabled()) return { ok: false, status: 0, data: null };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${config().url}/rest/v1/${path}`, { ...options, signal: ctrl.signal });
    if (!res.ok) return { ok: false, status: res.status, data: null };
    const txt = await res.text();
    return { ok: true, status: res.status, data: txt ? JSON.parse(txt) : true };
  } catch {
    return { ok: false, status: 0, data: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Toute requête réseau échoue en silence : le classement est un bonus. */
async function call(path, options = {}, timeoutMs = 8000) {
  const r = await request(path, options, timeoutMs);
  return r.ok ? r.data : null;
}

/* ─── Colonne « avatar » ──────────────────────────────────────────────
   Elle est arrivée après coup : une base créée avec l'ancien SQL ne la
   connaît pas, et PostgREST répond alors 400 à TOUTE requête qui la
   mentionne — lecture comprise. Publier la mise à jour du jeu avant
   d'avoir joué la migration casserait donc le classement entier.

   D'où ce filet : on tente avec l'avatar, et un 400 nous fait rejouer la
   requête sans lui, définitivement pour la session. Un 400 venu d'ailleurs
   (une contrainte violée) coûterait au pire les avatars jusqu'au prochain
   rechargement — jamais le classement.                                  */

let avatarOk = true;

/** @param {(withAvatar:boolean)=>Promise<{ok:boolean,status:number,data:*}>} run */
async function withAvatar(run) {
  if (avatarOk) {
    const r = await run(true);
    if (r.ok || r.status !== 400) return r;
    avatarOk = false;
  }
  return run(false);
}

/** L'identifiant d'avatar, ramené à une chaîne courte et inoffensive. */
function cleanAvatar(avatar) {
  return String(avatar || '').slice(0, 24);
}

/**
 * Publie un meilleur score. La clé primaire (joueur + morceau + difficulté
 * + mode) fait que l'envoi ÉCRASE la ligne précédente : la base ne garde
 * qu'un score par combinaison, exactement comme en local.
 */
export function publishScore(name, avatar, trackId, diff, keys, entry) {
  return publishMany(name, avatar, [{ trackId, diff, keys, entry }]);
}

/**
 * Répercute un changement de pseudo sur TOUTES les lignes déjà publiées.
 *
 * Sans ça, seul le morceau rejoué porterait le nouveau nom : le joueur
 * apparaîtrait sous deux pseudos selon les morceaux, et le classement
 * général (qui agrège par max(name)) afficherait celui qui vient le plus
 * loin dans l'alphabet — pas le plus récent.
 *
 * @returns {boolean|null} true si un renommage a eu lieu, false s'il n'y
 *   avait rien à faire, null si le réseau a échoué (on retentera).
 */
export async function syncProfile(name, avatar) {
  if (!enabled()) return false;
  const clean = String(name || '').trim().slice(0, 12);
  const av = cleanAvatar(avatar);
  if (!clean) return false;
  const p = readPlayer() || { id: playerId(), name: '' };
  if (p.name === clean && p.avatar === av) return false;   // déjà à jour
  const path = `scores?player_id=eq.${encodeURIComponent(p.id)}`;
  const r = await withAvatar((withAv) => request(path, {
    method: 'PATCH',
    headers: headers({ Prefer: 'return=minimal' }),
    body: JSON.stringify({
      name: clean,
      ...(withAv && av ? { avatar: av } : {}),
      updated_at: new Date().toISOString()
    })
  }));
  if (!r.ok) return null;                             // hors ligne : on réessaiera
  writePlayer({ ...p, name: clean, avatar: av });
  return true;
}

/**
 * Empreinte compacte d'un lot de scores. Elle sert à ne PAS renvoyer au
 * démarrage un ensemble déjà publié : sur 100 scores inchangés, la synchro
 * automatique devient une comparaison de chaîne, sans la moindre requête.
 */
function signature(name, avatar, list) {
  let h = 2166136261;
  const feed = (str) => {
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  };
  feed(name || '');
  feed(avatar || '');
  for (const { trackId, diff, keys, entry } of list) {
    feed(`${trackId}|${diff}|${keys}|${Math.round(entry.score || 0)}|${entry.grade}`);
  }
  return (h >>> 0).toString(36);
}

/**
 * Synchronisation silencieuse au démarrage : elle rattrape les parties
 * jouées hors ligne et les renommages en suspens, sans rien afficher et
 * sans requête quand rien n'a changé depuis le dernier envoi.
 * @returns {'inchangé'|'publié'|'échec'|'inactif'}
 */
export async function autoSync(name, avatar, list) {
  if (!enabled() || !list.length) return 'inactif';
  const sig = signature(name, avatar, list);
  const p = readPlayer() || { id: playerId(), name: '' };
  if (p.sig === sig) return 'inchangé';
  const res = await publishMany(name, avatar, list);
  if (res === null) return 'échec';
  writePlayer({ ...(readPlayer() || p), sig });
  return 'publié';
}

/** Publie plusieurs scores d'un coup (bouton « publier mes scores »). */
export async function publishMany(name, avatar, list) {
  if (!enabled() || !list.length) return null;
  const id = playerId();
  const av = cleanAvatar(avatar);
  // Toute publication répare au passage un renommage resté en suspens
  // (changement de pseudo ou d'avatar effectué hors ligne, par exemple).
  await syncProfile(name, av);
  const row = ({ trackId, diff, keys, entry }, withAv) => ({
    player_id: id,
    track_id: trackId,
    diff,
    keys: keys || '4',
    name: String(name || 'JOUEUR').slice(0, 12),
    ...(withAv && av ? { avatar: av } : {}),
    score: Math.round(entry.score || 0),
    grade: entry.grade || 'D',
    precision: Math.min(1, Math.max(0, entry.precision || 0)),
    combo: Math.round(entry.comboMax || 0),
    mods: entry.mods || []
  });
  // merge-duplicates : PostgREST traduit en « ON CONFLICT DO UPDATE ».
  const r = await withAvatar((withAv) => request('scores', {
    method: 'POST',
    headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(list.map((x) => row(x, withAv)))
  }));
  if (r.ok) {
    const p = readPlayer() || { id, name: '' };
    writePlayer({ ...p, name: String(name || 'JOUEUR').slice(0, 12), avatar: av });
  }
  return r.ok ? r.data : null;
}

/** Classement d'un morceau, pour une difficulté et un mode donnés. */
export async function trackBoard(trackId, diff, keys = '4', limit = 50) {
  const q = (withAv) => new URLSearchParams({
    select: `player_id,name,${withAv ? 'avatar,' : ''}score,grade,precision,combo,mods`,
    track_id: `eq.${trackId}`,
    diff: `eq.${diff}`,
    keys: `eq.${keys}`,
    order: 'score.desc',
    limit: String(limit)
  });
  const r = await withAvatar((withAv) => request(`scores?${q(withAv)}`, { headers: headers() }));
  return r.ok && Array.isArray(r.data) ? r.data : null;
}

/**
 * Classement général : une vue SQL agrège par joueur le nombre de SS, S+, S
 * et son meilleur combo. Le calcul se fait côté base, le jeu n'affiche.
 */
export async function globalBoard(limit = 50) {
  const q = (withAv) => new URLSearchParams({
    select: `player_id,name,${withAv ? 'avatar,' : ''}ss,splus,s,max_combo,charts`,
    order: 'ss.desc,splus.desc,s.desc,max_combo.desc',
    limit: String(limit)
  });
  const r = await withAvatar((withAv) => request(`leaderboard?${q(withAv)}`, { headers: headers() }));
  return r.ok && Array.isArray(r.data) ? r.data : null;
}
