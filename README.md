# MangaReader

Lecteur de mangas et de webtoons **hors ligne** pour iPhone. C'est une appli web 100 % statique (PWA) : pas de serveur, pas de compte.

Recréation améliorée de l'ancienne appli Pythonista (même logique de bibliothèque, progression, stats et lecteur vertical), hébergée sur GitHub Pages.

**Adresse : https://sys-seed.github.io/manga-reader/**

## Installation sur iPhone
1. Ouvre l'adresse ci-dessus dans **Safari**.
2. Touche **Partager**, puis **« Sur l'écran d'accueil »**, puis **Ajouter**.
3. Ouvre toujours l'appli **depuis l'icône « Mangas »**. Elle s'ouvre en plein écran et fonctionne sans réseau.

## Utilisation
- **➕ Importer** : des fichiers **.cbz / .zip**, des images, ou un dossier entier depuis l'app Fichiers. Si le choix de dossier n'est pas proposé, fais un appui long sur le dossier dans Fichiers, puis *Compresser*, et importe le .zip.
- Les pages sont stockées **sur l'iPhone**, dans l'appli : rien n'est envoyé en ligne. Seule la recherche AniList (résumé, genres, couverture) utilise le réseau.
- **Réglages › Fiches & stats fournies** : reprend `library_index.json`, `reading_stats.json` et `last_chapters_seen.json` de l'ancienne appli (dossier `data/`). Les images ne sont pas incluses : garde tes .cbz / dossiers de chapitres.
- **Réglages › Exporter une sauvegarde** : progression, statistiques et fiches dans un fichier JSON.

## Améliorations par rapport à Pythonista
- Stockage IndexedDB + import .cbz/.zip natif (plus besoin de Pythonista ni de chemins iCloud en dur).
- Reprise de lecture **à la page exacte** (pas seulement le chapitre).
- Métadonnées via **AniList** (légal, CORS OK) au lieu du scraping de sites de scans.
- Écriture atomique des chapitres (évite les imports partiels), sélecteur de chapitres dans le lecteur, mise à jour PWA plus fiable.
- Plafond de durée de session (évite les sessions aberrantes de plusieurs heures laissées ouvertes).

## Limites
- Safari limite l'espace disponible. L'espace utilisé est affiché dans Réglages et Stats.
- Supprimer l'icône ou effacer les données de Safari efface les mangas importés : **exporte une sauvegarde de temps en temps**.
- Les données de l'appli de l'écran d'accueil sont séparées de celles de l'onglet Safari.

Aucun téléchargement depuis des sites de scans : l'appli lit uniquement les fichiers que tu possèdes.

## Développement
Fichiers principaux : `app.js` (UI), `db.js` (IndexedDB + métier), `zip.js` (lecture CBZ/ZIP), `sw.js` (hors ligne).
Tests locaux : `python3 -m http.server 8080` puis ouvrir `http://127.0.0.1:8080/`.
