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
- **PIP** : message 0x1b porté ; reste la composition BoboVision du gadget (AlphaBlend_565_P5,
  32 niveaux) et le blit à clé de couleur sans BoboVision, dans `cpanel/viewcontrol.ts`.
- **Annuler une suppression de mur** : porté (la porte est ramassée puis replacée, sans Init, comme
  l'original) ; à vérifier en jeu.
- **Pizza** : appel, arrivée, accueil et dialogue vus ; paiement et remise de la boîte non observés.

Quartier / sauvegarde
- **Pages web** : ordre de `[objects]` du .pub porté (ordre de l'image de répertoire, 193
  seaux) mais non vérifié en jeu ; album avec photos non testé ; en SAVES=client les pages ne sont
  servies que par le service worker (documenté dans le guide). `ObjectFolder` parcourt encore par
  nom, pas dans l'ordre de hachage de l'original.
- **Langue** : anglais et allemand vérifiés dans un lot (textes, heure, argent). Non portés : film
  d'intro par langue, texte centré de cDDDSimsView::Init, BMP_ par langue.
- **Vignettes** : la grande vignette de House01 fait 158x86 au lieu de 159x85.
- **Ville magique** : décodeurs alpha de la version Windows portés (seuils 8 / 0xf7, profondeur
  écrite) et vignettes sans alpha ; non comparé au jeu. Risque : la vitre d'une fenêtre écrit la
  profondeur et peut cacher un Sim derrière (contraire à la note U44 de playtest.md) : à vérifier.
  `objecticon.ts`, `buildcatalog.ts` et l'export web gardent l'ancienne règle.
- **Créer un Sim** : l'arbre « design-a-person » demande un lot simulé derrière l'écran (gros
  chantier, détails dans `docs/decomp/cas-port.md`).
- **Import Unleashed** : porté (premier tick du quartier) mais non testé en jeu.
  CopyMissingUnleashedFilesIntoUserData (Neighborhood::Load) non porté. Attention : il importe
  6 familles dans les quartiers livrés en version 0x3f (dont UserData3) à leur prochaine ouverture.

Construction
- **Porte tenue et découpe des murs** : le code suit l'original (aucun écart trouvé) ; à comparer
  avec le jeu. Découpe des murs en diagonale corrigée (Wall::ComputeCutaway), à voir sur House02.

Interface / triches
- **Triches** : map_edit, sim_log, genable, draw_floorable portés (non testés en jeu) ; restent
  move_lots / mode 5, ReportMissingTextures, damagelist, sweep, draw_routes (drapeau seul), mode
  herbe de map_edit.
- **Champs de texte** : polices double octet.

## 3. Son

- Événements kSndob* sur un cSamplePatch (objet son non modélisé ; inatteignables dans le jeu livré).

## 4. Animation

- Correction de mouvement racine du moteur de marche (désactivée dans l'original aussi).

## 5. Performance

- **Chargement à froid d'un lot** : 15 à 19 s jusqu'à la vue du lot (Chrome), puis le mode Live
  charge animations et sons à la demande (1 à 2 min de réseau actif, ce n'est pas une attente).
  Voir `docs/perf-and-browsers.md`.
- **Mémoire** : `entryCache` borné (16 Mo), compétences d'animation déchargées après 160 s
  (TryUnloadSkills) ; TryUnloadSuits / TryUnloadAll non portés.
- **Pics de tick** : les recherches de route ne les expliquent pas ; coût régulier :
  `familyFriendCount` appelé à chaque image (`simulator.ts`).
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
