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
const CLEAN_FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/contract-boundaries/clean-api.txt", import.meta.url),
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

function writeSchemaVersionFixtures(root, agentVersion = "1", verificationVersion = "1") {
  const agentPath = join(root, "packages/keiko-contracts/src/editor-agent.ts");
  const verificationPath = join(root, "packages/keiko-contracts/src/editor-verification.ts");
  mkdirSync(dirname(agentPath), { recursive: true });
  writeFileSync(
    agentPath,
    `export const EDITOR_AGENT_SCHEMA_VERSION = "${agentVersion}" as const;\n`,
    "utf8",
  );
  writeFileSync(
    verificationPath,
    `export const EDITOR_VERIFICATION_SCHEMA_VERSION = "${verificationVersion}" as const;\n`,
    "utf8",
  );
}

function createFixtureRoot(apiFixturePath) {
  fixtureRoot = mkdtempSync(join(tmpdir(), "keiko-contract-boundaries-"));
  for (const relativePath of CHECKED_FILES) {
    const destination = join(fixtureRoot, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, "", "utf8");
  }
  copyFileSync(apiFixturePath, join(fixtureRoot, "packages/keiko-ui/src/lib/api.ts"));
  writeSchemaVersionFixtures(fixtureRoot);
  return fixtureRoot;
}

describe("managed-LSP contract boundary", () => {
  it("rejects UI-owned managed-LSP route envelopes", () => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      cwd: createFixtureRoot(FIXTURE_PATH),
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Managed LSP UI envelopes must alias contracts-owned route types.",
    );
  });
});

// Issue #2489 (Finding 7) — EditorAgentAction* / editor-verification / editor-agent-governance
// wire shapes previously had no pin at all: a local redeclaration in api.ts (the exact drift this
// script exists to catch for every other pinned surface) would have passed silently.
describe("editor-agent contract boundary (#2489 Finding 7)", () => {
  it.each([
    [
      "editor-agent-action-type-api.txt",
      "Editor-agent action types must alias EditorAgentActionType from contracts.",
    ],
    [
      "editor-agent-verification-api.txt",
      "Editor-agent verification shapes must alias editor-agent-verification.ts types.",
    ],
    [
      "editor-agent-governance-api.txt",
      "Editor-agent governance classification maps must alias editor-agent-governance.ts.",
    ],
  ])("rejects a local redeclaration in api.ts (%s)", (fixtureFile, expectedMessage) => {
    const apiFixturePath = fileURLToPath(
      new URL(`./fixtures/contract-boundaries/${fixtureFile}`, import.meta.url),
    );
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      cwd: createFixtureRoot(apiFixturePath),
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(expectedMessage);
  });
});

// Issue #2489 (Finding 8) — EDITOR_AGENT_SCHEMA_VERSION and EDITOR_VERIFICATION_SCHEMA_VERSION
// must not silently drift apart while both independent ladders are pinned at "1". The pure
// comparison logic itself is unit-tested directly in schema-version-lockstep.test.mjs (no
// subprocess); these two tests are the end-to-end CLI-behavior proof.
describe("editor-agent schema-version lockstep (#2489 Finding 8)", () => {
  it("passes when both schema-version constants match", () => {
    const root = createFixtureRoot(CLEAN_FIXTURE_PATH);
    writeSchemaVersionFixtures(root, "1", "1");
    const result = spawnSync(process.execPath, [SCRIPT_PATH], { cwd: root, encoding: "utf8" });

    expect(result.status).toBe(0);
  });

  it("rejects a schema-version drift between the two ladders", () => {
    const root = createFixtureRoot(CLEAN_FIXTURE_PATH);
    writeSchemaVersionFixtures(root, "1", "2");
    const result = spawnSync(process.execPath, [SCRIPT_PATH], { cwd: root, encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'EDITOR_AGENT_SCHEMA_VERSION ("1") and EDITOR_VERIFICATION_SCHEMA_VERSION ("2") have drifted ' +
        "out of lockstep.",
    );
  });
});
