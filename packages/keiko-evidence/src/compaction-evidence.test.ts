import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_ENGINEERING_SCHEMA_VERSION,
  DEFAULT_CONTEXT_PROFILE,
  validateContextAssemblyDiagnostics,
  validateContextBudget,
  type ContextAssemblyDiagnostics,
  type ContextBudget,
  type ContextCompactionRecord,
} from "@oscharko-dev/keiko-contracts";
import {
  createInMemoryEvidenceStore,
  loadEvidence,
  persistCompactionEvidence,
  persistConnectedContextEvidence,
  type EvidenceManifest,
} from "./index.js";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  type ConnectedContextPack,
} from "@oscharko-dev/keiko-contracts/connected-context";

const NOW = 1_700_000_000_000;
const SK_FAKE = ["sk", "-live-fakeCompactionSecret1234567890abcdef"].join("");
const BEARER_FAKE = ["Bearer ", "fakeCompactionBearerToken1234567890abcdef"].join("");
const ABS_PATH = "/Users/secretuser/Projects/Keiko/packages/keiko-evidence/src/secret.ts";

function profileWithModelId(): ContextAssemblyDiagnostics["profile"] {
  return {
    ...DEFAULT_CONTEXT_PROFILE,
    tokenEstimatorId: `estimator-${SK_FAKE}`,
    model: { id: `model-${SK_FAKE}`, provider: "example", notes: `notes-${BEARER_FAKE}` },
  };
}

function assemblyDiagnostics(): ContextAssemblyDiagnostics {
  return {
    schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
    profile: profileWithModelId(),
    totalEstimatedTokens: 1234,
    budgetPressure: "moderate",
    orderedForRecency: true,
    lanes: [
      {
        laneId: "repo-evidence",
        estimatedTokens: 500,
        includedItems: 4,
        excludedItems: 1,
        budgetPressure: "low",
        compactionReason: `dropped ${SK_FAKE}`,
        provenanceCounts: { "repo-file": 3, "tool-result": 1 },
      },
    ],
  };
}

function compactionRecord(): ContextCompactionRecord {
  return {
    schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
    laneId: "history-summary",
    reason: "exceeded MAX_CONTEXT_MESSAGES",
    itemsBefore: 20,
    itemsAfter: 4,
    tokensBefore: 8000,
    tokensAfter: 1200,
    summaryRefHash: "abc123",
    preservedFacts: [
      {
        statement: `the api key is ${SK_FAKE}`,
        sourceRef: { kind: "repo-file", stableId: "atom-1", scopePath: ABS_PATH },
      },
    ],
    assumptions: [
      { statement: `inferred from ${BEARER_FAKE}`, rationale: "test name", confidence: "low" },
    ],
    commandOutcomes: [{ command: "run tests", exitCode: 0, summary: `leaked ${SK_FAKE}` }],
    invalidationKeys: [{ scopePath: ABS_PATH, contentHash: "deadbeef" }],
    decisions: [`chose ${SK_FAKE}`],
    filesInspected: [ABS_PATH],
  };
}

function pack(): ConnectedContextPack {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: "pack-1",
    scope: {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      scopeId: "scope-1",
      workspaceRoot: "/repo",
      kind: "files",
      relativePaths: ["src/a.ts"],
      conversationId: "chat-1",
      connectedAtMs: NOW,
    },
    query: {
      kind: "natural-language",
      text: "hi",
      caseSensitive: false,
      maxResults: 10,
      emittedAtMs: NOW,
    },
    budget: {
      searchCallsMax: 4,
      filesReadMax: 8,
      excerptBytesMax: 1024,
      modelInputTokensMax: 2048,
      modelOutputTokensMax: 512,
      elapsedMsMax: 30_000,
      rerankCallsMax: 1,
    },
    usage: {
      searchCalls: 1,
      filesRead: 1,
      excerptBytes: 10,
      modelInputTokens: 20,
      modelOutputTokens: 5,
      elapsedMs: 12,
      rerankCalls: 0,
    },
    files: [],
    omitted: [],
    uncertainty: [],
    emittedAtMs: NOW,
    ledgerRef: undefined,
  };
}

function happyBudget(): ContextBudget {
  return {
    schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
    profile: DEFAULT_CONTEXT_PROFILE,
    lanes: [
      {
        laneId: "repo-evidence",
        priority: 1,
        maxTokens: 1000,
        minReservedTokens: 0,
        eviction: "drop-oldest",
      },
    ],
  };
}

function requireManifest(manifest: EvidenceManifest | undefined): EvidenceManifest {
  if (manifest === undefined) {
    throw new Error("expected manifest");
  }
  return manifest;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("compaction evidence (ADR-0056 W2)", () => {
  it("Gate 4/5 — field+whole-object redaction removes secrets from the stored manifest JSON", () => {
    const store = createInMemoryEvidenceStore();
    const result = persistCompactionEvidence(
      {
        runId: "compaction-run-1",
        modelId: "example-model",
        workspaceRoot: ABS_PATH,
        chatIdHash: sha256Hex("chat-1"),
        records: [compactionRecord()],
        startedAt: NOW,
        finishedAt: NOW + 5,
      },
      { store, env: {}, additionalSecrets: [SK_FAKE] },
    );
    // The RETURNED manifest must be secret-clean too (Layer 1), not only the stored JSON (Layer 2).
    // The redactor strips known secret patterns + supplied additionalSecrets from every string
    // surface; it does NOT strip arbitrary relative scopePaths (those are deny-checked by contract).
    expect(JSON.stringify(result.manifest)).not.toContain(SK_FAKE);
    const json = store.get("compaction-run-1");
    expect(json).toBeDefined();
    const serialized = json ?? "";
    expect(serialized).not.toContain(SK_FAKE);
    expect(serialized).not.toContain("fakeCompactionBearerToken");
    expect(serialized).toContain("[REDACTED]");
  });

  it("Gate 4b — no raw absolute path appears in the stored manifest JSON", () => {
    const store = createInMemoryEvidenceStore();
    persistCompactionEvidence(
      {
        runId: "compaction-run-2",
        modelId: "example-model",
        workspaceRoot: ABS_PATH,
        records: [compactionRecord()],
        startedAt: NOW,
        finishedAt: NOW + 5,
      },
      { store, env: {}, additionalSecrets: [SK_FAKE, ABS_PATH] },
    );
    const serialized = store.get("compaction-run-2") ?? "";
    expect(serialized).not.toContain(ABS_PATH);
    expect(serialized).not.toContain("/Users/secretuser");
    const manifest = requireManifest(loadEvidence(store, "compaction-run-2"));
    expect(manifest.context?.workspaceRoot).toBe(
      `compaction-root-${sha256Hex(`[REDACTED]`).slice(0, 16)}`,
    );
    expect(manifest.compaction).toHaveLength(1);
  });

  it("loads back through loadEvidence with a defined compaction array", () => {
    const store = createInMemoryEvidenceStore();
    persistCompactionEvidence(
      {
        runId: "compaction-run-3",
        modelId: "example-model",
        records: [compactionRecord()],
        startedAt: NOW,
        finishedAt: NOW + 5,
      },
      { store, env: {} },
    );
    const manifest = requireManifest(loadEvidence(store, "compaction-run-3"));
    expect(manifest.compaction?.[0]?.laneId).toBe("history-summary");
    expect(manifest.compaction?.[0]?.itemsBefore).toBe(20);
    expect(manifest.context).toBeUndefined();
  });

  it("retention prunes beyond maxRuns", () => {
    const store = createInMemoryEvidenceStore();
    const policy = { maxRuns: 2 } as const;
    for (let i = 0; i < 4; i += 1) {
      persistCompactionEvidence(
        {
          runId: `compaction-retain-${String(i)}`,
          modelId: "example-model",
          records: [compactionRecord()],
          startedAt: NOW + i,
          finishedAt: NOW + i + 1,
        },
        { store, env: {}, retention: policy },
      );
    }
    expect(store.list()).toHaveLength(2);
    expect(store.list()).toEqual(["compaction-retain-2", "compaction-retain-3"]);
  });
});

describe("connected-context evidence contextAssembly (ADR-0056 W2 Gate 3)", () => {
  it("persists a redacted, valid contextAssembly when present", () => {
    const store = createInMemoryEvidenceStore();
    persistConnectedContextEvidence(
      {
        runId: "grounded-ca-1",
        modelId: "example-model",
        workspaceRoot: "/repo",
        pack: pack(),
        contextAssembly: assemblyDiagnostics(),
        citationCount: 0,
        elapsedMs: 5,
        startedAt: NOW,
        finishedAt: NOW + 5,
      },
      { store, env: {}, additionalSecrets: [SK_FAKE, BEARER_FAKE] },
    );
    const manifest = requireManifest(loadEvidence(store, "grounded-ca-1"));
    const assembly = manifest.contextAssembly;
    expect(assembly).toBeDefined();
    if (assembly === undefined) {
      throw new Error("expected contextAssembly");
    }
    expect(validateContextAssemblyDiagnostics(assembly).ok).toBe(true);
    expect(validateContextBudget(happyBudget()).ok).toBe(true);
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain(SK_FAKE);
    expect(serialized).not.toContain("fakeCompactionBearerToken");
    expect(assembly.profile.tokenEstimatorId).toContain("[REDACTED]");
    expect(assembly.lanes[0]?.compactionReason).toContain("[REDACTED]");
  });

  it("omits contextAssembly when absent", () => {
    const store = createInMemoryEvidenceStore();
    persistConnectedContextEvidence(
      {
        runId: "grounded-ca-2",
        modelId: "example-model",
        workspaceRoot: "/repo",
        pack: pack(),
        citationCount: 0,
        elapsedMs: 5,
        startedAt: NOW,
        finishedAt: NOW + 5,
      },
      { store, env: {} },
    );
    const manifest = requireManifest(loadEvidence(store, "grounded-ca-2"));
    expect(manifest.contextAssembly).toBeUndefined();
  });
});
