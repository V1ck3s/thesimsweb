/**
 * Save storage layer — keeps an IndexedDB mirror and the Fastify `/api/saves`
 * endpoint in sync. Writes go to both; reads prefer IDB and fall back to the
 * server (and back-fill IDB) so the page works offline once it's been opened
 * online at least once.
 *
 * Identity: until proper auth is in place, every browser picks a random UUID
 * on first boot and stashes it in `localStorage`. The server's saves table is
 * keyed by this id, so two browsers don't accidentally share a save bucket.
 */

const USER_ID_KEY = "thesimsweb:userId";

function getUserId(): string {
  try {
    const existing = localStorage.getItem(USER_ID_KEY);
    if (existing) return existing;
    const fresh =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `u-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
    localStorage.setItem(USER_ID_KEY, fresh);
    return fresh;
  } catch {
    return "anonymous";
  }
}

function authHeaders(): Record<string, string> {
  return { "x-user": getUserId() };
}

import {
  idbDeleteSave,
  idbGetSave,
  idbListSaves,
  idbPutSave,
  type LocalSaveRecord,
} from "./idb.js";

export interface SaveDescriptor {
  id: string;
  name: string;
  size: number;
  updatedAt: number;
  /** Whether the local copy matches the server (or "unknown" if offline). */
  source: "local" | "server" | "both";
}

interface ServerSaveListItem {
  id: string;
  name: string;
  size: number;
  updatedAt: number;
}

async function fetchServerList(): Promise<ServerSaveListItem[] | null> {
  try {
    const res = await fetch("/api/saves", { headers: authHeaders() });
    if (!res.ok) return null;
    const json = (await res.json()) as { saves?: ServerSaveListItem[] };
    return Array.isArray(json.saves) ? json.saves : [];
  } catch {
    return null;
  }
}

/** List saves merging IDB + server. Each entry's `source` tells you whether
 *  it's local-only, server-only, or both. Sort: most-recent first. */
export async function listSaves(): Promise<SaveDescriptor[]> {
  const [local, server] = await Promise.all([idbListSaves(), fetchServerList()]);
  const merged = new Map<string, SaveDescriptor>();
  for (const rec of local) {
    merged.set(rec.id, {
      id: rec.id,
      name: rec.name,
      size: rec.payload.length,
      updatedAt: rec.updatedAt,
      source: "local",
    });
  }
  if (server) {
    for (const s of server) {
      const existing = merged.get(s.id);
      if (existing) {
        existing.source = "both";
        // Prefer the more recent metadata (server vs. local clock).
        if (s.updatedAt > existing.updatedAt) {
          existing.updatedAt = s.updatedAt;
          existing.name = s.name;
        }
      } else {
        merged.set(s.id, {
          id: s.id,
          name: s.name,
          size: s.size,
          updatedAt: s.updatedAt,
          source: "server",
        });
      }
    }
  }
  return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Persist a save under `id`. Writes to IDB first (synchronous-feeling) then
 *  pushes to the server best-effort. Returns true if at least IDB succeeded. */
export async function putSave(id: string, name: string, payload: string): Promise<{ idb: boolean; server: boolean }> {
  const rec: LocalSaveRecord = { id, name, payload, updatedAt: Date.now() };
  let idbOk = true;
  try {
    await idbPutSave(rec);
  } catch (err) {
    console.warn("[save] idb put failed:", err);
    idbOk = false;
  }
  let serverOk = false;
  try {
    const res = await fetch(
      `/api/saves/${encodeURIComponent(id)}?name=${encodeURIComponent(name)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream", ...authHeaders() },
        body: new TextEncoder().encode(payload),
      },
    );
    serverOk = res.ok;
  } catch (err) {
    console.warn("[save] server put failed:", err);
  }
  return { idb: idbOk, server: serverOk };
}

/** Fetch a save's payload, preferring IDB. Falls back to the server (and
 *  back-fills IDB on success). Returns null if neither source has it. */
export async function getSave(id: string): Promise<{ name: string; payload: string } | null> {
  const local = await idbGetSave(id);
  if (local) return { name: local.name, payload: local.payload };
  try {
    const res = await fetch(`/api/saves/${encodeURIComponent(id)}`, { headers: authHeaders() });
    if (!res.ok) return null;
    const payload = await res.text();
    const name = res.headers.get("X-Save-Name") ?? id;
    const updatedAtHdr = Number(res.headers.get("X-Save-Updated-At") ?? "0");
    try {
      await idbPutSave({ id, name, payload, updatedAt: updatedAtHdr || Date.now() });
    } catch {
      // best-effort backfill
    }
    return { name, payload };
  } catch {
    return null;
  }
}

/** Remove a save from both IDB and the server. */
export async function deleteSave(id: string): Promise<void> {
  try {
    await idbDeleteSave(id);
  } catch (err) {
    console.warn("[save] idb delete failed:", err);
  }
  try {
    await fetch(`/api/saves/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
  } catch (err) {
    console.warn("[save] server delete failed:", err);
  }
}

/** Generate a fresh kebab-cased id from a free-text save name. Falls back to a
 *  timestamp tail if the slug ends up empty (all-emoji name etc.). When the
 *  slug would collide with an existing save, append `-2`, `-3`, etc. so the
 *  user never overwrites a save silently. */
export async function slugifySaveId(name: string): Promise<string> {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 48) || `save-${Date.now()}`;
  // Check for collisions against both IDB and the server.
  const existing = await listSaves();
  const taken = new Set(existing.map((s) => s.id));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base.slice(0, 44)}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}
