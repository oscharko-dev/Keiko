import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type { MemoryId, MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";
import { buildRedactor } from "../index.js";
import type { UiHandlerDeps } from "../index.js";
import {
  runLocalKnowledgeProvider,
  runMemoryProvider,
  runRepoSearchProvider,
  type ProviderContext,
} from "./codingContextProviders.js";
import { buildLocalKnowledgeScope } from "./localKnowledgeRetrieval.js";

const tmpDirs: string[] = [];
const vaults: MemoryVaultStore[] = [];

function makeVault(): MemoryVaultStore {
  const dir = mkdtempSync(join(tmpdir(), "keiko-cc-mem-"));
  tmpDirs.push(dir);
  const vault = createMemoryVault({ memoryDir: dir, redactString: (s) => s });
  vaults.push(vault);
  return vault;
}

function insertUserMemory(vault: MemoryVaultStore, body: string): MemoryRecord {
  const now = 1_700_000_000_000;
  const record = {
    id: `mem-${body.length.toString(36)}` as unknown as MemoryId,
    schemaVersion: "1",
    scope: { kind: "user", userId: "local-operator" },
    type: "preference",
    body,
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: now,
      confidence: 0.9,
      sensitivity: "public",
    },
    validity: { validFrom: now - 1000 },
    status: "accepted",
    pinned: false,
    tags: [],
    createdAt: now,
    updatedAt: now,
  } as unknown as MemoryRecord;
  return vault.insertMemory(record);
}

function baseDeps(overrides: Partial<UiHandlerDeps> = {}): UiHandlerDeps {
  return {
    redactor: buildRedactor({}),
    env: {},
    config: undefined,
    ...overrides,
  } as unknown as UiHandlerDeps;
}

function providerCtx(overrides: Partial<ProviderContext> = {}): ProviderContext {
  return {
    deps: baseDeps(),
    realRoot: "/tmp/does-not-exist",
    signal: new AbortController().signal,
    maxBytesPerExcerpt: 8192,
    nowMs: 1_700_000_000_000,
    ...overrides,
  };
}

afterEach(() => {
  for (const vault of vaults.splice(0)) {
    vault.close();
  }
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildLocalKnowledgeScope", () => {
  it("builds a capsule scope, a capsule-set scope, or undefined", () => {
    expect(buildLocalKnowledgeScope("c1", undefined)).toMatchObject({
      kind: "capsule",
      capsuleId: "c1",
    });
    expect(buildLocalKnowledgeScope(undefined, "s1")).toMatchObject({
      kind: "capsule-set",
      capsuleSetId: "s1",
    });
    expect(buildLocalKnowledgeScope(undefined, undefined)).toBeUndefined();
  });
});

describe("runLocalKnowledgeProvider", () => {
  it("omits as unavailable when no query is supplied", async () => {
    const outcome = await runLocalKnowledgeProvider(providerCtx(), {
      queryText: undefined,
      capsuleId: "c1",
      capsuleSetId: undefined,
    });
    expect(outcome.excerpts).toHaveLength(0);
    expect(outcome.omission).toEqual({ sourceKind: "local-knowledge", reason: "unavailable" });
  });

  it("omits as unavailable when no capsule scope is supplied", async () => {
    const outcome = await runLocalKnowledgeProvider(providerCtx(), {
      queryText: "q",
      capsuleId: undefined,
      capsuleSetId: undefined,
    });
    expect(outcome.omission).toEqual({ sourceKind: "local-knowledge", reason: "unavailable" });
  });
});

describe("runMemoryProvider", () => {
  it("omits as unavailable when no vault is configured", async () => {
    const outcome = await runMemoryProvider(providerCtx(), { queryText: undefined });
    expect(outcome.omission).toEqual({ sourceKind: "memory", reason: "unavailable" });
  });

  it("returns redacted memory excerpts from the reused retrieveMemoryContext path", async () => {
    const vault = makeVault();
    insertUserMemory(vault, "Always prefer TypeScript strict mode in editor coding context.");
    const ctx = providerCtx({ deps: baseDeps({ memoryVault: vault }) });
    const outcome = await runMemoryProvider(ctx, { queryText: undefined });
    expect(outcome.omission).toBeUndefined();
    expect(outcome.excerpts.length).toBeGreaterThan(0);
    expect(outcome.excerpts[0]?.sourceKind).toBe("memory");
    expect(outcome.excerpts[0]?.text).toContain("TypeScript strict mode");
  });
});

describe("runRepoSearchProvider", () => {
  it("returns no excerpts and a repo-search omission when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await runRepoSearchProvider(providerCtx({ signal: controller.signal }), {
      documentPath: "src/a.ts",
      symbol: undefined,
      queryText: undefined,
      changedFiles: undefined,
    });
    expect(outcome.excerpts).toHaveLength(0);
    expect(outcome.omission).toEqual({ sourceKind: "repo-search", reason: "unavailable" });
  });

  it("omits files-focus as denied when the active document cannot be read", async () => {
    const outcome = await runRepoSearchProvider(providerCtx(), {
      documentPath: "src/missing.ts",
      symbol: undefined,
      queryText: undefined,
      changedFiles: undefined,
    });
    expect(outcome.omission).toEqual({ sourceKind: "files-focus", reason: "denied" });
  });
});
