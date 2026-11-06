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
- **Famille du tutoriel** : « user00177 » non reproduit (deux imports donnent « Jojo » et
  « Paulette ») ; seule source possible : `loadCharacter` sans CTSS (sauvegarde interrompue ?).

## 2. Fonctionnalités manquantes (visibles en jeu)

Live
- **Popups des besoins des animaux** : portés, non vérifiés. Page célébrité : niveaux 0 et
  0x11..0x13 non vérifiés.
- **PIP** : composition BoboVision portée avec le poids moyen de chaque niveau de la table
  AlphaBlend_565_P5 (pas la table par pixel, trop coûteuse à lire chaque image).
- **Annuler une suppression de mur** : porté (la porte est ramassée puis replacée, sans Init, comme
  l'original) ; à vérifier en jeu.
- **Pizza** : appel, arrivée, accueil et dialogue vus ; paiement et remise de la boîte non observés.

Quartier / sauvegarde
- **Pages web** : ordre de `[objects]` du .pub porté (ordre de l'image de répertoire, 193
  seaux) mais non vérifié en jeu ; album avec photos non testé ; en SAVES=client les pages ne sont
  servies que par le service worker (documenté dans le guide). `ObjectFolder` parcourt encore par
  nom, pas dans l'ordre de hachage de l'original.
- **Langue** : anglais, allemand et japonais vérifiés dans un lot ; polonais, CJK et thaï dessinés
  avec les polices du jeu. Restent : thaï en aperçu seulement (`?lang=19` ; branches propres au thaï
  des panneaux non portées), russe et hébreu (un tiers des textes, police russe ASCII, pas de
  droite à gauche), un caractère manquant en chinois traditionnel (popup faim), IME absent et
  capacité des champs comptée en caractères (l'original compte les octets), texte centré de
  cDDDSimsView::Init / SetMiniUI, mise en page 800x600 non vérifiée en double octet.
- **Ville magique** : décodeurs alpha de la version Windows portés (seuils 8 / 0xf7, profondeur
  écrite) et vignettes sans alpha ; non comparé au jeu. Risque : la vitre d'une fenêtre écrit la
  profondeur et peut cacher un Sim derrière (contraire à la note U44 de playtest.md) : à vérifier.
  `objecticon.ts`, `buildcatalog.ts` et l'export web gardent l'ancienne règle.
- **Créer un Sim** : la personne tourne sur House00 avec le simulateur (porté). Écarts : House00
  chargé au premier Créer un Sim au lieu de rester derrière le quartier, case libre cherchée depuis
  le centre du lot, personne pas encore sauvegardée avant « Terminé ».
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

- **Chargement d'un lot** : à froid 3,3 s de thread principal (était 7,1), 610 requêtes (918) ;
  à chaud 4,9 à 6,1 s (8,0). Restent : lectures IndexedDB décodées sur le thread principal,
  ~290 POST /api/ranges à froid, portraits rendus au premier chargement de chaque personne.
- **Mémoire** : `entryCache` borné (16 Mo), compétences d'animation déchargées après 160 s
  (TryUnloadSkills) ; TryUnloadSuits / TryUnloadAll non portés.
- **Pics de tick** : restent les recherches de route et l'interprétation des BHAV (travail de
  l'original) ; familyFriendCount mis en cache comme l'original.
- **Serveur sur /mnt/c** : le premier inventaire du manifest prend ~4 min quand le disque est
  chargé (plusieurs vite en polling) ; `?refresh` ne relit plus que les sauvegardes.

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
