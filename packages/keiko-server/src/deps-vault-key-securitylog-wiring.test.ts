// Wiring test for `buildUiHandlerDeps`'s composition of the five keychain key-tier callers that,
// until this change, could resolve a local vault key (env -> keychain -> keyfile,
// `@oscharko-dev/keiko-security/secret-vault`'s `resolveLocalVaultKey`) without ever being able to
// report which tier answered or that the keychain tier fell back (Wave 4a, epic #3233 §8, gap g18):
// `editorHotExitStore`, `localKnowledgeKeyProvider`, `atlassianConnectorCredentials`,
// `workspaceIndexForRoot`, and the provider-credential vault reached through
// `migrateLocalConfigCredentials`/`createProviderSecretResolver` inside `loadRuntimeGatewayConfig`.
//
// WHAT THIS PINS
//
// Each caller's own `securityLogSink` -> `resolveLocalVaultKey({ sink })` wiring is unit-pinned in
// its own file (`credentialVault.test.ts`-adjacent files do not yet exist for every caller, so the
// closed-vocabulary and fallback shapes are pinned once, centrally, in
// `@oscharko-dev/keiko-security/secret-vault.test.ts`). This file pins the ONE remaining link per
// caller: that the real composition root (`deps.ts`) actually supplies
// `securityLogSink: processServerLogSink()` when building each caller's production default — the
// same #3230-class regression (a port declared but never wired at composition) the sibling
// `deps-attachment-history-securitylog-wiring.test.ts` guards against for the two callers wired in
// an earlier part of this wave.
//
// `@oscharko-dev/keiko-security/secret-vault` is module-mocked to CAPTURE every `resolveLocalVaultKey`
// call's options (real behaviour is preserved via `importOriginal` + delegation) so each assertion
// below can inspect exactly what `deps.ts` supplied, without needing to force a real keychain
// failure or touch the developer's login keychain — hermetic per AGENTS.md.
//
// THE FAILURE THIS PINS: dropping any one `securityLogSink: processServerLogSink()` line from
// `deps.ts` leaves the matching call's `sink` field `undefined`, and that caller's assertion below
// fails.

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EDITOR_HOT_EXIT_SCHEMA_VERSION,
  type EditorHotExitSnapshotV1,
} from "@oscharko-dev/keiko-contracts";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
  type BufferedServerLogSink,
} from "./observability/index.js";
import { createInMemoryUiStore } from "./store/index.js";

type ResolveLocalVaultKeyOptions = Parameters<
  typeof import("@oscharko-dev/keiko-security/secret-vault").resolveLocalVaultKey
>[0];

let calls: ResolveLocalVaultKeyOptions[];

vi.mock("@oscharko-dev/keiko-security/secret-vault", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oscharko-dev/keiko-security/secret-vault")>();
  return {
    ...actual,
    resolveLocalVaultKey: (
      options: ResolveLocalVaultKeyOptions,
    ): ReturnType<typeof actual.resolveLocalVaultKey> => {
      calls.push(options);
      return actual.resolveLocalVaultKey(options);
    },
  };
});

// Imported AFTER the mock declaration so `deps.ts`'s internal `resolveLocalVaultKey` import (via
// every caller it composes) binds to the capturing wrapper above.
const { buildUiHandlerDeps } = await import("./deps.js");

const tmpDirs: string[] = [];

function tmp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}

let sink: BufferedServerLogSink;

beforeEach(() => {
  calls = [];
  sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
});

afterEach(() => {
  resetServerLogger();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Every call captured for `envVarName` must carry a `sink` — checked with `every`, not merely the
// first match, because the provider-credential vault is reached through TWO independent call sites
// (`migrateLocalConfigCredentials` and `createProviderSecretResolver`) that share one env var name;
// `.find()` would let either site's wiring regress unnoticed behind the other's. Each sink must not
// merely be present but IS the process-wide activity log: a write through it must reach
// `server.log`, exactly like a real fallback would.
function expectRealServerLogSink(envVarName: string, op: string): void {
  const matching = calls.filter((c) => c.envVarName === envVarName);
  expect(matching.length).toBeGreaterThan(0);
  expect(matching.every((c) => c.sink !== undefined)).toBe(true);
  matching[0]?.sink?.write({ level: "info", category: "security", op, extra: {} });
  expect(sink.events).toContainEqual(expect.objectContaining({ category: "security", op }));
}

function hotExitSnapshot(): EditorHotExitSnapshotV1 {
  return {
    schemaVersion: EDITOR_HOT_EXIT_SCHEMA_VERSION,
    workspaceRoot: "/repo",
    relativePath: "src/app.ts",
    content: "const x = 1;\n",
    baseVersion: { sizeBytes: 16, modifiedAt: 1, contentHash: "a".repeat(64) },
    contentHash: "b".repeat(64),
    savedContentHash: "a".repeat(64),
    updatedAt: 1_000,
    paneId: "pane-1",
    windowId: "editor-1",
  };
}

// The composition root types these surfaces as optional (a deployment may omit them); a wiring
// test is about the deployment that HAS them, so their absence is a failure, not a skip.
function present<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} was not composed`);
  return value;
}

describe("buildUiHandlerDeps — editorHotExitStore wires resolveLocalVaultKey's sink", () => {
  it("supplies a real server-log sink to the hot-exit vault's key resolution", () => {
    const uiDir = tmp("deps-hotexit-vaultkey-");
    const evidenceDir = tmp("deps-hotexit-vaultkey-ev-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { KEIKO_UI_DATA_DIR: uiDir },
    });
    try {
      const snapshot = hotExitSnapshot();
      const hotExitStore = present(deps.editorHotExitStore, "editorHotExitStore");
      const ref = hotExitStore.snapshotRefFor(snapshot.workspaceRoot, snapshot.relativePath);
      hotExitStore.write(snapshot, ref);

      expectRealServerLogSink("KEIKO_EDITOR_HOT_EXIT_KEY", "security.vault.key-resolved");
    } finally {
      deps.store.close();
      deps.memoryVault?.close();
    }
  });
});

describe("buildUiHandlerDeps — localKnowledgeKeyProvider wires resolveLocalVaultKey's sink", () => {
  it("supplies a real server-log sink to the knowledge store's key resolution", () => {
    const uiDir = tmp("deps-knowledge-vaultkey-");
    const evidenceDir = tmp("deps-knowledge-vaultkey-ev-");
    const knowledgeDir = tmp("deps-knowledge-vaultkey-store-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { KEIKO_UI_DATA_DIR: uiDir },
    });
    try {
      present(deps.localKnowledgeKeyProvider, "localKnowledgeKeyProvider").resolveKey({
        dbPath: join(knowledgeDir, "capsules.db"),
        schemaVersion: 1,
      });

      expectRealServerLogSink("KEIKO_LOCAL_KNOWLEDGE_KEY", "security.vault.key-resolved");
    } finally {
      deps.store.close();
      deps.memoryVault?.close();
    }
  });
});

describe("buildUiHandlerDeps — workspaceIndexForRoot wires resolveLocalVaultKey's sink", () => {
  it("supplies a real server-log sink to the workspace index's key resolution", () => {
    const uiDir = tmp("deps-wsindex-vaultkey-");
    const evidenceDir = tmp("deps-wsindex-vaultkey-ev-");
    const workspaceRoot = tmp("deps-wsindex-vaultkey-root-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { KEIKO_UI_DATA_DIR: uiDir },
    });
    try {
      if (deps.workspaceIndexForRoot === undefined) {
        throw new Error("production wiring did not build a workspaceIndexForRoot");
      }
      deps.workspaceIndexForRoot(workspaceRoot);

      expectRealServerLogSink("KEIKO_WORKSPACE_INDEX_KEY", "security.vault.key-resolved");
    } finally {
      deps.store.close();
      deps.memoryVault?.close();
    }
  });
});

describe("buildUiHandlerDeps — atlassianConnectorCredentials wires resolveLocalVaultKey's sink", () => {
  it("supplies a real server-log sink to the Atlassian custody vault's key resolution", () => {
    const uiDir = tmp("deps-atlassian-vaultkey-");
    const evidenceDir = tmp("deps-atlassian-vaultkey-ev-");
    const configDir = tmp("deps-atlassian-vaultkey-cfg-");
    const deps = buildUiHandlerDeps({
      configPath: join(configDir, "keiko.config.json"),
      evidenceDir,
      env: { KEIKO_UI_DATA_DIR: uiDir },
    });
    try {
      if (deps.atlassianConnectorCredentials === undefined) {
        throw new Error("production wiring did not build atlassianConnectorCredentials");
      }
      deps.atlassianConnectorCredentials.custody.create({
        provider: "jira",
        displayName: "Wiring Test Jira",
        baseUrl: "https://wiring-test.example.com",
        authScheme: "basic-api-token",
        accountEmail: "wiring-test@example.com",
        apiToken: ["synthetic", "wiring", "token", "0123456789"].join("-"),
      });

      expectRealServerLogSink(
        "KEIKO_ATLASSIAN_CONNECTOR_CREDENTIALS_KEY",
        "security.vault.key-resolved",
      );
    } finally {
      deps.store.close();
      deps.memoryVault?.close();
    }
  });
});

describe("buildUiHandlerDeps — provider-credential vault wires resolveLocalVaultKey's sink", () => {
  it("supplies a real server-log sink when migrating a plaintext config into the vault", () => {
    const uiDir = tmp("deps-credvault-vaultkey-");
    const evidenceDir = tmp("deps-credvault-vaultkey-ev-");
    const configPath = join(evidenceDir, "keiko.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        providers: [
          {
            modelId: "wiring-test-model",
            baseUrl: "https://wiring-test.example.invalid/openai/v1",
            apiKey: "plaintext-wiring-test-secret",
            timeoutMs: 30_000,
            maxRetries: 2,
            retryBaseDelayMs: 500,
          },
        ],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      }),
      "utf8",
    );

    const deps = buildUiHandlerDeps({
      configPath,
      evidenceDir,
      env: { KEIKO_UI_DATA_DIR: uiDir },
      store: createInMemoryUiStore(),
    });
    try {
      expectRealServerLogSink("KEIKO_PROVIDER_CREDENTIALS_KEY", "security.vault.key-resolved");
    } finally {
      deps.store.close();
      deps.memoryVault?.close();
    }
  });
});
