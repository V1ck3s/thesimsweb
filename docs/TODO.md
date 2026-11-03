# Reste à faire

Liste unique de ce qui reste ouvert, vérifiée contre le code le 2026-11-02. Les notes « not
ported » des documents de portage (`docs/decomp/*-port.md`) et les tableaux « Remaining » de
`docs/decomp/playtest.md` sont l'historique ; cette liste est la référence. Quand un point est
fait, le retirer d'ici et noter le correctif dans `playtest.md` / le journal de `PLAN.md`.

Entre parenthèses : la classe ou fonction d'origine, puis le fichier du port concerné (chemins
sous `client/src/game/`).

## 1. Bugs observés

- **Sim 194 de House01 (Max) sans tenue.** Non reproduit (habillé au chargement et sur 14 h de jeu).
  Piste : la tenue « mode » (0x23) des enfants est le nom provisoire `ADDED` (EditPerson::BeginFill) ;
  une sauvegarde faite en tenue 0x12 le laisserait sans corps. Il faut le moment exact.
- **$TokenNameLocal affiche le jeton brut** si le sélecteur de l'objet n'a pas encore été ouvert
  dans la session (ObjectFolder.selectorByGUID synchrone). `sim/xobject.ts`.
- **Erreurs d'arbre rares, cause non trouvée, non reproduites** : erreur 62 dans « do new adult
  idle » (arbre 8330) en ville ; 0x15 de la bonne dans « get paper to read » du journal ; 0x15 du
  majordome / de la bonne au compacteur (deux nettoyeurs sur la même assiette ?) ; Kyle resté un
  jour en « Vibrer » après le départ de Jada.

## 2. Fonctionnalités manquantes (visibles en jeu)

Live
- **Popups au survol sans icône d'objet** (cWinLivePopup::SetObject / DrawObjectIcon) ; **page
  célébrité** : les aptitudes ne sont pas des objets de catalogue. `cpanel/livepopup.ts`,
  `cpanel/live/fame.ts`.
- **Score d'agencement de la maison figé** (House::AddLayoutTick, décalage de minuit) ; besoin
  « pièce / éclairage » non porté (score de ComputeRoom, lumières de plafond Room +0x73).
  `world/winlotview.ts`, `sim/person.ts`, `world/lighting.ts`.
- **Tri des familles** après création des habitants / touristes (comparateur lbl_105BB988).
  `nbhd/townies.ts`.
- **Autonomie : filtres Hot Date centre-ville / vacances** de TryFindBestAction (lots 40..49 ou
  zonage 2). `sim/person.ts`.
- **Grimoire / livre de cuisine** : filtres d'extension et « déjà préparé » non appliqués
  (cPickSpellList::Init, drapeaux +0x66). `ui/magicbook.ts`.
- **PIP** : pas de photo automatique dans l'album, pas de BoboVision. `world/winpictureinpicture.ts`.
- **Tutoriel** : icône / animation de fermeture des dialogues (cTutorialIcon), Tut_CheckForEvents,
  appel générique 4. `ui/picturedialog.ts`, `ui/tutorialhighlight.ts`, `sim/xobject.ts`.
- **Repli du panneau Live** : pas de variante BoboVision (cWinViewControl::SetMode).
- **« Aller ici »** : test de l'herbe pour le type de lot 99 (cObjPickerTool::TryClick).

Achat / Construction
- **Papiers peints en plugin sans image de catalogue** ; murs et papiers peints sans image sur la
  fiche produit (DrawWallIcon, WallManager::DrawIconic). `data/buildcatalog.ts`.

Quartier / sauvegarde
- **Vignettes** : la petite vignette faite au déménagement peut différer d'un pixel. `world/thumbnail.ts`.
- **Quitter un lot communautaire** n'exécute pas SaveAllPersistentDataForMatterTransferance.
  `world/savegame.ts`.
- **Déménagement / SaveHouse** : ClearRouteHistory, remise à zéro du budget de la famille 0,
  nettoyage DeleteCharacter, objet 0xc3249a1d, diffusion « import lot ». `world/moveout.ts`.
- **Lot vide** : budget non sauvé, export impossible (ExportUnoccupiedLot).
- **Famille créée dans Créer une famille non exportée en .FAM** (FinishFamily). `cas/windesignfamily.ts`.
- **Pages web de la famille** (ExportFamilyHTML, DoInternetUpdate) et drapeau « occupé » de la mise
  à jour internet. `nbhd/winneighborhoodul.ts`.
- **Import** : contrôle du jeu de caractères (STR# 154 20 / 21). `nbhd/winneighborhoodul.ts`,
  `nbhd/wintown.ts`.
- **Créer un Sim** : costumes d'animaux / de clown et recréation de l'instance au changement d'âge
  (ResetInstanceSuits, SetAge). `cas/editperson.ts`.

- **Outil de déplacement** : la main du mode Achat ne pose pas le bit de surbrillance (+0x114 bit 1)
  sur l'objet survolé (le dessin est porté, `world/tools/movetool.ts`).
- **Papier peint** : cNewWallpaperTool::ModifyCursorPos (crochet de découpe des murs).

Interface
- **Champs de texte** : pas de sélection, presse-papiers, annulation ni barre de défilement
  (cTSWinTextEdit2). `ui/textedit.ts`.
- **Options** : pas de fondu entre les sous-panneaux, astuces de la maison du didacticiel non
  désactivées, sons d'interface. `cpanel/options.ts`.
- **Liste des familles** : position de l'infobulle (cPickFamilyList::GetTTPosition), présélection
  +0x130. `cas/winpickfamily.ts`.
- **Générique** : cadence de l'AnimDevice et remplissage au changement de page. `nbhd/wincredits.ts`.

## 3. Son

- Dérive de cHitTimer, kSndobUpdate / SetPosition. `audio/`.

## 4. Animation

- Moteur de marche : phases des pieds, distances d'arrêt, StdAnimOffset des animations d'ajustement,
  table de marche personnalisée de l'OBJD.
- SAnimator::UpdateOutfitAndHands, branche OBJD drapeau 8 ; Reset → ResetSuits.
- Plumb bobs éclairés par la pièce (LightingRig) ; ObjectModule::DayChanged / historique de la
  famille (`sim/simulator.ts`).

## 5. Performance

- **Fichiers de sauvegarde lus plusieurs fois par chargement** (`Neighborhood.iff` 5 fois, certains
  personnages 2 à 4 fois) : non mis en cache exprès ; il faudrait un cache par chargement.
- **Chargement à froid d'un lot sous Chrome** : environ 2 minutes d'attente sur les dernières requêtes.
- **Mémoire** : +11 à 17 Mo par jour de jeu, ce sont des caches remplis au premier usage (comportements,
  tables d'arbres, chunks IFF) ; redescend au rechargement.
- **Pics de tick** de 20 à 50 ms sur les échecs de route.

## 6. À vérifier (comparaison avec l'original à faire)

- Survol à la souris d'un objet en Live : la surbrillance n'a pas pu être testée (sur la copie des
  UserData du jeu, `selectedPerson()` rendait null : GUID de personne provisoire ?).
- Le lot ne paraît pas plus sombre à 22 h qu'en journée.
- Images du catalogue : la chaise de salon bon marché (ombre 0x10) a maintenant une ombre carrée
  que l'image livrée n'a pas ; le bouleau (ombre 0 sur le maître, -1 sur les parties) n'en a pas.
- Découpe des murs avec une porte tenue : le masque change, mais aucune différence visible aux
  endroits testés.
- Lot vide avec seulement un frigo : la famille meurt de faim (pas de plan de travail). Fidèle ?
- Repas à 10 $ répétés au frigo cher du centre-ville. Fidèle ?
- Le journal ne propose que « Recycler » l'après-midi. Probablement fidèle.
- Vraie livraison de pizza (bulles du livreur) jamais observée.
- Toit : régénéré quand on ne déplace que l'escalier ? Bouton de murs resynchronisé au chargement ?
  House90 : la terrasse de l'étage reste sans toit (le jeu la couvre).
- Ville magique : arbres pâles et citrouilles sombres (vue du lot et vignettes).
- Suivi de caméra : arrêt par les boutons d'étage, changement d'étage du sim suivi, toit masqué
  (portés, non testés en jeu). Emménagement sur un lot déjà construit ou sans boîte aux lettres.
- Pause / reprise des canaux non MP3 : reprise au même endroit ?
- Le menu camembert se ferme-t-il si son objet est supprimé ?
- Annuler une suppression de mur : l'objet revient-il côté simulation ?
- Erreurs 0x44e au chargement de House05 / House07 (anciennes, non revérifiées).
- U50 (objet invisible) : le cas exact de l'utilisateur n'a pas été reproduit.
- Valeurs non portées encore journalisées (`scope 23 room[temp0]`…) : relancer un soak et lister.

## 7. Action de l'utilisateur

- **U56, porte d'entrée des Charmant** : la sauvegarde `UserData/Houses/House69.iff` date d'avant le
  correctif U50. Reprendre la porte d'entrée et la porte « Wood 2 » du couloir / salle de bain avec
  la main, les reposer au même endroit, puis sauvegarder.

## 8. Finition et distribution (PLAN.md, phase 9)

- Jeu installable et jouable hors ligne (PWA).
- Version tactile / mobile.
- Page d'accueil et assistant d'import du dossier du jeu (utilisateur final).
- Documentation utilisateur.
- Décider : version publique hébergée ou usage personnel.

## 9. Outils de développement (faible priorité)

- Codes de triche non portés : map_edit, prepare_lot, sim_log, tile_info, history, w, triches
  graphiques, draw_routes / draw_floorable, move_lots, nessie, stream_fps, reload_neighborhood ;
  mode déplacement (5) et touches du quartier. `ui/cheat.ts`, `nbhd/winneighborhoodul.ts`.
- Touches s (ombres, liée aux triches graphiques) et t (fenêtre images/s) de la vue ; F8 (caméra
  « stalker », développeur). q (quitter) n'a pas d'équivalent web. `cpanel/modekeys.ts`.
- Rapport de textures manquantes (ReportMissingTextures), cWinTileInfo, cWinMemView.
- Touches 1..9 de l'outil terrain (changement de rendu).
- `world/worldedit.ts` duplique des fonctions de `wallworld.ts` (nettoyage).
