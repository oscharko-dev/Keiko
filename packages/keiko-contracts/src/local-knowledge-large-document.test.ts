import { describe, expect, it } from "vitest";

import type {
  ChunkId,
  CheckpointFingerprint,
  EmbeddingModelIdentity,
  ExtractionCheckpointRecord,
  LargeDocumentResourcePolicy,
} from "./index.js";
import {
  CHECKPOINT_INCOMPATIBILITY_REASONS,
  COVERAGE_QUALITIES,
  DEFAULT_EXTRACTION_CAPABILITY_AVAILABILITY,
  DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY,
  EXTRACTION_CAPABILITY_STATUSES,
  EXTRACTION_PHASES,
  LARGE_DOCUMENT_DIAGNOSTIC_CODES,
  LARGE_DOCUMENT_EXTRACTION_STRATEGIES,
  LARGE_DOCUMENT_RESUME_CHOICES,
  TERMINAL_EXTRACTION_PHASES,
  capabilityContributesCoverage,
  checkpointCompatibility,
  isTerminalExtractionPhase,
  largeDocumentPolicyFingerprint,
} from "./local-knowledge-large-document.js";
import {
  validateExtractionCheckpointRecord,
  validateLargeDocumentResourcePolicy,
} from "./local-knowledge-large-document-validation.js";

const IDENTITY: EmbeddingModelIdentity = {
  provider: "keiko",
  modelId: "embed-1",
  vectorDimensions: 1536,
  vectorMetric: "cosine",
};

function baseFingerprint(): CheckpointFingerprint {
  return {
    sourceContentHash: "abc123",
    parserVersion: "progressive-pdf@1",
    policyFingerprint: largeDocumentPolicyFingerprint(DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY),
    chunkingStrategyVersion: "chunker@2",
    embeddingIdentity: IDENTITY,
  };
}

function baseCheckpoint(): ExtractionCheckpointRecord {
  return {
    capsuleId: "cap-1" as ExtractionCheckpointRecord["capsuleId"],
    documentId: "doc-1" as ExtractionCheckpointRecord["documentId"],
    jobId: "job-1",
    strategy: "progressive-pdf",
    phase: "embedding",
    pageCursor: 12,
    sectionCursor: 0,
    objectCursor: 4096,
    extractedTextBytes: 65_536,
    chunkCursor: 40,
    embeddedChunkCursor: 24,
    lastEmbeddedChunkId: "doc-1#u3#24" as ChunkId,
    retryCount: 1,
    coverage: "partial",
    fingerprint: baseFingerprint(),
    terminalDiagnostics: [],
    createdAt: 1,
    updatedAt: 2,
  };
}

describe("DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY", () => {
  it("validates and separates every bounded dimension", () => {
    const result = validateLargeDocumentResourcePolicy(DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY);
    expect(result.ok).toBe(true);
    const policy = DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY;
    // Raw bytes, extracted text bytes, and the large-file threshold are distinct dimensions.
    expect(policy.maxRawFileBytes).toBeGreaterThan(policy.maxExtractedTextBytes);
    expect(policy.largeFileThresholdBytes).toBeLessThan(policy.maxRawFileBytes);
    expect(policy.maxParserObjects).toBeGreaterThan(policy.maxChunkCount);
  });

  it("is frozen so callers cannot mutate shared defaults", () => {
    expect(Object.isFrozen(DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY)).toBe(true);
  });
});

describe("largeDocumentPolicyFingerprint", () => {
  it("is stable for equal policies and changes when any dimension changes", () => {
    const a = largeDocumentPolicyFingerprint(DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY);
    const b = largeDocumentPolicyFingerprint({ ...DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY });
    expect(a).toBe(b);
    const changed = largeDocumentPolicyFingerprint({
      ...DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY,
      maxChunkCount: DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY.maxChunkCount + 1,
    });
    expect(changed).not.toBe(a);
  });
});

describe("validateLargeDocumentResourcePolicy", () => {
  it("rejects a non-object", () => {
    expect(validateLargeDocumentResourcePolicy(null).ok).toBe(false);
    expect(validateLargeDocumentResourcePolicy(42).ok).toBe(false);
  });

  it("rejects a non-positive bounded dimension", () => {
    const result = validateLargeDocumentResourcePolicy({
      ...DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY,
      maxExtractedTextBytes: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("maxExtractedTextBytes"))).toBe(true);
    }
  });

  it("allows maxRetryCount of zero (retries disabled)", () => {
    const result = validateLargeDocumentResourcePolicy({
      ...DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY,
      maxRetryCount: 0,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a large-file threshold above the raw byte ceiling", () => {
    const result = validateLargeDocumentResourcePolicy({
      ...DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY,
      largeFileThresholdBytes: DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY.maxRawFileBytes + 1,
    });
    expect(result.ok).toBe(false);
  });
});

describe("checkpointCompatibility", () => {
  it("accepts an identical fingerprint", () => {
    expect(checkpointCompatibility(baseFingerprint(), baseFingerprint())).toEqual({
      compatible: true,
    });
  });

  const mutations: readonly [string, (f: CheckpointFingerprint) => CheckpointFingerprint][] = [
    ["source-hash", (f): CheckpointFingerprint => ({ ...f, sourceContentHash: "deadbeef" })],
    ["parser-version", (f): CheckpointFingerprint => ({ ...f, parserVersion: "x@2" })],
    ["resource-policy", (f): CheckpointFingerprint => ({ ...f, policyFingerprint: "ldp1:0" })],
    ["chunking-strategy", (f): CheckpointFingerprint => ({ ...f, chunkingStrategyVersion: "z@9" })],
    [
      "embedding-identity",
      (f): CheckpointFingerprint => ({
        ...f,
        embeddingIdentity: { ...IDENTITY, vectorDimensions: 3072 },
      }),
    ],
  ];
  it.each(mutations)("refuses on a %s mismatch", (reason, mutate) => {
    const result = checkpointCompatibility(baseFingerprint(), mutate(baseFingerprint()));
    expect(result.compatible).toBe(false);
    if (!result.compatible) {
      expect(result.reasons).toContain(reason);
    }
  });

  it("treats a model revision change as an embedding-identity mismatch", () => {
    const stored = baseFingerprint();
    const current: CheckpointFingerprint = {
      ...stored,
      embeddingIdentity: { ...IDENTITY, modelRevision: "2026-06" },
    };
    const result = checkpointCompatibility(stored, current);
    expect(result.compatible).toBe(false);
  });

  it("enumerates the closed set of incompatibility reasons", () => {
    expect([...CHECKPOINT_INCOMPATIBILITY_REASONS].sort()).toEqual(
      [
        "chunking-strategy",
        "embedding-identity",
        "parser-version",
        "resource-policy",
        "source-hash",
      ].sort(),
    );
  });
});

describe("validateExtractionCheckpointRecord", () => {
  it("accepts a well-formed checkpoint", () => {
    expect(validateExtractionCheckpointRecord(baseCheckpoint()).ok).toBe(true);
  });

  it("accepts a checkpoint without lastEmbeddedChunkId", () => {
    const rest: Record<string, unknown> = { ...baseCheckpoint() };
    delete rest.lastEmbeddedChunkId;
    expect(validateExtractionCheckpointRecord(rest).ok).toBe(true);
  });

  it("rejects a negative cursor", () => {
    const result = validateExtractionCheckpointRecord({ ...baseCheckpoint(), pageCursor: -1 });
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown phase, strategy, or coverage", () => {
    expect(validateExtractionCheckpointRecord({ ...baseCheckpoint(), phase: "nope" }).ok).toBe(
      false,
    );
    expect(validateExtractionCheckpointRecord({ ...baseCheckpoint(), strategy: "nope" }).ok).toBe(
      false,
    );
    expect(validateExtractionCheckpointRecord({ ...baseCheckpoint(), coverage: "nope" }).ok).toBe(
      false,
    );
  });

  it("rejects a non-hex source content hash in the fingerprint", () => {
    const checkpoint = baseCheckpoint();
    const result = validateExtractionCheckpointRecord({
      ...checkpoint,
      fingerprint: { ...checkpoint.fingerprint, sourceContentHash: "not hex!" },
    });
    expect(result.ok).toBe(false);
  });
});

describe("phase + coverage helpers", () => {
  it("recognizes terminal phases", () => {
    for (const phase of TERMINAL_EXTRACTION_PHASES) {
      expect(isTerminalExtractionPhase(phase)).toBe(true);
    }
    expect(isTerminalExtractionPhase("extracting")).toBe(false);
    expect(isTerminalExtractionPhase("embedding")).toBe(false);
  });

  it("treats only fully-available capabilities as coverage-contributing", () => {
    expect(capabilityContributesCoverage("available")).toBe(true);
    for (const status of ["unavailable", "degraded", "failing"] as const) {
      expect(capabilityContributesCoverage(status)).toBe(false);
    }
  });

  it("defaults capability availability to unavailable for both modalities", () => {
    expect(DEFAULT_EXTRACTION_CAPABILITY_AVAILABILITY.ocr).toBe("unavailable");
    expect(DEFAULT_EXTRACTION_CAPABILITY_AVAILABILITY.multimodal).toBe("unavailable");
  });
});

describe("enumerations", () => {
  it("exposes the expected closed unions", () => {
    expect(EXTRACTION_PHASES).toContain("complete");
    expect(COVERAGE_QUALITIES).toContain("partial");
    expect(EXTRACTION_CAPABILITY_STATUSES).toEqual([
      "available",
      "unavailable",
      "degraded",
      "failing",
    ]);
    expect(LARGE_DOCUMENT_EXTRACTION_STRATEGIES).toContain("progressive-pdf");
    expect(LARGE_DOCUMENT_RESUME_CHOICES).toEqual(["resume", "restart", "abandon"]);
    expect(LARGE_DOCUMENT_DIAGNOSTIC_CODES.CHECKPOINT_INCOMPATIBLE).toBe("CHECKPOINT_INCOMPATIBLE");
  });
});

// Keep the policy type import referenced so the type-only import is not pruned.
const _policyTypeWitness: LargeDocumentResourcePolicy = DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY;

// The emitted public boundary promises the same complete nested checkpoint shape.
import { validateExtractionCheckpointRecord as publicValidateCheckpoint } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-large-document-validation";

for (const [entry, validate] of [
  ["source", validateExtractionCheckpointRecord],
  ["public", publicValidateCheckpoint],
] as const) {
  describe(`${entry} complete checkpoint admission`, () => {
    it("rejects a fingerprint with an incomplete embedding identity", () => {
      const input = {
        ...baseCheckpoint(),
        fingerprint: { ...baseFingerprint(), embeddingIdentity: {} },
      };
      const result = validate(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors).toContain(
        "checkpoint.fingerprint.embeddingIdentity.provider must be a non-empty string",
      );
    });
    it.each([
      null,
      {},
      { severity: "fatal", code: "C", message: "M" },
      { severity: "error", code: 2, message: "M" },
      { severity: "warning", code: "C", message: 2 },
      { severity: "info", code: "C", message: "M", documentId: 2 },
      { severity: "info", code: "C", message: "M", pageNumber: "1" },
    ])("rejects malformed diagnostic %#", (diagnostic) => {
      expect(validate({ ...baseCheckpoint(), terminalDiagnostics: [diagnostic] }).ok).toBe(false);
    });
    it("preserves complete checkpoint and diagnostic references", () => {
      const diagnostic = {
        severity: "info",
        code: "fixture",
        message: "fixture",
        documentId: "non-uuid",
        pageNumber: 0,
      };
      const input = { ...baseCheckpoint(), terminalDiagnostics: [diagnostic] };
      const result = validate(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(input);
      expect(result.value.fingerprint).toBe(input.fingerprint);
      expect(result.value.terminalDiagnostics).toBe(input.terminalDiagnostics);
      expect(result.value.terminalDiagnostics[0]).toBe(diagnostic);
    });
  });
}

type CheckpointAny<T> = 0 extends 1 & T ? true : false;
function consumePublicCheckpoint(input: unknown): void {
  const result = publicValidateCheckpoint(input);
  if (result.ok) {
    const cursor: number = result.value.pageCursor;
    const provider: string = result.value.fingerprint.embeddingIdentity.provider;
    const strategy: "standard-buffer" | "progressive-pdf" | "unsupported" | "oversized" =
      result.value.strategy;
    const _concrete: CheckpointAny<typeof result.value> = false;
    const _concreteIdentity: CheckpointAny<typeof result.value.fingerprint.embeddingIdentity> =
      false;
    for (const diagnostic of result.value.terminalDiagnostics) {
      const severity: "info" | "warning" | "error" = diagnostic.severity;
      const code: string = diagnostic.code;
      const page: number | undefined = diagnostic.pageNumber;
      expect(["info", "warning", "error"]).toContain(severity);
      expect(typeof code).toBe("string");
      expect(page).toBe(12);
    }
    expect(result.value).toBe(input);
    expect(cursor).toBe(12);
    expect(provider).toBe(IDENTITY.provider);
    expect(strategy).toBe("progressive-pdf");
  }
}
it("public checkpoint consumer retains independent nested primitive declarations", () => {
  consumePublicCheckpoint(baseCheckpoint());
  consumePublicCheckpoint({
    ...baseCheckpoint(),
    terminalDiagnostics: [
      { severity: "warning", code: "page-skipped", message: "Page skipped", pageNumber: 12 },
    ],
  });
});
