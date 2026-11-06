# Déploiement sur un serveur (Docker)

`Dockerfile` + `docker-compose.yml` à la racine. L'image contient le jeu construit (moteur WASM,
`client/dist`, serveur Fastify) ; **les fichiers de The Sims n'y sont pas** et ne doivent jamais y
être : ils sont montés en lecture seule depuis le serveur, ou, en mode « fichiers du jeu chez le
joueur » (`THESIMSWEB_GAME_FILES=client`, voir plus bas), importés par chaque joueur dans son
navigateur.

## Mise en place

1. Copier le dossier d'installation du jeu sur le serveur (par exemple `/srv/sims/Les Sims`, celui
   qui contient `GameData/`, `UserData/`, `ExpansionShared/`…). Il est lu tel quel, la casse des noms
   n'a pas d'importance (vérifié sur un système de fichiers Linux sensible à la casse).
2. Copier le dépôt (ou seulement les sources : voir `.dockerignore`) sur le serveur.
3. `cp .env.example .env` et régler `SIMS_DIR` (obligatoire, sauf en mode
   `THESIMSWEB_GAME_FILES=client`), `THESIMSWEB_PORT`, `THESIMSWEB_BIND`, `THESIMSWEB_SAVES`,
   `THESIMSWEB_GAME_FILES` (voir ci-dessous). Sans `SIMS_DIR`, compose monte `./server/assets/Sims`
   (créé vide au besoin) et le serveur signale dans son journal qu'il n'a pas de dossier de jeu.
4. `docker compose up -d --build`, puis ouvrir `http://<serveur>:<port>/` (page d'accueil : jouer,
   exporter / importer les sauvegardes ; guide du joueur : [`user-guide.md`](./user-guide.md)).

Mise à jour après un `git pull` : `docker compose up -d --build` (les sauvegardes restent).

## Sauvegardes : deux modes (`THESIMSWEB_SAVES`, variable `SAVES` du serveur)

- **`server`** (par défaut) : une instance = un joueur. Une seule série de sauvegardes, sur le
  serveur ; on la retrouve depuis n'importe quel navigateur.
- **`client`** : une instance = plusieurs joueurs. Chaque navigateur garde ses propres sauvegardes
  (IndexedDB, base `thesimsweb-saves`, `client/src/engine/saves.ts`) et part des quartiers
  d'origine du dossier du jeu. Le serveur refuse alors toute écriture (403) et n'utilise pas le
  volume `saves`. Les sauvegardes sont liées à l'adresse du site (domaine + port) et au
  navigateur : changer d'adresse, de navigateur, ou effacer les données du site les perd. Le jeu
  demande au navigateur un stockage persistant (`navigator.storage.persist`). La page d'accueil
  exporte et importe ces sauvegardes (une archive ZIP, voir [`user-guide.md`](./user-guide.md) § 4).

Changer de mode ne convertit rien : les sauvegardes du serveur restent dans le volume, celles des
navigateurs dans les navigateurs.

### Mode `server`

Le jeu écrit ses `UserData*` dans le volume nommé `saves` (monté sur `/app/server/data/overlay`) ;
il survit aux reconstructions. Pour reprendre des sauvegardes existantes (l'overlay local
`server/data/overlay/`) :

```bash
docker compose cp server/data/overlay/Sims thesimsweb:/app/server/data/overlay/
docker compose exec -u root thesimsweb chown -R node:node /app/server/data/overlay
```

Pour les récupérer : `docker compose cp thesimsweb:/app/server/data/overlay/Sims ./sauvegardes`.
Plus simple : **Export saves** / **Import saves…** sur la page d'accueil (`GET /api/saves` liste les
fichiers de l'overlay, l'import passe par `DELETE` / `PUT /api/files`). Hors Docker, la variable
`OVERLAY_DIR` du serveur change le dossier de l'overlay (défaut `server/data/overlay`).

## Film d'intro

Au démarrage, le jeu montre le film d'intro EA de sa langue (`Music/eag_<langue>.avi`, en
MS-MPEG4, que les navigateurs ne lisent pas). Le serveur le convertit une fois en WebM avec
`ffmpeg` (`server/src/routes/movies.ts`, copie gardée dans `server/data/movies/`). L'image
l'installe par défaut ; `docker compose build --build-arg WITH_FFMPEG=0` l'omet (image plus
petite, le film est alors sauté). En mode `GAME_FILES=client`, il est toujours sauté.

## Fichiers du jeu : sur le serveur ou chez chaque joueur (`THESIMSWEB_GAME_FILES`, variable `GAME_FILES` du serveur)

- **`server`** (par défaut) : le jeu tourne sur le dossier `SIMS_DIR` du serveur, servi sous
  `/assets/` (avec `/api/manifest` et `/api/ranges`). C'est l'usage personnel : son propre jeu, sur
  son propre serveur.
- **`client`** : **le serveur ne sert aucun fichier du jeu**, seulement l'application (pages,
  scripts, moteur WASM). Chaque joueur sélectionne sur la page d'accueil le dossier d'installation
  de **sa propre copie** de The Sims (Complete Collection) ; la page vérifie que c'est bien un
  dossier du jeu complet (`GameData/`, `ExpansionShared/`, `ExpansionPack…7/`, `UIGraphics/`,
  `SoundData/`, `UserData/Neighborhood.iff`…) et copie dans le navigateur (IndexedDB, base
  `thesimsweb-gamefiles`, `client/src/engine/gamefiles.ts`) les fichiers que le jeu lit (ni les
  `.exe` / `.dll`, ni les journaux, ni `support/`, ni les vidéos d'intro). Le jeu ne démarre
  qu'une fois l'import terminé ; sans import, `/game.html` renvoie à la page d'accueil.
  `/assets/`, `/api/manifest` et `/api/ranges` répondent 404, et les sauvegardes restent dans les
  navigateurs (`SAVES=client` est imposé, `THESIMSWEB_SAVES` est ignoré).

**Pourquoi ce mode** : pour ouvrir une instance à d'autres personnes sans **jamais distribuer les
fichiers de Maxis / Electronic Arts**, qui sont protégés par le droit d'auteur. Le serveur ne fait
qu'héberger le code du portage (libre) ; chaque joueur apporte son propre exemplaire du jeu, qui ne
quitte pas son ordinateur (le fichier est lu par le navigateur, rien n'est envoyé au serveur). En
mode `server`, au contraire, l'instance sert le jeu à quiconque l'atteint : à réserver à soi-même.

Limites :

- **Place** : environ **3,2 Go** par navigateur (la Complete Collection entière moins les
  programmes), stockés dans le profil du navigateur. Firefox et Chrome l'acceptent sur un disque qui
  a la place ; la page demande le stockage persistant (`navigator.storage.persist`) pour que le
  navigateur ne l'efface pas en cas de manque de place.
- **Un import par navigateur** (et par adresse du site, comme les sauvegardes) : un autre
  navigateur, un autre appareil, une autre adresse (domaine, port) demandent un nouvel import.
- L'import prend quelques minutes (copie locale de 3 Go). Interrompu (onglet fermé, bouton
  **Stop**), il reprend là où il s'était arrêté en sélectionnant de nouveau le dossier : les
  fichiers déjà copiés, de même taille et même date, ne sont pas recopiés. Sous Chrome / Edge, le
  sélecteur de dossier (File System Access API) garde le dossier, et un bouton **Resume** reprend
  sans le resélectionner.
- Le dossier sélectionné n'est que lu. Les sauvegardes d'origine qu'il contient (`UserData*`) sont
  copiées comme le reste ; les sauvegardes du joueur les masquent ensuite, comme en mode
  `SAVES=client`.
- **Remove the game files** efface l'import (les sauvegardes restent) ; **Import again…** refait
  un import (seuls les fichiers changés sont recopiés, ceux qui ont disparu du dossier sont retirés).
- Le jeu tourne alors entièrement dans le navigateur : une fois l'import fait, il démarre sans
  connexion si le service worker est actif (HTTPS ou localhost, voir plus bas).

Hors Docker : `GAME_FILES=client pnpm start` (ou `GAME_FILES=client npx tsx src/index.ts` dans
`server/`).

## Sécurité

Le serveur n'a **aucune authentification** : en mode `server`, quiconque l'atteint peut jouer et
écraser les sauvegardes (`PUT` / `DELETE /api/files/Sims/UserData*/`). En mode `client`, il est en
lecture seule, mais sert quand même les fichiers du jeu à qui l'atteint, sauf avec
`THESIMSWEB_GAME_FILES=client` (il ne sert alors plus que l'application). Par défaut le port n'est publié que sur
`127.0.0.1` ; le mettre derrière un reverse proxy (Caddy, nginx, Traefik) avec authentification et
HTTPS, ou le garder sur un réseau privé (VPN). `THESIMSWEB_BIND=0.0.0.0` l'expose directement.

Le reverse proxy doit laisser passer les requêtes `Range` et les corps `PUT` jusqu'à 128 Mo
(nginx : `client_max_body_size 128m;`). Le mode hors ligne (service worker) exige HTTPS, sauf sur
`localhost` : derrière un reverse proxy HTTPS il fonctionne, en `http://<ip-du-LAN>` non.

## Détails de l'image

- Étape `wasm` : `rust:1.95` + `wasm-pack` 0.14 → `crates/wasm-bindings/pkg`.
- Étape `build` : `pnpm install --frozen-lockfile`, build du client et du serveur, `pnpm deploy`
  du serveur avec ses seules dépendances de production.
- Étape finale : `node:22-bookworm-slim`, utilisateur `node`, `HOST=0.0.0.0`, `PORT=3000`,
  healthcheck sur `/api/health`. Environ 360 Mo.
