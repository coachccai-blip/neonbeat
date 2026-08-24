// Mode écoute : le lecteur de musique de l'application.
//
// Il n'emprunte PAS le moteur audio du jeu. Celui-ci décode chaque morceau
// entièrement en mémoire — indispensable pour placer les notes à la
// milliseconde, absurde pour écouter un album : plusieurs dizaines de méga-
// octets par piste et une attente au lancement. Ici un simple élément
// <audio> suffit : lecture immédiate en flux, déplacement natif dans la
// piste, et surtout la Media Session, qui met les contrôles sur l'écran
// verrouillé et permet de continuer à écouter téléphone rangé.
//
// Les deux mondes ne se croisent jamais : lancer une partie coupe le
// lecteur, et le lecteur laisse la priorité aux préversions du jeu.

import * as storage from './storage.js';

const REPEATS = ['all', 'one', 'off'];

let el = null;                 // l'élément <audio>
let liste = [];                // catalogue, dans l'ordre d'affichage
let ordre = [];                // indices dans l'ordre de lecture
let pos = -1;                  // position dans `ordre`
let abonnes = [];
let objetUrl = null;           // blob du morceau en cours
let precharge = { id: null, url: null }; // blob du morceau suivant, prêt d'avance
let jeton = 0;                 // annule un chargement dépassé
let chargement = false;

/** Élément audio, créé au premier besoin. */
function audio() {
  if (el) return el;
  el = new Audio();
  el.id = 'player-audio';
  el.preload = 'metadata';
  el.setAttribute('playsinline', '');
  // Attaché au document : un élément détaché est traité comme un média
  // secondaire par certains navigateurs mobiles, qui le suspendent plus
  // volontiers dès que l'onglet passe en arrière-plan — précisément ce
  // qu'on ne veut pas d'un lecteur de musique.
  el.hidden = true;
  document.body.appendChild(el);
  el.volume = clampVol(storage.get('volume'));
  el.addEventListener('ended', auSuivant);
  el.addEventListener('timeupdate', signaler);
  el.addEventListener('play', () => { etatSysteme('playing'); signaler(); });
  el.addEventListener('pause', () => { etatSysteme('paused'); signaler(); });
  el.addEventListener('loadedmetadata', signaler);
  return el;
}

// Le volume du jeu est un gain Web Audio qui peut dépasser 1 ; celui d'un
// élément <audio> ne le peut pas.
function clampVol(v) {
  return Math.max(0, Math.min(1, typeof v === 'number' ? v : 0.8));
}

export function init(tracks) {
  liste = tracks || [];
  rebatir();
}

/** Ordre de lecture : celui du catalogue, ou tiré au sort si aléatoire. */
function rebatir(garder) {
  const idCourant = garder && ordre[pos] != null ? liste[ordre[pos]].id : null;
  ordre = liste.map((_, i) => i);
  if (storage.get('plShuffle')) {
    for (let i = ordre.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ordre[i], ordre[j]] = [ordre[j], ordre[i]];
    }
  }
  // Le morceau en cours reste en cours : changer de mode ne doit pas
  // interrompre ce qu'on écoute.
  pos = idCourant ? ordre.findIndex((i) => liste[i].id === idCourant) : -1;
  // L'ordre a changé : le morceau préchargé n'est peut-être plus le bon.
  oublierPrecharge();
  precharger();
}

export function onChange(cb) {
  abonnes.push(cb);
}

function signaler() {
  const s = state();
  for (const cb of abonnes) cb(s);
}

export function state() {
  const t = ordre[pos] != null ? liste[ordre[pos]] : null;
  return {
    track: t,
    playing: !!(el && !el.paused && t),
    charge: !!t,
    chargement,
    time: el ? el.currentTime || 0 : 0,
    duration: el && el.duration && isFinite(el.duration) ? el.duration : (t ? t.duration : 0),
    shuffle: !!storage.get('plShuffle'),
    repeat: storage.get('plRepeat') || 'all',
    // Le morceau suivant, déjà en mémoire et prêt à enchaîner sans réseau.
    pret: precharge.id
  };
}

/**
 * Charge le morceau en mémoire et rend une URL locale.
 *
 * Pourquoi ne pas donner l'adresse du fichier à l'élément <audio> ? Parce
 * qu'un flux n'est déplaçable que si le serveur annonce gérer les requêtes
 * de plage. Le service worker, lui, sert les morceaux depuis son cache
 * permanent et ne les gère pas : le navigateur déclarait alors le média
 * « seekable: [0, 0] » ALORS MÊME qu'il était intégralement en mémoire, et
 * la barre de position restait inerte.
 *
 * Un blob local, lui, est toujours déplaçable. Il coûte quelques méga-
 * octets — sans commune mesure avec le décodage complet que fait le moteur
 * du jeu — et garantit au passage une lecture sans coupure hors ligne.
 */
async function versBlob(id) {
  const res = await fetch(`./tracks/${id}.mp3`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/**
 * Rend une URL locale jouable pour ce morceau, en réutilisant le blob
 * préchargé s'il correspond — c'est là tout l'intérêt : au moment où un
 * morceau se termine, le suivant est déjà en mémoire et l'enchaînement ne
 * demande plus le moindre accès réseau. Sur un téléphone verrouillé, le
 * navigateur gèle le JavaScript dès qu'un silence s'installe ; ne rien
 * avoir à télécharger entre deux pistes est ce qui permet à la lecture de
 * continuer indéfiniment en arrière-plan.
 */
async function chargerBlob(id, monJeton) {
  let url;
  if (precharge.id === id && precharge.url) {
    url = precharge.url;                       // déjà prêt : aucun téléchargement
    precharge = { id: null, url: null };       // il devient le morceau en cours
  } else {
    url = await versBlob(id);
  }
  if (monJeton !== jeton) {                     // l'utilisateur a changé d'avis
    URL.revokeObjectURL(url);
    return null;
  }
  if (objetUrl && objetUrl !== url) URL.revokeObjectURL(objetUrl);
  objetUrl = url;
  return objetUrl;
}

function oublierPrecharge() {
  if (precharge.url) URL.revokeObjectURL(precharge.url);
  precharge = { id: null, url: null };
}

/** L'identifiant du morceau qui sera joué après le morceau en cours. */
function idSuivant() {
  const rep = storage.get('plRepeat') || 'all';
  if (rep === 'one') return null;              // on relit le même sans recharger
  if (!ordre.length || pos < 0) return null;
  const suiv = pos + 1;
  if (suiv >= ordre.length) return rep === 'off' ? null : liste[ordre[0]].id;
  return liste[ordre[suiv]].id;
}

/**
 * Prépare le morceau suivant pendant que le morceau en cours joue — le
 * moment où le JavaScript tourne encore librement, écran allumé ou non.
 */
async function precharger() {
  const nid = idSuivant();
  if (!nid) return;
  if (precharge.id === nid && precharge.url) return;   // déjà prêt
  oublierPrecharge();
  const monJeton = jeton;
  let url;
  try {
    url = await versBlob(nid);
  } catch {
    return;
  }
  // La lecture a pu changer de morceau entre-temps : ce préchargement est
  // alors périmé.
  if (monJeton !== jeton || idSuivant() !== nid) {
    URL.revokeObjectURL(url);
    return;
  }
  precharge = { id: nid, url };
}

/** Joue ce morceau ; sans argument, reprend là où on en était. */
export async function play(id) {
  const a = audio();
  let cible = id;
  if (cible) {
    const i = ordre.findIndex((k) => liste[k].id === cible);
    if (i < 0) return;
    pos = i;
  } else if (pos < 0) {
    pos = 0;
    cible = liste[ordre[0]].id;
  } else {
    cible = liste[ordre[pos]].id;
  }
  const monJeton = ++jeton;
  chargement = true;
  mediaSession();
  signaler();
  let url;
  try {
    url = await chargerBlob(cible, monJeton);
  } catch {
    url = null;
  }
  if (monJeton !== jeton) return;             // un autre morceau a pris la main
  chargement = false;
  if (!url) return signaler();
  a.src = url;
  a.volume = clampVol(storage.get('volume'));
  a.loop = false;                 // la répétition est gérée par `auSuivant`
  a.play().catch(() => {});
  mediaSession();
  signaler();
  precharger();                   // le morceau suivant se prépare en fond
}

/**
 * Déverrouille l'élément audio dans un geste de l'utilisateur.
 *
 * Le chargement d'un morceau passe par un `await` ; sur mobile, la
 * permission de jouer accordée par un tap peut ne plus valoir de l'autre
 * côté de cette attente. On fait donc jouer un silence pendant le geste :
 * l'élément est dès lors considéré comme activé, et tout le reste suit.
 */
const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';
let amorce = false;
export function amorcer() {
  if (amorce) return;
  amorce = true;
  const a = audio();
  a.src = SILENCE;
  a.play().then(() => a.pause()).catch(() => {});
}

export function toggle() {
  const a = audio();
  if (!a.src || a.src === SILENCE) return play();
  if (a.paused) { a.play().catch(() => {}); mediaSession(); } else a.pause();
  signaler();
}

export function pause() {
  if (el && !el.paused) { el.pause(); signaler(); }
}

/** Arrêt complet : le lecteur rend la main (partie, calibration). */
export function stop() {
  jeton++;                        // annule un chargement en cours
  chargement = false;
  pos = -1;
  oublierPrecharge();
  if (!el) return signaler();
  el.pause();
  el.removeAttribute('src');
  el.load();
  if (objetUrl) { URL.revokeObjectURL(objetUrl); objetUrl = null; }
  etatSysteme('none');
  signaler();
}

function auSuivant() {
  // Le silence d'amorçage se termine dans l'instant : sans cette garde, il
  // déclenchait l'enchaînement et le seul fait d'OUVRIR le mode écoute
  // lançait un morceau que personne n'avait demandé.
  if (pos < 0) return;
  const rep = storage.get('plRepeat') || 'all';
  if (rep === 'one') {
    // Rembobiner plutôt que recharger : aucun accès réseau, enchaînement
    // instantané, et la boucle tient sur un téléphone verrouillé.
    const a = audio();
    a.currentTime = 0;
    a.play().catch(() => {});
    mediaSession();
    signaler();
    return;
  }
  if (pos + 1 >= ordre.length && rep === 'off') { pause(); return; }
  next();
}

export function next() {
  if (!ordre.length) return;
  pos = (pos + 1) % ordre.length;
  play(liste[ordre[pos]].id);
}

/**
 * Précédent — ou début du morceau s'il est déjà bien entamé, comme sur
 * toutes les platines : le premier appui rembobine, le second recule.
 */
export function prev() {
  if (!ordre.length) return;
  if (el && el.currentTime > 3) { el.currentTime = 0; return signaler(); }
  pos = (pos - 1 + ordre.length) % ordre.length;
  play(liste[ordre[pos]].id);
}

export function seekFrac(f) {
  const a = audio();
  const d = a.duration;
  if (!d || !isFinite(d)) return;
  a.currentTime = Math.max(0, Math.min(d - 0.05, f * d));
  signaler();
}

export function setShuffle(on) {
  storage.set('plShuffle', !!on);
  rebatir(true);
  signaler();
}

/** Fait tourner les modes de répétition : toutes → une → aucune. */
export function cycleRepeat() {
  const i = REPEATS.indexOf(storage.get('plRepeat') || 'all');
  storage.set('plRepeat', REPEATS[(i + 1) % REPEATS.length]);
  // Le morceau à préparer dépend du mode : le recalculer tout de suite.
  oublierPrecharge();
  precharger();
  signaler();
}

export function setVolume(v) {
  if (el) el.volume = clampVol(v);
}

/**
 * Contrôles système : titre, pochette et boutons sur l'écran verrouillé.
 * C'est ce qui fait la différence entre « un son qui sort du navigateur »
 * et un vrai lecteur de musique.
 */
let pochette = null;
export function setCoverMaker(fn) { pochette = fn; }

/**
 * Annonce l'état de lecture au système. Un `playbackState` tenu à jour aide
 * le navigateur à garder la session active — donc l'onglet vivant — quand
 * l'écran est verrouillé.
 */
function etatSysteme(s) {
  if ('mediaSession' in navigator) {
    try { navigator.mediaSession.playbackState = s; } catch { /* ignore */ }
  }
}

function mediaSession() {
  if (!('mediaSession' in navigator)) return;
  const t = ordre[pos] != null ? liste[ordre[pos]] : null;
  if (!t) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist || 'NEONBEAT',
      album: 'NEONBEAT',
      artwork: pochette ? [{ src: pochette(t), sizes: '96x96', type: 'image/png' }] : []
    });
    navigator.mediaSession.setActionHandler('play', () => toggle());
    navigator.mediaSession.setActionHandler('pause', () => pause());
    navigator.mediaSession.setActionHandler('previoustrack', () => prev());
    navigator.mediaSession.setActionHandler('nexttrack', () => next());
  } catch { /* navigateur sans Media Session : le lecteur marche quand même */ }
}
