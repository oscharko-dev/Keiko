// #2642: guards the Reuse-And-No-Duplication rule that PR #2483 established for the Playwright
// server-entry family. Every Code-task browser journey must boot through the shared composition
// (tests/e2e/servers/coding-runtime-server-shared.mts), NOT re-declare BFF/UI/workspace wiring in
// its own entry. This test fails when an entry imports composition primitives directly, which is
// the exact drift that produced the third hand-copied 2387 server this issue removes.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVERS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "tests",
  "e2e",
  "servers",
);

const SHARED_ENTRY_IMPORT = /from ["']\.\/coding-runtime-server-shared\.mjs["']/;
const SHARED_JOURNEY_ENTRYPOINT = "runCodingRuntimeJourneyServer";

// Composition primitives that MUST live in the shared entry, not in a per-journey entry. Any of
// these appearing in a per-journey entry indicates the shared entry has been bypassed. Constants
// (e.g. RESEARCH_JOURNEY_URL) are allowed even when exported from the same underlying module — the
// duplication we care about is boot-path composition, not shared fixture data.
const FORBIDDEN_COMPOSITION_TOKENS: readonly string[] = [
  "buildUiHandlerDeps",
  "createUiServer",
  "createFunctionalRuntimeResolver",
  "functionalGatewayConfig",
  "scriptedResponse",
  "scriptedTranscript",
  "productionDiscoveryBffDeps",
  "buildCspHeader",
  "extractInlineScriptHashes",
  "createWorkspaceProvisioningService",
  "createWorkspaceLifecycleService",
  "createWorkspaceReconciliationService",
  "buildWorkspaceInstanceStoreOverDatabase",
  "buildActiveWorkspacePointerStoreOverDatabase",
  "createWorkspaceMutexRegistry",
  "createVerificationRunnerManager",
  "createInMemoryUiStore",
  "runMigrations",
  "createCodingRuntimeEvidenceAggregator",
  "readProductionWorkspaceHead",
  "createScriptedOpenCodeHarness",
  "scriptedFunctionalPortable",
];

const PER_JOURNEY_ENTRIES: readonly string[] = [
  "coding-runtime-2385-server.mts",
  "coding-runtime-2386-server.mts",
  "coding-runtime-2387-server.mts",
  "coding-runtime-2483-real-binary-server.mts",
];

function readEntry(filename: string): string {
  return readFileSync(resolve(SERVERS_DIR, filename), "utf8");
}

// Strips block comments and single-line comments so a token mentioned only in prose (e.g. the
// 2483 entry's header comment describing production discovery) cannot false-fail this gate.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const commentStart = line.indexOf("//");
      return commentStart >= 0 ? line.slice(0, commentStart) : line;
    })
    .join("\n");
}

describe("Code-task Playwright server entries", () => {
  for (const filename of PER_JOURNEY_ENTRIES) {
    describe(filename, () => {
      it("imports the shared journey composition", () => {
        const source = readEntry(filename);
        expect(source, `${filename} must import from ./coding-runtime-server-shared.mjs`).toMatch(
          SHARED_ENTRY_IMPORT,
        );
        expect(
          source,
          `${filename} must call ${SHARED_JOURNEY_ENTRYPOINT} rather than compose its own boot path`,
        ).toContain(SHARED_JOURNEY_ENTRYPOINT);
      });

      it("does not re-declare composition primitives owned by the shared entry", () => {
        const code = stripComments(readEntry(filename));
        const leaked = FORBIDDEN_COMPOSITION_TOKENS.filter((token) => code.includes(token));
        expect(
          leaked,
          `${filename} must not reference composition primitives that live in the shared entry`,
        ).toEqual([]);
      });
    });
  }
});
