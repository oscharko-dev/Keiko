import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = fileURLToPath(new URL("../check-contract-boundaries.mjs", import.meta.url));
const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/contract-boundaries/managed-lsp-api.txt", import.meta.url),
);
const CHECKED_FILES = [
  "packages/keiko-ui/src/lib/api.ts",
  "packages/keiko-server/src/editor/lsp/managedLspControl.ts",
  "packages/keiko-server/src/editor/lsp/managedLspRoutes.ts",
  "packages/keiko-server/src/chat-stream-handlers.ts",
  "packages/keiko-server/src/chat-handlers.ts",
  "packages/keiko-ui/src/lib/quality-intelligence-api.ts",
  "packages/keiko-ui/src/app/components/desktop/widgets/quality-intelligence/CandidatesPane.tsx",
  "packages/keiko-server/src/qualityIntelligence/reviewStore.ts",
  "packages/keiko-ui/src/lib/memory-api.ts",
];

let fixtureRoot = "";

afterEach(() => {
  if (fixtureRoot.length > 0) rmSync(fixtureRoot, { force: true, recursive: true });
  fixtureRoot = "";
});

function createFixtureRoot() {
  fixtureRoot = mkdtempSync(join(tmpdir(), "keiko-contract-boundaries-"));
  for (const relativePath of CHECKED_FILES) {
    const destination = join(fixtureRoot, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, "", "utf8");
  }
  copyFileSync(FIXTURE_PATH, join(fixtureRoot, "packages/keiko-ui/src/lib/api.ts"));
  return fixtureRoot;
}

describe("managed-LSP contract boundary", () => {
  it("rejects UI-owned managed-LSP route envelopes", () => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      cwd: createFixtureRoot(),
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Managed LSP UI envelopes must alias contracts-owned route types.",
    );
  });
});
