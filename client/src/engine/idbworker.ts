/**
 * Writes the asset cache's put batches off the main thread (see queuePut in
 * engine/idb.ts): each message is one batch, answered with its number once
 * its transaction ends.
 */

import { openDb, writePuts } from "./idb.js";

interface Batch {
  batch: number;
  puts: Array<[store: string, key: string, value: unknown]>;
}

self.onmessage = (e: MessageEvent<Batch>) => {
  const { batch, puts } = e.data;
  const reply = (): void => self.postMessage({ batch });
  void openDb().then((db) => {
    if (!db) return reply();
    writePuts(db, puts, reply);
  });
};
