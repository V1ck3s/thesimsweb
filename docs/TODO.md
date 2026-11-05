# Reste à faire

Liste unique de ce qui reste ouvert, vérifiée contre le code le 2026-11-05. Les notes « not
ported » des documents de portage (`docs/decomp/*-port.md`) et les tableaux « Remaining » de
`docs/decomp/playtest.md` sont l'historique ; cette liste est la référence. Quand un point est
fait, le retirer d'ici et noter le correctif dans `playtest.md` / le journal de `PLAN.md`.

Entre parenthèses : la classe ou fonction d'origine, puis le fichier du port concerné (chemins
sous `client/src/game/`).

## 1. Bugs observés

- **Animaux bloqués en « Action - Chase Tail »** plus de 8 heures de jeu : non reproduit (l'arbre
  finit toujours après 4 à 10 boucles ; seule une animation qui ne finit jamais l'expliquerait).
- **Erreur 62 dans « do new adult idle »** : Breakpoint des données, aussi dans l'original ; vu en
  ville quand une personne commence à attendre en portant quelque chose (port interrompu ?).
- **Famille du tutoriel** : le nom vient maintenant de FAMs ; les membres « user00177 » n'ont pas
  été reproduits.

## 2. Fonctionnalités manquantes (visibles en jeu)

Live
- **Popups des besoins des animaux** : portés, non vérifiés. Page célébrité : niveaux 0 et
  0x11..0x13 non vérifiés.
- **PIP** : composition BoboVision du gadget par son masque alpha et message 0x1b de fin de fondu
  (cTSWin::Plot / BlitPrivateBufferToParent, `ui/tswin.ts`).
- **Annuler une suppression de mur** : l'objet revient, mais le port remet le même objet et le
  relance à Main sans Init ; l'original recrée un objet neuf (Init). `world/tools/wallundo.ts`.

Quartier / sauvegarde
- **Pages web** : l'ordre de `[objects]` du .pub suit notre index. Lien vers les pages en mode
  SAVES=client sans service worker (serveur de dev) : non servies. Album photo avec photos
  (MakeCurThumb porté) non testé.
- **Langue** (réglage de la page d'accueil, `engine/language.ts`) : à finir de vérifier. Le
  quartier se charge en `?lang=1` ; à contrôler : textes de l'interface, catalogue, bulles,
  formats d'argent / d'heure, décalages de police (fame / job / house / options ne connaissent que
  le français), noms des quartiers et lots (STR# 2000 par langue), modèles web anglais en repli.
  Les outils (dirttool, floortool, movetool, wallpapertool, pooltool, walltool) formatent les
  prix avec `toLocaleString("en-US")` au lieu de makeMoneyString.
- **Vignettes** : le vert du terrain est un cran 5 bits trop bas sur ~28 % des pixels (génération
  des couleurs du terrain) ; la grande vignette de House01 fait 158x86 au lieu de 159x85.
- **Ville magique** : feuillage des bouleaux translucide (vue et vignettes), opaque dans le jeu ;
  piste : décodeurs Spr2 sans alpha quand l'option « AA » est coupée (InitSpr2Decoder).
- **Créer un Sim** : l'arbre « design-a-person » est approché par l'attente de l'aperçu.
- **Import Unleashed** (NeedsUnleashedImport / TryImportUnleashedFamilies) au premier tick du quartier.

Construction
- **Porte tenue et découpe des murs** : piste dans Wall::Draw (chemin outil de construction).
- **HOUS 0** : la sauvegarde recopie l'octet de découpe dynamique (+0x49) du fichier chargé au lieu
  de l'état courant. `world/housesave.ts`.
- **Option « ombres »** : la touche s la bascule, mais le rendu ne l'a jamais appliquée.

Interface / triches
- **Triches non portées** : map_edit, sim_log, triches graphiques autres que grid (genable,
  damagelist, sweep, draw_routes, draw_floorable), move_lots / mode 5, ReportMissingTextures.
- **Champs de texte** : polices double octet.

## 3. Son

- Événements kSndob* sur un cSamplePatch (objet son non modélisé ; inatteignables dans le jeu livré).

## 4. Animation

- Correction de mouvement racine du moteur de marche (désactivée dans l'original aussi).

## 5. Performance

- **Chargement à froid d'un lot** : 15 à 19 s jusqu'à la vue du lot (Chrome), puis le mode Live
  charge animations et sons à la demande (1 à 2 min de réseau actif, ce n'est pas une attente).
  Voir `docs/perf-and-browsers.md`.
- **Mémoire** : la fuite des objets supprimés est corrigée ; reste la croissance des caches
  (animations, `entryCache` d'`engine/assets.ts` qui garde les entrées FAR brutes déjà analysées).
- **Pics de tick** : FindPath au pire 8,6 ms (était 35 à 39) ; reste un tick de 24 ms quand
  trois routes tombent dans le même tick.

## 6. À vérifier (comparaison avec l'original à faire)

- Journal : seulement « Recycler » l'après-midi (état fixé par l'init selon le global 15, non
  identifié).
- Livraison de pizza : le livreur arrive, mais personne n'a payé dans le test ; bulles et boîte non vues.
- Suivi de caméra : arrêt par les boutons d'étage, changement d'étage du sim suivi, toit masqué.
- Emménagement sur un lot déjà construit ou sans boîte aux lettres.
- Pause / reprise des canaux non MP3 : reprise au même endroit ?
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
