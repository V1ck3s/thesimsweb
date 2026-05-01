import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import Database from "better-sqlite3";

interface Options {
  repoRoot: string;
}

interface SaveRow {
  id: string;
  user: string;
  name: string;
  data: Buffer;
  updated_at: number;
}

interface SaveListItem {
  id: string;
  name: string;
  size: number;
  updatedAt: number;
}

export async function registerSavesRoute(
  app: FastifyInstance,
  { repoRoot }: Options,
): Promise<void> {
  const dataDir = join(repoRoot, "server", "data");
  await mkdir(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "saves.sqlite"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS saves (
      id TEXT PRIMARY KEY,
      user TEXT NOT NULL,
      name TEXT NOT NULL,
      data BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS saves_user_idx ON saves(user);
  `);

  // No real auth in phase 0 — the client passes a simple user header. JWT
  // can be added later without changing route shape.
  const userOf = (req: FastifyRequest): string =>
    typeof req.headers["x-user"] === "string" ? req.headers["x-user"] : "anonymous";

  app.get<{ Reply: { saves: SaveListItem[] } }>("/api/saves", async (req) => {
    const user = userOf(req);
    const rows = db
      .prepare<[string], SaveRow>(
        "SELECT id, name, length(data) as size, updated_at FROM saves WHERE user = ? ORDER BY updated_at DESC",
      )
      .all(user) as unknown as Array<{
      id: string;
      name: string;
      size: number;
      updated_at: number;
    }>;
    return {
      saves: rows.map((r) => ({
        id: r.id,
        name: r.name,
        size: r.size,
        updatedAt: r.updated_at,
      })),
    };
  });

  app.get<{ Params: { id: string } }>("/api/saves/:id", async (req, reply) => {
    const user = userOf(req);
    const row = db
      .prepare<[string, string], SaveRow>(
        "SELECT id, user, name, data, updated_at FROM saves WHERE id = ? AND user = ?",
      )
      .get(req.params.id, user);
    if (!row) {
      return reply.code(404).send({ error: "not_found" });
    }
    reply.header("Content-Type", "application/octet-stream");
    reply.header("X-Save-Name", row.name);
    reply.header("X-Save-Updated-At", String(row.updated_at));
    return reply.send(row.data);
  });

  app.put<{ Params: { id: string }; Querystring: { name?: string }; Body: Buffer }>(
    "/api/saves/:id",
    {
      bodyLimit: 50 * 1024 * 1024,
    },
    async (req, reply) => {
      const user = userOf(req);
      const name = req.query.name ?? "Untitled";
      const data = req.body;
      const now = Date.now();
      db.prepare(
        `INSERT INTO saves (id, user, name, data, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           user = excluded.user,
           name = excluded.name,
           data = excluded.data,
           updated_at = excluded.updated_at`,
      ).run(req.params.id, user, name, data, now);
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string } }>("/api/saves/:id", async (req, reply) => {
    const user = userOf(req);
    const result = db
      .prepare("DELETE FROM saves WHERE id = ? AND user = ?")
      .run(req.params.id, user);
    if (result.changes === 0) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.code(204).send();
  });

  // Raw bytes content type so PUT bodies arrive as Buffer.
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );
}
