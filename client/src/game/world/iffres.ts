/**
 * Resource file access (iResFile): an IFF read either standalone from the game
 * folder or out of a FAR archive, with chunk lookup by type and id.
 */

import { readFarEntry, readStandaloneIff, type IffChunkInfo } from "../../engine/assets.js";
import { engine } from "../../engine/wasm.js";

export class ResFile {
  private readonly byKey = new Map<string, IffChunkInfo>();

  constructor(
    readonly name: string,
    readonly data: Uint8Array,
    readonly chunks: IffChunkInfo[],
  ) {
    for (const c of chunks) this.byKey.set(`${c.kind}:${c.id}`, c);
  }

  /** Path relative to the game folder (e.g. "GameData/walls.iff"). */
  static async open(path: string): Promise<ResFile> {
    const { data, chunks } = await readStandaloneIff(`Sims/${path}`);
    return new ResFile(path, data, chunks);
  }

  /** IFF stored inside a FAR archive (path relative to the game folder). */
  static async openInFar(farPath: string, entry: string): Promise<ResFile> {
    const data = await readFarEntry(`Sims/${farPath}`, entry);
    const wasm = await engine();
    return new ResFile(entry, data, wasm.parseIffChunks(data) as IffChunkInfo[]);
  }

  find(kind: string, id: number): IffChunkInfo | null {
    return this.byKey.get(`${kind}:${id}`) ?? null;
  }

  list(kind: string): IffChunkInfo[] {
    return this.chunks.filter((c) => c.kind === kind);
  }

  count(kind: string): number {
    let n = 0;
    for (const c of this.chunks) if (c.kind === kind) n++;
    return n;
  }

  payload(c: IffChunkInfo): Uint8Array {
    return this.data.subarray(c.dataStart, c.dataStart + c.dataLen);
  }

  get(kind: string, id: number): Uint8Array | null {
    const c = this.find(kind, id);
    return c ? this.payload(c) : null;
  }
}
