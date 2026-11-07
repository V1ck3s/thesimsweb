# Reste à faire

Liste unique de ce qui reste ouvert, vérifiée contre le code le 2026-11-05. Les notes « not
ported » des documents de portage (`docs/decomp/*-port.md`) et les tableaux « Remaining » de
`docs/decomp/playtest.md` sont l'historique ; cette liste est la référence. Quand un point est
fait, le retirer d'ici et noter le correctif dans `playtest.md` / le journal de `PLAN.md`.

Entre parenthèses : la classe ou fonction d'origine, puis le fichier du port concerné (chemins
sous `client/src/game/`).

## 1. Bugs observés

- **Animaux bloqués en « Action - Chase Tail »** plus de 8 heures de jeu : non reproduit (une
  action dure 30 à 60 min ; l'animal la choisit sans doute de nouveau, pub fun 20).
- **Erreur 62 dans « do new adult idle »** : Breakpoint des données (nœud 29 de l'arbre 8330),
  aussi dans l'original ; qui pousse « Wait » sur une personne qui porte quelque chose : non trouvé.
- **« user00177 »** : corrigé (ordre d'écriture du fichier personnage de l'original : nom avant la
  sauvegarde du quartier, à l'import comme dans Créer un Sim). Les fichiers orphelins
  `UserData/Characters/User00177.iff` et `User00178.iff` de l'utilisateur (Créer un Sim interrompu
  par un rechargement) sont laissés tels quels.

## 2. Fonctionnalités manquantes (visibles en jeu)

Live
- **Popups des besoins des animaux** : portés, non vérifiés. Page célébrité : niveaux 0 et
  0x11..0x13 non vérifiés.
- **PIP** : composition BoboVision exacte (table AlphaBlend_565_P5, ~0,7 ms par image) ; coût de la
  relecture non mesuré dans Firefox sur un vrai GPU.
- **Annuler une suppression de mur** : porté (la porte est ramassée puis replacée, sans Init, comme
  l'original) ; à vérifier en jeu.
- **Pizza** : appel, arrivée, accueil et dialogue vus ; paiement et remise de la boîte non observés.

Quartier / sauvegarde
- **Pages web** : album avec photos non testé ; en SAVES=client les pages ne sont servies que par
  le service worker (documenté dans le guide). `ObjectFolder` suit l'ordre de l'original
  (`data/dirimage.ts`) ; restent par nom : plugins sols / murs, textures des skins, MatchFolderScanner.
- **Langue** : 14 langues proposées (dont polonais, CJK et thaï) ; IME et capacité en octets
  portés. Non proposés : russe et hébreu (l'installation n'a que des copies des textes anglais).
  800x600 : le port tourne toujours en 1024x768 (l'original choisit le plus grand mode) ;
  SetMiniUI non porté. Texte « Paused » de cDDDSimsView porté : à confirmer face au jeu.
- **Ville magique** : décodeurs alpha de la version Windows portés (seuils 8 / 0xf7, profondeur
  écrite) et vignettes sans alpha ; non comparé au jeu. Risque : la vitre d'une fenêtre écrit la
  profondeur et peut cacher un Sim derrière (contraire à la note U44 de playtest.md) : à vérifier.
  `objecticon.ts`, `buildcatalog.ts` et l'export web gardent l'ancienne règle.
- **Créer un Sim** : House00 chargé derrière le quartier, case de départ de l'original, voisin
  visible du simulateur, drapeau de suppression ; le simulateur de House00 ne tourne que pendant
  le dialogue (rien à simuler sinon).
- **Import Unleashed** : porté et testé (copie des fichiers manquants, import une seule fois).
  Il importe 6 familles dans les quartiers livrés en version 0x3f (dont UserData3) à leur
  prochaine ouverture, comme l'original.

Construction
- **Porte tenue et découpe des murs** : le code suit l'original (aucun écart trouvé) ; à comparer
  avec le jeu. Découpe des murs en diagonale corrigée (Wall::ComputeCutaway), à voir sur House02.

Interface / triches
- **Triches** : toutes portées et testées sauf celles sans équivalent : ReportMissingTextures
  (boîte jamais montrée par l'original ; EditPerson::ValidateTextures non porté), damagelist et
  sweep (pas de rectangles de dommages ni de profileur ici), draw_routes (aucun code de dessin).

## 3. Son

- Événements kSndob* 4..10 : vérifié, aucun fichier .hot livré ne les utilise (rien à porter).

## 4. Animation

- Correction de mouvement racine du moteur de marche (désactivée dans l'original aussi).

## 5. Performance

- **Chargement d'un lot** : à froid, lot à l'écran en 9,3 s (13,7 avant les lectures en
  parallèle), ~135 POST /api/ranges ; à chaud ~5 s. Restent : lectures dépendantes par nature
  (CMX puis maillages puis textures), scan du catalogue d'achat ~25 s après un chargement à froid,
  portraits rendus sur le thread principal au premier chargement.
- **Mémoire** : `entryCache` borné, TryUnloadSkills / TryUnloadSuits / TryUnloadAll portés (le
  passage des costumes ne libère rien, comme l'original : horloge partagée avec les compétences).
- **Pics de tick** : restent les recherches de route et l'interprétation des BHAV (travail de
  l'original) ; familyFriendCount mis en cache comme l'original.
- **Serveur sur /mnt/c** : inventaire du jeu gardé sur disque (`server/data/manifest-cache.json`) ;
  la première liste des sauvegardes après un démarrage prend encore 50 à 90 s.

## 6. À vérifier (comparaison avec l'original à faire)

- Suivi de caméra, emménagement sans boîte aux lettres, popups des besoins des animaux et page
  célébrité : conformes au code décompilé, non vus en jeu.
- U50 (objet invisible) : le cas exact de l'utilisateur n'a pas été reproduit.
- Version tactile : testée en émulation Chrome seulement (pas d'appareil réel, pas de Firefox Android).

## 7. Action de l'utilisateur

- **U56, porte d'entrée des Charmant** : la sauvegarde `UserData/Houses/House69.iff` date d'avant le
  correctif U50. Reprendre la porte d'entrée et la porte « Wood 2 » du couloir / salle de bain avec
  la main, les reposer au même endroit, puis sauvegarder.

## 8. Finition et distribution

Fait : page d'accueil, export / import des sauvegardes, PWA hors ligne, guide utilisateur
(`docs/user-guide.md`), version tactile, mode `GAME_FILES=client` (chaque joueur importe son dossier).
Cible : usage personnel d'abord (un joueur par serveur), mode public en option.

## 9. Outils de développement (faible priorité)

Voir §2 « Interface / triches ».
