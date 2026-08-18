# NEONBEAT

Jeu de rythme mobile façon DJ Max — **4 joueurs dans le même salon, chacun sur
son téléphone**, sans installation ni compte. 100 % statique, hébergeable sur
GitHub Pages.

## Jouer

Ouvrir l'URL GitHub Pages du dépôt sur un téléphone (portrait) :

1. **CRÉER UNE PARTIE** → un code à 4 lettres + un QR code s'affichent.
2. Les autres scannent le QR (ou saisissent le code) et rejoignent le lobby.
3. À la première visite, chaque joueur passe une **calibration** de latence
   (20 frappes en rythme — c'est elle qui rend le jeu précis sur ton appareil).
4. L'hôte choisit le morceau ; **chacun choisit sa difficulté** et sa
   **vitesse de chute** (multiplicateur ×1 → ×6 façon DJ Max : plus c'est
   rapide, moins il y a de notes à l'écran en même temps).
5. Mode **SALON** (seul le téléphone de l'hôte joue le son, les autres sont
   synchronisés à ±20 ms) ou **CASQUES** (chacun son audio).

Le jeu reste entièrement jouable **en solo**, même sans réseau.

## Musique

Cinq compositions originales (CC0), du plus facile au plus difficile :

| # | Titre | BPM | Style |
|---|---|---|---|
| 1 | Neon Sunrise | 100 | synthwave |
| 2 | Midnight Drive | 118 | retrowave |
| 3 | Laser Bloom | 128 | electro-house |
| 4 | Circuit Storm | 145 | electro |
| 5 | Hyper Nova | 174 | drum & bass |

Aucun fichier audio dans le dépôt : chaque morceau est **synthétisé sur
l'appareil** (`js/synth.js`) à partir de sa partition (`js/songs/*.js`), et les
charts jouables (`tracks/*.json`) sont **dérivées de la même partition** — la
synchronisation notes/musique est donc exacte par construction.

Trois difficultés par morceau (EASY / NORMAL / HARD), 4 couloirs, notes
simples et notes longues, multi-touch (accords jusqu'à 4 doigts).

**Pistes importées** : le jeu lit aussi des fichiers MP3/M4A placés dans
`tracks/` (voir `tools/import-audio.mjs`, qui analyse le signal — BPM, onsets
par bandes — et génère les charts calées sur la grille rythmique). Chaque
piste importée doit être documentée dans `tracks/CREDITS.md`.

## Développement

Aucun build : vanilla HTML/CSS/JS en modules ES, servi tel quel.

```bash
python3 -m http.server 8000        # puis http://localhost:8000
```

- Régénérer les charts après avoir modifié une partition :
  `node tools/build-charts.mjs`
- Éditeur de charts manuel (desktop, clavier D F J K) : `tools/editor.html`
- Multijoueur : PeerJS via le broker public `0.peerjs.com` (configurable en
  tête de `js/net.js`, ou par `localStorage['neonbeat.signaling']`).

## Déploiement GitHub Pages

`Settings → Pages → Deploy from a branch`, racine de la branche. Le fichier
`.nojekyll` est déjà présent et tous les chemins sont relatifs.

Licences : code MIT · musiques CC0 (voir `tracks/CREDITS.md`).
