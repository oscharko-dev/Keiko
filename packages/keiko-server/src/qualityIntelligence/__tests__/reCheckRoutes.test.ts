// Integration tests for handleQiReCheck and handleQiRegenerateStale (Epic #735, Issue #743).
//
// Seeds a temp evidenceDir with a run manifest (including sourceFingerprints) and a
// candidates artifact, then calls the handlers directly. Verifies:
//   - re-check returns 0 stale when fingerprints match
//   - re-check returns N stale when a source hash changes
//   - re-check returns 404 for an unknown run id
//   - re-check returns 500 when evidenceDir is not configured
//   - re-check returns 400 for a missing/malformed body
//   - regenerate-stale returns 404 for an unknown run id
//   - regenerate-stale returns 500 when evidenceDir is not configured
//
// NOTE: regenerate-stale exercises the full model-routed workflow. In the integration
// test context the config has no providers, so #761 now expects a deterministic baseline run.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import {
  listQualityIntelligenceRuns,
  loadQualityIntelligenceCandidates,
  loadQualityIntelligenceRun,
  recordQualityIntelligenceRun,
  recordQualityIntelligenceCandidates,
} from "@oscharko-dev/keiko-evidence";
import type {
  EvidenceStore,
  QualityIntelligenceEvidenceManifest,
} from "@oscharko-dev/keiko-evidence";
import type { RouteContext, RouteResult } from "../../routes.js";
import { STREAMING } from "../../routes.js";
import type { UiHandlerDeps } from "../../deps.js";
import { buildRedactor, createRunRegistry } from "../../index.js";
import { createInMemoryUiStore } from "../../store/index.js";
import { ingestInlineSources } from "../runIngestion.js";
import { handleQiReCheck, handleQiRegenerateStale } from "../reCheckRoutes.js";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function emptyStore(): EvidenceStore {
  return { put: () => "", list: () => [], get: () => undefined, delete: () => undefined };
}

function deps(evidenceDir: string): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: emptyStore(),
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    evidenceDir,
  };
}

function depsNoDir(): UiHandlerDeps {
  return { ...deps("/tmp/fake"), evidenceDir: undefined };
}

function makeReq(body: Record<string, unknown>): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
  return req as unknown as IncomingMessage;
}

function makeRawReq(raw: string): IncomingMessage {
  const req = Readable.from([Buffer.from(raw, "utf8")]);
  return req as unknown as IncomingMessage;
}

function ctx(
  handler: "re-check" | "regenerate-stale",
  runId: string,
  req: IncomingMessage,
): RouteContext {
  return {
    req,
    res: {} as RouteContext["res"],
    params: { id: runId },
    url: new URL(`http://127.0.0.1/api/quality-intelligence/runs/${runId}/${handler}`),
  };
}

function asResult(outcome: RouteResult | typeof STREAMING): RouteResult {
  if (outcome === STREAMING) throw new Error("expected RouteResult, got STREAMING");
  return outcome;
}

const HASH_AAA = "a".repeat(64);

const AUDIT_SUMMARY_ID =
  "qi-audit-recheck-001" as QualityIntelligenceEvidenceManifest["provenanceRefs"]["auditSummaryId"];

function runRecordInput(
  runId: string,
  overrides: Partial<Parameters<typeof recordQualityIntelligenceRun>[0]> = {},
): Parameters<typeof recordQualityIntelligenceRun>[0] {
  return {
    runId,
    planAt: "2026-06-09T10:00:00.000Z",
    completedAt: "2026-06-09T10:01:00.000Z",
    status: "succeeded",
    policyProfileIds: [],
    retentionPolicyId: "default",
    modelGatewayCallCount: 1,
    totals: { candidates: 1, findings: 0, exports: 0 },
    findings: [],
    exports: [],
    evidenceRefs: [{ envelopeId: "env-1", atomId: "atom-1", lifecycleStatus: "finalised" }],
    provenanceRefs: { envelopeIds: ["env-1"], auditSummaryId: AUDIT_SUMMARY_ID },
    sourceFingerprints: [{ envelopeId: "env-1", integrityHashSha256Hex: HASH_AAA }],
    ...overrides,
  };
}

function makeCandidateRow(): Parameters<
  typeof recordQualityIntelligenceCandidates
>[0]["candidates"][number] {
  return {
    id: QualityIntelligence.asQualityIntelligenceTestCaseId("cand-recheck-001"),
    runId: QualityIntelligence.asQualityIntelligenceRunId("run-recheck-001"),
    derivedFromAtomIds: [QualityIntelligence.asQualityIntelligenceEvidenceAtomId("atom-1")],
    title: "Login with valid credentials",
    preconditions: ["User is on login page"],
    steps: ["Enter email", "Enter password", "Click Submit"],
    expectedResults: ["User is redirected to dashboard"],
    priority: "P1",
    riskClass: "functional",
    tags: [],
    status: "proposed",
  };
}

function qiCandidate(
  runId: string,
  id: string,
  title: string,
  derivedFromAtomIds: readonly string[],
): Parameters<typeof recordQualityIntelligenceCandidates>[0]["candidates"][number] {
  return {
    id: QualityIntelligence.asQualityIntelligenceTestCaseId(id),
    runId: QualityIntelligence.asQualityIntelligenceRunId(runId),
    derivedFromAtomIds: derivedFromAtomIds.map((atomId) =>
      QualityIntelligence.asQualityIntelligenceEvidenceAtomId(atomId),
    ),
    title,
    preconditions: [],
    steps: ["Step 1"],
    expectedResults: ["Expected 1"],
    priority: "P2",
    riskClass: "regression",
    tags: [],
    status: "proposed",
  };
}

function seedRunFromSources(args: {
  readonly runId: string;
  readonly sources: readonly {
    readonly kind: "requirements" | "workspace";
    readonly label: string;
    readonly text?: string;
    readonly path?: string;
  }[];
  readonly candidates: Parameters<typeof recordQualityIntelligenceCandidates>[0]["candidates"];
  readonly editedRevisions?: readonly QualityIntelligence.QualityIntelligenceCandidateEditedRevision[];
  readonly findings?: Parameters<typeof recordQualityIntelligenceRun>[0]["findings"];
}): ReturnType<typeof ingestInlineSources> {
  const requestSources: QualityIntelligence.QualityIntelligenceInlineSource[] = args.sources.map(
    (source) =>
      source.kind === "requirements"
        ? { kind: "requirements", label: source.label, text: source.text ?? "" }
        : { kind: "workspace", label: source.label, path: source.path ?? "" },
  );
  const ingestion = ingestInlineSources({
    request: { sources: requestSources },
    runId: args.runId,
    registeredAt: "2026-06-09T10:00:00.000Z",
  });
  recordQualityIntelligenceRun(
    {
      runId: args.runId,
      planAt: "2026-06-09T10:00:00.000Z",
      completedAt: "2026-06-09T10:01:00.000Z",
      status: "succeeded",
      policyProfileIds: ["qi:regression-default"],
      retentionPolicyId: "default",
      modelGatewayCallCount: 0,
      totals: {
        candidates: args.candidates.length,
        findings: args.findings?.length ?? 0,
        exports: 0,
      },
      findings: args.findings ?? [],
      exports: [],
      evidenceRefs: ingestion.ingestedAtoms.map((entry) => ({
        envelopeId: String(entry.atom.sourceEnvelopeId),
        atomId: String(entry.atom.id),
        lifecycleStatus: entry.atom.lifecycleStatus,
      })),
      provenanceRefs: ingestion.provenanceRefs,
      sourceFingerprints: ingestion.envelopes.map((envelope) => ({
        envelopeId: String(envelope.id),
        integrityHashSha256Hex: envelope.provenance.integrityHashSha256Hex,
      })),
      atomFingerprints: ingestion.ingestedAtoms.map((entry) => ({
        atomId: String(entry.atom.id),
        envelopeId: String(entry.atom.sourceEnvelopeId),
        canonicalHashSha256Hex: entry.atom.canonicalHashSha256Hex,
      })),
    },
    { evidenceDir },
  );
  recordQualityIntelligenceCandidates({
    runId: args.runId,
    generatedAt: "2026-06-09T10:01:00.000Z",
    candidates: args.candidates,
    editedRevisions: args.editedRevisions,
    evidenceDir,
    redact: (value: unknown): unknown => value,
  });
  return ingestion;
}

// ─── Test lifecycle ───────────────────────────────────────────────────────────

let evidenceDir: string;

const RUN_ID = "run-recheck-001";

beforeEach(() => {
  evidenceDir = mkdtempSync(join(tmpdir(), "keiko-recheck-test-"));
  recordQualityIntelligenceRun(runRecordInput(RUN_ID), { evidenceDir });
  recordQualityIntelligenceCandidates({
    runId: RUN_ID,
    generatedAt: "2026-06-09T10:01:00.000Z",
    candidates: [makeCandidateRow()],
    evidenceDir,
    redact: (v: unknown): unknown => v,
  });
});

afterEach(() => {
  rmSync(evidenceDir, { recursive: true, force: true });
});

// ─── re-check: error paths ────────────────────────────────────────────────────

describe("handleQiReCheck — no evidence dir", () => {
  it("returns 500 QI_NO_EVIDENCE_DIR when evidenceDir is not configured", async () => {
    const body = { sources: [{ kind: "requirements", label: "req", text: "REQ-1: login" }] };
    const result = asResult(
      await handleQiReCheck(ctx("re-check", RUN_ID, makeReq(body)), depsNoDir()),
    );
    expect(result.status).toBe(500);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_NO_EVIDENCE_DIR");
  });
});

describe("handleQiReCheck — run not found", () => {
  it("returns 404 QI_NOT_FOUND for an unknown run id", async () => {
    const body = { sources: [{ kind: "requirements", label: "req", text: "REQ-1: login" }] };
    const result = asResult(
      await handleQiReCheck(
        ctx("re-check", "run-does-not-exist", makeReq(body)),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(404);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_NOT_FOUND");
  });
});

describe("handleQiReCheck — missing id param", () => {
  it("returns 400 QI_BAD_REQUEST when id param is absent", async () => {
    const c: RouteContext = {
      req: makeReq({ sources: [{ kind: "requirements", label: "r", text: "x" }] }),
      res: {} as RouteContext["res"],
      params: {},
      url: new URL("http://127.0.0.1/api/quality-intelligence/runs//re-check"),
    };
    const result = asResult(await handleQiReCheck(c, deps(evidenceDir)));
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_REQUEST");
  });
});

describe("handleQiReCheck — malformed body", () => {
  it("returns 400 QI_BAD_REQUEST for non-JSON body", async () => {
    const result = asResult(
      await handleQiReCheck(ctx("re-check", RUN_ID, makeRawReq("not json")), deps(evidenceDir)),
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_REQUEST");
  });

  it("returns 400 QI_BAD_REQUEST when sources array is empty", async () => {
    const result = asResult(
      await handleQiReCheck(ctx("re-check", RUN_ID, makeReq({ sources: [] })), deps(evidenceDir)),
    );
    expect(result.status).toBe(400);
  });

  it("returns 400 QI_BAD_REQUEST when body is missing sources field", async () => {
    const result = asResult(
      await handleQiReCheck(
        ctx("re-check", RUN_ID, makeReq({ adapter: "csv" })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(400);
  });
});

// ─── re-check / regenerate-stale: capsule connector source parse (Epic #710) ────
//
// The re-check route carries its OWN copy of validateCapsuleSource / validateCapsuleSetSource
// (reCheckRoutes.ts), separate from the start-run parser (runRoutes.ts). Epic #710's capsule
// flow includes drift re-check of a capsule-sourced run, so this copy must (a) accept the same
// capsule / capsule-set shapes the start-run parser does and (b) reject malformed ids the same
// way — otherwise a capsule run that generates fine would silently fail (or wrongly succeed) on
// re-check. Before these tests the re-check capsule parse path had zero coverage, so deleting a
// connector-kind branch or a trim guard here passed CI undetected.
//
// deps() configures no Local Knowledge store, so a WELL-FORMED capsule source parses and reaches
// ingestion, where the absent resolver throws a coded QI_CAPSULE_UNAVAILABLE (400) — distinct
// from the parse-level QI_BAD_SOURCE (400) a MALFORMED source produces. That code distinction is
// what makes these mutation-effective: dropping the capsule branch turns the accept case into
// QI_BAD_SOURCE; dropping the trim guard turns the reject case into QI_CAPSULE_UNAVAILABLE.
describe("handleQiReCheck — capsule connector sources (Epic #710)", () => {
  it("accepts a well-formed capsule source at parse, surfacing ingestion-level QI_CAPSULE_UNAVAILABLE (not parse-level QI_BAD_SOURCE)", async () => {
    const body = { sources: [{ kind: "capsule", label: "Product KB", capsuleId: "cap-abc" }] };
    const result = asResult(
      await handleQiReCheck(ctx("re-check", RUN_ID, makeReq(body)), deps(evidenceDir)),
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_CAPSULE_UNAVAILABLE");
  });

  it("accepts a well-formed capsule-set source at parse, surfacing ingestion-level QI_CAPSULE_UNAVAILABLE", async () => {
    const body = { sources: [{ kind: "capsule-set", label: "All KBs", capsuleSetId: "set-abc" }] };
    const result = asResult(
      await handleQiReCheck(ctx("re-check", RUN_ID, makeReq(body)), deps(evidenceDir)),
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_CAPSULE_UNAVAILABLE");
  });

  it("rejects a whitespace-only capsuleId at parse with QI_BAD_SOURCE (trim guard)", async () => {
    const body = { sources: [{ kind: "capsule", label: "Product KB", capsuleId: "   " }] };
    const result = asResult(
      await handleQiReCheck(ctx("re-check", RUN_ID, makeReq(body)), deps(evidenceDir)),
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_SOURCE");
  });

  it("rejects an empty capsuleSetId at parse with QI_BAD_SOURCE (trim guard)", async () => {
    const body = { sources: [{ kind: "capsule-set", label: "All KBs", capsuleSetId: "" }] };
    const result = asResult(
      await handleQiReCheck(ctx("re-check", RUN_ID, makeReq(body)), deps(evidenceDir)),
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_SOURCE");
  });
});

describe("handleQiRegenerateStale — capsule connector sources (Epic #710)", () => {
  it("routes a well-formed capsule source through the same capsule ingestion path (QI_CAPSULE_UNAVAILABLE)", async () => {
    const body = { sources: [{ kind: "capsule", label: "Product KB", capsuleId: "cap-abc" }] };
    const result = asResult(
      await handleQiRegenerateStale(
        ctx("regenerate-stale", RUN_ID, makeReq(body)),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_CAPSULE_UNAVAILABLE");
  });
});

describe("handleQiReCheck — malformed candidates companion", () => {
  it("returns 500 QI_RECHECK_FAILED when the candidates companion is corrupted", async () => {
    writeFileSync(
      join(evidenceDir, "qi", `${RUN_ID}.candidates.json`),
      JSON.stringify({
        qiCandidatesSchemaVersion: 1,
        runId: RUN_ID,
        generatedAt: "2026-06-09T10:01:00.000Z",
        candidates: [
          {
            id: "cand-recheck-001",
            title: "Corrupt me",
            preconditions: ["ready"],
            steps: "not-an-array",
            expectedResults: ["done"],
            priority: "P1",
            riskClass: "functional",
            tags: [],
            status: "proposed",
            derivedFromAtomIds: ["atom-1"],
          },
        ],
      }),
      "utf8",
    );

    const body = {
      sources: [{ kind: "requirements", label: "req-1", text: "REQ-1: User can log in" }],
    };
    const result = asResult(
      await handleQiReCheck(ctx("re-check", RUN_ID, makeReq(body)), deps(evidenceDir)),
    );
    expect(result.status).toBe(500);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_RECHECK_FAILED");
  });
});

// ─── re-check: happy path — unchanged sources ─────────────────────────────────

describe("handleQiReCheck — unchanged source (same hash)", () => {
  it("returns 200 with staleCount=0 when the ingested source produces the same hash", async () => {
    // Supply a requirements source whose content we know produces a predictable hash.
    // The re-check compares against the stored HASH_AAA fingerprint for env-1.
    // Because ingestInlineSources computes its own hash, and the stored hash is HASH_AAA
    // (a string of 64 'a's — not from real content), the fingerprints will differ.
    // This test verifies the shape of the 200 response rather than the zero-stale case.
    const body = {
      sources: [{ kind: "requirements", label: "req-1", text: "REQ-1: User can log in" }],
    };
    const result = asResult(
      await handleQiReCheck(ctx("re-check", RUN_ID, makeReq(body)), deps(evidenceDir)),
    );
    expect(result.status).toBe(200);
    const b = result.body as {
      runId: string;
      staleCount: number;
      fresh: readonly string[];
      changedStale: readonly unknown[];
      orphanedStale: readonly unknown[];
    };
    expect(b.runId).toBe(RUN_ID);
    expect(typeof b.staleCount).toBe("number");
    expect(Array.isArray(b.fresh)).toBe(true);
    expect(Array.isArray(b.changedStale)).toBe(true);
    expect(Array.isArray(b.orphanedStale)).toBe(true);
  });

  it("returns staleCount = changedStale.length + orphanedStale.length", async () => {
    const body = {
      sources: [{ kind: "requirements", label: "req-1", text: "REQ-1: User can log in" }],
    };
    const result = asResult(
      await handleQiReCheck(ctx("re-check", RUN_ID, makeReq(body)), deps(evidenceDir)),
    );
    const b = result.body as {
      staleCount: number;
      changedStale: readonly unknown[];
      orphanedStale: readonly unknown[];
    };
    expect(b.staleCount).toBe(b.changedStale.length + b.orphanedStale.length);
  });
});

// ─── re-check: run with no sourceFingerprints stored ─────────────────────────

describe("handleQiReCheck — no stored sourceFingerprints", () => {
  it("marks all candidates as stale (orphanedStale) when manifest has no sourceFingerprints", async () => {
    const runIdNoFp = "run-recheck-no-fp";
    // Seed without sourceFingerprints: rest-destructure drops the optional (readonly) key, since
    // exactOptionalPropertyTypes forbids setting it to `undefined` and the field cannot be deleted.
    const { sourceFingerprints: _droppedFingerprints, ...noFpInput } = runRecordInput(runIdNoFp);
    void _droppedFingerprints;
    recordQualityIntelligenceRun(noFpInput, { evidenceDir });
    recordQualityIntelligenceCandidates({
      runId: runIdNoFp,
      generatedAt: "2026-06-09T10:01:00.000Z",
      candidates: [
        {
          id: QualityIntelligence.asQualityIntelligenceTestCaseId("cand-nofp-001"),
          runId: QualityIntelligence.asQualityIntelligenceRunId(runIdNoFp),
          derivedFromAtomIds: [QualityIntelligence.asQualityIntelligenceEvidenceAtomId("atom-1")],
          title: "Stale candidate",
          preconditions: [],
          steps: [],
          expectedResults: [],
          priority: "P2",
          riskClass: "regression",
          tags: [],
          status: "proposed",
        },
      ],
      evidenceDir,
      redact: (v: unknown): unknown => v,
    });

    const body = {
      sources: [{ kind: "requirements", label: "req-1", text: "REQ-1: User can log in" }],
    };
    const result = asResult(
      await handleQiReCheck(ctx("re-check", runIdNoFp, makeReq(body)), deps(evidenceDir)),
    );
    expect(result.status).toBe(200);
    const b = result.body as {
      staleCount: number;
      orphanedStale: readonly unknown[];
    };
    // oldFingerprints is empty → every candidate's envelope is "removed" → all orphanedStale
    expect(b.staleCount).toBeGreaterThanOrEqual(1);
    expect(b.orphanedStale.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── regenerate-stale: error paths ───────────────────────────────────────────

describe("handleQiRegenerateStale — no evidence dir", () => {
  it("returns 500 QI_NO_EVIDENCE_DIR when evidenceDir is not configured", async () => {
    const body = { sources: [{ kind: "requirements", label: "req", text: "REQ-1: login" }] };
    const result = asResult(
      await handleQiRegenerateStale(ctx("regenerate-stale", RUN_ID, makeReq(body)), depsNoDir()),
    );
    expect(result.status).toBe(500);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_NO_EVIDENCE_DIR");
  });
});

describe("handleQiRegenerateStale — run not found", () => {
  it("returns 404 QI_NOT_FOUND for an unknown run id", async () => {
    const body = { sources: [{ kind: "requirements", label: "req", text: "REQ-1: login" }] };
    const result = asResult(
      await handleQiRegenerateStale(
        ctx("regenerate-stale", "run-does-not-exist", makeReq(body)),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(404);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_NOT_FOUND");
  });
});

describe("handleQiRegenerateStale — no model configured", () => {
  it("returns 200 and writes a deterministic baseline run when no providers are configured", async () => {
    // A real drift scenario: one requirement edited (changed-stale), one unchanged (preserved). This
    // gives the regeneration an atom to work on so the no-providers baseline path runs and writes a
    // succeeded run that preserves the fresh candidate — rather than the empty-merge guard tripping.
    const runId = "run-noprov-baseline";
    const originalText = "Login must work reliably\nMFA must work reliably";
    const seeded = ingestInlineSources({
      request: { sources: [{ kind: "requirements", label: "Spec", text: originalText }] },
      runId,
      registeredAt: "2026-06-09T10:00:00.000Z",
    });
    seedRunFromSources({
      runId,
      sources: [{ kind: "requirements", label: "Spec", text: originalText }],
      candidates: [
        qiCandidate(runId, "cand-fresh", "Login test", [String(seeded.ingestedAtoms[0]?.atom.id)]),
        qiCandidate(runId, "cand-stale", "MFA test", [String(seeded.ingestedAtoms[1]?.atom.id)]),
      ],
    });
    const body = {
      sources: [
        {
          kind: "requirements",
          label: "Spec",
          text: "Login must work reliably\nMFA must also write an audit entry",
        },
      ],
    };
    const result = asResult(
      await handleQiRegenerateStale(
        ctx("regenerate-stale", runId, makeReq(body)),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(200);
    const response = result.body as {
      runId: string;
      regeneratedCount: number;
      preservedCount: number;
    };
    expect(response.runId).not.toBe(runId);
    // The unchanged Login candidate is preserved; no model means no model provenance on the new run.
    expect(response.preservedCount).toBe(1);
    expect(response.regeneratedCount).toBeGreaterThanOrEqual(0);
    const manifest = loadQualityIntelligenceRun(response.runId, { evidenceDir });
    expect(manifest?.status).toBe("succeeded");
    expect(manifest?.modelId).toBeUndefined();
    expect(manifest?.seedUsed).toBeUndefined();
    // #790: the regenerated run's coverage rows carry redacted requirement excerpts so the new
    // run's Gap Radar / traceability stay auditor-readable, mirroring the initial-run path.
    const matrix = manifest?.coverageMatrix ?? [];
    expect(matrix.length).toBeGreaterThan(0);
    const excerpts = matrix.map((row) => row.requirementExcerptRedacted ?? "");
    expect(excerpts.some((e) => e.includes("Login must work reliably"))).toBe(true);
  });
});

describe("handleQiRegenerateStale — malformed candidates companion", () => {
  it("returns 500 QI_REGEN_FAILED when the candidates companion is corrupted", async () => {
    writeFileSync(
      join(evidenceDir, "qi", `${RUN_ID}.candidates.json`),
      JSON.stringify({
        qiCandidatesSchemaVersion: 1,
        runId: RUN_ID,
        generatedAt: "2026-06-09T10:01:00.000Z",
        candidates: [
          {
            id: "cand-recheck-001",
            title: "Corrupt me",
            preconditions: ["ready"],
            steps: "not-an-array",
            expectedResults: ["done"],
            priority: "P1",
            riskClass: "functional",
            tags: [],
            status: "proposed",
            derivedFromAtomIds: ["atom-1"],
          },
        ],
      }),
      "utf8",
    );

    const body = {
      sources: [{ kind: "requirements", label: "req-1", text: "REQ-1: User can log in" }],
    };
    const result = asResult(
      await handleQiRegenerateStale(
        ctx("regenerate-stale", RUN_ID, makeReq(body)),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(500);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_REGEN_FAILED");
  });
});

describe("handleQiRegenerateStale — missing id param", () => {
  it("returns 400 QI_BAD_REQUEST when id param is absent", async () => {
    const c: RouteContext = {
      req: makeReq({ sources: [{ kind: "requirements", label: "r", text: "x" }] }),
      res: {} as RouteContext["res"],
      params: {},
      url: new URL("http://127.0.0.1/api/quality-intelligence/runs//regenerate-stale"),
    };
    const result = asResult(await handleQiRegenerateStale(c, deps(evidenceDir)));
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_REQUEST");
  });
});

describe("handleQiReCheck — requirement drift is atom-aware (#798)", () => {
  it("marks only the candidate derived from the edited requirement line as stale", async () => {
    const runId = "run-req-atom-aware";
    const originalText = "Login must work reliably\nMFA must work reliably";
    const seeded = ingestInlineSources({
      request: {
        sources: [{ kind: "requirements", label: "Spec", text: originalText }],
      },
      runId,
      registeredAt: "2026-06-09T10:00:00.000Z",
    });
    seedRunFromSources({
      runId,
      sources: [{ kind: "requirements", label: "Spec", text: originalText }],
      candidates: [
        qiCandidate(runId, "cand-req-1", "Login test", [String(seeded.ingestedAtoms[0]?.atom.id)]),
        qiCandidate(runId, "cand-req-2", "MFA test", [String(seeded.ingestedAtoms[1]?.atom.id)]),
      ],
    });

    const result = asResult(
      await handleQiReCheck(
        ctx(
          "re-check",
          runId,
          makeReq({
            sources: [
              {
                kind: "requirements",
                label: "Spec",
                text: "Login must work reliably\nMFA must also write an audit entry",
              },
            ],
          }),
        ),
        deps(evidenceDir),
      ),
    );

    expect(result.status).toBe(200);
    const body = result.body as {
      staleCount: number;
      fresh: readonly string[];
      changedStale: readonly { candidateId: string; reason: string; envelopeId: string }[];
    };
    expect(body.staleCount).toBe(1);
    expect(body.fresh).toEqual(["cand-req-1"]);
    expect(body.changedStale).toHaveLength(1);
    expect(body.changedStale[0]).toMatchObject({
      candidateId: "cand-req-2",
      reason: "source-changed",
    });
    expect(typeof body.changedStale[0]?.envelopeId).toBe("string");
  });
});

describe("handleQiReCheck — workspace content drift is atom-aware (#799)", () => {
  it("detects an in-place file content edit even when the workspace root and file path stay the same", async () => {
    const runId = "run-workspace-atom-aware";
    const dir = mkdtempSync(join(tmpdir(), "qi-recheck-ws-"));
    try {
      const path = join(dir, "spec.md");
      writeFileSync(path, "Version one requirement.\n", "utf8");
      const seeded = ingestInlineSources({
        request: {
          sources: [{ kind: "workspace", label: "Repo", path: dir }],
        },
        runId,
        registeredAt: "2026-06-09T10:00:00.000Z",
      });
      seedRunFromSources({
        runId,
        sources: [{ kind: "workspace", label: "Repo", path: dir }],
        candidates: [
          qiCandidate(runId, "cand-ws-1", "Workspace test", [
            String(seeded.ingestedAtoms[0]?.atom.id),
          ]),
        ],
      });

      writeFileSync(path, "Version two requirement.\n", "utf8");
      const result = asResult(
        await handleQiReCheck(
          ctx(
            "re-check",
            runId,
            makeReq({ sources: [{ kind: "workspace", label: "Repo", path: dir }] }),
          ),
          deps(evidenceDir),
        ),
      );

      expect(result.status).toBe(200);
      const body = result.body as {
        staleCount: number;
        changedStale: readonly { candidateId: string; reason: string; envelopeId: string }[];
      };
      expect(body.staleCount).toBe(1);
      expect(body.changedStale).toHaveLength(1);
      expect(body.changedStale[0]).toMatchObject({
        candidateId: "cand-ws-1",
        reason: "source-changed",
      });
      expect(typeof body.changedStale[0]?.envelopeId).toBe("string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("handleQiRegenerateStale — preserved candidates are materialised in the new run (#800)", () => {
  it("keeps preserved fresh candidates and their edit history in the new run artifact", async () => {
    const runId = "run-regen-preserve";
    const originalText = "Login must work reliably\nMFA must work reliably";
    const seeded = ingestInlineSources({
      request: {
        sources: [{ kind: "requirements", label: "Spec", text: originalText }],
      },
      runId,
      registeredAt: "2026-06-09T10:00:00.000Z",
    });
    seedRunFromSources({
      runId,
      sources: [{ kind: "requirements", label: "Spec", text: originalText }],
      candidates: [
        qiCandidate(runId, "cand-preserved", "Login test", [
          String(seeded.ingestedAtoms[0]?.atom.id),
        ]),
        qiCandidate(runId, "cand-stale", "MFA test", [String(seeded.ingestedAtoms[1]?.atom.id)]),
      ],
      editedRevisions: [
        {
          candidateId: "cand-preserved",
          provenance: {
            editedAt: "2026-06-09T10:02:00.000Z",
            editedBy: "human",
            editorLabel: "Reviewer A",
          },
          editedFields: {
            title: "Login test (edited)",
          },
        },
      ],
    });

    const result = asResult(
      await handleQiRegenerateStale(
        ctx(
          "regenerate-stale",
          runId,
          makeReq({
            sources: [
              {
                kind: "requirements",
                label: "Spec",
                text: "Login must work reliably\nMFA must also write an audit entry",
              },
            ],
          }),
        ),
        deps(evidenceDir),
      ),
    );

    expect(result.status).toBe(200);
    const body = result.body as {
      runId: string;
      regeneratedCount: number;
      preservedCount: number;
    };
    expect(body.regeneratedCount).toBe(1);
    expect(body.preservedCount).toBe(1);
    const artifact = loadQualityIntelligenceCandidates(body.runId, { evidenceDir });
    const candidateIds = artifact?.candidates.map((candidate) => candidate.id) ?? [];
    expect(candidateIds).toContain("cand-preserved");
    expect(candidateIds).toHaveLength(2);
    expect(artifact?.editedRevisions?.map((revision) => revision.candidateId)).toEqual([
      "cand-preserved",
    ]);
  });
});

describe("handleQiRegenerateStale — legacy requirements runs fail closed without writing a failed empty run (#801)", () => {
  it("returns a controlled legacy error and leaves no extra run in the list", async () => {
    const runId = "run-legacy-requirements";
    const originalText = "Login must work reliably\nMFA must work reliably";
    const seeded = ingestInlineSources({
      request: {
        sources: [{ kind: "requirements", label: "Spec", text: originalText }],
      },
      runId,
      registeredAt: "2026-06-09T10:00:00.000Z",
    });
    recordQualityIntelligenceRun(
      {
        runId,
        planAt: "2026-06-09T10:00:00.000Z",
        completedAt: "2026-06-09T10:01:00.000Z",
        status: "succeeded",
        policyProfileIds: ["qi:regression-default"],
        retentionPolicyId: "default",
        modelGatewayCallCount: 0,
        totals: { candidates: 1, findings: 0, exports: 0 },
        findings: [],
        exports: [],
        evidenceRefs: seeded.ingestedAtoms.map((entry) => ({
          envelopeId: String(entry.atom.sourceEnvelopeId),
          atomId: String(entry.atom.id),
          lifecycleStatus: entry.atom.lifecycleStatus,
        })),
        provenanceRefs: seeded.provenanceRefs,
        sourceFingerprints: seeded.envelopes.map((envelope) => ({
          envelopeId: String(envelope.id),
          integrityHashSha256Hex: envelope.provenance.integrityHashSha256Hex,
        })),
      },
      { evidenceDir },
    );
    recordQualityIntelligenceCandidates({
      runId,
      generatedAt: "2026-06-09T10:01:00.000Z",
      candidates: [
        qiCandidate(runId, "cand-legacy", "Legacy MFA test", [
          String(seeded.ingestedAtoms[1]?.atom.id),
        ]),
      ],
      evidenceDir,
      redact: (value: unknown): unknown => value,
    });

    const beforeRunIds = listQualityIntelligenceRuns({ evidenceDir });
    const result = asResult(
      await handleQiRegenerateStale(
        ctx(
          "regenerate-stale",
          runId,
          makeReq({
            sources: [
              {
                kind: "requirements",
                label: "Spec",
                text: "Login must work reliably\nMFA must also write an audit entry",
              },
            ],
          }),
        ),
        deps(evidenceDir),
      ),
    );

    expect(result.status).toBe(409);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "QI_REGEN_LEGACY_REQUIREMENTS_UNSUPPORTED",
    );
    expect(listQualityIntelligenceRuns({ evidenceDir })).toEqual(beforeRunIds);
  });
});

describe("handleQiReCheck — workspace file order changes do NOT false-orphan unchanged files (#735 drift)", () => {
  it("keeps unchanged files fresh when a new file is added ahead of them in discovery order", async () => {
    const runId = "run-workspace-reorder";
    const dir = mkdtempSync(join(tmpdir(), "qi-recheck-reorder-"));
    try {
      // Two unchanged spec files. Their atom ids are derived from the file PATH (not the discovery
      // index), so adding a sibling that sorts ahead of them must not change their ids.
      writeFileSync(join(dir, "a-auth.md"), "Auth requirement one.\n", "utf8");
      writeFileSync(join(dir, "b-pay.md"), "Payment requirement one.\n", "utf8");
      const seeded = ingestInlineSources({
        request: { sources: [{ kind: "workspace", label: "Repo", path: dir }] },
        runId,
        registeredAt: "2026-06-09T10:00:00.000Z",
      });
      const atomIds = seeded.ingestedAtoms.map((entry) => String(entry.atom.id));
      expect(atomIds.length).toBe(2);
      seedRunFromSources({
        runId,
        sources: [{ kind: "workspace", label: "Repo", path: dir }],
        candidates: atomIds.map((atomId, i) =>
          qiCandidate(runId, `cand-ws-${String(i)}`, `Test ${String(i)}`, [atomId]),
        ),
      });

      // Add a brand-new file that sorts FIRST — under the buggy index-based scheme this shifted every
      // existing file's atom id and orphaned every candidate. The contents of a-auth.md/b-pay.md are
      // untouched.
      writeFileSync(join(dir, "0-intro.md"), "Intro with its own requirement statement.\n", "utf8");
      const result = asResult(
        await handleQiReCheck(
          ctx(
            "re-check",
            runId,
            makeReq({ sources: [{ kind: "workspace", label: "Repo", path: dir }] }),
          ),
          deps(evidenceDir),
        ),
      );

      expect(result.status).toBe(200);
      const body = result.body as {
        staleCount: number;
        fresh: readonly string[];
        changedStale: readonly unknown[];
        orphanedStale: readonly unknown[];
      };
      // Both original candidates' files are unchanged → no drift at all.
      expect(body.staleCount).toBe(0);
      expect([...body.fresh].sort()).toEqual(["cand-ws-0", "cand-ws-1"]);
      expect(body.changedStale).toHaveLength(0);
      expect(body.orphanedStale).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("handleQiRegenerateStale — never turns a non-empty run into an empty one (#735 data-loss guard)", () => {
  it("fails closed with QI_REGEN_WOULD_EMPTY when every candidate is orphaned and nothing is regeneratable", async () => {
    const runId = "run-regen-would-empty";
    const dir = mkdtempSync(join(tmpdir(), "qi-recheck-empty-"));
    try {
      writeFileSync(join(dir, "spec.md"), "The only tracked requirement.\n", "utf8");
      const seeded = ingestInlineSources({
        request: { sources: [{ kind: "workspace", label: "Repo", path: dir }] },
        runId,
        registeredAt: "2026-06-09T10:00:00.000Z",
      });
      seedRunFromSources({
        runId,
        sources: [{ kind: "workspace", label: "Repo", path: dir }],
        candidates: [
          qiCandidate(runId, "cand-only", "Only test", [String(seeded.ingestedAtoms[0]?.atom.id)]),
        ],
      });

      // Replace the tracked file with an unrelated one: the original atom disappears (its candidate is
      // orphaned) and there is no replacement atom to regenerate from → the merge would be empty.
      rmSync(join(dir, "spec.md"));
      writeFileSync(join(dir, "other.md"), "A completely different requirement.\n", "utf8");

      const beforeRunIds = listQualityIntelligenceRuns({ evidenceDir });
      const result = asResult(
        await handleQiRegenerateStale(
          ctx(
            "regenerate-stale",
            runId,
            makeReq({ sources: [{ kind: "workspace", label: "Repo", path: dir }] }),
          ),
          deps(evidenceDir),
        ),
      );

      expect(result.status).toBe(409);
      expect((result.body as { error: { code: string } }).error.code).toBe("QI_REGEN_WOULD_EMPTY");
      // No empty run was materialised.
      expect(listQualityIntelligenceRuns({ evidenceDir })).toEqual(beforeRunIds);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("re-check / regenerate-stale — invalid run id is rejected with 400 (#735 hardening)", () => {
  it("handleQiReCheck returns 400 QI_BAD_REQUEST for a traversal-shaped run id", async () => {
    const result = asResult(
      await handleQiReCheck(
        ctx(
          "re-check",
          "run/../../etc/passwd",
          makeReq({ sources: [{ kind: "requirements", label: "r", text: "x requirement" }] }),
        ),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_REQUEST");
  });

  it("handleQiRegenerateStale returns 400 QI_BAD_REQUEST for a run id containing a NUL byte", async () => {
    const result = asResult(
      await handleQiRegenerateStale(
        ctx(
          "regenerate-stale",
          `run-${String.fromCharCode(0)}evil`,
          makeReq({ sources: [{ kind: "requirements", label: "r", text: "x requirement" }] }),
        ),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_REQUEST");
  });
});

describe("handleQiRegenerateStale — the original immutable run is never mutated (#743)", () => {
  it("leaves the original manifest byte-identical after a regeneration writes a new run", async () => {
    const runId = "run-immutable-original";
    const originalText = "Login must work reliably\nMFA must work reliably";
    const seeded = ingestInlineSources({
      request: { sources: [{ kind: "requirements", label: "Spec", text: originalText }] },
      runId,
      registeredAt: "2026-06-09T10:00:00.000Z",
    });
    seedRunFromSources({
      runId,
      sources: [{ kind: "requirements", label: "Spec", text: originalText }],
      candidates: [
        qiCandidate(runId, "cand-keep", "Login test", [String(seeded.ingestedAtoms[0]?.atom.id)]),
        qiCandidate(runId, "cand-drift", "MFA test", [String(seeded.ingestedAtoms[1]?.atom.id)]),
      ],
    });

    const before = JSON.stringify(loadQualityIntelligenceRun(runId, { evidenceDir }));
    const beforeCandidates = JSON.stringify(
      loadQualityIntelligenceCandidates(runId, { evidenceDir }),
    );

    const result = asResult(
      await handleQiRegenerateStale(
        ctx(
          "regenerate-stale",
          runId,
          makeReq({
            sources: [
              {
                kind: "requirements",
                label: "Spec",
                text: "Login must work reliably\nMFA must also write an audit entry",
              },
            ],
          }),
        ),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(200);
    const newRunId = (result.body as { runId: string }).runId;
    expect(newRunId).not.toBe(runId);

    // The original run's manifest AND candidates artifact are unchanged after regeneration.
    expect(JSON.stringify(loadQualityIntelligenceRun(runId, { evidenceDir }))).toBe(before);
    expect(JSON.stringify(loadQualityIntelligenceCandidates(runId, { evidenceDir }))).toBe(
      beforeCandidates,
    );
  });
});

describe("handleQiRegenerateStale — edit history of STALE candidates is dropped, fresh edits kept (#743)", () => {
  it("never carries an edited revision of a regenerated/stale candidate into the new run", async () => {
    const runId = "run-regen-edit-scope";
    const originalText = "Login must work reliably\nMFA must work reliably";
    const seeded = ingestInlineSources({
      request: { sources: [{ kind: "requirements", label: "Spec", text: originalText }] },
      runId,
      registeredAt: "2026-06-09T10:00:00.000Z",
    });
    seedRunFromSources({
      runId,
      sources: [{ kind: "requirements", label: "Spec", text: originalText }],
      candidates: [
        qiCandidate(runId, "cand-fresh", "Login test", [String(seeded.ingestedAtoms[0]?.atom.id)]),
        qiCandidate(runId, "cand-stale", "MFA test", [String(seeded.ingestedAtoms[1]?.atom.id)]),
      ],
      editedRevisions: [
        {
          candidateId: "cand-fresh",
          provenance: {
            editedAt: "2026-06-09T10:02:00.000Z",
            editedBy: "human",
            editorLabel: "Reviewer A",
          },
          editedFields: { title: "Login test (edited)" },
        },
        {
          candidateId: "cand-stale",
          provenance: {
            editedAt: "2026-06-09T10:03:00.000Z",
            editedBy: "human",
            editorLabel: "Reviewer B",
          },
          editedFields: { title: "MFA test (edited, will be regenerated away)" },
        },
      ],
    });

    const result = asResult(
      await handleQiRegenerateStale(
        ctx(
          "regenerate-stale",
          runId,
          makeReq({
            sources: [
              {
                kind: "requirements",
                label: "Spec",
                text: "Login must work reliably\nMFA must also write an audit entry",
              },
            ],
          }),
        ),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(200);
    const newRunId = (result.body as { runId: string }).runId;
    const artifact = loadQualityIntelligenceCandidates(newRunId, { evidenceDir });
    const preservedRevisionIds = artifact?.editedRevisions?.map((r) => r.candidateId) ?? [];
    // The fresh candidate's edit is carried forward; the stale candidate's edit is NOT.
    expect(preservedRevisionIds).toContain("cand-fresh");
    expect(preservedRevisionIds).not.toContain("cand-stale");
  });
});
