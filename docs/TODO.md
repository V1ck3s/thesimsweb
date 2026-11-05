# Reste à faire

Liste unique de ce qui reste ouvert, vérifiée contre le code le 2026-11-05. Les notes « not
ported » des documents de portage (`docs/decomp/*-port.md`) et les tableaux « Remaining » de
`docs/decomp/playtest.md` sont l'historique ; cette liste est la référence. Quand un point est
fait, le retirer d'ici et noter le correctif dans `playtest.md` / le journal de `PLAN.md`.

Entre parenthèses : la classe ou fonction d'origine, puis le fichier du port concerné (chemins
sous `client/src/game/`).

## 1. Bugs observés

- **Enfant sans corps en tenue « mode » (0x12)** : fidèle à l'original (la chaîne 0x23 des enfants
  est `ADDED`, FindSuit échoue ; après ResetSuits ou un rechargement l'enfant n'a plus de corps).
  Reste à trouver quel arbre met un enfant dans cette tenue. `sims/sanimator.ts`.
- **Erreurs d'arbre rares, non reproduites** (25 jours de jeu sur House01) : l'erreur 62 de « do
  new adult idle » (8330) est un Breakpoint des données (attribut 5 > 12) ; reste à savoir qui le
  pose en ville. 0x15 de la bonne (journal, compacteur) : pas de bonne sur les lots testés.
- **Animaux bloqués** en « Action - Chase Tail » plus de 8 heures de jeu ; **besoins de la famille**
  qui s'effondrent sur plusieurs jours sans intervention (fun, social à -100) : à comparer.
- **Famille du tutoriel importée sans nom** : photos nommées `_17_NNNN`, membres « user00177 ».

## 2. Fonctionnalités manquantes (visibles en jeu)

Live
- **Popups des besoins des animaux** : portés, non vérifiés. Page célébrité : niveaux 0 et
  0x11..0x13 non vérifiés.
- **PIP** : composition BoboVision du gadget par son masque alpha, message 0x1b de fin de fondu.
- **Tutoriel** : drapeau d'opérande +0x3e (rapport de cible des dialogues), appels de focus,
  SetOverlapsScrollArea.

Achat / Construction
- **Sols en plugin** (.flr) absents du catalogue. `data/buildcatalog.ts`.
- **Outil papier peint** : la découpe des murs suit maintenant le curseur décalé
  (ModifyCursorPos), non vérifié en jeu.

Quartier / sauvegarde
- **Pages web de la famille** (ExportFamilyHTML, DoInternetUpdate, drapeau « occupé ») : ~4600 lignes
  d'origine, rendus JPEG de visages / corps et vignettes de maison. Plan dans `docs/decomp/nbhd-port.md`.
- **Vignettes** : la petite vignette du déménagement peut différer d'un pixel ; calculs vérifiés,
  la cause serait dans le rendu (bords à 1/8) : comparer au pixel avec un fichier sauvé par le jeu.
- **Créer un Sim** : l'arbre « design-a-person » est approché par l'attente de l'aperçu ;
  costumes de clown portés mais RefillFans (seul appelant) ne l'est pas.

Interface
- **Champs de texte** : double-clic et polices double octet.

## 3. Son

- Événements kSndob* sur un cSamplePatch (objet son non modélisé ; inatteignables dans le jeu livré).

## 4. Animation

- Correction de mouvement racine du moteur de marche (désactivée dans l'original aussi).
- NPC-FX : le premier habillage « vêtements de jour » du rendu lui met des mains (l'original non).

## 5. Performance

- **Chargement à froid d'un lot** : 15 à 19 s jusqu'à la vue du lot (Chrome), puis le mode Live
  charge animations et sons à la demande (1 à 2 min de réseau actif, ce n'est pas une attente).
  Voir `docs/perf-and-browsers.md`.
- **Mémoire** : +11 à 17 Mo par jour de jeu, ce sont des caches remplis au premier usage (comportements,
  tables d'arbres, chunks IFF) ; redescend au rechargement.
- **Pics de tick** : FindPath au pire 8,6 ms (était 35 à 39) ; reste un tick de 24 ms quand
  trois routes tombent dans le même tick.

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
- Sauvegardes en mode `SAVES=client` : export / import (une archive des `UserData*` du navigateur),
  sans quoi effacer les données du site les perd.

## 9. Outils de développement (faible priorité)

- Codes de triche non portés : map_edit, prepare_lot, sim_log, tile_info, history, w, triches
  graphiques, draw_routes / draw_floorable, move_lots, nessie, stream_fps, reload_neighborhood ;
  mode déplacement (5) et touches du quartier. `ui/cheat.ts`, `nbhd/winneighborhoodul.ts`.
- Touches s (ombres, liée aux triches graphiques) et t (fenêtre images/s) de la vue ; F8 (caméra
  « stalker », développeur). q (quitter) n'a pas d'équivalent web. `cpanel/modekeys.ts`.
- Rapport de textures manquantes (ReportMissingTextures), cWinTileInfo, cWinMemView.
- Touches 1..9 de l'outil terrain (changement de rendu).
- `world/worldedit.ts` duplique des fonctions de `wallworld.ts` (nettoyage).
