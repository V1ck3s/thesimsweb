# Guide d'utilisation

thesimsweb fait tourner **Les Sims (2000, Complete Collection)** dans un navigateur, à partir des
fichiers d'une installation du jeu. Le projet ne contient **aucun fichier du jeu** : il faut sa
propre copie installée (le dossier qui contient `GameData/`, `UserData/`, `ExpansionShared/`…).

## 1. Installation

### En local (une machine, un joueur)

Outils : Node 22, pnpm 10, Rust + `wasm-pack` (voir `docs/DEVELOPMENT.md`, « Bootstrap d'une nouvelle machine »).

```bash
pnpm install
mkdir -p server/assets
ln -s "/chemin/vers/Les Sims" server/assets/Sims   # le dossier d'installation du jeu (lu, jamais modifié)
pnpm start                                         # construit ce qui manque, puis sert le jeu
```

Ouvrir <http://127.0.0.1:3000/>. Options : `pnpm start --port 4000` (ou `PORT=4000`),
`HOST=0.0.0.0 pnpm start` pour le réseau local, `SAVES=client pnpm start` pour garder les
sauvegardes dans le navigateur (voir § 3).

### Sur un serveur (Docker)

`cp .env.example .env`, régler `SIMS_DIR` (le dossier du jeu sur le serveur) et
`THESIMSWEB_SAVES`, puis `docker compose up -d --build`. Détails, sécurité et reverse proxy :
[`docker.md`](./docker.md). Le serveur n'a pas d'authentification : le mettre derrière un reverse
proxy avec mot de passe et HTTPS, ou sur un réseau privé.

## 2. La page d'accueil

`/` ouvre une page d'accueil (en anglais, hors du jeu) :

- **Play** lance le jeu (`/game.html`) ;
- le mode de sauvegarde de l'instance, le nombre de fichiers sauvegardés, **Export saves** et
  **Import saves…** (§ 4) ;
- l'état du stockage du navigateur (persistant ou non, place occupée) et du mode hors ligne (§ 6).

Les adresses directes du jeu restent valables : `/game.html`, et `/` suivi d'une query string
(`/?house=1` entre directement dans la maison 1, `/?nbhd=UserData2` choisit le quartier). Un
marque-page sur `/?…` lance donc toujours le jeu.

Le premier lancement lit tout le catalogue d'objets (une à deux minutes) ; les fichiers du jeu
sont ensuite gardés par le navigateur (IndexedDB) et les lancements suivants prennent quelques
secondes. Ne jouer que dans un seul onglet à la fois.

## 3. Les deux modes de sauvegarde

Le mode est choisi par instance, au lancement du serveur (variable `SAVES`, ou
`THESIMSWEB_SAVES` avec Docker). La page d'accueil l'affiche.

- **`server`** (par défaut) : une seule série de sauvegardes, sur le serveur
  (`server/data/overlay/`, ou le volume `saves` avec Docker). On la retrouve depuis n'importe quel
  navigateur ; tous ceux qui jouent sur l'instance partagent les mêmes quartiers.
- **`client`** : chaque navigateur garde ses propres sauvegardes (IndexedDB) et part des quartiers
  d'origine du dossier du jeu ; le serveur est en lecture seule. Les sauvegardes sont liées au
  navigateur, à l'appareil et à l'adresse du site (domaine + port) : changer l'un des trois, ou
  effacer les données du site, les fait disparaître. **Exporter régulièrement** (§ 4) et accepter le
  stockage persistant (bouton « Keep this site's data » de la page d'accueil, ou la demande du
  navigateur).

Changer de mode ne convertit rien ; pour passer d'un mode à l'autre, exporter puis importer.

## 4. Exporter et importer les sauvegardes

**Export saves (.zip)** télécharge une archive ZIP `thesims-saves-AAAA-MM-JJ.zip` de tous les
fichiers écrits par le jeu, avec leur chemin dans le dossier du jeu
(`Sims/UserData2/Houses/House01.iff`, `Sims/UserData/Characters/User00012.iff`…) :

- en mode `client`, les fichiers sauvegardés dans ce navigateur ;
- en mode `server`, les fichiers sauvegardés sur le serveur (les originaux du dossier du jeu, jamais
  modifiés, n'y sont pas).

**Import saves…** remplace **toutes** les sauvegardes de l'instance par le contenu d'une archive,
après confirmation : les sauvegardes absentes de l'archive sont supprimées (les fichiers d'origine
du jeu réapparaissent), celles de l'archive sont écrites. En mode `server`, cela touche tous les
joueurs de l'instance. Fermer les onglets du jeu avant d'importer. L'opération n'est pas
annulable : exporter d'abord en cas de doute.

L'import accepte aussi une archive faite à la main (ZIP stocké ou compressé « deflate », comme le
font Windows, macOS et `zip`) : seuls les fichiers sous un dossier `UserData`, `UserData2`… sont
pris, quel que soit le dossier au-dessus (`sauvegarde/UserData2/…`, `Sims/UserData2/…`,
`UserData2/…`). On peut donc reprendre les sauvegardes du jeu original sous Windows en zippant ses
dossiers `UserData*` (attention : l'archive remplace tout, quartiers d'origine compris si elle les
contient). Une archive sans aucun fichier `UserData*` est refusée sans rien changer.

En mode `server` on peut aussi copier les fichiers directement (voir [`docker.md`](./docker.md)).

## 5. Navigateurs

- **Firefox** et **Chrome / Edge** (ordinateur de bureau) : pris en charge.
- Safari : non testé régulièrement.
- Le jeu se joue à la souris et au clavier.

## 6. Hors ligne et installation comme application

Le site s'installe comme une application (Chrome / Edge : icône d'installation dans la barre
d'adresse, ou menu « Installer… » ; Firefox de bureau ne le propose en général pas, mais le mode
hors ligne y fonctionne).

Une fois le jeu lancé une fois sur l'appareil, **il redémarre sans connexion** :

- la page d'accueil et le jeu (pages, scripts, moteur WASM) sont gardés par un service worker ;
- les fichiers du jeu déjà lus le sont dans le cache IndexedDB ;
- les dernières réponses du serveur (configuration, liste des fichiers, fichiers de quartier et
  de maison lus) sont gardées par le service worker.

Limites :

- **HTTPS ou localhost obligatoire** : les navigateurs n'activent pas de service worker sur une
  adresse `http://` du réseau local (`http://192.168.x.x:3000`). Le jeu y fonctionne, mais pas
  hors ligne. Utiliser `http://localhost` / `127.0.0.1`, ou HTTPS via un reverse proxy.
- Hors ligne, seul ce qui a déjà été lu est disponible : un quartier ou un terrain jamais ouvert,
  une page du catalogue jamais affichée, les musiques (lues en continu, non gardées) demandent le
  serveur.
- En mode `server`, le jeu **ne peut pas sauvegarder hors ligne** (les sauvegardes vont au
  serveur). En mode `client`, il sauvegarde normalement dans le navigateur.
- Le serveur de développement (`pnpm dev`, port 5173) n'installe pas de service worker : le mode
  hors ligne ne concerne que les builds (`pnpm start`, Docker).
- Après une mise à jour du jeu sur le serveur, le nouveau code est chargé au lancement suivant
  (en ligne) ; l'ancien reste utilisé hors ligne tant que la nouvelle version n'a pas été chargée.

## 7. Limites connues

- Il faut sa propre copie du jeu, installée sur le serveur ; pas encore d'import du dossier du jeu
  depuis le navigateur.
- Aucune authentification côté serveur (voir [`docker.md`](./docker.md), « Sécurité »).
- Les données du navigateur (cache des fichiers du jeu, plusieurs centaines de Mo, et sauvegardes
  en mode `client`) peuvent être effacées par le navigateur si le disque manque de place, tant que
  le stockage n'est pas persistant.
- Un seul onglet du jeu à la fois.
- La version tactile / mobile est en cours.
- Le reste (fonctions du jeu manquantes, bugs connus) : [`TODO.md`](./TODO.md).

## 8. Dépannage

- **Le jeu ne démarre plus après une mise à jour** : recharger la page (Ctrl+F5) ; au besoin,
  outils de développement → Application → Service workers → « Unregister », puis recharger.
- **Repartir de zéro** (perd les sauvegardes en mode `client` : exporter d'abord) : effacer les
  données du site dans les réglages du navigateur.
