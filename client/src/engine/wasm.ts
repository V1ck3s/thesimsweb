// Lazy initialiser for the Rust→WASM engine module.
// `init()` is called once on first access, then `engine` resolves to the
// fully-typed bindings.

import init, * as bindings from "@thesimsweb/wasm-bindings";
import wasmUrl from "@thesimsweb/wasm-bindings/wasm_bindings_bg.wasm?url";

let ready: Promise<typeof bindings> | undefined;

export function engine(): Promise<typeof bindings> {
  if (!ready) {
    ready = init({ module_or_path: wasmUrl }).then(() => bindings);
  }
  return ready;
}
