// Shared CliIo capture helper for keiko-cli unit tests. Extracted from 17+ test files
// that each defined a byte-identical `interface Captured` + `function makeIo()` /
// `function capture()` — one implementation of the same trivial fixture kept diverging
// (one exported an `err()` getter, another a snapshot; some used `outChunks[]`, others
// `out = ""`), and a real fix to any of them required editing every file.
//
// This module lives under `packages/keiko-cli/src/test-support/` so it is excluded from
// the package's PUBLIC exports (the barrel in `packages/keiko-cli/src/index.ts` never
// re-exports the `test-support/` directory) while still sitting inside the compiled
// program so per-file tsc + vitest see it (KEIKO-0906).

import type { CliIo } from "../runner.js";

export interface CapturedCliIo {
  readonly io: CliIo;
  readonly out: () => string;
  readonly err: () => string;
}

/**
 * Returns a CliIo whose `.out(text)` and `.err(text)` accumulate their argument, plus
 * two `out()` / `err()` snapshot readers that join the buffered chunks. Callers rely on
 * both the accumulation (multiple .out calls compose) and the readers (call at any
 * point to inspect what the SUT wrote so far).
 */
export function makeCapturedIo(): CapturedCliIo {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: {
      out: (text: string): void => {
        outChunks.push(text);
      },
      err: (text: string): void => {
        errChunks.push(text);
      },
    },
    out: (): string => outChunks.join(""),
    err: (): string => errChunks.join(""),
  };
}
