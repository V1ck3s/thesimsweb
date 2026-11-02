# Reste à faire

Liste unique de ce qui reste ouvert, vérifiée contre le code le 2026-11-02. Les notes « not
ported » des documents de portage (`docs/decomp/*-port.md`) et les tableaux « Remaining » de
`docs/decomp/playtest.md` sont l'historique ; cette liste est la référence. Quand un point est
fait, le retirer d'ici et noter le correctif dans `playtest.md` / le journal de `PLAN.md`.

Entre parenthèses : la classe ou fonction d'origine, puis le fichier du port concerné (chemins
sous `client/src/game/`).

## 1. Bugs observés

- **Annuaire et relations sans visage pour les PNJ connus** (livreur, bonne…) : les têtes sont lues
  dans `Characters/` au lieu du propre fichier de la personne (PersonFinder::GetPictureBuffer /
  GetRelPictureBuffer). `ui/phonebook.ts`, `cpanel/live/relationship.ts` → utiliser
  `cas/personpictures.ts` comme les bulles et les icônes d'action.
- **Sim 194 de House01 sans tenue.** Cause non cherchée.
- **Dialogues de rumeurs / d'aide en boucle sur la maison 56 quand le jeu est en pause.** Cause non
  cherchée.
- **Images du catalogue délavées et sans ombre** (ObjSelector::GetThumbnailHasShadow).
  `cpanel/buy/objecticon.ts`.
- **$TokenNameLocal affiche le jeton brut** si le sélecteur de l'objet n'a pas encore été ouvert
  dans la session (ObjectFolder.selectorByGUID synchrone). `sim/xobject.ts`.
- **Fenêtre PIP : un changement d'étage ne recalcule pas la découpe des murs.**
  `world/winpictureinpicture.ts`.
- **Lampe allumée / éteinte par le jeu : la lumière de la pièce ne change qu'au prochain changement
  d'heure ou d'édition** (RoomManager::RoomLightingChanged). `world/lighting.ts`.
- **Erreurs d'arbre rares, cause non trouvée, non reproduites** : erreur 62 dans « do new adult
  idle » (arbre 8330) en ville ; 0x15 de la bonne dans « get paper to read » du journal ; 0x15 du
  majordome / de la bonne au compacteur (deux nettoyeurs sur la même assiette ?) ; Kyle resté un
  jour en « Vibrer » après le départ de Jada.

## 2. Fonctionnalités manquantes (visibles en jeu)

Live
- **Panneau des personnes** : pas de menu camembert sur les portraits, pas de suivi de caméra d'un
  sim (cWinPeople, kTrackingTarget, Animator::SetTrackedObject, StopTracking), pas de popup
  portrait de famille, pas d'incrustation « au travail ». `cpanel/people.ts`.
- **Popups au survol sans icône d'objet** (cWinLivePopup::SetObject / DrawObjectIcon) ; **page
  célébrité** : les aptitudes ne sont pas des objets de catalogue. `cpanel/livepopup.ts`,
  `cpanel/live/fame.ts`.
- **Pas de surbrillance (contour) de l'objet survolé / sélectionné** (cXObject::SetHilite) : l'id
  est suivi, seul le dessin manque. `world/winlotview.ts`.
- **Arrivée de la famille en voiture à l'emménagement** : les sims apparaissent sur place.
  `world/winlotview.ts`.
- **Score d'agencement de la maison figé** (House::AddLayoutTick, décalage de minuit) ; besoin
  « pièce / éclairage » non porté (score de ComputeRoom, lumières de plafond Room +0x73).
  `world/winlotview.ts`, `sim/person.ts`, `world/lighting.ts`.
- **Familles de touristes** jamais créées (DoFirstTimeTouristFamilies, RefillTouristFamilies,
  AddNewTourist) ; habitants préfabriqués sans leur personnalité de modèle. `nbhd/townies.ts`,
  `nbhd/winneighborhoodul.ts`.
- **Autonomie : filtres Hot Date centre-ville / vacances** de TryFindBestAction (lots 40..49 ou
  zonage 2). `sim/person.ts`.
- **Grimoire / livre de cuisine** : filtres d'extension et « déjà préparé » non appliqués
  (cPickSpellList::Init, drapeaux +0x66). `ui/magicbook.ts`.
- **PIP** : pas de photo automatique dans l'album, pas de BoboVision. `world/winpictureinpicture.ts`.
- **Tutoriel** : icône / animation de fermeture des dialogues (cTutorialIcon), Tut_CheckForEvents,
  appel générique 4. `ui/picturedialog.ts`, `ui/tutorialhighlight.ts`, `sim/xobject.ts`.
- **Mode panoramique Alt** de la vue (EdgeDetectScroller, Pan.cur). `world/edgescroll.ts`.
- **Repli du panneau Live** : pas de variante BoboVision (cWinViewControl::SetMode).
- **« Aller ici »** : test de l'herbe pour le type de lot 99 (cObjPickerTool::TryClick).

Achat / Construction
- **Outil de déplacement** : Échap remet l'objet à la main au lieu d'annuler (ObjectUndoable) ;
  pas de Ctrl+Suppr ni de retournement pour portes et fenêtres (FlipPortal, modes 3..9) ; pas de
  `/` `?` pour changer d'emplacement dans un conteneur (cMoveTool::OnChar) ; les conteneurs
  multi-cases ne choisissent pas le côté libre (AttemptFloaterPlacement) ; pas de test « il faut
  un sol » (0x1f) aux étages. `world/tools/movetool.ts`, `world/tools/cursorobject.ts`.
- **Découpe des murs** : ne s'adapte ni à l'outil porte / fenêtre (cTool::AdjustCutawayForTool) ni
  à l'objet tenu (DoDynamicCutaway). `world/cutaway.ts`.
- **Papiers peints en plugin sans image de catalogue** ; murs et papiers peints sans image sur la
  fiche produit (DrawWallIcon, WallManager::DrawIconic). `data/buildcatalog.ts`.
- **Placement** : Simulator +0x36 pris à 0, message 0xf3 « pièce changée » non envoyé.
  `world/tools/placement.ts`.

Quartier / sauvegarde
- **Vignettes du quartier sans les sims.** `world/thumbnail.ts`.
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

Interface
- **Champs de texte** : pas de sélection, presse-papiers, annulation ni barre de défilement
  (cTSWinTextEdit2). `ui/textedit.ts`.
- **Options** : pas de fondu entre les sous-panneaux, astuces de la maison du didacticiel non
  désactivées, sons d'interface. `cpanel/options.ts`.
- **Liste des familles** : position de l'infobulle (cPickFamilyList::GetTTPosition), présélection
  +0x130. `cas/winpickfamily.ts`.
- **Générique** : cadence de l'AnimDevice et remplissage au changement de page. `nbhd/wincredits.ts`.

## 3. Son

- Pas de « whoosh » à l'ouverture du popup du catalogue (`cpanel/buy/catalogpopup.ts`), pas de son
  de refus sur un produit trop cher (cTool::DoDeniedSound, `cpanel/catalog.ts`), pas de sons dans
  les sélecteurs tenue / transformation / animal (`world/objectdialogshow.ts`), pas de sons
  d'interface dans le panneau de construction (`cpanel/arch.ts`).
- Pas de limite de voix par liste de sons (CheckPriority), dérive de cHitTimer, kSndobUpdate /
  SetPosition. `audio/`.

## 4. Animation

- Moteur de marche : phases des pieds, distances d'arrêt, StdAnimOffset des animations d'ajustement,
  table de marche personnalisée de l'OBJD.
- SAnimator::UpdateOutfitAndHands, branche OBJD drapeau 8 ; Reset → ResetSuits.
- Plumb bobs éclairés par la pièce (LightingRig) ; ObjectModule::DayChanged / historique de la
  famille (`sim/simulator.ts`).

## 5. Performance

- **Chargement** : les icônes du catalogue et une partie des lectures des fichiers d'objets ne
  passent pas par le cache IndexedDB (`data/catalog.ts` readAssetRange, `RangedIff`).
- **Mémoire** : +11 à 17 Mo par jour de jeu, ce sont des caches remplis au premier usage (comportements,
  tables d'arbres, chunks IFF) ; redescend au rechargement.
- **Pics de tick** de 20 à 50 ms sur les échecs de route.

## 6. À vérifier (comparaison avec l'original à faire)

- Lot vide avec seulement un frigo : la famille meurt de faim (pas de plan de travail). Fidèle ?
- Repas à 10 $ répétés au frigo cher du centre-ville. Fidèle ?
- Le journal ne propose que « Recycler » l'après-midi. Probablement fidèle.
- Vraie livraison de pizza (bulles du livreur) jamais observée.
- Toit : régénéré quand on ne déplace que l'escalier ? Caché quand la caméra suit un sim ? Bouton
  de murs resynchronisé au chargement ? Décalage THMB des vignettes, eau dans les vignettes.
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
- Touches q (quitter), s (ombres), t (images/s), v (version) de la vue. `cpanel/modekeys.ts`.
- Rapport de textures manquantes (ReportMissingTextures), cWinTileInfo, cWinMemView.
- Touches 1..9 de l'outil terrain (changement de rendu).
- `world/worldedit.ts` duplique des fonctions de `wallworld.ts` (nettoyage).
