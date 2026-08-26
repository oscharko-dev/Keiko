// Shared CliIo capture helper for keiko-cli unit tests. #2906 round 3 (comment 3865329066):
// the original claim here ("extracted from 17+ test files") was never made good on — only
// doctor.test.ts imported it, so the module added a second compiled source file and a second
// fixture variant without reducing anything. Migrated in the same change to its first two real
// consumers (doctor.test.ts, uninstall.test.ts, launcher.test.ts — each previously defined a
// byte-identical `interface Captured` + `function makeIo()`), each aliased as
// `const makeIo = makeCapturedIo;` so no existing call site had to change.
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
