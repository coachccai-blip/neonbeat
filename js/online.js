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

const PLAYER_KEY = 'neonbeat.player';   // isolé : survit aux mises à jour

/** Le classement est-il configuré ? Sinon, tout ce module est inerte. */
export function enabled() {
  return !!(SUPABASE.url && SUPABASE.key);
}

/**
 * Identifiant stable de l'appareil. Généré une seule fois, rangé à part des
 * réglages pour ne jamais être emporté par une mise à jour.
 */
export function playerId() {
  try {
    const cur = localStorage.getItem(PLAYER_KEY);
    if (cur) return cur;
    const id = (crypto.randomUUID && crypto.randomUUID()) || fallbackId();
    localStorage.setItem(PLAYER_KEY, id);
    return id;
  } catch {
    // Navigation privée : identifiant éphémère, le classement marche quand
    // même le temps de la session.
    return (memoryId ||= fallbackId());
  }
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
  return {
    apikey: SUPABASE.key,
    Authorization: `Bearer ${SUPABASE.key}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

/** Toute requête réseau échoue en silence : le classement est un bonus. */
async function call(path, options = {}, timeoutMs = 8000) {
  if (!enabled()) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${SUPABASE.url}/rest/v1/${path}`, { ...options, signal: ctrl.signal });
    if (!res.ok) return null;
    const txt = await res.text();
    return txt ? JSON.parse(txt) : true;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Publie un meilleur score. La clé primaire (joueur + morceau + difficulté
 * + mode) fait que l'envoi ÉCRASE la ligne précédente : la base ne garde
 * qu'un score par combinaison, exactement comme en local.
 */
export function publishScore(name, trackId, diff, keys, entry) {
  return publishMany(name, [{ trackId, diff, keys, entry }]);
}

/** Publie plusieurs scores d'un coup (bouton « publier mes scores »). */
export async function publishMany(name, list) {
  if (!enabled() || !list.length) return null;
  const id = playerId();
  const rows = list.map(({ trackId, diff, keys, entry }) => ({
    player_id: id,
    track_id: trackId,
    diff,
    keys: keys || '4',
    name: String(name || 'JOUEUR').slice(0, 12),
    score: Math.round(entry.score || 0),
    grade: entry.grade || 'D',
    precision: Math.min(1, Math.max(0, entry.precision || 0)),
    combo: Math.round(entry.comboMax || 0),
    mods: entry.mods || []
  }));
  // merge-duplicates : PostgREST traduit en « ON CONFLICT DO UPDATE ».
  return call('scores', {
    method: 'POST',
    headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(rows)
  });
}

/** Classement d'un morceau, pour une difficulté et un mode donnés. */
export async function trackBoard(trackId, diff, keys = '4', limit = 50) {
  const q = new URLSearchParams({
    select: 'player_id,name,score,grade,precision,combo,mods',
    track_id: `eq.${trackId}`,
    diff: `eq.${diff}`,
    keys: `eq.${keys}`,
    order: 'score.desc',
    limit: String(limit)
  });
  const rows = await call(`scores?${q}`, { headers: headers() });
  return Array.isArray(rows) ? rows : null;
}

/**
 * Classement général : une vue SQL agrège par joueur le nombre de SS, S+, S
 * et son meilleur combo. Le calcul se fait côté base, le jeu n'affiche.
 */
export async function globalBoard(limit = 50) {
  const q = new URLSearchParams({
    select: 'player_id,name,ss,splus,s,max_combo,charts',
    order: 'ss.desc,splus.desc,s.desc,max_combo.desc',
    limit: String(limit)
  });
  const rows = await call(`leaderboard?${q}`, { headers: headers() });
  return Array.isArray(rows) ? rows : null;
}
