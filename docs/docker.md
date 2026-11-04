# Déploiement sur un serveur (Docker)

`Dockerfile` + `docker-compose.yml` à la racine. L'image contient le jeu construit (moteur WASM,
`client/dist`, serveur Fastify) ; **les fichiers de The Sims n'y sont pas** et ne doivent jamais y
être : ils sont montés en lecture seule depuis le serveur.

## Mise en place

1. Copier le dossier d'installation du jeu sur le serveur (par exemple `/srv/sims/Les Sims`, celui
   qui contient `GameData/`, `UserData/`, `ExpansionShared/`…). Il est lu tel quel, la casse des noms
   n'a pas d'importance (vérifié sur un système de fichiers Linux sensible à la casse).
2. Copier le dépôt (ou seulement les sources : voir `.dockerignore`) sur le serveur.
3. `cp .env.example .env` et régler `SIMS_DIR` (obligatoire), `THESIMSWEB_PORT`, `THESIMSWEB_BIND`,
   `THESIMSWEB_SAVES` (voir ci-dessous).
4. `docker compose up -d --build`, puis ouvrir `http://<serveur>:<port>/`.

Mise à jour après un `git pull` : `docker compose up -d --build` (les sauvegardes restent).

## Sauvegardes : deux modes (`THESIMSWEB_SAVES`, variable `SAVES` du serveur)

- **`server`** (par défaut) : une instance = un joueur. Une seule série de sauvegardes, sur le
  serveur ; on la retrouve depuis n'importe quel navigateur.
- **`client`** : une instance = plusieurs joueurs. Chaque navigateur garde ses propres sauvegardes
  (IndexedDB, base `thesimsweb-saves`, `client/src/engine/saves.ts`) et part des quartiers
  d'origine du dossier du jeu. Le serveur refuse alors toute écriture (403) et n'utilise pas le
  volume `saves`. Les sauvegardes sont liées à l'adresse du site (domaine + port) et au
  navigateur : changer d'adresse, de navigateur, ou effacer les données du site les perd. Le jeu
  demande au navigateur un stockage persistant (`navigator.storage.persist`). Pas encore
  d'export / import des sauvegardes (voir `docs/TODO.md`).

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

## Sécurité

Le serveur n'a **aucune authentification** : en mode `server`, quiconque l'atteint peut jouer et
écraser les sauvegardes (`PUT` / `DELETE /api/files/Sims/UserData*/`). En mode `client`, il est en
lecture seule, mais sert quand même les fichiers du jeu à qui l'atteint. Par défaut le port n'est publié que sur
`127.0.0.1` ; le mettre derrière un reverse proxy (Caddy, nginx, Traefik) avec authentification et
HTTPS, ou le garder sur un réseau privé (VPN). `THESIMSWEB_BIND=0.0.0.0` l'expose directement.

Le reverse proxy doit laisser passer les requêtes `Range` et les corps `PUT` jusqu'à 128 Mo
(nginx : `client_max_body_size 128m;`).

## Détails de l'image

- Étape `wasm` : `rust:1.95` + `wasm-pack` 0.14 → `crates/wasm-bindings/pkg`.
- Étape `build` : `pnpm install --frozen-lockfile`, build du client et du serveur, `pnpm deploy`
  du serveur avec ses seules dépendances de production.
- Étape finale : `node:22-bookworm-slim`, utilisateur `node`, `HOST=0.0.0.0`, `PORT=3000`,
  healthcheck sur `/api/health`. Environ 360 Mo.
