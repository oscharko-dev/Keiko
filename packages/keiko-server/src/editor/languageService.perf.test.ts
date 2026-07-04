// GEN-PERF-EDITOR-001 regression: the TypeScript language provider must share ONE
// process-wide ts.DocumentRegistry across requests so the default-lib .d.ts set and every
// reachable import parse ONCE, not once per diagnostics/completion/hover request.
//
// This is a mechanism proof (per the task's "prefer mechanism proofs over wall-clock"
// guidance): we count ts.createDocumentRegistry constructions and assert it is built exactly
// ONCE across 10 sequential diagnostics requests over a fixture root of ~20 imports (pre-fix
// it was built once per request → 10 times). A companion test pins that sharing the registry
// is BEHAVIOR-PRESERVING — warm requests produce byte-identical diagnostics to the cold one.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import type { LanguageServiceRequest } from "@oscharko-dev/keiko-contracts";

// The `typescript` default export is a non-configurable ESM namespace, so vi.spyOn cannot
// patch createDocumentRegistry directly. We mock the module with a factory that delegates to
// the real implementation and tallies registry constructions into a shared counter — this
// is the mechanism proof that ONE registry is shared across all requests.
const registryConstructions = { count: 0 };
vi.mock("typescript", async () => {
  // vitest's CJS interop synthesizes a `.default` for the `typescript` module at runtime, but the
  // `typeof import("typescript")` namespace type does not declare one (TS2339 under nodenext). Type
  // the imported module as also carrying that synthesized default so the real `ts` object is
  // reachable without changing runtime behavior.
  const actual = await vi.importActual<
    typeof import("typescript") & { readonly default: typeof import("typescript") }
  >("typescript");
  const real = actual.default;
  const wrapped: typeof real = {
    ...real,
    createDocumentRegistry: (...args: Parameters<typeof real.createDocumentRegistry>) => {
      registryConstructions.count += 1;
      return real.createDocumentRegistry(...args);
    },
  };
  return { default: wrapped, ...wrapped };
});

import { runLanguageOperation, type RunLanguageOperationOptions } from "./languageService.js";

let root: string;
const MODULE_COUNT = 20;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-ls-perf-")));
  mkdirSync(join(root, "src"), { recursive: true });
  // ~20 imported modules so the program has real lib + import ASTs to (re)parse.
  for (let i = 0; i < MODULE_COUNT; i += 1) {
    writeFileSync(
      join(root, "src", `mod${String(i)}.ts`),
      `export function fn${String(i)}(value: number): number {\n  return value + ${String(i)};\n}\n`,
      "utf8",
    );
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function importingOverlay(): string {
  const imports = Array.from(
    { length: MODULE_COUNT },
    (_, i) => `import { fn${String(i)} } from './mod${String(i)}.js';`,
  ).join("\n");
  const uses = Array.from({ length: MODULE_COUNT }, (_, i) => `fn${String(i)}(${String(i)})`).join(
    " + ",
  );
  return `${imports}\nexport const total = ${uses};\n`;
}

function tsDocument(path: string, text: string): LanguageServiceRequest["document"] {
  return { path, languageId: "typescript", text };
}

function diagnosticsOptions(relativePath: string): RunLanguageOperationOptions {
  return {
    fs: nodeWorkspaceFs,
    realRoot: root,
    overlayAbsolutePath: join(root, relativePath),
    now: () => 0,
  };
}

function runDiagnostics(overlayText: string): string {
  const outcome = runLanguageOperation(
    { operation: "diagnostics", root, document: tsDocument("src/main.ts", overlayText) },
    diagnosticsOptions("src/main.ts"),
  );
  expect(outcome.kind).toBe("diagnostics");
  if (outcome.kind !== "diagnostics") throw new Error("unreachable");
  return JSON.stringify(outcome.result.diagnostics);
}

describe("typescript language provider registry reuse (GEN-PERF-EDITOR-001)", () => {
  it("constructs the shared DocumentRegistry once across 10 sequential requests", () => {
    const before = registryConstructions.count;
    const overlay = importingOverlay();

    for (let i = 0; i < 10; i += 1) {
      runDiagnostics(overlay);
    }

    // One shared registry for all 10 requests — pre-fix this was 10 (one per withService).
    expect(registryConstructions.count - before).toBe(1);
  });

  it("produces identical diagnostics on warm requests (registry sharing is behavior-preserving)", () => {
    // The overlay imports 20 modules and has a real type error (adding a string to the
    // numeric total) so diagnostics are non-empty and content-bearing.
    const overlay = `${importingOverlay()}export const bad: number = total + "x";\n`;

    const cold = runDiagnostics(overlay);
    expect(cold).not.toBe("[]");

    // Nine subsequent requests reuse the shared registry's parsed lib/import ASTs and must
    // yield byte-identical diagnostics — proving reuse changes performance, not results.
    for (let i = 0; i < 9; i += 1) {
      expect(runDiagnostics(overlay)).toBe(cold);
    }

    // An edited overlay (version bump inside the host) must still re-check against the SAME
    // shared registry and reflect the new buffer — the cache never serves stale diagnostics.
    const fixed = `${importingOverlay()}export const good: number = total + 1;\n`;
    expect(runDiagnostics(fixed)).not.toBe(cold);
  });
});
