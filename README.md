# thesimsweb

Réimplémentation web de **The Sims (Maxis, 2000) Complete / Deluxe Edition**.

Le but : faire tourner le jeu directement dans un navigateur moderne, sans installation, à partir des fichiers que l'utilisateur fournit depuis sa propre installation légale du jeu.

> ⚠️ Ce projet **ne distribue aucun asset Maxis / EA**. Pour jouer, vous devez fournir votre propre copie du jeu (CD ou installation Origin/EA App).

## État du projet

- Phase 0 (monorepo + scaffold) : ✅ terminée.
- Phase 0bis (spike d'émulation v86/Boxedwine) : ✅ terminée — Approche D rejetée. Voir [`docs/decision-A-vs-D.md`](./docs/decision-A-vs-D.md).
- Depuis 2026-10-25 : le jeu est porté classe par classe depuis le code décompilé (`client/game.html`, `client/src/game/`, voir [`docs/decomp/`](./docs/decomp/)). Jouable de bout en bout ; phase de playtest et corrections (`docs/decomp/playtest.md`).

Plan détaillé : [`PLAN.md`](./PLAN.md). Notes pour les sessions futures : `docs/DEVELOPMENT.md`.

## Stack

- **Client** : TypeScript strict, Vite, WebGL 2, IndexedDB.
- **Engine** : Rust → WebAssembly (`#![no_std]`, `wasm-pack`, exposé en workspace pnpm sous `@thesimsweb/wasm-bindings`).
- **Serveur de dev** : Fastify (Node 22), `@fastify/static` avec Range, sauvegardes écrites dans un overlay (`server/data/overlay/`), le dossier du jeu restant en lecture seule.

## Quick start

```bash
pnpm install
wasm-pack build --target web --scope thesimsweb crates/wasm-bindings
pnpm dev   # → client http://localhost:5173/  ·  server http://127.0.0.1:3000/
```

Détails et bootstrap d'une machine vierge : `docs/DEVELOPMENT.md`.

## Play (production build)

You need Node 22, pnpm, and Rust with `wasm-pack` (the engine is compiled to
WebAssembly). Point the server at your own installation of the game first:

```bash
pnpm install
mkdir -p server/assets
ln -s "/path/to/Maxis/The Sims" server/assets/Sims   # read-only is fine
pnpm start                                            # → http://127.0.0.1:3000/
```

`pnpm start` (`scripts/start.mjs`) rebuilds whatever is stale — the WASM engine,
the client bundle (`client/dist/`, vite) and the server (`server/dist/`, tsc) —
then runs the Fastify server, which serves the game at `/` next to `/assets`,
`/api/*` and the save overlay. Open the URL in Firefox or Chrome.

- Port / interface: `pnpm start --port 4000` (or `PORT=4000`), `HOST=0.0.0.0 pnpm start` for the LAN.
- `pnpm start --rebuild` forces every build step, `--no-build` only runs the server.
- `pnpm build` builds everything without starting anything.
- URL options: `/?nbhd=UserData2` opens another neighborhood, `/?house=1` goes straight into a lot.
- Saves never touch the game folder: they go to `server/data/overlay/Sims/UserData*/`,
  which shadows the originals (delete a folder there to reset that neighborhood).

## Layout

```
client/                 Vite + TS frontend
server/                 Fastify dev backend (assets streaming, save overlay, built client)
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
