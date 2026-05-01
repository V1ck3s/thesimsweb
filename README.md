# thesimsweb

Réimplémentation web de **The Sims (Maxis, 2000) Complete / Deluxe Edition**.

Le but : faire tourner le jeu directement dans un navigateur moderne, sans installation, à partir des fichiers que l'utilisateur fournit depuis sa propre installation légale du jeu.

> ⚠️ Ce projet **ne distribue aucun asset Maxis / EA**. Pour jouer, vous devez fournir votre propre copie du jeu (CD ou installation Origin/EA App).

## État du projet

- Phase 0 (monorepo + scaffold) : ✅ terminée.
- Phase 0bis (spike d'émulation v86/Boxedwine) : ✅ terminée — Approche D rejetée. Voir [`docs/decision-A-vs-D.md`](./docs/decision-A-vs-D.md).
- Phase 1 (RE des formats) + Phase 2 (parseurs Rust) : 🚧 prochaines étapes.

Plan détaillé : [`PLAN.md`](./PLAN.md). Notes pour les sessions futures : `docs/DEVELOPMENT.md`.

## Stack

- **Client** : TypeScript strict, Vite, WebGL 2, IndexedDB.
- **Engine** : Rust → WebAssembly (`#![no_std]`, `wasm-pack`, exposé en workspace pnpm sous `@thesimsweb/wasm-bindings`).
- **Serveur de dev** : Fastify (Node 22), `@fastify/static` avec Range, SQLite via `better-sqlite3` pour les saves.

## Quick start

```bash
pnpm install
wasm-pack build --target web --scope thesimsweb crates/wasm-bindings
pnpm dev   # → client http://localhost:5173/  ·  server http://127.0.0.1:3000/
```

Détails et bootstrap d'une machine vierge : `docs/DEVELOPMENT.md`.

## Layout

```
client/                 Vite + TS frontend
server/                 Fastify dev backend (assets streaming + saves API)
crates/
  iff/                  Maxis IFF parser
  far/                  FAR archive parser
  sprite/               SPR2 / RLE / palette decoder
  wasm-bindings/        wasm-pack cdylib exposing the above to TS
docs/                   Format specs & design decisions
spike/                  Throwaway experiments (v86 emulation spike, etc.)
PLAN.md                 Living roadmap
```

## Mention légale

The Sims™ est une marque déposée d'Electronic Arts Inc. Ce projet n'est ni affilié ni endossé par EA ou Maxis.
