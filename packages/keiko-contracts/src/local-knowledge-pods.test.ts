import { describe, expect, it } from "vitest";

import {
  LOCAL_KNOWLEDGE_SCHEMA_VERSION,
  type KnowledgeCapsuleId,
  type KnowledgeSourceId,
} from "./local-knowledge.js";
import {
  KNOWLEDGE_POD_SUMMARY_SCHEMA_VERSION,
  isKnowledgePodEvidenceSafeText,
  validateKnowledgePodSummary,
  type KnowledgePodSummary,
} from "./local-knowledge-pods.js";
import { resolveKnowledgePodModelUsePolicy } from "./local-knowledge-model-use-policy.js";
import { HTML_MANUAL_REFRESH_SCHEMA_VERSION } from "./html-manual-refresh.js";

function happySummary(): KnowledgePodSummary {
  return {
    schemaVersion: KNOWLEDGE_POD_SUMMARY_SCHEMA_VERSION,
    id: "cap-risk-controls" as KnowledgePodSummary["id"],
    kind: "pod",
    displayName: "Risk Controls Pod",
    description: "Policy and engineering guidance",
    tags: ["policy", "engineering"],
    readiness: "ready",
    lifecycleState: "ready",
    counts: {
      capsuleCount: 1,
      sourceCount: 2,
      documentCount: 12,
      chunkCount: 48,
      vectorCount: 48,
    },
    sourceKinds: ["folder", "repository"],
    retrieval: {
      lexicalIndex: true,
      vectorIndex: true,
      hybridGrounding: true,
      crossSpaceScoreMixing: false,
      embeddingProvider: "openai-compatible:3f65d1e8",
      embeddingModelId: "text-embedding-3-small",
      embeddingSpaceFingerprint: "space-v1",
      vectorDimensions: 1536,
      vectorMetric: "cosine",
    },
    privacy: {
      localFirst: true,
      modelOpen: true,
      rawContentExposed: false,
      privatePathsExposed: false,
      evidenceMode: "counts-hashes-and-status",
      storageLocation: "local-runtime-state",
    },
    governance: {
      locationKind: "local",
      sealingPosture: "local-store-policy",
      policyPosture: "not-declared",
      managedServiceDependency: false,
    },
    modelUsePolicy: resolveKnowledgePodModelUsePolicy(undefined),
    compatibility: {
      backingKind: "knowledge-capsule",
      capsuleIds: ["cap-risk-controls" as KnowledgeCapsuleId],
      sourceIds: ["src-risk-controls" as KnowledgeSourceId],
      localKnowledgeSchemaVersion: LOCAL_KNOWLEDGE_SCHEMA_VERSION,
      migrationRequired: false,
      persistedStateRenamed: false,
    },
    updatedAt: 1_700_000_000_000,
    degradationReasons: [],
  };
}

function invalidErrors(result: ReturnType<typeof validateKnowledgePodSummary>): readonly string[] {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected invalid Knowledge Pod summary");
  return result.errors;
}

describe("validateKnowledgePodSummary", () => {
  it("exposes the evidence-safe text predicate used by summary producers", () => {
    expect(isKnowledgePodEvidenceSafeText("Policy Pod")).toBe(true);
    expect(isKnowledgePodEvidenceSafeText("/Users/alice/customer/private.pdf")).toBe(false);
  });

  it("redacts filesystem paths regardless of where they appear in the text", () => {
    for (const unsafe of [
      "report=/Users/alice/private/customer.pdf",
      "report:/Users/alice/secret.pdf",
      "a/Users/alice/secret.pdf",
      "内部/Users/alice/secret.pdf",
      "C:/Users/alice/customer/private.pdf",
      "C:\\Users\\alice",
      "../../etc/passwd",
      "~/secrets/keys.txt",
    ]) {
      expect(isKnowledgePodEvidenceSafeText(unsafe)).toBe(false);
    }
  });

  it("keeps benign display names with a single slash evidence-safe", () => {
    for (const safeText of [
      "UI/UX Guidelines",
      "TCP/IP Reference",
      "Q3 2024 / Finance",
      "24/7 Support",
    ]) {
      expect(isKnowledgePodEvidenceSafeText(safeText)).toBe(true);
    }
  });

  it("redacts single-segment absolute paths embedded mid-string, not only full-string paths", () => {
    for (const unsafe of [
      "Indexing failed while reading /private for capsule metadata",
      "Source root /etc could not be scoped",
      "Gateway wrote logs under /var while retrying",
      "Denied access to /home during scan",
      "/tmp was purged before retry",
    ]) {
      expect(isKnowledgePodEvidenceSafeText(unsafe)).toBe(false);
    }
  });

  it("redacts single-segment absolute paths after any punctuation boundary, not only whitespace or brackets", () => {
    // A prior fix (PR #1973) enumerated a fixed set of boundary characters before a single-segment
    // path; a follow-up audit (PR #2031) then had to add another. Both left gaps for separators
    // outside the enumerated set — a negative-lookbehind-for-word-char rule closes the whole class.
    for (const unsafe of [
      "path=/etc",
      "key:/etc",
      "a,/etc,b",
      "a;/etc;b",
      "a|/etc|b",
      "flag-/etc",
      ")/etc leaked",
      "See report at D:/secret.pdf",
    ]) {
      expect(isKnowledgePodEvidenceSafeText(unsafe)).toBe(false);
    }
  });

  it("redacts single-backslash Windows-style paths, not only UNC double-backslash paths", () => {
    for (const unsafe of ["See \\Users\\alice\\secret.pdf", "Restore from \\Backups\\latest"]) {
      expect(isKnowledgePodEvidenceSafeText(unsafe)).toBe(false);
    }
  });

  it("accepts a body-free Knowledge Pod summary over existing Local Knowledge state", () => {
    const result = validateKnowledgePodSummary(happySummary());
    expect(result.ok).toBe(true);
  });

  it("accepts closed pod-set readiness counts and reason codes", () => {
    const result = validateKnowledgePodSummary({
      ...happySummary(),
      kind: "pod-set",
      compatibility: {
        ...happySummary().compatibility,
        backingKind: "capsule-set",
      },
      counts: {
        ...happySummary().counts,
        capsuleCount: 3,
      },
      setReadiness: {
        readyCount: 1,
        draftCount: 0,
        degradedCount: 1,
        unavailableCount: 0,
        deniedCount: 1,
        indexingCount: 1,
        staleCount: 0,
        errorCount: 0,
        missingCount: 0,
        reasonCodes: ["member-indexing", "member-degraded", "policy-denied"],
      },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts future pod-set placeholders only as non-functional readiness evidence", () => {
    const cases = [
      ["remote", "future-remote-member"],
      ["federated", "future-federated-member"],
      ["ephemeral", "future-ephemeral-member"],
    ] as const;

    for (const [placeholderKind, reasonCode] of cases) {
      const base = happySummary();
      const result = validateKnowledgePodSummary({
        ...base,
        kind: "pod-set",
        readiness: "unavailable",
        counts: { ...base.counts, capsuleCount: 1 },
        setReadiness: {
          readyCount: 0,
          draftCount: 0,
          degradedCount: 0,
          unavailableCount: 1,
          deniedCount: 0,
          indexingCount: 0,
          staleCount: 0,
          errorCount: 0,
          missingCount: 0,
          reasonCodes: [reasonCode],
        },
        sourceKinds: [placeholderKind],
        retrieval: {
          ...base.retrieval,
          lexicalIndex: false,
          vectorIndex: false,
          hybridGrounding: false,
        },
        governance: { ...base.governance, locationKind: placeholderKind },
        compatibility: { ...base.compatibility, backingKind: "capsule-set" },
      });

      expect(result.ok).toBe(true);
    }
  });

  it("rejects future pod placeholders that claim ready retrieval or omit set reasons", () => {
    const readyRemote = validateKnowledgePodSummary({
      ...happySummary(),
      sourceKinds: ["remote"],
      governance: { ...happySummary().governance, locationKind: "remote" },
      readiness: "ready",
    });
    const missingSetReason = validateKnowledgePodSummary({
      ...happySummary(),
      kind: "pod-set",
      readiness: "unavailable",
      counts: { ...happySummary().counts, capsuleCount: 1 },
      setReadiness: {
        readyCount: 0,
        draftCount: 0,
        degradedCount: 0,
        unavailableCount: 1,
        deniedCount: 0,
        indexingCount: 0,
        staleCount: 0,
        errorCount: 0,
        missingCount: 0,
        reasonCodes: [],
      },
      sourceKinds: ["federated"],
      retrieval: {
        ...happySummary().retrieval,
        lexicalIndex: false,
        vectorIndex: false,
        hybridGrounding: false,
      },
      governance: { ...happySummary().governance, locationKind: "federated" },
      compatibility: { ...happySummary().compatibility, backingKind: "capsule-set" },
    });

    expect(invalidErrors(readyRemote)).toEqual(
      expect.arrayContaining([
        "future pod placeholders must be degraded or unavailable",
        "future pod placeholders must not advertise retrieval capabilities",
      ]),
    );
    expect(invalidErrors(missingSetReason)).toContain(
      "setReadiness.reasonCodes must include future-federated-member for future placeholders",
    );
  });

  it("rejects malformed pod-set readiness metadata", () => {
    const invalidCode = validateKnowledgePodSummary({
      ...happySummary(),
      kind: "pod-set",
      compatibility: { ...happySummary().compatibility, backingKind: "capsule-set" },
      setReadiness: {
        readyCount: 1,
        draftCount: 0,
        degradedCount: 0,
        unavailableCount: 0,
        deniedCount: 0,
        indexingCount: 0,
        staleCount: 0,
        errorCount: 0,
        missingCount: 0,
        reasonCodes: ["raw-provider-error"],
      },
    });
    const nonSet = validateKnowledgePodSummary({
      ...happySummary(),
      setReadiness: {
        readyCount: 1,
        draftCount: 0,
        degradedCount: 0,
        unavailableCount: 0,
        deniedCount: 0,
        indexingCount: 0,
        staleCount: 0,
        errorCount: 0,
        missingCount: 0,
        reasonCodes: [],
      },
    });
    const mismatch = validateKnowledgePodSummary({
      ...happySummary(),
      kind: "pod-set",
      compatibility: { ...happySummary().compatibility, backingKind: "capsule-set" },
      setReadiness: {
        readyCount: 0,
        draftCount: 0,
        degradedCount: 0,
        unavailableCount: 0,
        deniedCount: 0,
        indexingCount: 0,
        staleCount: 0,
        errorCount: 0,
        missingCount: 0,
        reasonCodes: [],
      },
    });

    expect(invalidErrors(invalidCode)).toContain(
      "setReadiness.reasonCodes entries must be known reason codes",
    );
    expect(invalidErrors(nonSet)).toContain("setReadiness is only valid for pod-set summaries");
    expect(invalidErrors(mismatch)).toContain(
      "setReadiness member counts must match counts.capsuleCount",
    );
  });

  it("rejects unexpected raw-content fields", () => {
    const result = validateKnowledgePodSummary({
      ...happySummary(),
      rawDocumentBody: "customer contract body",
    });
    expect(invalidErrors(result)).toContain("summary must not include rawDocumentBody");
  });

  it("rejects absolute private paths in display strings", () => {
    const result = validateKnowledgePodSummary({
      ...happySummary(),
      displayName: "/Users/alice/customer/private.pdf",
    });
    expect(invalidErrors(result)).toContain("summary.displayName must be an evidence-safe string");
  });

  it("rejects absolute, home-relative, UNC, and temporary path variants", () => {
    for (const displayName of [
      "~/customer/private.pdf",
      String.raw`\\server\share\customer.pdf`,
      String.raw`C:\Users\alice\customer\private.pdf`,
      "C:/Users/alice/customer/private.pdf",
      "/tmp/customer/private.pdf",
      "/private/var/folders/customer/private.pdf",
      "file:///Users/alice/customer/private.pdf",
    ]) {
      const result = validateKnowledgePodSummary({ ...happySummary(), displayName });
      expect(invalidErrors(result)).toContain(
        "summary.displayName must be an evidence-safe string",
      );
    }
  });

  it("rejects secret-shaped strings in degradation reasons", () => {
    const result = validateKnowledgePodSummary({
      ...happySummary(),
      degradationReasons: ["Gateway returned Bearer secret-token-value"],
    });
    expect(invalidErrors(result)).toContain(
      "summary.degradationReasons entries must be evidence-safe strings",
    );
  });

  it("rejects endpoint-like values in retrieval metadata", () => {
    for (const embeddingProvider of [
      "https://example.test/embed",
      "//gateway.example.test/embed",
      "gateway.internal/v1",
      "localhost:11434/v1",
      "127.0.0.1:11434/v1",
      "[::1]:11434/v1",
      "[2001:db8::1]:443/v1",
      "https://example.test/embed?api_key=secret-value",
      "gateway.internal/v1?api_key=secret-value",
      "wss://gateway.example.test/embed?access_token=secret-value",
      "https://example.test/embed?client_secret=secret-value",
      "https://example.test/embed?refresh_token=secret-value",
      "https://example.test/embed?auth[x-access-token]=secret-value",
      "https://user:secret@example.test/embed",
      "user:secret@example.test/embed",
    ]) {
      const result = validateKnowledgePodSummary({
        ...happySummary(),
        retrieval: { ...happySummary().retrieval, embeddingProvider },
      });
      expect(invalidErrors(result)).toContain(
        "retrieval.embeddingProvider must be an evidence-safe string when set",
      );
    }
  });

  it("rejects a bare key=value token assignment even without a leading ? or # query marker", () => {
    // containsTokenParameterKey previously only scanned text following a literal `?` or `#`, so a
    // plain assignment fragment (e.g. from a config dump or error message) reached evidence text
    // untouched.
    for (const unsafe of [
      "password=hunter2",
      "Failed with password=hunter2 for retry",
      "aws_secret_access_key=AKIAABCDEFGHIJKLMNOP",
      "a=b, token=abc123",
    ]) {
      expect(isKnowledgePodEvidenceSafeText(unsafe)).toBe(false);
    }
  });

  it("keeps benign key=value-shaped text evidence-safe", () => {
    for (const safeText of ["x=y", "email=redacted", "ratio=1"]) {
      expect(isKnowledgePodEvidenceSafeText(safeText)).toBe(true);
    }
  });

  it("redacts newer secret shapes: GitHub fine-grained PATs, lowercase bearer, and JWT-shaped tokens", () => {
    for (const unsafe of [
      "github_pat_11ABCDEFG0123456789abcdefghijklmno",
      "authorization: bearer sk-live-abcdef123456",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ]) {
      expect(isKnowledgePodEvidenceSafeText(unsafe)).toBe(false);
    }
  });

  it("checks endpoint and token parameter text without regex backtracking", () => {
    const repeatedSafeText = `${"pod-reference ".repeat(200)}example`;
    const repeatedEndpoint = `${"http://".repeat(200)}example.test/path`;
    const repeatedSchemeEndpoint = `${"A".repeat(1_000)}://example.test/path`;
    const repeatedUserInfoEndpoint = `${"!".repeat(1_000)}@example.test/path`;
    const encodedTokenEndpoint = "gateway.internal/v1?%61ccess_token=secret-value";
    const encodedSecretEndpoint = "gateway.internal/v1?%63lient_secret=secret-value";
    const fragmentTokenText = "pod metadata #access_token=secret-value";
    const repeatedBareAssignment = `${"a=b ".repeat(2_000)}token=abc123`;
    // The exact adversarial shape a polynomial key=value regex would choke on: a long run of a
    // single repeated key-body character with no `=` in sight, so the backward scan from every
    // `=` (there are none) never fires and the whole value-safety check must still return quickly.
    const repeatedKeyBodyNoAssignment = "A".repeat(3_000);

    expect(isKnowledgePodEvidenceSafeText(repeatedSafeText)).toBe(true);
    expect(isKnowledgePodEvidenceSafeText(repeatedEndpoint)).toBe(false);
    expect(isKnowledgePodEvidenceSafeText(repeatedSchemeEndpoint)).toBe(false);
    expect(isKnowledgePodEvidenceSafeText(repeatedUserInfoEndpoint)).toBe(false);
    expect(isKnowledgePodEvidenceSafeText(encodedTokenEndpoint)).toBe(false);
    expect(isKnowledgePodEvidenceSafeText(encodedSecretEndpoint)).toBe(false);
    expect(isKnowledgePodEvidenceSafeText(fragmentTokenText)).toBe(false);
    expect(isKnowledgePodEvidenceSafeText(repeatedBareAssignment)).toBe(false);
    expect(isKnowledgePodEvidenceSafeText(repeatedKeyBodyNoAssignment)).toBe(true);
  });

  it("requires compatibility to keep persisted Local Knowledge state unmigrated", () => {
    const result = validateKnowledgePodSummary({
      ...happySummary(),
      compatibility: {
        ...happySummary().compatibility,
        migrationRequired: true,
      },
    });
    expect(invalidErrors(result)).toContain(
      "compatibility must preserve Local Knowledge state compatibility",
    );
  });

  it("requires explicit local or future-governed pod posture metadata", () => {
    const result = validateKnowledgePodSummary({
      ...happySummary(),
      governance: {
        locationKind: "hosted-cloud",
        sealingPosture: "local-store-policy",
        policyPosture: "not-declared",
        managedServiceDependency: false,
      },
    });
    expect(invalidErrors(result)).toContain("governance.locationKind is invalid");
  });

  it("rejects invalid model-use policy summary metadata", () => {
    const result = validateKnowledgePodSummary({
      ...happySummary(),
      modelUsePolicy: {
        source: "remote-policy-plane",
        mode: "sealed-local",
        operations: {
          ...happySummary().modelUsePolicy.operations,
          externalEmbeddings: "inherit",
        },
      },
    });

    expect(invalidErrors(result)).toEqual(
      expect.arrayContaining([
        "modelUsePolicy.source is invalid",
        "modelUsePolicy.operations.externalEmbeddings is invalid",
      ]),
    );
  });

  it("rejects invalid lifecycle and retrieval enum metadata", () => {
    const result = validateKnowledgePodSummary({
      ...happySummary(),
      lifecycleState: "published",
      retrieval: {
        ...happySummary().retrieval,
        vectorDimensions: 0,
        vectorMetric: "jaccard",
      },
    });

    expect(invalidErrors(result)).toEqual(
      expect.arrayContaining([
        "summary.lifecycleState is invalid",
        "retrieval.vectorDimensions must be a positive integer when set",
        "retrieval.vectorMetric is invalid when set",
      ]),
    );
  });

  it("rejects negative timestamps", () => {
    const result = validateKnowledgePodSummary({
      ...happySummary(),
      updatedAt: -1,
    });

    expect(invalidErrors(result)).toContain(
      "summary.updatedAt must be a finite non-negative number",
    );
  });

  it("rejects non-primitive retrieval metadata values", () => {
    const result = validateKnowledgePodSummary({
      ...happySummary(),
      retrieval: {
        ...happySummary().retrieval,
        vectorDimensions: { leak: "/tmp/x" },
        vectorMetric: { leak: "/tmp/x" },
      },
    });

    expect(invalidErrors(result)).toEqual(
      expect.arrayContaining([
        "retrieval.vectorDimensions must be a positive integer when set",
        "retrieval.vectorMetric is invalid when set",
      ]),
    );
  });

  it("accepts an optional evidence-safe manual source fingerprint (Epic #1852)", () => {
    const result = validateKnowledgePodSummary({
      ...happySummary(),
      manualSourceFingerprint: "a".repeat(64),
    });
    expect(result.ok).toBe(true);
  });

  it("accepts HTML manual source kinds without teaching them to KnowledgeSourceScope", () => {
    const result = validateKnowledgePodSummary({
      ...happySummary(),
      sourceKinds: ["html-manual-local", "html-manual-http"],
      manualSourceFingerprint: "fp-device-handbook",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a manual source fingerprint that leaks a raw path", () => {
    const result = validateKnowledgePodSummary({
      ...happySummary(),
      manualSourceFingerprint: "/Users/alice/manuals/index.html",
    });
    expect(invalidErrors(result)).toContain(
      "summary.manualSourceFingerprint must be an evidence-safe string when set",
    );
  });

  function validManualRefresh(): NonNullable<KnowledgePodSummary["manualRefresh"]> {
    return {
      schemaVersion: HTML_MANUAL_REFRESH_SCHEMA_VERSION,
      outcome: "updated",
      sourceKind: "html-manual-http",
      counts: {
        addedPages: 1,
        changedPages: 0,
        removedPages: 0,
        unchangedPages: 5,
        failedPages: 0,
        deniedLinks: 0,
      },
      removalDetection: "evaluated",
      crawlRunFingerprint: "sha256:AbCdEf123-_9",
      reasonCodes: ["pages-added"],
      refreshedAt: 1_700_000_000_000,
    };
  }

  it("accepts a Knowledge Pod summary carrying a redacted manual refresh change summary (Epic #1856)", () => {
    const result = validateKnowledgePodSummary({
      ...happySummary(),
      manualRefresh: validManualRefresh(),
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an unexpected top-level field on the manual refresh change summary", () => {
    // validateManualRefreshChangeSummary (html-manual-refresh.ts) checks required-field
    // presence/type/enum membership but does not reject unknown keys itself; this summary-layer
    // onlyKeys check is the only place that catches an accidentally-widened persisted record, the
    // same protection every other nested field on KnowledgePodSummary already gets.
    const result = validateKnowledgePodSummary({
      ...happySummary(),
      manualRefresh: {
        ...validManualRefresh(),
        rawPageUrl: "https://intranet.example.test/manual/page-7",
      },
    });
    expect(invalidErrors(result)).toContain("summary.manualRefresh must not include rawPageUrl");
  });

  it("rejects an unexpected field nested inside manual refresh counts", () => {
    const result = validateKnowledgePodSummary({
      ...happySummary(),
      manualRefresh: {
        ...validManualRefresh(),
        counts: { ...validManualRefresh().counts, skippedPages: 3 },
      },
    });
    expect(invalidErrors(result)).toContain(
      "summary.manualRefresh.counts must not include skippedPages",
    );
  });
});
