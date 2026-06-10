// Regression guard for a circular-import temporal-dead-zone (TDZ) crash that the normal vitest
// suite CANNOT reproduce: vitest transpiles via esbuild and resolves the grounded-qa.ts ⇄
// grounded-qa-hybrid.ts module-init order differently from Node's native ESM loader. The bug
// (a top-level constant in grounded-qa-hybrid interpolating GROUNDED_SYSTEM_PROMPT from
// grounded-qa before that module finished initializing) made the REAL server crash on boot with
// "Cannot access 'GROUNDED_SYSTEM_PROMPT' before initialization" while every unit test stayed green.
//
// This guard imports the built grounded-qa-hybrid module in a real Node ESM child process, which
// reproduces the native module-init order. It skips when the dist is absent (e.g. a source-only
// `vitest` run with no preceding build); the canonical gate builds packages before testing.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const distEntry = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "grounded-qa-hybrid.js",
);

describe("grounded modules — native Node ESM boot", () => {
  it.skipIf(!existsSync(distEntry))(
    "initializes grounded-qa-hybrid (cyclic with grounded-qa) with no temporal-dead-zone error",
    () => {
      const script = `await import(${JSON.stringify(distEntry)}); console.log("BOOT_OK");`;
      const out = execFileSync(
        process.execPath,
        ["--experimental-sqlite", "--input-type=module", "-e", script],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      expect(out).toContain("BOOT_OK");
    },
  );
});
