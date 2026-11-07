/**
 * The asset cache's IndexedDB work off the main thread (see queuePut and
 * queueGet in engine/idb.ts): each message is one batch of puts, answered
 * with its number once its transaction ends, or one batch of gets, answered
 * with its number and the values read (their bytes transferred).
 */

import { bufferList, openDb, readGets, writePuts } from "./idb.js";

interface Batch {
  batch: number;
  puts?: Array<[store: string, key: string, value: unknown]>;
  gets?: Array<[store: string, key: string]>;
}

self.onmessage = (e: MessageEvent<Batch>) => {
  const { batch, puts, gets } = e.data;
  void openDb().then((db) => {
    if (gets) {
      const reply = (values: unknown[]): void => {
        try {
          self.postMessage({ batch, values }, { transfer: [...bufferList(values)] });
        } catch {
          self.postMessage({ batch });
        }
      };
      if (!db) return reply([]);
      readGets(db, gets, reply);
      return;
    }
    const reply = (): void => self.postMessage({ batch });
    if (!db || !puts) return reply();
    writePuts(db, puts, reply);
  });
};
