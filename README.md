# thesimsweb

Réimplémentation web de **The Sims (Maxis, 2000) Complete / Deluxe Edition**.

Le but : faire tourner le jeu directement dans un navigateur moderne, sans installation, à partir des fichiers que l'utilisateur fournit depuis sa propre installation légale du jeu.

> ⚠️ Ce projet **ne distribue aucun asset Maxis / EA**. Pour jouer, vous devez fournir votre propre copie du jeu (CD ou installation Origin/EA App).

## État du projet

🚧 **Phase 0 — Initialisation.** Le plan détaillé se trouve dans [`PLAN.md`](./PLAN.md).

## Stack envisagée

- **TypeScript** (UI, game loop, VM SimAntics)
- **Rust → WebAssembly** (parseurs FAR/IFF, décodeur sprites)
- **WebGL 2** (rendu isométrique)
- **Web Audio API** (musique, voix, FX)
- **IndexedDB** + **OPFS** (stockage des assets et sauvegardes)

## Démarrage

_(Pas encore de code — voir [`PLAN.md`](./PLAN.md) pour la roadmap.)_

## Mention légale

The Sims™ est une marque déposée d'Electronic Arts Inc. Ce projet n'est ni affilié ni endossé par EA ou Maxis.
