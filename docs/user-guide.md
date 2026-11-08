# Guide d'utilisation

thesimsweb fait tourner **Les Sims (2000, Complete Collection)** dans un navigateur, à partir des
fichiers d'une installation du jeu. Le projet ne contient **aucun fichier du jeu** : il faut sa
propre copie installée (le dossier qui contient `GameData/`, `UserData/`, `ExpansionShared/`…) :
sur le serveur (cas par défaut), ou, sur une instance ouverte à d'autres, importée dans son
navigateur (§ 3 bis).

## 1. Installation

### En local (une machine, un joueur)

Outils : Node 22, pnpm 10, Rust + `wasm-pack` (voir `docs/DEVELOPMENT.md`, « Bootstrap d'une nouvelle machine »).

```bash
pnpm install
mkdir -p server/assets
ln -s "/chemin/vers/Les Sims" server/assets/Sims   # le dossier d'installation du jeu (lu, jamais modifié)
pnpm start                                         # construit ce qui manque, puis sert le jeu
```

Vérifier l'installation du jeu : `pnpm check-game` (le dossier lié dans `server/assets/Sims`), ou
`pnpm check-game "/chemin/vers/Les Sims"`. La commande compare le dossier à la liste des fichiers
d'une installation complète (Complete Collection, `client/public/gamefiles-reference.json` : chemins
et tailles seulement) et dit ce qui manque, dossier par dossier (`--all` : tout lister). Code de
sortie 1 s'il manque des fichiers du jeu ; il manque des peaux, musiques ou sons : 0 (le jeu
tourne, avec moins) ; une taille différente (autre langue ou version, ou copie abîmée) est signalée
sans erreur. La page d'accueil fait la même vérification (section « Fichiers du jeu »).

Ouvrir <http://127.0.0.1:3000/>. Options : `pnpm start --port 4000` (ou `PORT=4000`),
`HOST=0.0.0.0 pnpm start` pour le réseau local, `SAVES=client pnpm start` pour garder les
sauvegardes dans le navigateur (voir § 3), `GAME_FILES=client pnpm start` pour que chaque joueur
importe son propre jeu dans son navigateur (§ 3 bis).

### Sur un serveur (Docker)

`cp .env.example .env`, régler `SIMS_DIR` (le dossier du jeu sur le serveur) et
`THESIMSWEB_SAVES`, puis `docker compose up -d --build`. Détails, sécurité et reverse proxy :
[`docker.md`](./docker.md). Le serveur n'a pas d'authentification : le mettre derrière un reverse
proxy avec mot de passe et HTTPS, ou sur un réseau privé.

## 2. La page d'accueil

`/` ouvre une page d'accueil (en anglais, hors du jeu) :

- **Play** lance le jeu (`/game.html`) ;
- la section **Game files** : la vérification de l'installation (fichiers manquants, par
  dossier, et tailles différentes de l'installation de référence) ; sur une instance en mode
  `GAME_FILES=client`, l'import du dossier du jeu dans le navigateur (§ 3 bis), vérifié une fois
  importé ; **Play** n'est actif qu'une fois l'import terminé ;
- le mode de sauvegarde de l'instance, le nombre de fichiers sauvegardés, **Export saves** et
  **Import saves…** (§ 4) ;
- l'état du stockage du navigateur (persistant ou non, place occupée) et du mode hors ligne (§ 6) ;
- la section **Display** : la résolution du jeu et l'interface centrée (ci-dessous).

### Résolution et interface centrée

Le jeu original dessine un pixel de jeu par pixel d'écran : dans un grand mode (l'astuce
« widescreen » de `Sims.exe`), le quartier et le terrain paraissent tout petits et les panneaux
minuscules. Le portage garde à toutes les résolutions l'aspect du 1024 × 768 par défaut : même zoom,
mêmes panneaux, agrandis à la taille de l'écran ; un écran plus large montre davantage de terrain à
gauche et à droite. Le jeu calcule son image à environ 768 pixels de haut (5120 × 1440 → 2731 × 768),
si bien qu'une grande résolution coûte à peu près autant qu'un 1024 × 768.

- **Resolution** : 1024 × 768 par défaut, ou une taille courante de 800 × 600 à 5120 × 2160 (dont
  5120 × 1440 en 32:9) ; 800 × 600 et 1024 × 768 tournent tels quels, comme dans l'original.
  - **Fit the window, following its size** : le jeu suit la taille de la fenêtre pendant la partie
    (les fenêtres se replacent ; le panneau de contrôle est reconstruit en une ou deux secondes,
    l'ancien reste affiché en attendant ; pendant la création d'une famille ou d'un Sim, le
    changement attend la fermeture de l'écran).
  - **Fit the window when the game starts** : la taille de la fenêtre au lancement, gardée ensuite.
- Hors interface centrée, un écran plus large que 1024 prend les mises en page « 800 » des pages du
  panneau Vie (personnes, cadeaux, centres d'intérêt, relations), comme l'original : le jeu ne prévoit
  ses pages larges qu'à exactement 1024 de large.
- **Keep the interface centred on very wide screens** (option du portage, absente de l'original,
  désactivée par défaut) : le panneau de contrôle, la commande de vue (le disque en bas à gauche) et
  l'incrustation sont placés dans une bande centrée de 1024 de large, exactement l'interface du
  1024 × 768 (avec ses pages Vie larges) ; le terrain occupe tout l'écran, y compris à côté du panneau.
- Les choix autres que « following its size » s'appliquent au prochain lancement (recharger l'onglet
  du jeu). Dans l'URL : `?res=1920x1080`, `?res=auto` ou `?res=window`, `?hud=centred` ou `?hud=full`.

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

## 3 bis. Importer son propre jeu dans le navigateur (`GAME_FILES=client`)

Une instance peut être lancée sans aucun fichier du jeu sur le serveur (variable `GAME_FILES=client`,
ou `THESIMSWEB_GAME_FILES=client` avec Docker, voir [`docker.md`](./docker.md)). C'est le mode pour
ouvrir une instance à d'autres personnes : le serveur n'héberge que le code du portage et ne
distribue **jamais** les fichiers du jeu, protégés par le droit d'auteur de Maxis / Electronic Arts.
Chaque joueur utilise **sa propre copie** du jeu :

1. Ouvrir la page d'accueil, section **Game files**, puis **Select the game folder…**.
2. Choisir le dossier d'installation de The Sims (Complete Collection) sur son ordinateur : celui
   qui contient `GameData`, `ExpansionShared`, `ExpansionPack` … `ExpansionPack7`, `UserData`… (un
   dossier au-dessus convient aussi). Firefox et Chrome demandent de confirmer l'accès au dossier.
3. La page vérifie que le dossier est complet (sinon elle dit quels fichiers manquent), puis copie
   dans le navigateur les fichiers que le jeu lit (environ **3,2 Go**, quelques minutes ; ni les
   programmes `.exe` / `.dll`, ni les journaux, ni le dossier `support`). Rien n'est envoyé au
   serveur. Une barre de progression suit la copie.
4. **Play** devient actif. Le dossier d'origine n'est jamais modifié et n'est plus nécessaire
   ensuite.

Bon à savoir :

- **Un import par navigateur** : un autre navigateur, un autre appareil ou une autre adresse du
  site demandent un nouvel import. Prévoir ~3,2 Go de place libre sur le disque du navigateur ;
  accepter le stockage persistant si le navigateur le demande.
- **Interrompu** (onglet fermé, bouton **Stop**, manque de place) : resélectionner le même dossier
  reprend la copie là où elle s'était arrêtée. Sous Chrome / Edge, le bouton **Resume** reprend sans
  resélectionner le dossier.
- **Import again…** met à jour l'import (après un patch du jeu, par exemple) : seuls les fichiers
  changés sont recopiés.
- **Remove the game files** libère la place ; les sauvegardes, elles, restent.
- Les sauvegardes restent dans le navigateur (comme le mode `SAVES=client`, § 3) : exporter
  régulièrement (§ 4).
- Une fois l'import fait, le jeu n'a plus besoin du serveur pour ses fichiers : il fonctionne hors
  ligne (§ 6), musiques comprises.

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
- **Pages web des familles en mode `client`** (bouton Internet du quartier, option « exporter en
  HTML ») : le jeu les écrit dans le navigateur, et seul le service worker les sert
  (`/webpages/…`). Il faut donc un build ouvert en HTTPS ou sur localhost ; sans service worker
  (adresse `http://` du réseau local, `pnpm dev`), le lien ouvre les pages d'origine du dossier du
  jeu (ou une erreur 404), pas celles du joueur. En mode `server`, le serveur les sert toujours.
- Après une mise à jour du jeu sur le serveur, le nouveau code est chargé au lancement suivant
  (en ligne) ; l'ancien reste utilisé hors ligne tant que la nouvelle version n'a pas été chargée.

## 7. Limites connues

- Il faut sa propre copie du jeu, installée sur le serveur, ou importée dans chaque navigateur
  (§ 3 bis, ~3,2 Go par navigateur).
- Aucune authentification côté serveur (voir [`docker.md`](./docker.md), « Sécurité »).
- Les données du navigateur (cache des fichiers du jeu, plusieurs centaines de Mo, et sauvegardes
  en mode `client`) peuvent être effacées par le navigateur si le disque manque de place, tant que
  le stockage n'est pas persistant.
- Un seul onglet du jeu à la fois.
- La version tactile / mobile est en cours.
- Le reste (fonctions du jeu manquantes, bugs connus) : [`TODO.md`](./TODO.md).

## 8. Dépannage

- **Le jeu ne démarre pas, ou il manque des objets, des sons, des quartiers** : `pnpm check-game`
  (ou la section « Fichiers du jeu » de la page d'accueil) dit quels fichiers manquent.

- **Le jeu ne démarre plus après une mise à jour** : recharger la page (Ctrl+F5) ; au besoin,
  outils de développement → Application → Service workers → « Unregister », puis recharger.
- **Repartir de zéro** (perd les sauvegardes en mode `client` : exporter d'abord) : effacer les
  données du site dans les réglages du navigateur.
