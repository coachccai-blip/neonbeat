# Crédits musicaux

Toutes les pistes de NEONBEAT sont des **compositions originales** écrites
pour le jeu et placées dans le **domaine public (CC0 1.0)**.

Aucun fichier audio n'est distribué : chaque morceau est **synthétisé en
temps réel sur l'appareil** à partir de sa partition (`js/songs/*.js`) par le
moteur de synthèse du jeu (`js/synth.js`). Les partitions jouables
(`tracks/*.json`) sont dérivées de ces mêmes partitions musicales, ce qui
garantit une synchronisation exacte entre les notes et la musique.

| Titre | Auteur | BPM | Source | Licence |
|---|---|---|---|---|
| **Neon Sunrise** | NEONBEAT | 100 | `js/songs/neon-sunrise.js` | CC0-1.0 |
| **Midnight Drive** | NEONBEAT | 118 | `js/songs/midnight-drive.js` | CC0-1.0 |
| **Laser Bloom** | NEONBEAT | 128 | `js/songs/laser-bloom.js` | CC0-1.0 |
| **Circuit Storm** | NEONBEAT | 145 | `js/songs/circuit-storm.js` | CC0-1.0 |
| **Hyper Nova** | NEONBEAT | 174 | `js/songs/hyper-nova.js` | CC0-1.0 |

## Pistes importées par le propriétaire du site

Les pistes suivantes ont été **fournies par le propriétaire du site** (fichiers
MP3 déposés tels quels dans `tracks/`). Elles ne sont pas des créations
NEONBEAT : **la vérification et la détention des droits de diffusion relèvent
de la responsabilité du propriétaire du site**. Les partitions jouables ont
été générées par analyse du signal (`tools/import-audio.mjs`).

| Titre | Fichier | BPM détecté | Licence |
|---|---|---|---|
| Tout est verrouillé | `verrouille.mp3` | 94 | fournie par l'utilisateur — droits à sa charge |
| Laissez aller | `laissez-aller.mp3` | 134 | fournie par l'utilisateur — droits à sa charge |
| DBZGT | `dbzgt.mp3` | 131 | fournie par l'utilisateur — droits à sa charge |
| Sushi Club | `sushi-club.mp3` | 138 | fournie par l'utilisateur — droits à sa charge |
| Papillon | `papillon.mp3` | 164 | fournie par l'utilisateur — droits à sa charge |
| Dorée | `doree.mp3` | 122 | fournie par l'utilisateur — droits à sa charge |
| Départ CDG | `depart-cdg.mp3` | 159 | fournie par l'utilisateur — droits à sa charge |
| Terre de magie | `terre-de-magie.mp3` | 142 | fournie par l'utilisateur — droits à sa charge |
| L'histoire de la life | `histoire-de-la-life.mp3` | 170 | fournie par l'utilisateur — droits à sa charge |
| Jusqu'où je peux aller | `jusquou-je-peux-aller.mp3` | 164 | fournie par l'utilisateur — droits à sa charge |

## Bibliothèques embarquées

| Lib | Usage | Licence |
|---|---|---|
| **PeerJS** (`vendor/peerjs.min.js`) | Multijoueur WebRTC | MIT |
| **qrcode-generator** (`vendor/qrcode.min.js`) | QR code du salon | MIT |
