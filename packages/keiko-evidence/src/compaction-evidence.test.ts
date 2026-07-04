import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_COMPACTION_MODEL_SUMMARY_PROMPT_VERSION,
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
const POSIX_SPACE_PATH = "/Users/Alice Smith/Secret Project/src/file.ts";
const WIN_DRIVE_PATH = "C:\\Users\\secretuser\\Projects\\Keiko\\src\\secret.ts";
const WIN_FORWARD_DRIVE_PATH = "D:/Users/secretuser/Projects/Keiko/src/secret.ts";
const WIN_UNC_PATH = "\\\\server\\share\\secret\\file.ts";

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

function fullCompactionRecord(): ContextCompactionRecord {
  const fullRef = {
    kind: "repo-file" as const,
    stableId: `stable-${SK_FAKE}`,
    scopePath: ABS_PATH,
    lineRange: { startLine: 7, endLine: 12 },
    contentHash: `content-${SK_FAKE}`,
    evidenceAtomId: `atom-${SK_FAKE}`,
    notPersistedReason: `not persisted because ${SK_FAKE}`,
  };
  return {
    ...compactionRecord(),
    laneId: "repo-evidence",
    rehydration: {
      schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
      laneId: "repo-evidence",
      handleId: `handle-${SK_FAKE}`,
      itemCount: 2,
      approxTokens: 144,
      kind: "repo-file",
      scopePath: ABS_PATH,
      lineRange: { startLine: 7, endLine: 12 },
      contentHash: `excerpt-${SK_FAKE}`,
      evidenceAtomId: `rehydrate-atom-${SK_FAKE}`,
      notPersistedReason: `artifact not persisted ${SK_FAKE}`,
      approvedSummary: `approved ${BEARER_FAKE}`,
    },
    sourceSpans: [
      fullRef,
      {
        kind: "tool-result",
        stableId: `tool-${SK_FAKE}`,
        notPersistedReason: `dropped ${SK_FAKE}`,
      },
    ],
    preservedFacts: [
      {
        statement: `full fact ${SK_FAKE}`,
        sourceRef: fullRef,
        inferred: true,
        corroborating: [fullRef],
      },
      { statement: `inferred only ${SK_FAKE}`, inferred: false },
    ],
    userConstraints: [
      { statement: `constraint ${SK_FAKE}`, sourceRef: fullRef },
      { statement: `constraint without source ${SK_FAKE}` },
    ],
    openQuestions: [`question ${SK_FAKE}`],
    filesChanged: [ABS_PATH],
    failingTests: [`failed ${SK_FAKE}`],
    droppedCategories: [`noise ${SK_FAKE}`],
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

function requireFirstCompaction(manifest: EvidenceManifest): ContextCompactionRecord {
  const record = manifest.compaction?.[0];
  if (record === undefined) {
    throw new Error("expected compaction record");
  }
  return record;
}

function persistFullCompactionEvidence(): {
  readonly store: ReturnType<typeof createInMemoryEvidenceStore>;
  readonly manifest: EvidenceManifest;
} {
  const store = createInMemoryEvidenceStore();
  persistCompactionEvidence(
    {
      runId: "compaction-run-full",
      modelId: "example-model",
      records: [fullCompactionRecord()],
      startedAt: NOW,
      finishedAt: NOW + 5,
    },
    { store, env: {}, additionalSecrets: [SK_FAKE, BEARER_FAKE, ABS_PATH] },
  );
  return { store, manifest: requireManifest(loadEvidence(store, "compaction-run-full")) };
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
    // surface; absolute paths are also path-redacted so caller-provided secret hints are not required.
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

  it("redacts POSIX absolute paths containing spaces in model summaries", () => {
    const store = createInMemoryEvidenceStore();
    persistCompactionEvidence(
      {
        runId: "compaction-run-posix-space-path",
        modelId: "example-model",
        records: [
          {
            ...compactionRecord(),
            modelSummary: {
              promptVersion: CONTEXT_COMPACTION_MODEL_SUMMARY_PROMPT_VERSION,
              modelId: "summary-model",
              status: "valid",
              validationState: "accepted",
              content: `Continue from ${POSIX_SPACE_PATH}`,
              filesAndSymbols: [`${POSIX_SPACE_PATH} parseStructuredSummary`],
            },
          },
        ],
        startedAt: NOW,
        finishedAt: NOW + 5,
      },
      { store, env: {} },
    );

    const serialized = store.get("compaction-run-posix-space-path") ?? "";
    expect(serialized).toContain("[REDACTED_PATH]");
    expect(serialized).not.toContain("/Users/Alice");
    expect(serialized).not.toContain("Secret Project/src/file.ts");
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
    const serialized = store.get("compaction-run-3") ?? "";
    expect(serialized).not.toContain(ABS_PATH);
    expect(serialized).not.toContain("/Users/secretuser");
    expect(serialized).toContain("[REDACTED_PATH]");
    const manifest = requireManifest(loadEvidence(store, "compaction-run-3"));
    expect(JSON.stringify(manifest)).not.toContain(ABS_PATH);
    expect(manifest.compaction?.[0]?.laneId).toBe("history-summary");
    expect(manifest.compaction?.[0]?.itemsBefore).toBe(20);
    expect(manifest.context).toBeUndefined();
  });

  it("redacts Windows absolute path forms without caller-provided secret hints", () => {
    const store = createInMemoryEvidenceStore();
    persistCompactionEvidence(
      {
        runId: "compaction-run-windows-paths",
        modelId: "example-model",
        records: [
          {
            ...compactionRecord(),
            preservedFacts: [
              { statement: `drive path ${WIN_DRIVE_PATH}` },
              { statement: `forward drive path ${WIN_FORWARD_DRIVE_PATH}` },
              { statement: `unc path ${WIN_UNC_PATH}` },
            ],
            sourceSpans: [
              { kind: "repo-file", stableId: "drive", scopePath: WIN_DRIVE_PATH },
              {
                kind: "repo-file",
                stableId: "forward-drive",
                scopePath: WIN_FORWARD_DRIVE_PATH,
              },
              { kind: "repo-file", stableId: "unc", scopePath: WIN_UNC_PATH },
            ],
            filesInspected: [WIN_DRIVE_PATH, WIN_FORWARD_DRIVE_PATH, WIN_UNC_PATH],
          },
        ],
        startedAt: NOW,
        finishedAt: NOW + 5,
      },
      { store, env: {} },
    );
    const serialized = store.get("compaction-run-windows-paths") ?? "";
    expect(serialized).not.toContain(WIN_DRIVE_PATH);
    expect(serialized).not.toContain(WIN_FORWARD_DRIVE_PATH);
    expect(serialized).not.toContain(WIN_UNC_PATH);
    expect(serialized).not.toContain("C:\\Users\\secretuser");
    expect(serialized).not.toContain("D:/Users/secretuser");
    expect(serialized).not.toContain("\\\\server\\share");
    expect(serialized).toContain("[REDACTED_PATH]");
  });

  it("redacts optional provenance and rehydration fields in serialized evidence", () => {
    const { store, manifest } = persistFullCompactionEvidence();
    const serialized = store.get("compaction-run-full") ?? "";
    expect(serialized).not.toContain(SK_FAKE);
    expect(serialized).not.toContain("fakeCompactionBearerToken");
    expect(serialized).not.toContain(ABS_PATH);
    const record = requireFirstCompaction(manifest);
    const firstSpan = record.sourceSpans?.[0];
    expect(firstSpan?.lineRange).toEqual({ startLine: 7, endLine: 12 });
    expect(record.rehydration?.approvedSummary).toContain("[REDACTED]");
  });

  it("redacts optional constraints and string-array fields in loaded evidence", () => {
    const { manifest } = persistFullCompactionEvidence();
    const record = requireFirstCompaction(manifest);
    expect(record.userConstraints).toHaveLength(2);
    expect(record.openQuestions?.[0]).toContain("[REDACTED]");
    expect(record.filesChanged?.[0]).toContain("[REDACTED]");
    expect(record.failingTests?.[0]).toContain("[REDACTED]");
    expect(record.droppedCategories?.[0]).toContain("[REDACTED]");
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

  it("persists contextAssembly with optional model, reason, and provenance fields omitted", () => {
    const store = createInMemoryEvidenceStore();
    persistConnectedContextEvidence(
      {
        runId: "grounded-ca-minimal",
        modelId: "example-model",
        workspaceRoot: "/repo",
        pack: pack(),
        contextAssembly: {
          schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
          profile: { ...DEFAULT_CONTEXT_PROFILE, tokenEstimatorId: `plain-${SK_FAKE}` },
          totalEstimatedTokens: 12,
          budgetPressure: "low",
          orderedForRecency: false,
          lanes: [
            {
              laneId: "repo-evidence",
              estimatedTokens: 12,
              includedItems: 1,
              excludedItems: 0,
              budgetPressure: "low",
            },
          ],
        },
        citationCount: 0,
        elapsedMs: 5,
        startedAt: NOW,
        finishedAt: NOW + 5,
      },
      { store, env: {}, additionalSecrets: [SK_FAKE] },
    );
    const manifest = requireManifest(loadEvidence(store, "grounded-ca-minimal"));
    const assembly = manifest.contextAssembly;
    expect(assembly?.profile.model).toBeUndefined();
    expect(assembly?.lanes[0]?.compactionReason).toBeUndefined();
    expect(assembly?.lanes[0]?.provenanceCounts).toBeUndefined();
    expect(JSON.stringify(assembly)).not.toContain(SK_FAKE);
  });
});
