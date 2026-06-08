// Purity guard: production source under `qualityIntelligence/` (excluding the store / retention
// files that legitimately need filesystem IO) must NOT import provider SDKs, NOT import
// `node:fs/promises` directly, and must reach Node IO only through the established keiko-evidence
// store seams. This is the structural enforcement of ADR-0023 D8 redaction-before-persist:
// pure modules cannot accidentally write something raw.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const QI_SRC_DIR = new URL("..", import.meta.url).pathname;

// Files that are *expected* to import node:fs/* primitives — the store seam, the retention
// orchestrator (which removes side-file dirs + quarantines corrupt manifests). Every other file
// under `qualityIntelligence/` is pure.
const IO_ALLOWED_FILES: ReadonlySet<string> = new Set<string>([
  "store.ts",
  "retention.ts",
  "companionStore.ts",
]);

// Provider SDKs we never want pulled into the QI sub-module (defence against accidental
// dependency-graph bloat under the QI namespace).
const FORBIDDEN_SDK_PATTERNS: readonly RegExp[] = [
  /from\s+["']openai["']/,
  /from\s+["']@anthropic-ai\//,
  /from\s+["']@aws-sdk\//,
  /from\s+["']@azure\//,
  /from\s+["']@google-cloud\//,
];

// Node IO surfaces a pure module must not pull in.
const FORBIDDEN_NODE_IO_PATTERNS: readonly RegExp[] = [
  /from\s+["']node:fs["']/,
  /from\s+["']node:fs\/promises["']/,
  /from\s+["']node:net["']/,
  /from\s+["']node:http["']/,
  /from\s+["']node:https["']/,
  /from\s+["']node:tls["']/,
  /from\s+["']node:dns["']/,
  /from\s+["']node:child_process["']/,
  /from\s+["']node:os["']/,
  /from\s+["']node:process["']/,
];

async function listProductionSources(dir: string): Promise<readonly string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      continue;
    }
    if (!entry.name.endsWith(".ts")) {
      continue;
    }
    if (entry.name.endsWith(".test.ts")) {
      continue;
    }
    out.push(entry.name);
  }
  return out.sort();
}

describe("purity guard for packages/keiko-evidence/src/qualityIntelligence/", () => {
  it("the QI source dir exists and contains the M1+M2+M3 production files", async () => {
    const dirStat = await stat(QI_SRC_DIR);
    expect(dirStat.isDirectory()).toBe(true);
    const files = await listProductionSources(QI_SRC_DIR);
    expect(files).toEqual([
      "candidatesArtifact.ts",
      "companionStore.ts",
      "index.ts",
      "manifestSchema.ts",
      "redaction.ts",
      "retention.ts",
      "retentionPolicy.ts",
      "store.ts",
    ]);
  });

  it("no production file imports a provider SDK", async () => {
    const files = await listProductionSources(QI_SRC_DIR);
    for (const name of files) {
      const source = await readFile(join(QI_SRC_DIR, name), "utf8");
      for (const pattern of FORBIDDEN_SDK_PATTERNS) {
        expect(pattern.test(source), `${name} imports a forbidden SDK (${pattern.source})`).toBe(
          false,
        );
      }
    }
  });

  it("pure modules do not import any node:fs|net|http|tls|dns|child_process|https|os|process surface", async () => {
    const files = await listProductionSources(QI_SRC_DIR);
    for (const name of files) {
      if (IO_ALLOWED_FILES.has(name)) {
        continue;
      }
      const source = await readFile(join(QI_SRC_DIR, name), "utf8");
      for (const pattern of FORBIDDEN_NODE_IO_PATTERNS) {
        expect(
          pattern.test(source),
          `${name} reaches Node IO directly (${pattern.source}); route through the store seam`,
        ).toBe(false);
      }
    }
  });

  it("the production source uses `redact` from the security package, not a local regex", async () => {
    // The QI deny-list lives in redaction.ts (linear regexes only — see the comments there for the
    // ReDoS argument). Other production files must NOT define raw regex secret patterns; they
    // delegate to `redact()` from `@oscharko-dev/keiko-security`. The CodeQL polynomial-redos
    // gate is the second line of defence.
    const files = await listProductionSources(QI_SRC_DIR);
    for (const name of files) {
      if (name === "redaction.ts") {
        continue;
      }
      const source = await readFile(join(QI_SRC_DIR, name), "utf8");
      // Heuristic: a global-flagged regex on `Bearer`/`sk-`/`gh[a-z]_` is a secret-shape pattern.
      expect(
        /\/(Bearer|sk-|gh[a-z]_)[^/]*\/[gimsuy]+/.test(source),
        `${name} appears to define its own secret-shape regex; reuse redact() from keiko-security`,
      ).toBe(false);
    }
  });
});
