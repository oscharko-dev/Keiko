// Model-independence & reproducibility matrix (Epic #761, Issue #764).
//
// A unit matrix (fake gateway — no network) proving the three #761 guarantees:
//   1. Capability routing: QI picks a model purely by capability; an unsatisfiable capability set
//      yields the typed QI_CAPABILITY_UNAVAILABLE error (graceful, 0 model calls).
//   2. Deterministic baseline: structural stages run model-free; candidate ids are content-hashed.
//   3. Reproducibility: identical inputs → identical candidate ids, regardless of the model tier.
//
// See docs/epic-761-determinism-matrix.md for the capability × outcome table this pins.

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
import { selectModelForQiCapability } from "../modelSelection.js";
import { QiGenerationError } from "../generationPort.js";

// ─── Capability matrix ─────────────────────────────────────────────────────────

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
  readonly expectModel: string | null;
}

const MATRIX: readonly MatrixRow[] = [
  {
    label: "chat + structured-output (high tier)",
    caps: [capability("tier-high", { structuredOutput: true, costClass: "high" })],
    expectModel: "tier-high",
  },
  {
    label: "chat + structured-output (low tier preferred over high)",
    caps: [
      capability("tier-high", { structuredOutput: true, costClass: "high" }),
      capability("tier-low", { structuredOutput: true, costClass: "low" }),
    ],
    expectModel: "tier-low",
  },
  {
    label: "chat-only (no structured-output) → unavailable",
    caps: [capability("chat-only", { structuredOutput: false })],
    expectModel: null,
  },
  {
    label: "no model configured → unavailable",
    caps: undefined,
    expectModel: null,
  },
];

describe("Epic #761 capability matrix", () => {
  for (const row of MATRIX) {
    it(`routes qi:test-design for: ${row.label}`, () => {
      const deps = depsWith(row.caps === undefined ? undefined : configWith(row.caps));
      if (row.expectModel === null) {
        try {
          selectModelForQiCapability(deps, "qi:test-design");
          expect.fail("should have thrown QI_CAPABILITY_UNAVAILABLE");
        } catch (err) {
          expect(err).toBeInstanceOf(QiGenerationError);
          expect((err as QiGenerationError).code).toBe("QI_CAPABILITY_UNAVAILABLE");
        }
      } else {
        expect(selectModelForQiCapability(deps, "qi:test-design")).toBe(row.expectModel);
      }
    });
  }
});

// ─── Reproducibility (deterministic content-hashed ids) ──────────────────────────

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
  modelId: string,
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
      generate: () => Promise.resolve({ rawText: MODEL_OUTPUT, modelCallCount: 1, modelId }),
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
    // Same run id + same inputs, two different "model tiers" — ids are content-hashed, not model-dependent.
    const a = await runQualityIntelligenceModelRoutedTestDesign(
      runInput("qi-run-repro-001"),
      fixedGenerateDeps(createInMemoryQualityIntelligenceLocalStore(), "tier-high", idsA),
    );
    const b = await runQualityIntelligenceModelRoutedTestDesign(
      runInput("qi-run-repro-001"),
      fixedGenerateDeps(createInMemoryQualityIntelligenceLocalStore(), "tier-low", idsB),
    );
    expect(a.status).toBe("succeeded");
    expect(b.status).toBe("succeeded");
    expect(idsA.length).toBeGreaterThan(0);
    expect(idsA).toEqual(idsB);
  });

  it("records the generating model id and a null seed in evidence", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const summary = await runQualityIntelligenceModelRoutedTestDesign(
      runInput("qi-run-repro-002"),
      fixedGenerateDeps(store, "tier-high"),
    );
    expect(summary.status).toBe("succeeded");
    const manifest = store.load("qi-run-repro-002");
    expect(manifest?.modelId).toBe("tier-high");
    expect(manifest?.seedUsed).toBeNull();
  });

  it("keeps a deterministic baseline (no judge → run still succeeds, qualityScore null)", async () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    const summary = await runQualityIntelligenceModelRoutedTestDesign(
      runInput("qi-run-repro-003"),
      fixedGenerateDeps(store, "tier-high"),
    );
    expect(summary.status).toBe("succeeded");
    expect(summary.qualityScore).toBeNull();
  });
});
