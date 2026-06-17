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

import { EventEmitter } from "node:events";
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
import { QUALITY_INTELLIGENCE_DEFAULT_WORKFLOW_LIMITS } from "@oscharko-dev/keiko-workflows";
import { parseGatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import type {
  GatewayRequest,
  ModelCapability,
  NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
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

function closableCtx(
  handler: "re-check" | "regenerate-stale",
  runId: string,
  req: IncomingMessage,
): RouteContext {
  const res = new EventEmitter() as RouteContext["res"];
  Object.defineProperty(res, "writableEnded", { value: false, configurable: true });
  return { ...ctx(handler, runId, req), res };
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
        ...(entry.replacementGroupId !== undefined
          ? { replacementGroupId: entry.replacementGroupId }
          : {}),
        ...(entry.replacementOrdinal !== undefined
          ? { replacementOrdinal: entry.replacementOrdinal }
          : {}),
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

type CandidatesArtifact = NonNullable<ReturnType<typeof loadQualityIntelligenceCandidates>>;

function loadRequiredCandidatesArtifact(runId: string): CandidatesArtifact {
  const artifact = loadQualityIntelligenceCandidates(runId, { evidenceDir });
  expect(artifact).toBeDefined();
  if (artifact === undefined) throw new Error(`Missing candidates artifact for ${runId}`);
  return artifact;
}

function expectWorkspaceMarkdownRegenerationArtifact(args: {
  readonly runId: string;
  readonly changedAtomId: string;
  readonly unrelatedAddedAtomId: string;
}): void {
  const artifact = loadRequiredCandidatesArtifact(args.runId);
  const candidateIds = artifact.candidates.map((candidate) => candidate.id);
  expect(candidateIds).toContain("cand-doc-fresh");
  expect(candidateIds).not.toContain("cand-doc-stale");
  expect(artifact.editedRevisions?.map((revision) => revision.candidateId)).toEqual([
    "cand-doc-fresh",
  ]);
  const regenerated = artifact.candidates.filter((candidate) => candidate.id !== "cand-doc-fresh");
  expect(regenerated).toHaveLength(1);
  const [regeneratedCandidate] = regenerated;
  expect(regeneratedCandidate).toBeDefined();
  if (regeneratedCandidate === undefined) {
    throw new Error("Expected one regenerated candidate");
  }
  const atomIds = regeneratedCandidate.derivedFromAtomIds.map(String);
  expect(atomIds).toContain(args.changedAtomId);
  expect(atomIds).not.toContain(args.unrelatedAddedAtomId);
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

// ─── re-check: figma-snapshot screenIds parity (Issue #754 no-leak) ─────────────
//
// The re-check route shares the start-run route's figma-snapshot screenIds validator, so it must
// reject the SAME malformed scopes (empty array, over-cap) the start-run route does. Were they to
// diverge, a scoped figma run that generated correctly could re-check against the WHOLE board —
// reintroducing the scope leak on the drift path. A malformed source surfaces as parse-level
// QI_BAD_SOURCE (400) here, before the manifest is even loaded.
describe("handleQiReCheck — figma-snapshot screenIds parity (Issue #754)", () => {
  it("rejects a figma-snapshot source with an empty screenIds array", async () => {
    const body = {
      sources: [{ kind: "figma-snapshot", label: "Scope", snapshotRunId: "snap-1", screenIds: [] }],
    };
    const result = asResult(
      await handleQiReCheck(ctx("re-check", RUN_ID, makeReq(body)), deps(evidenceDir)),
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_SOURCE");
  });

  it("rejects a figma-snapshot source whose screenIds exceed the count cap", async () => {
    const body = {
      sources: [
        {
          kind: "figma-snapshot",
          label: "Scope",
          snapshotRunId: "snap-1",
          screenIds: Array.from({ length: 201 }, (_v, i) => `s-${String(i)}`),
        },
      ],
    };
    const result = asResult(
      await handleQiReCheck(ctx("re-check", RUN_ID, makeReq(body)), deps(evidenceDir)),
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_SOURCE");
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

describe("handleQiReCheck — missing candidates companion", () => {
  it("fails closed when the manifest says candidates exist but the companion is absent", async () => {
    rmSync(join(evidenceDir, "qi", `${RUN_ID}.candidates.json`));

    const result = asResult(
      await handleQiReCheck(
        ctx(
          "re-check",
          RUN_ID,
          makeReq({
            sources: [{ kind: "requirements", label: "req-1", text: "REQ-1: User can log in" }],
          }),
        ),
        deps(evidenceDir),
      ),
    );

    expect(result.status).toBe(500);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_CANDIDATES_MISSING");
  });
});

// ─── re-check: happy path — unchanged sources ─────────────────────────────────

describe("handleQiReCheck — unchanged source (same hash)", () => {
  it("returns 200 response shape when the stored fingerprint is artificial", async () => {
    // The default fixture stores HASH_AAA, not a hash produced by ingestInlineSources, so this
    // verifies only the response shape for a successful re-check.
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

  it("returns staleCount=0 with all original candidates fresh for an identical real-ingested source", async () => {
    const runId = "run-recheck-real-unchanged";
    const originalText = "Login must work reliably\nMFA must work reliably";
    const source = { kind: "requirements", label: "Spec", text: originalText } as const;
    const seeded = ingestInlineSources({
      request: { sources: [source] },
      runId,
      registeredAt: "2026-06-09T10:00:00.000Z",
    });
    expect(seeded.ingestedAtoms).toHaveLength(2);

    seedRunFromSources({
      runId,
      sources: [source],
      candidates: [
        qiCandidate(runId, "cand-unchanged-login", "Login test", [
          String(seeded.ingestedAtoms[0]?.atom.id),
        ]),
        qiCandidate(runId, "cand-unchanged-mfa", "MFA test", [
          String(seeded.ingestedAtoms[1]?.atom.id),
        ]),
      ],
    });

    const result = asResult(
      await handleQiReCheck(
        ctx("re-check", runId, makeReq({ sources: [source] })),
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
    expect(body.staleCount).toBe(0);
    expect([...body.fresh].sort()).toEqual(["cand-unchanged-login", "cand-unchanged-mfa"]);
    expect(body.changedStale).toHaveLength(0);
    expect(body.orphanedStale).toHaveLength(0);
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

describe("handleQiReCheck — legacy source-only fingerprints", () => {
  it("fails closed instead of reporting fresh when atom fingerprints are absent", async () => {
    const runId = "run-recheck-source-only";
    const originalText = "Login must work reliably\nMFA must work reliably";
    const source = { kind: "requirements", label: "Spec", text: originalText } as const;
    const seeded = ingestInlineSources({
      request: { sources: [source] },
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
        totals: { candidates: 2, findings: 0, exports: 0 },
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
        qiCandidate(runId, "cand-source-only-login", "Login test", [
          String(seeded.ingestedAtoms[0]?.atom.id),
        ]),
        qiCandidate(runId, "cand-source-only-mfa", "MFA test", [
          String(seeded.ingestedAtoms[1]?.atom.id),
        ]),
      ],
      evidenceDir,
      redact: (value: unknown): unknown => value,
    });

    const result = asResult(
      await handleQiReCheck(
        ctx("re-check", runId, makeReq({ sources: [source] })),
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
    expect(body.fresh).toHaveLength(0);
    expect(body.staleCount).toBe(2);
    expect(body.changedStale.length + body.orphanedStale.length).toBe(2);
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

// Issue #763 (Epic #761) AC2: model provenance (modelId / seedUsed / modelParameters) of a
// MODEL-attributed regeneration must be carried forward onto the merged run record so a re-checked
// run stays attributable. The existing coverage only asserts the no-model path (modelId/seedUsed
// undefined); the `optionalModelFields` carry-forward (`regeneratedManifest.modelId !== undefined`
// etc.) is mutation-blind without a model-backed regeneration that actually sets those fields.
describe("handleQiRegenerateStale — carries model provenance forward (Issue #763)", () => {
  const MODEL_ID = "recheck-chat-model";

  function chatCapability(modelId: string): ModelCapability {
    return {
      id: modelId,
      kind: "chat",
      contextWindow: 128_000,
      maxOutputTokens: 4_096,
      toolCalling: true,
      structuredOutput: true,
      streaming: true,
      supportsImageInput: false,
      supportsDocumentInput: false,
      supportsResponseFormat: true,
      workflowEligible: true,
      costClass: "medium",
      latencyClass: "standard",
      throughputHint: "test",
      preferredUseCases: ["Chat"],
      knownLimitations: [],
    };
  }

  // Canned generation output covering the regenerated atom; the judge call (different shape) fails
  // soft and never blocks the succeeded run, so the model id is still attributed.
  const REGEN_CANDIDATES_JSON = JSON.stringify({
    testCases: [
      {
        title: "Verify MFA writes an audit entry on login",
        preconditions: ["An audit user exists."],
        steps: ["Log in with MFA."],
        expectedResults: ["An audit entry is written."],
        priority: "P1",
        riskClass: "compliance",
        derivedFromEvidenceIndexes: [1],
        tags: ["audit-login"],
      },
    ],
  });

  function fakeChatPort(content: string): ModelPort {
    return {
      call: (req: GatewayRequest, _signal: AbortSignal): Promise<NormalizedResponse> =>
        Promise.resolve({
          content,
          modelId: req.modelId,
          finishReason: "stop",
          toolCalls: [],
          structuredOutput: null,
          usage: {
            requestId: "req-test",
            promptTokens: 10,
            completionTokens: 5,
            latencyMs: 1,
            costClass: "medium",
          },
        }),
    };
  }

  function depsWithModel(dir: string): UiHandlerDeps {
    const config = parseGatewayConfig(
      {
        providers: [
          {
            modelId: MODEL_ID,
            baseUrl: "https://fake.example.com/v1",
            apiKey: "fake-key",
            capability: chatCapability(MODEL_ID),
          },
        ],
      },
      {},
    );
    const port = fakeChatPort(REGEN_CANDIDATES_JSON);
    return {
      config,
      configPresent: true,
      evidenceStore: emptyStore(),
      env: {},
      redactor: buildRedactor({}, config),
      registry: createRunRegistry(),
      modelPortFactory: (): ModelPort => port,
      store: createInMemoryUiStore(),
      evidenceDir: dir,
    };
  }

  it("carries the regenerated run's modelId and seedUsed onto the merged run", async () => {
    const runId = "run-model-recheck";
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
        qiCandidate(runId, "cand-login", "Login test", [String(seeded.ingestedAtoms[0]?.atom.id)]),
        qiCandidate(runId, "cand-mfa", "MFA test", [String(seeded.ingestedAtoms[1]?.atom.id)]),
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
        depsWithModel(evidenceDir),
      ),
    );
    expect(result.status).toBe(200);
    const newRunId = (result.body as { runId: string }).runId;
    expect(newRunId).not.toBe(runId);
    const manifest = loadQualityIntelligenceRun(newRunId, { evidenceDir });
    expect(manifest?.status).toBe("succeeded");
    // The regeneration ran a model, so the merged run is model-attributed (not the baseline path).
    expect(manifest?.modelId).toBe(MODEL_ID);
    expect(manifest?.modelParameters).toEqual({ responseFormat: "json_schema" });
    // No seed flows through the regenerate path, so a model run records seedUsed: null (not absent).
    expect(manifest?.seedUsed).toBeNull();
  });
});

// Persist-time secret redaction parity with the initial-run path (Issue #747 defence-in-depth). The
// regenerate-stale endpoint forwards regenerated judge rationales into the on-disk MERGED manifest;
// the live additionalSecrets list must reach that manifest writer too, otherwise a configured
// provider secret echoed in a rationale that the security-package builtin patterns do not match would
// survive on disk. Mirrors runExecution.test.ts "redacts configured provider secrets from persisted
// judge rationales".
describe("handleQiRegenerateStale — redacts configured provider secrets from merged judge rationales (#747)", () => {
  const MODEL_ID = "recheck-judge-model";
  // A configured provider secret whose shape matches NONE of the security-package builtin patterns
  // (not sk-/ghp_/AWS/assignment shaped), so only the additionalSecrets list can scrub it.
  const PROVIDER_SECRET = "literal-provider-secret-qi-regen-747";

  function chatCapability(modelId: string): ModelCapability {
    return {
      id: modelId,
      kind: "chat",
      contextWindow: 128_000,
      maxOutputTokens: 4_096,
      toolCalling: true,
      structuredOutput: true,
      streaming: true,
      supportsImageInput: false,
      supportsDocumentInput: false,
      supportsResponseFormat: true,
      workflowEligible: true,
      costClass: "medium",
      latencyClass: "standard",
      throughputHint: "test",
      preferredUseCases: ["Chat"],
      knownLimitations: [],
    };
  }

  const REGEN_CANDIDATES_JSON = JSON.stringify({
    testCases: [
      {
        title: "Verify MFA writes an audit entry on login",
        preconditions: ["An audit user exists."],
        steps: ["Log in with MFA."],
        expectedResults: ["An audit entry is written."],
        priority: "P1",
        riskClass: "compliance",
        derivedFromEvidenceIndexes: [1],
        tags: ["audit-login"],
      },
    ],
  });

  const WEAK_JUDGE_VERDICT_JSON = JSON.stringify({
    dimensions: [
      {
        name: "verifiability",
        score: 10,
        rationale: `The candidate is unverifiable and echoed ${PROVIDER_SECRET}.`,
      },
      { name: "atomicity", score: 20, rationale: "too broad" },
      { name: "determinism", score: 15, rationale: "timing-sensitive" },
      { name: "ac-fidelity", score: 10, rationale: "misses the acceptance criteria" },
    ],
    overallRationale: `Weak: the rationale repeated ${PROVIDER_SECRET}.`,
  });

  // Returns the judge verdict for the judge call (recognised by the judge system prompt) and the
  // generation JSON otherwise, so a single port serves both the generation and judge dispatches.
  function judgeAwarePort(): ModelPort {
    return {
      call: (req: GatewayRequest, _signal: AbortSignal): Promise<NormalizedResponse> => {
        const isJudge = req.messages.some(
          (m) => m.role === "system" && m.content.includes("test-quality judge"),
        );
        return Promise.resolve({
          content: isJudge ? WEAK_JUDGE_VERDICT_JSON : REGEN_CANDIDATES_JSON,
          modelId: req.modelId,
          finishReason: "stop",
          toolCalls: [],
          structuredOutput: null,
          usage: {
            requestId: "req-test",
            promptTokens: 10,
            completionTokens: 5,
            latencyMs: 1,
            costClass: "medium",
          },
        });
      },
    };
  }

  function depsWithSecretApiKey(dir: string): UiHandlerDeps {
    const config = parseGatewayConfig(
      {
        providers: [
          {
            modelId: MODEL_ID,
            baseUrl: "https://fake.example.com/v1",
            apiKey: PROVIDER_SECRET,
            capability: chatCapability(MODEL_ID),
          },
        ],
      },
      {},
    );
    const port = judgeAwarePort();
    return {
      config,
      configPresent: true,
      evidenceStore: emptyStore(),
      env: {},
      redactor: buildRedactor({}, config),
      registry: createRunRegistry(),
      modelPortFactory: (): ModelPort => port,
      store: createInMemoryUiStore(),
      evidenceDir: dir,
    };
  }

  it("scrubs the secret from the persisted merged manifest's judge rationale", async () => {
    const runId = "run-regen-redaction";
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
        qiCandidate(runId, "cand-login", "Login test", [String(seeded.ingestedAtoms[0]?.atom.id)]),
        qiCandidate(runId, "cand-mfa", "MFA test", [String(seeded.ingestedAtoms[1]?.atom.id)]),
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
        depsWithSecretApiKey(evidenceDir),
      ),
    );
    expect(result.status).toBe(200);
    const newRunId = (result.body as { runId: string }).runId;
    const manifest = loadQualityIntelligenceRun(newRunId, { evidenceDir });
    expect(manifest?.status).toBe("succeeded");
    // Non-vacuous: the regenerated judge produced a persisted test-quality finding...
    const testQualityFindings = (manifest?.findings ?? []).filter(
      (finding) => finding.kind === "test-quality",
    );
    expect(testQualityFindings.length).toBeGreaterThan(0);
    // ...and the configured provider secret it echoed is scrubbed from the on-disk manifest.
    const persistedFindings = JSON.stringify(testQualityFindings);
    expect(persistedFindings).toContain("[REDACTED]");
    expect(persistedFindings).not.toContain(PROVIDER_SECRET);
    expect(JSON.stringify(manifest)).not.toContain(PROVIDER_SECRET);
  });
});

describe("handleQiRegenerateStale — no stale candidates still materialises a new run (#743)", () => {
  it("writes a new immutable run preserving all candidates and edits when nothing is stale", async () => {
    const runId = "run-regen-no-stale";
    const originalText = "Login must work reliably\nMFA must work reliably";
    const source = { kind: "requirements", label: "Spec", text: originalText } as const;
    const seeded = ingestInlineSources({
      request: { sources: [source] },
      runId,
      registeredAt: "2026-06-09T10:00:00.000Z",
    });
    seedRunFromSources({
      runId,
      sources: [source],
      candidates: [
        qiCandidate(runId, "cand-no-stale-login", "Login test", [
          String(seeded.ingestedAtoms[0]?.atom.id),
        ]),
        qiCandidate(runId, "cand-no-stale-mfa", "MFA test", [
          String(seeded.ingestedAtoms[1]?.atom.id),
        ]),
      ],
      editedRevisions: [
        {
          candidateId: "cand-no-stale-login",
          provenance: {
            editedAt: "2026-06-09T10:02:00.000Z",
            editedBy: "human",
            editorLabel: "Reviewer A",
          },
          editedFields: { title: "Login test (edited)" },
        },
      ],
    });
    const beforeManifest = JSON.stringify(loadQualityIntelligenceRun(runId, { evidenceDir }));
    const beforeArtifact = JSON.stringify(
      loadQualityIntelligenceCandidates(runId, { evidenceDir }),
    );

    const result = asResult(
      await handleQiRegenerateStale(
        ctx("regenerate-stale", runId, makeReq({ sources: [source] })),
        deps(evidenceDir),
      ),
    );

    expect(result.status).toBe(200);
    const body = result.body as {
      runId: string;
      regeneratedCount: number;
      preservedCount: number;
    };
    expect(body.runId).not.toBe(runId);
    expect(body.regeneratedCount).toBe(0);
    expect(body.preservedCount).toBe(2);
    expect(JSON.stringify(loadQualityIntelligenceRun(runId, { evidenceDir }))).toBe(beforeManifest);
    expect(JSON.stringify(loadQualityIntelligenceCandidates(runId, { evidenceDir }))).toBe(
      beforeArtifact,
    );
    const newManifest = loadQualityIntelligenceRun(body.runId, { evidenceDir });
    expect(newManifest?.runId).toBe(body.runId);
    expect(newManifest?.status).toBe("succeeded");
    expect(newManifest?.totals.candidates).toBe(2);
    expect(listQualityIntelligenceRuns({ evidenceDir })).toContain(body.runId);
    const artifact = loadQualityIntelligenceCandidates(body.runId, { evidenceDir });
    expect(artifact?.candidates.map((candidate) => candidate.id).sort()).toEqual([
      "cand-no-stale-login",
      "cand-no-stale-mfa",
    ]);
    expect(artifact?.editedRevisions?.map((revision) => revision.candidateId)).toEqual([
      "cand-no-stale-login",
    ]);
  });
});

describe("handleQiRegenerateStale — candidate artifact persistence (#735)", () => {
  it("does not persist a new run after the client response closes", async () => {
    const runId = "run-regen-client-closed";
    const source = {
      kind: "requirements",
      label: "Spec",
      text: "Login must work reliably",
    } as const;
    const seeded = ingestInlineSources({
      request: { sources: [source] },
      runId,
      registeredAt: "2026-06-09T10:00:00.000Z",
    });
    seedRunFromSources({
      runId,
      sources: [source],
      candidates: [
        qiCandidate(runId, "cand-client-closed-login", "Login test", [
          String(seeded.ingestedAtoms[0]?.atom.id),
        ]),
      ],
    });
    const beforeRunIds = listQualityIntelligenceRuns({ evidenceDir });
    const c = closableCtx("regenerate-stale", runId, makeReq({ sources: [source] }));

    const pending = handleQiRegenerateStale(c, deps(evidenceDir));
    c.res.emit("close");
    const result = asResult(await pending);

    expect(result.status).toBe(499);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_REQUEST_CANCELLED");
    expect(listQualityIntelligenceRuns({ evidenceDir })).toEqual(beforeRunIds);
  });

  it("does not expose a new run when the candidate artifact write fails", async () => {
    const runId = "run-regen-artifact-write-fails";
    const source = {
      kind: "requirements",
      label: "Spec",
      text: "Login must work reliably",
    } as const;
    const seeded = ingestInlineSources({
      request: { sources: [source] },
      runId,
      registeredAt: "2026-06-09T10:00:00.000Z",
    });
    seedRunFromSources({
      runId,
      sources: [source],
      candidates: [
        qiCandidate(runId, "cand-artifact-fail-login", "Login test", [
          String(seeded.ingestedAtoms[0]?.atom.id),
        ]),
      ],
    });
    const beforeRunIds = listQualityIntelligenceRuns({ evidenceDir });
    const beforeManifest = JSON.stringify(loadQualityIntelligenceRun(runId, { evidenceDir }));
    const beforeArtifact = JSON.stringify(
      loadQualityIntelligenceCandidates(runId, { evidenceDir }),
    );

    const failingDeps: UiHandlerDeps = {
      ...deps(evidenceDir),
      redactor: () => {
        throw new Error("candidate artifact redaction failed");
      },
    };
    const result = asResult(
      await handleQiRegenerateStale(
        ctx("regenerate-stale", runId, makeReq({ sources: [source] })),
        failingDeps,
      ),
    );

    expect(result.status).toBe(500);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_REGEN_FAILED");
    expect(listQualityIntelligenceRuns({ evidenceDir })).toEqual(beforeRunIds);
    expect(JSON.stringify(loadQualityIntelligenceRun(runId, { evidenceDir }))).toBe(beforeManifest);
    expect(JSON.stringify(loadQualityIntelligenceCandidates(runId, { evidenceDir }))).toBe(
      beforeArtifact,
    );
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

  it("marks a deleted requirement line as orphaned-stale, not changed-stale", async () => {
    const runId = "run-req-atom-removed";
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
        qiCandidate(runId, "cand-kept-line", "Login test", [
          String(seeded.ingestedAtoms[0]?.atom.id),
        ]),
        qiCandidate(runId, "cand-deleted-line", "MFA test", [
          String(seeded.ingestedAtoms[1]?.atom.id),
        ]),
      ],
    });

    const result = asResult(
      await handleQiReCheck(
        ctx(
          "re-check",
          runId,
          makeReq({
            sources: [{ kind: "requirements", label: "Spec", text: "Login must work reliably" }],
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
      orphanedStale: readonly { candidateId: string; reason: string; envelopeId: string }[];
    };
    expect(body.staleCount).toBe(1);
    expect(body.fresh).toEqual(["cand-kept-line"]);
    expect(body.changedStale).toHaveLength(0);
    expect(body.orphanedStale).toEqual([
      expect.objectContaining({
        candidateId: "cand-deleted-line",
        reason: "source-removed",
      }),
    ]);
  });

  it("classifies an empty current requirements source as all orphaned-stale", async () => {
    const runId = "run-req-current-empty";
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
        qiCandidate(runId, "cand-empty-login", "Login test", [
          String(seeded.ingestedAtoms[0]?.atom.id),
        ]),
        qiCandidate(runId, "cand-empty-mfa", "MFA test", [
          String(seeded.ingestedAtoms[1]?.atom.id),
        ]),
      ],
    });

    const result = asResult(
      await handleQiReCheck(
        ctx(
          "re-check",
          runId,
          makeReq({ sources: [{ kind: "requirements", label: "Spec", text: " \n\t " }] }),
        ),
        deps(evidenceDir),
      ),
    );

    expect(result.status).toBe(200);
    const body = result.body as {
      staleCount: number;
      fresh: readonly string[];
      changedStale: readonly { candidateId: string; reason: string; envelopeId: string }[];
      orphanedStale: readonly { candidateId: string; reason: string; envelopeId: string }[];
    };
    expect(body.staleCount).toBe(2);
    expect(body.fresh).toEqual([]);
    expect(body.changedStale).toEqual([]);
    expect(body.orphanedStale).toEqual([
      expect.objectContaining({ candidateId: "cand-empty-login", reason: "source-removed" }),
      expect.objectContaining({ candidateId: "cand-empty-mfa", reason: "source-removed" }),
    ]);
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

describe("handleQiRegenerateStale — requirement replacements are positional (#743)", () => {
  it("regenerates only the edited requirement line and ignores unrelated newly-added lines", async () => {
    const runId = "run-regen-requirement-positional";
    const originalText = "Login must work reliably\nMFA must work reliably";
    const currentText =
      "Login must work reliably\nMFA must also write an audit entry\nReports must export as CSV";
    const seeded = ingestInlineSources({
      request: { sources: [{ kind: "requirements", label: "Spec", text: originalText }] },
      runId,
      registeredAt: "2026-06-09T10:00:00.000Z",
    });
    const current = ingestInlineSources({
      request: { sources: [{ kind: "requirements", label: "Spec", text: currentText }] },
      runId,
      registeredAt: "2026-06-09T10:00:00.000Z",
    });
    seedRunFromSources({
      runId,
      sources: [{ kind: "requirements", label: "Spec", text: originalText }],
      candidates: [
        qiCandidate(runId, "cand-positional-fresh", "Login test", [
          String(seeded.ingestedAtoms[0]?.atom.id),
        ]),
        qiCandidate(runId, "cand-positional-stale", "MFA test", [
          String(seeded.ingestedAtoms[1]?.atom.id),
        ]),
      ],
    });

    const result = asResult(
      await handleQiRegenerateStale(
        ctx(
          "regenerate-stale",
          runId,
          makeReq({ sources: [{ kind: "requirements", label: "Spec", text: currentText }] }),
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
    expect(artifact?.candidates).toHaveLength(2);
    expect(artifact?.candidates.map((candidate) => candidate.id)).toContain(
      "cand-positional-fresh",
    );
    const unrelatedAddedAtomId = String(current.ingestedAtoms[2]?.atom.id);
    expect(
      artifact?.candidates.some((candidate) =>
        candidate.derivedFromAtomIds.map(String).includes(unrelatedAddedAtomId),
      ),
    ).toBe(false);
  });

  it("regenerates only the edited requirement line inside a workspace Markdown document", async () => {
    const runId = "run-regen-workspace-markdown-requirement";
    const dir = mkdtempSync(join(tmpdir(), "qi-regen-doc-"));
    try {
      const specPath = join(dir, "fachkonzept.md");
      const originalText = [
        "# Fachkonzept",
        "",
        "Login must work reliably for every registered user.",
        "Payments must support card capture for approved orders.",
      ].join("\n");
      const currentText = [
        "# Fachkonzept",
        "",
        "Reports must export CSV summaries for finance users.",
        "Login must work reliably for every registered user.",
        "Payments must support card capture and PayPal for approved orders.",
      ].join("\n");
      writeFileSync(specPath, originalText, "utf8");
      const seeded = ingestInlineSources({
        request: { sources: [{ kind: "workspace", label: "Repo", path: dir }] },
        runId,
        registeredAt: "2026-06-09T10:00:00.000Z",
      });
      expect(seeded.ingestedAtoms).toHaveLength(2);
      seedRunFromSources({
        runId,
        sources: [{ kind: "workspace", label: "Repo", path: dir }],
        candidates: [
          qiCandidate(runId, "cand-doc-fresh", "Login test", [
            String(seeded.ingestedAtoms[0]?.atom.id),
          ]),
          qiCandidate(runId, "cand-doc-stale", "Payment test", [
            String(seeded.ingestedAtoms[1]?.atom.id),
          ]),
        ],
        editedRevisions: [
          {
            candidateId: "cand-doc-fresh",
            provenance: {
              editedAt: "2026-06-09T10:02:00.000Z",
              editedBy: "human",
              editorLabel: "Reviewer A",
            },
            editedFields: { title: "Login test (edited)" },
          },
        ],
      });
      const beforeManifest = JSON.stringify(loadQualityIntelligenceRun(runId, { evidenceDir }));
      const beforeArtifact = JSON.stringify(
        loadQualityIntelligenceCandidates(runId, { evidenceDir }),
      );

      writeFileSync(specPath, currentText, "utf8");
      const current = ingestInlineSources({
        request: { sources: [{ kind: "workspace", label: "Repo", path: dir }] },
        runId,
        registeredAt: "2026-06-09T10:00:00.000Z",
      });
      expect(current.ingestedAtoms).toHaveLength(3);
      const unrelatedAddedAtomId = String(current.ingestedAtoms[0]?.atom.id);
      const changedAtomId = String(current.ingestedAtoms[2]?.atom.id);

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

      expect(result.status).toBe(200);
      const body = result.body as {
        runId: string;
        regeneratedCount: number;
        preservedCount: number;
      };
      expect(body.regeneratedCount).toBe(1);
      expect(body.preservedCount).toBe(1);
      expect(JSON.stringify(loadQualityIntelligenceRun(runId, { evidenceDir }))).toBe(
        beforeManifest,
      );
      expect(JSON.stringify(loadQualityIntelligenceCandidates(runId, { evidenceDir }))).toBe(
        beforeArtifact,
      );
      expectWorkspaceMarkdownRegenerationArtifact({
        runId: body.runId,
        changedAtomId,
        unrelatedAddedAtomId,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("handleQiRegenerateStale — merged candidate budget (#743)", () => {
  it("fails closed without writing a new run when preserved plus regenerated candidates exceed the cap", async () => {
    const runId = "run-regen-candidate-cap";
    const originalText =
      "Login must work reliably\nMFA must work reliably\nReports must export as CSV";
    const currentText =
      "Login must work reliably\nMFA must also write an audit entry\nReports must export as PDF";
    const seeded = ingestInlineSources({
      request: { sources: [{ kind: "requirements", label: "Spec", text: originalText }] },
      runId,
      registeredAt: "2026-06-09T10:00:00.000Z",
    });
    const limit = QUALITY_INTELLIGENCE_DEFAULT_WORKFLOW_LIMITS.maxCandidatesPerRun;
    const preserved = Array.from({ length: limit - 1 }, (_, index) =>
      qiCandidate(runId, `cand-cap-preserved-${String(index)}`, `Login test ${String(index)}`, [
        String(seeded.ingestedAtoms[0]?.atom.id),
      ]),
    );
    seedRunFromSources({
      runId,
      sources: [{ kind: "requirements", label: "Spec", text: originalText }],
      candidates: [
        ...preserved,
        qiCandidate(runId, "cand-cap-stale-mfa", "MFA test", [
          String(seeded.ingestedAtoms[1]?.atom.id),
        ]),
        qiCandidate(runId, "cand-cap-stale-reports", "Reports test", [
          String(seeded.ingestedAtoms[2]?.atom.id),
        ]),
      ],
    });

    const beforeRunIds = listQualityIntelligenceRuns({ evidenceDir });
    const result = asResult(
      await handleQiRegenerateStale(
        ctx(
          "regenerate-stale",
          runId,
          makeReq({ sources: [{ kind: "requirements", label: "Spec", text: currentText }] }),
        ),
        deps(evidenceDir),
      ),
    );

    expect(result.status).toBe(409);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "QI_REGEN_CANDIDATE_CAP_EXCEEDED",
    );
    expect(listQualityIntelligenceRuns({ evidenceDir })).toEqual(beforeRunIds);
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

// ─── merged findings: severity-sort + per-run cap parity with the initial run path (#743) ──────
//
// The initial run path (modelRoutedTestDesign) orders findings by severity BEFORE truncating to
// maxFindingsPerRun, so high-severity findings (including uncovered-requirement coverage gaps)
// always survive the per-run cap. The re-check merge path assembles preserved + regenerated +
// coverage-gap findings and MUST apply the same sort-then-cap so the two production persist paths
// converge: a re-check whose merged findings exceed the cap persists exactly maxFindingsPerRun
// rows, severity-ordered, with the most-severe rows retained.
//
// The cap is sourced from QUALITY_INTELLIGENCE_DEFAULT_WORKFLOW_LIMITS.maxFindingsPerRun because the
// re-check regeneration sub-run (regenWorkflowDeps) passes no custom `limits` and therefore runs
// under the default workflow limits — keeping the merge cap consistent with the sub-run's own cap.
//
// Fixture note: a single inline source ingests at most MAX_TOTAL_ATOMS (120) atoms, so coverage-gap
// rows alone cannot exceed the 512 cap. To build a deterministic >512 merged set we carry forward
// preserved test-quality (judge) findings from the seeded old manifest — filteredJudgeFindings keeps
// every "test-quality" finding whose candidateId is preserved — mixed in severity, plus a single
// high-severity uncovered coverage gap. Identical sources => zero stale => the merge path runs with
// no baseline regeneration, so the persisted finding set is fully deterministic.
describe("handleQiRegenerateStale — merged findings are severity-sorted and capped like the initial run path (#743)", () => {
  const CAP = QUALITY_INTELLIGENCE_DEFAULT_WORKFLOW_LIMITS.maxFindingsPerRun;
  const SEVERITY_RANK = QualityIntelligence.QUALITY_INTELLIGENCE_SEVERITY_RANK;

  function judgeFinding(
    index: number,
    candidateId: string,
    severity: QualityIntelligence.QualityIntelligenceSeverity,
  ): Parameters<typeof recordQualityIntelligenceRun>[0]["findings"][number] {
    return {
      id: `qi-finding-judge-${String(index)}`,
      kind: "test-quality",
      severity,
      summaryRedacted: `Judge finding ${String(index)} (${severity}).`,
      candidateId,
    };
  }

  it("persists exactly maxFindingsPerRun severity-ordered findings, keeping a high coverage gap and dropping low ones", async () => {
    const runId = "run-regen-findings-cap";
    // Two requirement lines => two atoms. The first is covered by the preserved candidate (no gap);
    // the second has no covering candidate, yielding one high-severity uncovered coverage gap.
    const text = "Login must work reliably\nMFA must work reliably";
    const seeded = ingestInlineSources({
      request: { sources: [{ kind: "requirements", label: "Spec", text }] },
      runId,
      registeredAt: "2026-06-09T10:00:00.000Z",
    });
    const coveredAtomId = String(seeded.ingestedAtoms[0]?.atom.id);

    // Build a >CAP judge-finding set with a controlled severity mix, all scoped to the preserved
    // candidate so filteredJudgeFindings carries every one forward into the merge:
    //   - a handful of `critical` (rank 0, ahead of the high coverage gap),
    //   - enough `medium` (rank 2) to comfortably overshoot the cap,
    //   - a tail of `low` (rank 3) that MUST be dropped once the cap is hit.
    const criticalCount = 5;
    const mediumCount = CAP + 20; // overshoot the cap with mid-severity rows alone
    const lowCount = 40; // these are the rows the cap must drop after sorting
    const seededFindings = [
      ...Array.from({ length: criticalCount }, (_, i) => judgeFinding(i, "cand-cov", "critical")),
      ...Array.from({ length: mediumCount }, (_, i) =>
        judgeFinding(criticalCount + i, "cand-cov", "medium"),
      ),
      ...Array.from({ length: lowCount }, (_, i) =>
        judgeFinding(criticalCount + mediumCount + i, "cand-cov", "low"),
      ),
    ];

    seedRunFromSources({
      runId,
      sources: [{ kind: "requirements", label: "Spec", text }],
      candidates: [qiCandidate(runId, "cand-cov", "Login test", [coveredAtomId])],
      findings: seededFindings,
    });

    // Identical sources => nothing stale => deterministic merge with no baseline regeneration.
    const result = asResult(
      await handleQiRegenerateStale(
        ctx(
          "regenerate-stale",
          runId,
          makeReq({ sources: [{ kind: "requirements", label: "Spec", text }] }),
        ),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(200);
    const newRunId = (result.body as { runId: string }).runId;
    const manifest = loadQualityIntelligenceRun(newRunId, { evidenceDir });
    const findings = manifest?.findings ?? [];

    // AC1 (cap): the merged set far exceeds the cap pre-truncation, so exactly CAP rows persist, and
    // totals.findings stays equal to the persisted length.
    expect(seededFindings.length).toBeGreaterThan(CAP);
    expect(findings).toHaveLength(CAP);
    expect(manifest?.totals.findings).toBe(CAP);

    // AC2 (severity order): ranks are non-decreasing across the persisted array (critical -> low).
    const ranks = findings.map((row) => SEVERITY_RANK[row.severity]);
    for (let i = 1; i < ranks.length; i += 1) {
      expect(ranks[i] ?? 0).toBeGreaterThanOrEqual(ranks[i - 1] ?? 0);
    }

    // AC3 (high coverage gap survives): the uncovered second requirement's high coverage-gap finding
    // is kept despite the cap, and ALL critical judge findings survive while the low tail is dropped.
    expect(findings.some((row) => row.kind === "coverage-gap" && row.severity === "high")).toBe(
      true,
    );
    expect(findings.filter((row) => row.severity === "critical")).toHaveLength(criticalCount);
    expect(findings.some((row) => row.severity === "low")).toBe(false);
  });
});

// ─── TEST 2 — FIX 2 (GAP-B): buildMergedCandidates deduplication (#1131) ──────
//
// Before the fix buildMergedCandidates returned [...preserved, ...regenerated] without
// deduplication, so a preserved candidate whose content was regenerated byte-for-byte
// identically (e.g. baseline no-model mode) would appear TWICE in the candidates artifact.
// The fix wraps the concat in deduplicateCandidates(). This test seeds ONE preserved
// candidate and ONE stale candidate whose regenerated replacement is CONTENT-IDENTICAL to
// the preserved one (same title/steps/expectedResults/priority/riskClass/preconditions).
// After deduplication the artifact must contain exactly ONE merged candidate, not two.
//
// RED-verify: revert reCheckRoutes.ts:1131 to the plain concat → artifact has 2 entries
// → expect(...).toHaveLength(1) fails. Restore → green.
describe("handleQiRegenerateStale — buildMergedCandidates deduplicates equivalent candidates (Fix #1131 GAP-B)", () => {
  it("collapses a regenerated candidate that is content-identical to a preserved one into a single entry", async () => {
    // Arrange: seed a run with two requirements atoms.
    //   - atom[0] → cand-dedup-login   (will be PRESERVED: atom unchanged in re-check)
    //   - atom[1] → cand-dedup-reports (will be STALE: atom content changes)
    // The baseline regeneration for the stale atom happens to produce a candidate whose
    // title, steps, expectedResults, priority, riskClass, and preconditions are IDENTICAL
    // to the preserved candidate.  deduplicateCandidates must collapse them to one.
    const runId = "run-regen-dedup-fix-1131";
    const originalText =
      "Login must work reliably for every registered user.\n" +
      "Reports must export to PDF for finance teams.";
    const seeded = ingestInlineSources({
      request: { sources: [{ kind: "requirements", label: "Spec", text: originalText }] },
      runId,
      registeredAt: "2026-06-09T10:00:00.000Z",
    });
    expect(seeded.ingestedAtoms).toHaveLength(2);

    // The SHARED content that both the preserved and the regenerated candidate will carry.
    // Using a helper: qiCandidate() fills preconditions=[], steps=["Step 1"],
    // expectedResults=["Expected 1"], priority="P2", riskClass="regression".
    const sharedTitle = "Verify login works for every registered user";
    seedRunFromSources({
      runId,
      sources: [{ kind: "requirements", label: "Spec", text: originalText }],
      candidates: [
        // Preserved: tied to atom[0] — will NOT be stale.
        {
          id: QualityIntelligence.asQualityIntelligenceTestCaseId("cand-dedup-login"),
          runId: QualityIntelligence.asQualityIntelligenceRunId(runId),
          derivedFromAtomIds: [
            QualityIntelligence.asQualityIntelligenceEvidenceAtomId(
              String(seeded.ingestedAtoms[0]?.atom.id),
            ),
          ],
          title: sharedTitle,
          preconditions: [],
          steps: ["Navigate to login", "Enter valid credentials", "Click submit"],
          expectedResults: ["User is redirected to the dashboard"],
          priority: "P1" as const,
          riskClass: "functional" as const,
          tags: [],
          status: "proposed" as const,
        },
        // Stale: tied to atom[1] — will BE stale when its requirement changes.
        qiCandidate(runId, "cand-dedup-reports", "Reports test", [
          String(seeded.ingestedAtoms[1]?.atom.id),
        ]),
      ],
    });

    // Act: re-check with the second requirement changed so cand-dedup-reports is stale.
    // No model is configured → baseline regeneration.  We rely on the baseline producing
    // a structural candidate from the same atom text; what matters is NOT the exact
    // regenerated title but rather that we can force a collision — so we use the
    // no-model baseline and override the candidate artifact post-regeneration would be
    // too complex.  Instead we use a model port that returns content-identical JSON.
    const CLONE_CANDIDATES_JSON = JSON.stringify({
      testCases: [
        {
          title: sharedTitle,
          preconditions: [],
          steps: ["Navigate to login", "Enter valid credentials", "Click submit"],
          expectedResults: ["User is redirected to the dashboard"],
          priority: "P1",
          riskClass: "functional",
          derivedFromEvidenceIndexes: [1],
          tags: [],
        },
      ],
    });

    function chatCapabilityDedup(modelId: string): ModelCapability {
      return {
        id: modelId,
        kind: "chat",
        contextWindow: 128_000,
        maxOutputTokens: 4_096,
        toolCalling: true,
        structuredOutput: true,
        streaming: true,
        supportsImageInput: false,
        supportsDocumentInput: false,
        supportsResponseFormat: true,
        workflowEligible: true,
        costClass: "medium",
        latencyClass: "standard",
        throughputHint: "test",
        preferredUseCases: ["Chat"],
        knownLimitations: [],
      };
    }

    const DEDUP_MODEL_ID = "dedup-chat-model";
    const dedupConfig = parseGatewayConfig(
      {
        providers: [
          {
            modelId: DEDUP_MODEL_ID,
            baseUrl: "https://fake.example.com/v1",
            apiKey: "fake-key",
            capability: chatCapabilityDedup(DEDUP_MODEL_ID),
          },
        ],
      },
      {},
    );
    const dedupDeps: UiHandlerDeps = {
      config: dedupConfig,
      configPresent: true,
      evidenceStore: emptyStore(),
      env: {},
      redactor: buildRedactor({}, dedupConfig),
      registry: createRunRegistry(),
      modelPortFactory: (): ModelPort => ({
        call: (req: GatewayRequest, _signal: AbortSignal): Promise<NormalizedResponse> =>
          Promise.resolve({
            content: CLONE_CANDIDATES_JSON,
            modelId: req.modelId,
            finishReason: "stop",
            toolCalls: [],
            structuredOutput: null,
            usage: {
              requestId: "req-dedup-test",
              promptTokens: 10,
              completionTokens: 5,
              latencyMs: 1,
              costClass: "medium",
            },
          }),
      }),
      store: createInMemoryUiStore(),
      evidenceDir,
    };

    const changedText =
      "Login must work reliably for every registered user.\n" +
      "Reports must now export to CSV and PDF for finance teams.";
    const result = asResult(
      await handleQiRegenerateStale(
        ctx(
          "regenerate-stale",
          runId,
          makeReq({ sources: [{ kind: "requirements", label: "Spec", text: changedText }] }),
        ),
        dedupDeps,
      ),
    );

    expect(result.status).toBe(200);
    const body = result.body as { runId: string; preservedCount: number; regeneratedCount: number };
    // 1 preserved + ≥1 regenerated before dedup.
    expect(body.preservedCount).toBe(1);
    expect(body.regeneratedCount).toBeGreaterThanOrEqual(1);
    const artifact = loadQualityIntelligenceCandidates(body.runId, { evidenceDir });
    const artifactCount = artifact?.candidates.length ?? 0;
    const rawCount = body.preservedCount + body.regeneratedCount;
    // KEY assertion (FIX 2): dedup must reduce the artifact below the raw concat length.
    // Without deduplicateCandidates() the artifact would equal rawCount (no reduction).
    // With dedup, content-identical candidates collapse so artifactCount < rawCount.
    expect(artifactCount).toBeLessThan(rawCount);
    // And the surviving candidates must cover the shared title (exactly one form of it).
    const titles = artifact?.candidates.map((c) => c.title) ?? [];
    expect(titles.filter((t) => t === sharedTitle)).toHaveLength(1);
  });
});

// ─── re-check / regenerate-stale: absolute-path guard for file sources (#791) ─
//
// parseSources() in reCheckRoutes.ts shares the same isAbsolute contract as runRoutes.ts
// (Issue #791 route-boundary contract). Without the guard a caller can pass a relative path
// like "docs/spec.md" and reach the OS-level read with a working-directory-relative path —
// a different file depending on where the server process runs.
describe("handleQiReCheck — relative file source path rejected (#791)", () => {
  it("returns 400 QI_BAD_SOURCE for a relative file source path", async () => {
    const body = { sources: [{ kind: "file", label: "Relative", path: "docs/spec.md" }] };
    const result = asResult(
      await handleQiReCheck(ctx("re-check", RUN_ID, makeReq(body)), deps(evidenceDir)),
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string; message: string } }).error).toMatchObject({
      code: "QI_BAD_SOURCE",
    });
    expect((result.body as { error: { code: string; message: string } }).error.message).toMatch(
      /absolute local paths/i,
    );
  });
});

describe("handleQiRegenerateStale — relative file source path rejected (#791)", () => {
  it("returns 400 QI_BAD_SOURCE for a relative file source path", async () => {
    const body = { sources: [{ kind: "file", label: "Relative", path: "docs/spec.md" }] };
    const result = asResult(
      await handleQiRegenerateStale(
        ctx("regenerate-stale", RUN_ID, makeReq(body)),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string; message: string } }).error).toMatchObject({
      code: "QI_BAD_SOURCE",
    });
    expect((result.body as { error: { code: string; message: string } }).error.message).toMatch(
      /absolute local paths/i,
    );
  });
});

// ─── re-check / regenerate-stale: readBody oversize cap ──────────────────────
//
// The capped guard (runRoutes.ts:45-61 pattern) ensures that once the 2 MB threshold is hit
// the promise rejects exactly once (capped=true gate) and the end handler never resolves with
// a partial buffer. Without `if (!capped)` in the end handler the promise could settle twice
// (reject then resolve), causing the 413 branch to be skipped on short-lingering streams.
describe("handleQiReCheck — body too large returns 413", () => {
  it("returns 413 QI_BODY_TOO_LARGE when the request body exceeds 2 MB", async () => {
    const oversized = Buffer.alloc(2 * 1024 * 1024 + 1, 0x41); // 2 MB + 1 byte of 'A'
    const req = Readable.from([oversized]) as unknown as IncomingMessage;
    const result = asResult(await handleQiReCheck(ctx("re-check", RUN_ID, req), deps(evidenceDir)));
    expect(result.status).toBe(413);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BODY_TOO_LARGE");
  });
});

describe("handleQiRegenerateStale — body too large returns 413", () => {
  it("returns 413 QI_BODY_TOO_LARGE when the request body exceeds 2 MB", async () => {
    const oversized = Buffer.alloc(2 * 1024 * 1024 + 1, 0x41);
    const req = Readable.from([oversized]) as unknown as IncomingMessage;
    const result = asResult(
      await handleQiRegenerateStale(ctx("regenerate-stale", RUN_ID, req), deps(evidenceDir)),
    );
    expect(result.status).toBe(413);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BODY_TOO_LARGE");
  });
});
