// Model-independence & reproducibility matrix (Epic #761, Issue #764).
//
// A unit matrix (fake gateway — no network) proving the updated #761 guarantees:
//   1. Capability routing prefers structured-output chat models, degrades to chat-only, then
//      deterministic no-model baseline.
//   2. Deterministic baseline: structural stages run model-free; candidate ids are content-hashed.
//   3. Reproducibility: identical inputs → identical candidate ids, and explicit seeds are persisted
//      only when actually applied.

import { describe, expect, it } from "vitest";
import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import { parseGatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import type { ModelCapability } from "@oscharko-dev/keiko-model-gateway";
import {
  createInMemoryQualityIntelligenceLocalStore,
  type EvidenceStore,
  type QualityIntelligenceEvidenceManifest,
} from "@oscharko-dev/keiko-evidence";
import { buildRedactor, createRunRegistry } from "../../index.js";
import { createInMemoryUiStore } from "../../store/index.js";
import {
  runQualityIntelligenceModelRoutedTestDesign,
  type QualityIntelligenceModelRoutedTestDesignDeps,
  type QualityIntelligenceModelRoutedTestDesignInput,
} from "@oscharko-dev/keiko-workflows";
import type { UiHandlerDeps } from "../../deps.js";
import { resolveQiTestDesignSelection } from "../modelSelection.js";

function capability(id: string, overrides: Partial<ModelCapability>): ModelCapability {
  return {
    id,
    kind: "chat",
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: true,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "test",
    preferredUseCases: ["Chat"],
    knownLimitations: [],
    ...overrides,
  };
}

function configWith(caps: readonly ModelCapability[]): ReturnType<typeof parseGatewayConfig> {
  return parseGatewayConfig(
    {
      providers: caps.map((c) => ({
        modelId: c.id,
        baseUrl: "https://fake.example.com/v1",
        apiKey: "fake-key",
        capability: c,
      })),
    },
    {},
  );
}

function emptyStore(): EvidenceStore {
  return { put: () => "", list: () => [], get: () => undefined, delete: () => undefined };
}

function depsWith(config: ReturnType<typeof parseGatewayConfig> | undefined): UiHandlerDeps {
  return {
    config,
    configPresent: config !== undefined,
    evidenceStore: emptyStore(),
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
  };
}

interface MatrixRow {
  readonly label: string;
  readonly caps: readonly ModelCapability[] | undefined;
  readonly expected:
    | { readonly kind: "baseline" }
    | { readonly kind: "model"; readonly modelId: string; readonly structuredOutput: boolean };
}

const MATRIX: readonly MatrixRow[] = [
  {
    label: "chat + structured-output (single tier)",
    caps: [capability("tier-high", { structuredOutput: true, costClass: "high" })],
    expected: { kind: "model", modelId: "tier-high", structuredOutput: true },
  },
  {
    label: "chat + structured-output (preferred over cheaper chat-only)",
    caps: [
      capability("tier-chat-only", { structuredOutput: false, costClass: "low" }),
      capability("tier-structured", { structuredOutput: true, costClass: "medium" }),
    ],
    expected: { kind: "model", modelId: "tier-structured", structuredOutput: true },
  },
  {
    label: "chat-only (no structured-output) → tolerant parser path",
    caps: [capability("chat-only", { structuredOutput: false })],
    expected: { kind: "model", modelId: "chat-only", structuredOutput: false },
  },
  {
    label: "no model configured → baseline",
    caps: undefined,
    expected: { kind: "baseline" },
  },
];

describe("Epic #761 capability matrix", () => {
  for (const row of MATRIX) {
    it(`routes qi:test-design for: ${row.label}`, () => {
      const selection = resolveQiTestDesignSelection(
        depsWith(row.caps === undefined ? undefined : configWith(row.caps)),
      );
      expect(selection.kind).toBe(row.expected.kind);
      if (row.expected.kind === "baseline") {
        expect(selection).toEqual({ kind: "baseline" });
      } else if (selection.kind === "model") {
        expect(selection.modelId).toBe(row.expected.modelId);
        expect(selection.capability.structuredOutput).toBe(row.expected.structuredOutput);
      }
    });
  }
});

function makeAtom(id: string): QualityIntelligence.QualityIntelligenceEvidenceAtom {
  return {
    id: QualityIntelligence.asQualityIntelligenceEvidenceAtomId(id),
    kind: "requirement",
    sourceEnvelopeId: QualityIntelligence.asQualityIntelligenceSourceEnvelopeId("env-1"),
    canonicalHashSha256Hex: "a".repeat(64),
    redactionStatus: "not-required",
    lifecycleStatus: "draft",
  };
}

const MODEL_OUTPUT = JSON.stringify([
  {
    title: "Login succeeds with valid credentials",
    steps: ["Enter email", "Enter password", "Submit"],
    expectedResults: ["User reaches dashboard"],
    derivedFromEvidenceIndexes: [1],
  },
  {
    title: "Login rejected with invalid password",
    steps: ["Enter email", "Enter wrong password", "Submit"],
    expectedResults: ["Error is shown"],
    derivedFromEvidenceIndexes: [1],
  },
]);

function fixedGenerateDeps(
  store: ReturnType<typeof createInMemoryQualityIntelligenceLocalStore>,
  result: {
    readonly rawText: string;
    readonly modelCallCount: number;
    readonly modelId?: string | undefined;
    readonly seedUsed?: number | null;
    readonly modelParameters?: Record<string, unknown> | undefined;
  },
  capturedIds?: string[],
): QualityIntelligenceModelRoutedTestDesignDeps {
  return {
    sink: { emit: () => undefined },
    evidenceStore: store,
    candidatesSink: {
      record: (cands): void => {
        if (capturedIds !== undefined) capturedIds.push(...cands.map((c) => String(c.id)));
      },
    },
    generate: {
      generate: () => Promise.resolve(result),
    },
    clock: { nowIso: () => "2026-06-09T00:00:00.000Z" },
  };
}

function runInput(runId: string): QualityIntelligenceModelRoutedTestDesignInput {
  return {
    plan: {
      id: QualityIntelligence.asQualityIntelligenceRunId(runId),
      requestedAt: "2026-06-09T00:00:00.000Z",
      plannerKind: "model-routed",
      stages: [],
    },
    envelopes: [],
    ingestedAtoms: [{ atom: makeAtom("atom-1"), canonicalText: "The system shall allow login." }],
    provenanceRefs: {
      envelopeIds: ["env-1"],
      auditSummaryId:
        "audit-matrix-001" as QualityIntelligenceEvidenceManifest["provenanceRefs"]["auditSummaryId"],
    },
  };
}

describe("Epic #761 reproducibility", () => {
  it("produces identical candidate ids for identical inputs across model tiers", async () => {
    const idsA: string[] = [];
    const idsB: string[] = [];
    const a = await runQualityIntelligenceModelRoutedTestDesign(
      runInput("qi-run-repro-001"),
      fixedGenerateDeps(
        createInMemoryQualityIntelligenceLocalStore(),
        { rawText: MODEL_OUTPUT, modelCallCount: 1, modelId: "tier-high", seedUsed: null },
        idsA,
      ),
    );
    const b = await runQualityIntelligenceModelRoutedTestDesign(
      runInput("qi-run-repro-001"),
      fixedGenerateDeps(
        createInMemoryQualityIntelligenceLocalStore(),
        { rawText: MODEL_OUTPUT, modelCallCount: 1, modelId: "tier-low", seedUsed: null },
        idsB,
      ),
    );
    expect(a.status).toBe("succeeded");
    expect(b.status).toBe("succeeded");
    expect(idsA.length).toBeGreaterThan(0);
    expect(idsA).toEqual(idsB);
  });

  it("records the generating model id and a null seed for unseeded model runs", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const summary = await runQualityIntelligenceModelRoutedTestDesign(
      runInput("qi-run-repro-002"),
      fixedGenerateDeps(store, {
        rawText: MODEL_OUTPUT,
        modelCallCount: 1,
        modelId: "tier-high",
        seedUsed: null,
      }),
    );
    expect(summary.status).toBe("succeeded");
    const manifest = store.load("qi-run-repro-002");
    expect(manifest?.modelId).toBe("tier-high");
    expect(manifest?.seedUsed).toBeNull();
  });

  it("records an explicit seed only when the model path applied one", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const summary = await runQualityIntelligenceModelRoutedTestDesign(
      runInput("qi-run-repro-003"),
      fixedGenerateDeps(store, {
        rawText: MODEL_OUTPUT,
        modelCallCount: 1,
        modelId: "seeded-tier",
        seedUsed: 11,
        modelParameters: { seed: 11 },
      }),
    );
    expect(summary.status).toBe("succeeded");
    const manifest = store.load("qi-run-repro-003");
    expect(manifest?.seedUsed).toBe(11);
    expect(manifest?.modelParameters?.seed).toBe(11);
  });

  it("keeps a deterministic baseline with no model attribution", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const summary = await runQualityIntelligenceModelRoutedTestDesign(
      runInput("qi-run-repro-004"),
      fixedGenerateDeps(store, {
        rawText: JSON.stringify({ testCases: [] }),
        modelCallCount: 0,
      }),
    );
    expect(summary.status).toBe("succeeded");
    expect(summary.modelGatewayCallCount).toBe(0);
    expect(summary.qualityScore).toBeNull();
    const manifest = store.load("qi-run-repro-004");
    expect(manifest?.modelId).toBeUndefined();
    expect(manifest?.seedUsed).toBeUndefined();
  });
});
