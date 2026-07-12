// Integration tests for handleQiReview (Epic #270, Issue #282).
//
// Seeds a real evidenceDir with a recorded QI run manifest, then fires the review
// handler directly. Verifies approve / bad-action / not-found / missing-id / non-JSON
// body / run-scope approve paths. No network or SSE — pure function + real fs.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import {
  recordQualityIntelligenceCandidates,
  recordQualityIntelligenceRun,
} from "@oscharko-dev/keiko-evidence";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { RouteContext, RouteResult } from "../../routes.js";
import { STREAMING } from "../../routes.js";
import type { UiHandlerDeps } from "../../deps.js";
import { buildRedactor, createRunRegistry } from "../../index.js";
import { createInMemoryUiStore } from "../../store/index.js";
import {
  buildApplyReviewDecisionInput,
  handleQiReview,
  mapReviewError,
  parseDecision,
} from "../reviewRoutes.js";
import {
  applyReviewDecision,
  appendEditAudit,
  loadRunReviewState,
  runReviewStateOf,
  candidateReviewStateOf,
  verifyQiReviewAuditIntegrity,
  hashQiReviewAuditEntry,
  QualityIntelligenceReviewCandidateNotFound,
  QualityIntelligenceReviewRunApprovalRejected,
  QualityIntelligenceReviewGovernanceRejected,
  QualityIntelligenceReviewIntegrityError,
} from "../reviewStore.js";
import type { QualityIntelligenceEvidenceManifest } from "@oscharko-dev/keiko-evidence";

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

function depsWithPrincipal(
  evidenceDir: string,
  actorId: string,
  displayLabel: string,
): UiHandlerDeps {
  return {
    ...deps(evidenceDir),
    qualityIntelligenceReviewPrincipal: () => ({
      actorId,
      displayLabel,
      source: "test",
      kind: "human",
    }),
  };
}

function depsNoDir(): UiHandlerDeps {
  return { ...deps("/tmp/fake"), evidenceDir: undefined };
}

/** Build an IncomingMessage fake from a JSON body using Readable.from. */
function makeReq(body: Record<string, unknown>): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
  return req as unknown as IncomingMessage;
}

/** Build an IncomingMessage fake with raw (non-JSON) text. */
function makeRawReq(raw: string): IncomingMessage {
  const req = Readable.from([Buffer.from(raw, "utf8")]);
  return req as unknown as IncomingMessage;
}

function ctx(runId: string, req: IncomingMessage): RouteContext {
  return {
    req,
    res: {} as RouteContext["res"],
    params: { id: runId },
    url: new URL(`http://127.0.0.1/api/quality-intelligence/runs/${runId}/review`),
  };
}

function ctxNoId(req: IncomingMessage): RouteContext {
  return {
    req,
    res: {} as RouteContext["res"],
    params: {},
    url: new URL("http://127.0.0.1/api/quality-intelligence/runs//review"),
  };
}

function asResult(outcome: RouteResult | typeof STREAMING): RouteResult {
  if (outcome === STREAMING) throw new Error("expected RouteResult, got STREAMING");
  return outcome;
}

function errorOf(result: RouteResult): { readonly code: string; readonly message: string } {
  return (result.body as { error: { code: string; message: string } }).error;
}

function parsedDecision(
  body: Record<string, unknown>,
): NonNullable<ReturnType<typeof parseDecision>> {
  const decision = parseDecision(body);
  if (decision === undefined) throw new Error("expected parsed review decision");
  return decision;
}

/** Minimal record input. totals must satisfy the findings/exports invariant. */
function minimalRecordInput(
  runId: string,
  candidateCount: number = REVIEW_CANDIDATE_IDS.length,
): Parameters<typeof recordQualityIntelligenceRun>[0] {
  return {
    runId,
    planAt: "2026-06-01T10:00:00.000Z",
    completedAt: "2026-06-01T10:01:00.000Z",
    status: "succeeded",
    policyProfileIds: [],
    retentionPolicyId: "default",
    modelGatewayCallCount: 1,
    totals: { candidates: candidateCount, findings: 0, exports: 0 },
    findings: [],
    exports: [],
    evidenceRefs: [],
    provenanceRefs: {
      envelopeIds: [],
      auditSummaryId:
        "qi-audit-test" as QualityIntelligenceEvidenceManifest["provenanceRefs"]["auditSummaryId"],
    },
  };
}

const REVIEW_CANDIDATE_IDS = [
  "cand-abc",
  "cand-1",
  "cand-2",
  "cand-x",
  "cand-bidi",
  "cand-format",
  "__proto__",
  "constructor",
] as const;

function reviewCandidate(
  runId: string,
  id: string,
): Parameters<typeof recordQualityIntelligenceCandidates>[0]["candidates"][number] {
  return {
    id: QualityIntelligence.asQualityIntelligenceTestCaseId(id),
    runId: QualityIntelligence.asQualityIntelligenceRunId(runId),
    derivedFromAtomIds: [],
    title: `Candidate ${id}`,
    preconditions: [],
    steps: ["Step"],
    expectedResults: ["Expected result"],
    priority: "P2",
    riskClass: "regression",
    tags: [],
    status: "proposed",
  };
}

function seedReviewCandidates(runId: string): void {
  recordQualityIntelligenceCandidates({
    runId,
    generatedAt: "2026-06-01T10:01:00.000Z",
    candidates: REVIEW_CANDIDATE_IDS.map((id) => reviewCandidate(runId, id)),
    evidenceDir,
    redact: (value: unknown): unknown => value,
  });
}

function seedLegacyEditAuditWithoutActor(runId: string, candidateId: string): void {
  mkdirSync(join(evidenceDir, "qi"), { recursive: true });
  writeFileSync(
    join(evidenceDir, "qi", `${runId}.review.json`),
    JSON.stringify({
      qiReviewSchemaVersion: 1,
      runId,
      runState: "open",
      candidateStates: {},
      auditLog: [
        {
          at: "2026-06-01T10:30:00.000Z",
          action: "edit",
          scope: "candidate",
          candidateId,
          reviewerLabel: "Legacy editor",
          fromState: "open",
          toState: "open",
        },
      ],
      lastUpdatedAt: "2026-06-01T10:30:00.000Z",
    }),
  );
}

function reviewLockPath(runId: string): string {
  const digest = createHash("sha256").update(runId).digest("hex").slice(0, 32);
  return join(evidenceDir, "qi", ".review-locks", `${digest}.lock`);
}

// ─── Test lifecycle ───────────────────────────────────────────────────────────

let evidenceDir: string;

beforeEach(() => {
  evidenceDir = mkdtempSync(join(tmpdir(), "keiko-review-test-"));
  // Seed a run manifest that the review handler can load.
  recordQualityIntelligenceRun(minimalRecordInput("run-review-001"), { evidenceDir });
  seedReviewCandidates("run-review-001");
});

afterEach(() => {
  rmSync(evidenceDir, { recursive: true, force: true });
});

describe("review decision parsing", () => {
  it("omits candidateId for non-string request values instead of materialising undefined", () => {
    const decision = parsedDecision({ action: "approve", candidateId: 42 });

    expect(decision.scope).toBe("run");
    expect(Object.hasOwn(decision, "candidateId")).toBe(false);
  });

  it("materialises candidateId for candidate-scope request values", () => {
    const decision = parsedDecision({ action: "approve", candidateId: "cand-1" });

    expect(decision.scope).toBe("candidate");
    expect(Object.hasOwn(decision, "candidateId")).toBe(true);
    expect(decision.candidateId).toBe("cand-1");
  });

  it("omits candidateId from run-scope ApplyReviewDecisionInput", () => {
    const decision = parsedDecision({ action: "approve" });
    const input = buildApplyReviewDecisionInput(
      "run-review-001",
      decision,
      evidenceDir,
      { actorId: "route-reviewer", displayLabel: "Route reviewer", kind: "human" },
      undefined,
      deps(evidenceDir),
    );

    expect(input.scope).toBe("run");
    expect(Object.hasOwn(input, "candidateId")).toBe(false);
  });

  it("materialises candidateId in candidate-scope ApplyReviewDecisionInput", () => {
    const decision = parsedDecision({ action: "approve", candidateId: "cand-1" });
    const input = buildApplyReviewDecisionInput(
      "run-review-001",
      decision,
      evidenceDir,
      { actorId: "route-reviewer", displayLabel: "Route reviewer", kind: "human" },
      REVIEW_CANDIDATE_IDS,
      deps(evidenceDir),
    );

    expect(input.scope).toBe("candidate");
    expect(Object.hasOwn(input, "candidateId")).toBe(true);
    expect(input.candidateId).toBe("cand-1");
  });
});

// ─── Missing id param → 400 ───────────────────────────────────────────────────

describe("handleQiReview — missing id param", () => {
  it("returns 400 when id param is absent from ctx.params", async () => {
    const req = makeReq({ action: "approve" });
    const result = asResult(await handleQiReview(ctxNoId(req), deps(evidenceDir)));
    expect(result.status).toBe(400);
    expect(errorOf(result)).toEqual({
      code: "QI_BAD_REQUEST",
      message: "Run id is required.",
    });
  });

  it("returns 400 when id param is an empty string", async () => {
    const req = makeReq({ action: "approve" });
    const c: RouteContext = {
      req,
      res: {} as RouteContext["res"],
      params: { id: "" },
      url: new URL("http://127.0.0.1/api/quality-intelligence/runs//review"),
    };
    const result = asResult(await handleQiReview(c, deps(evidenceDir)));
    expect(result.status).toBe(400);
    expect(errorOf(result)).toEqual({
      code: "QI_BAD_REQUEST",
      message: "Run id is required.",
    });
  });

  it("returns 400 when id param is only whitespace", async () => {
    const req = makeReq({ action: "approve" });
    const c: RouteContext = {
      req,
      res: {} as RouteContext["res"],
      params: { id: "   " },
      url: new URL("http://127.0.0.1/api/quality-intelligence/runs/   /review"),
    };
    const result = asResult(await handleQiReview(c, deps(evidenceDir)));
    expect(result.status).toBe(400);
    expect(errorOf(result)).toEqual({
      code: "QI_BAD_REQUEST",
      message: "Run id is required.",
    });
  });
});

// ─── Non-JSON body → 400 ─────────────────────────────────────────────────────

describe("handleQiReview — non-JSON body", () => {
  it("returns 400 QI_BAD_REQUEST for a non-JSON body", async () => {
    const req = makeRawReq("not json at all");
    const result = asResult(await handleQiReview(ctx("run-review-001", req), deps(evidenceDir)));
    expect(result.status).toBe(400);
    expect(errorOf(result)).toEqual({
      code: "QI_BAD_REQUEST",
      message: "Review body is not valid JSON.",
    });
  });

  it("returns 400 QI_BAD_REQUEST when body is a JSON array (not an object)", async () => {
    const req = makeRawReq(JSON.stringify([{ action: "approve" }]));
    const result = asResult(await handleQiReview(ctx("run-review-001", req), deps(evidenceDir)));
    expect(result.status).toBe(400);
    expect(errorOf(result)).toEqual({
      code: "QI_BAD_REQUEST",
      message: "Review body must be an object.",
    });
  });

  it("returns 413 QI_BODY_TOO_LARGE when the review body exceeds the byte cap", async () => {
    const req = makeRawReq("x".repeat(16 * 1024 + 1));
    const result = asResult(await handleQiReview(ctx("run-review-001", req), deps(evidenceDir)));
    expect(result.status).toBe(413);
    expect(errorOf(result)).toEqual({
      code: "QI_BODY_TOO_LARGE",
      message: "Review body is too large.",
    });
  });
});

// ─── Bad action → 400 QI_BAD_ACTION ──────────────────────────────────────────

describe("handleQiReview — bad action", () => {
  it("returns 400 QI_BAD_ACTION for an unrecognised action value", async () => {
    const req = makeReq({ action: "invalid-action" });
    const result = asResult(await handleQiReview(ctx("run-review-001", req), deps(evidenceDir)));
    expect(result.status).toBe(400);
    expect(errorOf(result)).toEqual({
      code: "QI_BAD_ACTION",
      message: "A valid review action is required.",
    });
  });

  it("returns 400 QI_BAD_ACTION when the action field is missing", async () => {
    const req = makeReq({ candidateId: "cand-1" });
    const result = asResult(await handleQiReview(ctx("run-review-001", req), deps(evidenceDir)));
    expect(result.status).toBe(400);
    expect(errorOf(result)).toEqual({
      code: "QI_BAD_ACTION",
      message: "A valid review action is required.",
    });
  });

  it("returns 400 QI_BAD_ACTION when action is an empty string", async () => {
    const req = makeReq({ action: "" });
    const result = asResult(await handleQiReview(ctx("run-review-001", req), deps(evidenceDir)));
    expect(result.status).toBe(400);
    expect(errorOf(result)).toEqual({
      code: "QI_BAD_ACTION",
      message: "A valid review action is required.",
    });
  });
});

// ─── Not found → 404 ─────────────────────────────────────────────────────────

describe("handleQiReview — not found", () => {
  it("returns 404 QI_NOT_FOUND for a run id that was never recorded", async () => {
    const req = makeReq({ action: "approve" });
    const result = asResult(
      await handleQiReview(ctx("run-does-not-exist", req), deps(evidenceDir)),
    );
    expect(result.status).toBe(404);
    expect(errorOf(result)).toEqual({
      code: "QI_NOT_FOUND",
      message: "Quality Intelligence run not found.",
    });
  });

  it("returns 404 QI_CANDIDATE_NOT_FOUND for a candidate id outside the persisted artifact", async () => {
    const req = makeReq({ action: "approve", candidateId: "missing-candidate" });
    const result = asResult(await handleQiReview(ctx("run-review-001", req), deps(evidenceDir)));
    expect(result.status).toBe(404);
    expect(errorOf(result)).toEqual({
      code: "QI_CANDIDATE_NOT_FOUND",
      message: "Candidate not found for this run.",
    });
  });

  it("returns 404 for candidate-scope review when the run has no candidate artifact", async () => {
    recordQualityIntelligenceRun(minimalRecordInput("run-review-no-artifact", 0), { evidenceDir });
    const req = makeReq({ action: "approve", candidateId: "cand-1" });
    const result = asResult(
      await handleQiReview(ctx("run-review-no-artifact", req), deps(evidenceDir)),
    );

    expect(result.status).toBe(404);
    expect(errorOf(result)).toEqual({
      code: "QI_CANDIDATE_NOT_FOUND",
      message: "Candidate not found for this run.",
    });
  });
});

// ─── No evidence dir → 500 ───────────────────────────────────────────────────

describe("handleQiReview — no evidence dir", () => {
  it("returns 500 QI_NO_EVIDENCE_DIR when evidenceDir is not configured", async () => {
    const req = makeReq({ action: "approve" });
    const result = asResult(await handleQiReview(ctx("run-review-001", req), depsNoDir()));
    expect(result.status).toBe(500);
    expect(errorOf(result)).toEqual({
      code: "QI_NO_EVIDENCE_DIR",
      message: "The evidence directory is not configured.",
    });
  });
});

describe("mapReviewError", () => {
  it("maps store-level candidate and run precondition failures for defensive callers", () => {
    const missingCandidate = mapReviewError(
      new QualityIntelligenceReviewCandidateNotFound("cand-missing"),
    );
    const blockedRun = mapReviewError(new QualityIntelligenceReviewRunApprovalRejected(["cand-1"]));

    expect(missingCandidate.status).toBe(404);
    expect(errorOf(missingCandidate)).toEqual({
      code: "QI_CANDIDATE_NOT_FOUND",
      message: "Candidate not found for this run.",
    });
    expect(blockedRun.status).toBe(409);
    expect(errorOf(blockedRun)).toEqual({
      code: "QI_REVIEW_RUN_APPROVAL_BLOCKED",
      message: "Approve every candidate before approving the Quality Intelligence run.",
    });
  });

  it("maps reopen actor governance and unknown errors without leaking details", () => {
    const actorMissing = mapReviewError(
      new QualityIntelligenceReviewGovernanceRejected(
        "REOPEN_ACTOR_REQUIRED",
        "reopen",
        "cand-1",
        "missing actor",
      ),
    );
    const fallback = mapReviewError(new Error("redactor secret path"));

    expect(actorMissing.status).toBe(409);
    expect(errorOf(actorMissing)).toEqual({
      code: "QI_REVIEW_REOPEN_ACTOR_REQUIRED",
      message: "Reopening a review requires a server-resolved reviewer principal.",
    });
    expect(fallback.status).toBe(500);
    expect(errorOf(fallback)).toEqual({
      code: "QI_REVIEW_FAILED",
      message: "Failed to record the review decision.",
    });
  });
});

// ─── Happy path: candidate-scope approve → 200 ───────────────────────────────

describe("handleQiReview — candidate-scope approve", () => {
  it("returns 200 with candidateStates containing the approved candidate", async () => {
    const req = makeReq({ action: "approve", candidateId: "cand-abc" });
    const result = asResult(await handleQiReview(ctx("run-review-001", req), deps(evidenceDir)));
    expect(result.status).toBe(200);
    const body = result.body as {
      candidateStates: Record<string, string>;
      auditCount: number;
      runState: string;
    };
    expect(body.candidateStates["cand-abc"]).toBe("approved");
  });

  it("returns auditCount = 1 after a single approve action", async () => {
    const req = makeReq({ action: "approve", candidateId: "cand-abc" });
    const result = asResult(await handleQiReview(ctx("run-review-001", req), deps(evidenceDir)));
    const body = result.body as { auditCount: number };
    expect(body.auditCount).toBe(1);
  });

  it("auditCount grows with each subsequent review action", async () => {
    const d = deps(evidenceDir);
    await handleQiReview(
      ctx("run-review-001", makeReq({ action: "approve", candidateId: "cand-1" })),
      d,
    );
    const result = asResult(
      await handleQiReview(
        ctx("run-review-001", makeReq({ action: "reject", candidateId: "cand-2" })),
        d,
      ),
    );
    const body = result.body as { auditCount: number };
    expect(body.auditCount).toBe(2);
  });

  // eslint-disable-next-line complexity
  it("persists a monotone tamper-evident audit chain and detects modified entries", async () => {
    const d = deps(evidenceDir);
    await handleQiReview(
      ctx("run-review-001", makeReq({ action: "approve", candidateId: "cand-1" })),
      d,
    );
    await handleQiReview(
      ctx("run-review-001", makeReq({ action: "reject", candidateId: "cand-2" })),
      d,
    );
    const review = loadRunReviewState("run-review-001", evidenceDir);
    expect(review?.auditLog.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(review?.auditLog[0]?.priorHashSha256Hex).toBe("0".repeat(64));
    expect(review?.auditLog[1]?.priorHashSha256Hex).toBe(review?.auditLog[0]?.entryHashSha256Hex);
    expect(review === undefined ? false : verifyQiReviewAuditIntegrity(review).ok).toBe(true);

    const firstEntry = review?.auditLog[0];
    if (review === undefined || firstEntry === undefined) throw new Error("expected audit entry");
    const tampered = {
      ...review,
      auditLog: [{ ...firstEntry, toState: "rejected" as const }, ...review.auditLog.slice(1)],
    };
    const report = verifyQiReviewAuditIntegrity(tampered);
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain("ENTRY_HASH_MISMATCH");
  });

  it("reports each audit-chain integrity issue with its exact code and message", async () => {
    const d = deps(evidenceDir);
    await handleQiReview(
      ctx("run-review-001", makeReq({ action: "approve", candidateId: "cand-1" })),
      d,
    );
    await handleQiReview(
      ctx("run-review-001", makeReq({ action: "reject", candidateId: "cand-2" })),
      d,
    );
    const review = loadRunReviewState("run-review-001", evidenceDir);
    const first = review?.auditLog[0];
    const second = review?.auditLog[1];
    if (review === undefined || first === undefined || second === undefined) {
      throw new Error("expected two audit entries");
    }
    const {
      sequence: _sequence,
      priorHashSha256Hex: _priorHash,
      entryHashSha256Hex: _entryHash,
      ...unchainedSecond
    } = second;
    void _sequence;
    void _priorHash;
    void _entryHash;

    expect(
      verifyQiReviewAuditIntegrity({
        ...review,
        auditLog: [first, unchainedSecond],
      }).issues,
    ).toEqual([
      {
        index: 1,
        code: "MISSING_CHAIN_FIELD",
        message: "Unchained audit entry appears after chained entries.",
      },
    ]);
    expect(
      verifyQiReviewAuditIntegrity({
        ...review,
        auditLog: [first, { ...second, sequence: 7 }],
      }).issues,
    ).toEqual(
      expect.arrayContaining([
        {
          index: 1,
          code: "SEQUENCE_NOT_MONOTONE",
          message: "Expected audit sequence 2, got 7.",
        },
      ]),
    );
    expect(
      verifyQiReviewAuditIntegrity({
        ...review,
        auditLog: [first, { ...second, priorHashSha256Hex: "f".repeat(64) }],
      }).issues,
    ).toEqual(
      expect.arrayContaining([
        {
          index: 1,
          code: "PRIOR_HASH_MISMATCH",
          message: "Audit entry prior hash does not match the previous entry.",
        },
      ]),
    );
  });

  it("reconstructs the prior hash for a legacy previous entry without stored entry hash", async () => {
    const d = deps(evidenceDir);
    await handleQiReview(
      ctx("run-review-001", makeReq({ action: "approve", candidateId: "cand-1" })),
      d,
    );
    await handleQiReview(
      ctx("run-review-001", makeReq({ action: "reject", candidateId: "cand-2" })),
      d,
    );
    const review = loadRunReviewState("run-review-001", evidenceDir);
    const first = review?.auditLog[0];
    const second = review?.auditLog[1];
    if (review === undefined || first === undefined || second === undefined) {
      throw new Error("expected two audit entries");
    }
    const { entryHashSha256Hex: _firstEntryHash, ...firstWithoutEntryHash } = first;
    void _firstEntryHash;
    const secondWithFallbackPrior = {
      ...second,
      priorHashSha256Hex: hashQiReviewAuditEntry(firstWithoutEntryHash),
    };
    const secondWithRecomputedHash = {
      ...secondWithFallbackPrior,
      entryHashSha256Hex: hashQiReviewAuditEntry(secondWithFallbackPrior),
    };

    expect(
      verifyQiReviewAuditIntegrity({
        ...review,
        auditLog: [firstWithoutEntryHash, secondWithRecomputedHash],
      }).issues,
    ).toEqual([
      {
        index: 0,
        code: "ENTRY_HASH_MISMATCH",
        message: "Audit entry hash does not match its content.",
      },
    ]);
  });

  it("fails closed when materialized candidate state is forged without an audit entry", () => {
    mkdirSync(join(evidenceDir, "qi"), { recursive: true });
    writeFileSync(
      join(evidenceDir, "qi", "run-review-001.review.json"),
      JSON.stringify({
        qiReviewSchemaVersion: 1,
        runId: "run-review-001",
        runState: "open",
        candidateStates: { "cand-1": "approved" },
        auditLog: [],
        lastUpdatedAt: "2026-06-01T10:30:00.000Z",
      }),
      "utf8",
    );

    expect(() => loadRunReviewState("run-review-001", evidenceDir)).toThrow(
      QualityIntelligenceReviewIntegrityError,
    );
  });

  it("keeps both audit entries when candidate decisions arrive concurrently", async () => {
    const d = deps(evidenceDir);
    const [first, second] = await Promise.all([
      handleQiReview(
        ctx("run-review-001", makeReq({ action: "approve", candidateId: "cand-1" })),
        d,
      ),
      handleQiReview(
        ctx("run-review-001", makeReq({ action: "reject", candidateId: "cand-2" })),
        d,
      ),
    ]);
    expect(asResult(first).status).toBe(200);
    expect(asResult(second).status).toBe(200);
    const review = loadRunReviewState("run-review-001", evidenceDir);
    expect(review?.auditLog).toHaveLength(2);
    expect(review?.auditLog.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(review === undefined ? false : verifyQiReviewAuditIntegrity(review).ok).toBe(true);
  });
});

describe("handleQiReview — review persistence failures", () => {
  it("maps a live foreign review lock to QI_REVIEW_WRITE_CONFLICT", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000);"], {
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (child.pid === undefined) throw new Error("expected child pid");
    const lockPath = reviewLockPath("run-review-001");

    try {
      mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
      writeFileSync(lockPath, `${String(child.pid)}\n`, "utf8");
      const result = asResult(
        await handleQiReview(
          ctx("run-review-001", makeReq({ action: "approve", candidateId: "cand-1" })),
          deps(evidenceDir),
        ),
      );

      expect(result.status).toBe(409);
      expect(errorOf(result)).toEqual({
        code: "QI_REVIEW_WRITE_CONFLICT",
        message: "Another review update is in progress. Retry the review action.",
      });
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      child.kill();
      rmSync(lockPath, { force: true });
    }
  });

  it("maps a tampered review artifact to QI_REVIEW_TAMPERED", async () => {
    mkdirSync(join(evidenceDir, "qi"), { recursive: true });
    writeFileSync(
      join(evidenceDir, "qi", "run-review-001.review.json"),
      JSON.stringify({
        qiReviewSchemaVersion: 1,
        runId: "run-review-001",
        runState: "open",
        candidateStates: { "cand-1": "approved" },
        auditLog: [],
        lastUpdatedAt: "2026-06-01T10:30:00.000Z",
      }),
      "utf8",
    );

    const result = asResult(
      await handleQiReview(
        ctx("run-review-001", makeReq({ action: "approve", candidateId: "cand-1" })),
        deps(evidenceDir),
      ),
    );

    expect(result.status).toBe(409);
    expect(errorOf(result)).toEqual({
      code: "QI_REVIEW_TAMPERED",
      message: "The review artifact failed integrity validation.",
    });
  });

  it("maps redactor failures to QI_REVIEW_FAILED and removes the review lock", async () => {
    const lockPath = reviewLockPath("run-review-001");
    const failingDeps = {
      ...deps(evidenceDir),
      redactor: (): unknown => {
        throw new Error("redactor failed");
      },
    };

    const result = asResult(
      await handleQiReview(
        ctx("run-review-001", makeReq({ action: "approve", candidateId: "cand-1" })),
        failingDeps,
      ),
    );

    expect(result.status).toBe(500);
    expect(errorOf(result)).toEqual({
      code: "QI_REVIEW_FAILED",
      message: "Failed to record the review decision.",
    });
    expect(existsSync(lockPath)).toBe(false);
  });
});

// ─── Happy path: run-scope approve → 200 ─────────────────────────────────────

describe("handleQiReview — run-scope approve", () => {
  it("rejects run-level approval while any persisted candidate is still open", async () => {
    const req = makeReq({ action: "approve" });
    const result = asResult(await handleQiReview(ctx("run-review-001", req), deps(evidenceDir)));
    expect(result.status).toBe(409);
    expect(errorOf(result)).toEqual({
      code: "QI_REVIEW_RUN_APPROVAL_BLOCKED",
      message: "Approve every candidate before approving the Quality Intelligence run.",
    });
    expect(loadRunReviewState("run-review-001", evidenceDir)).toBeUndefined();
  });

  it("returns 200 with runState 'approved' when a run has no candidate artifact to gate", async () => {
    recordQualityIntelligenceRun(minimalRecordInput("run-review-empty", 0), { evidenceDir });
    const req = makeReq({ action: "approve" });
    const result = asResult(await handleQiReview(ctx("run-review-empty", req), deps(evidenceDir)));
    expect(result.status).toBe(200);
    const body = result.body as { runState: string };
    expect(body.runState).toBe("approved");
  });

  it("treats a non-string candidateId as absent and applies a run-scope decision", async () => {
    recordQualityIntelligenceRun(minimalRecordInput("run-review-non-string", 0), { evidenceDir });
    const req = makeReq({ action: "approve", candidateId: 42 });
    const result = asResult(
      await handleQiReview(ctx("run-review-non-string", req), deps(evidenceDir)),
    );

    expect(result.status).toBe(200);
    const body = result.body as { runState: string; candidateStates: Record<string, string> };
    expect(body.runState).toBe("approved");
    expect(body.candidateStates).toEqual({});
  });

  it("run-scope approve does NOT change already-approved individual candidate states", async () => {
    for (const candidateId of REVIEW_CANDIDATE_IDS) {
      applyReviewDecision({
        runId: "run-review-001",
        evidenceDir,
        action: "approve",
        scope: "candidate",
        candidateId,
        actor: { actorId: "candidate-reviewer", displayLabel: "Candidate reviewer" },
        now: "2026-06-01T10:30:00.000Z",
        redact: (value: unknown): unknown => value,
      });
    }
    const req = makeReq({ action: "approve" });
    const result = asResult(await handleQiReview(ctx("run-review-001", req), deps(evidenceDir)));
    expect(result.status).toBe(200);
    const body = result.body as { candidateStates: Record<string, string> };
    expect(Object.values(body.candidateStates)).toEqual(REVIEW_CANDIDATE_IDS.map(() => "approved"));
  });
});

describe("reviewStore — store-level governance gates", () => {
  it("rejects a candidate decision when candidateIds proves the candidate is absent", () => {
    expect(() => {
      applyReviewDecision({
        runId: "run-review-001",
        evidenceDir,
        action: "approve",
        scope: "candidate",
        candidateId: "missing-candidate",
        candidateIds: REVIEW_CANDIDATE_IDS,
        actor: { actorId: "reviewer", displayLabel: "Reviewer" },
        now: "2026-06-01T10:20:00.000Z",
        redact: (value: unknown): unknown => value,
      });
    }).toThrow(QualityIntelligenceReviewCandidateNotFound);
    expect(loadRunReviewState("run-review-001", evidenceDir)).toBeUndefined();
  });

  it("rejects run approval in the store while any known candidate is not approved", () => {
    expect(() => {
      applyReviewDecision({
        runId: "run-review-001",
        evidenceDir,
        action: "approve",
        scope: "run",
        candidateIds: REVIEW_CANDIDATE_IDS,
        actor: { actorId: "reviewer", displayLabel: "Reviewer" },
        now: "2026-06-01T10:20:00.000Z",
        redact: (value: unknown): unknown => value,
      });
    }).toThrow(QualityIntelligenceReviewRunApprovalRejected);
    expect(loadRunReviewState("run-review-001", evidenceDir)).toBeUndefined();
  });

  it("rejects reopen without a server actor and reason before it writes audit", () => {
    expect(() => {
      applyReviewDecision({
        runId: "run-review-001",
        evidenceDir,
        action: "reopen",
        scope: "run",
        now: "2026-06-01T10:20:00.000Z",
        redact: (value: unknown): unknown => value,
      });
    }).toThrow(QualityIntelligenceReviewGovernanceRejected);
    expect(loadRunReviewState("run-review-001", evidenceDir)).toBeUndefined();
  });

  it("trims and caps a store-level reopen reason before persisting audit", () => {
    applyReviewDecision({
      runId: "run-review-001",
      evidenceDir,
      action: "request-changes",
      scope: "run",
      actor: { actorId: "reviewer", displayLabel: "Reviewer" },
      now: "2026-06-01T10:20:00.000Z",
      redact: (value: unknown): unknown => value,
    });
    applyReviewDecision({
      runId: "run-review-001",
      evidenceDir,
      action: "reopen",
      scope: "run",
      actor: { actorId: "reviewer", displayLabel: "Reviewer" },
      reason: `  ${"r".repeat(600)}  `,
      now: "2026-06-01T10:21:00.000Z",
      redact: (value: unknown): unknown => value,
    });

    const review = loadRunReviewState("run-review-001", evidenceDir);
    const reopen = review?.auditLog.find((entry) => entry.action === "reopen");
    expect(reopen?.reason).toBe("r".repeat(512));
  });

  it("omits reason from store-level audit entries when no reason is supplied", () => {
    applyReviewDecision({
      runId: "run-review-001",
      evidenceDir,
      action: "reject",
      scope: "run",
      actor: { actorId: "reviewer", displayLabel: "Reviewer" },
      now: "2026-06-01T10:20:00.000Z",
      redact: (value: unknown): unknown => value,
    });

    const review = loadRunReviewState("run-review-001", evidenceDir);
    expect(review?.auditLog[0]?.reason).toBeUndefined();
  });
});

// ─── Legal first transitions from OPEN (Issue #282 FIX A) ────────────────────
//
// A fresh run is OPEN. approve / reject / request-changes / withdraw all flip away from open and
// are legal. reopen-from-open is a no-op (to === from) and is now rejected with 409.

describe("handleQiReview — first transition from OPEN", () => {
  it.each(["approve", "reject", "request-changes", "withdraw"])(
    "accepts action '%s' from open without error",
    async (action) => {
      // Record a fresh run for each action to avoid state contamination.
      const freshDir = mkdtempSync(join(tmpdir(), `keiko-review-action-${action}-`));
      try {
        recordQualityIntelligenceRun(minimalRecordInput("run-action-test"), {
          evidenceDir: freshDir,
        });
        const req = makeReq({ action });
        const result = asResult(await handleQiReview(ctx("run-action-test", req), deps(freshDir)));
        expect(result.status).toBe(200);
      } finally {
        rmSync(freshDir, { recursive: true, force: true });
      }
    },
  );

  it("rejects reopen-from-open as 409 (no-op transition) and persists no review artifact", async () => {
    const req = makeReq({ action: "reopen", reason: "Reviewer wants another pass." });
    const result = asResult(await handleQiReview(ctx("run-review-001", req), deps(evidenceDir)));
    expect(result.status).toBe(409);
    expect(errorOf(result)).toEqual({
      code: "QI_REVIEW_TRANSITION_NOT_ALLOWED",
      message: 'Review transition not permitted: cannot reopen a run/candidate in state "open".',
    });
    // A first illegal action must not even create the `.review.json` companion (no audit log).
    expect(loadRunReviewState("run-review-001", evidenceDir)).toBeUndefined();
  });
});

// ─── Illegal transitions are rejected and do not mutate state (Issue #282 FIX A) ──

describe("handleQiReview — illegal transitions are rejected (run scope)", () => {
  const transitionRunId = "run-review-transition";

  beforeEach(() => {
    recordQualityIntelligenceRun(minimalRecordInput(transitionRunId, 0), { evidenceDir });
  });

  it("rejects approve→reject (rejecting an approved run) with 409 and persists no audit entry", async () => {
    const d = deps(evidenceDir);
    // approve the run first (legal: open → approved).
    await handleQiReview(ctx(transitionRunId, makeReq({ action: "approve" })), d);
    // reject an approved run — illegal (approved is terminal, action !== reopen).
    const result = asResult(
      await handleQiReview(ctx(transitionRunId, makeReq({ action: "reject" })), d),
    );
    expect(result.status).toBe(409);
    expect(errorOf(result)).toEqual({
      code: "QI_REVIEW_TRANSITION_NOT_ALLOWED",
      message:
        'Review transition not permitted: cannot reject a run/candidate in state "approved".',
    });
    // State unchanged (still approved) and the audit log did NOT grow past the single approve.
    const after = loadRunReviewState(transitionRunId, evidenceDir);
    expect(runReviewStateOf(after)).toBe("approved");
    expect(after?.auditLog).toHaveLength(1);
  });

  it("rejects reject→approve (approving a rejected run) with 409", async () => {
    const d = deps(evidenceDir);
    await handleQiReview(ctx(transitionRunId, makeReq({ action: "reject" })), d);
    const result = asResult(
      await handleQiReview(ctx(transitionRunId, makeReq({ action: "approve" })), d),
    );
    expect(result.status).toBe(409);
    const after = loadRunReviewState(transitionRunId, evidenceDir);
    expect(runReviewStateOf(after)).toBe("rejected");
    expect(after?.auditLog).toHaveLength(1);
  });

  it("rejects approve→reopen because approved is terminal in the pure review state machine", async () => {
    const d = deps(evidenceDir);
    const approve = asResult(
      await handleQiReview(ctx(transitionRunId, makeReq({ action: "approve" })), d),
    );
    expect(approve.status).toBe(200);
    const reopen = asResult(
      await handleQiReview(
        ctx(transitionRunId, makeReq({ action: "reopen", reason: "Wrong approval." })),
        d,
      ),
    );
    expect(reopen.status).toBe(409);
    const after = loadRunReviewState(transitionRunId, evidenceDir);
    expect(runReviewStateOf(after)).toBe("approved");
    expect(after?.auditLog).toHaveLength(1);
  });

  it("rejects changes-requested→approve until the review is explicitly reopened", async () => {
    const d = deps(evidenceDir);
    await handleQiReview(ctx(transitionRunId, makeReq({ action: "request-changes" })), d);
    const result = asResult(
      await handleQiReview(ctx(transitionRunId, makeReq({ action: "approve" })), d),
    );
    expect(result.status).toBe(409);
    const after = loadRunReviewState(transitionRunId, evidenceDir);
    expect(runReviewStateOf(after)).toBe("changes-requested");
    expect(after?.auditLog).toHaveLength(1);
  });

  it("rejects changes-requested→reopen without a non-empty reason", async () => {
    const d = deps(evidenceDir);
    await handleQiReview(ctx(transitionRunId, makeReq({ action: "request-changes" })), d);
    const result = asResult(
      await handleQiReview(ctx(transitionRunId, makeReq({ action: "reopen" })), d),
    );
    expect(result.status).toBe(409);
    expect(errorOf(result)).toEqual({
      code: "QI_REVIEW_REOPEN_REASON_REQUIRED",
      message: "Reopening a review requires a non-empty reason.",
    });
    const after = loadRunReviewState(transitionRunId, evidenceDir);
    expect(runReviewStateOf(after)).toBe("changes-requested");
    expect(after?.auditLog).toHaveLength(1);
  });

  it("permits changes-requested→reopen→approve as the legal revision chain", async () => {
    const d = deps(evidenceDir);
    await handleQiReview(ctx(transitionRunId, makeReq({ action: "request-changes" })), d);
    await handleQiReview(
      ctx(transitionRunId, makeReq({ action: "reopen", reason: "Changes were addressed." })),
      d,
    );
    const result = asResult(
      await handleQiReview(ctx(transitionRunId, makeReq({ action: "approve" })), d),
    );
    expect(result.status).toBe(200);
    expect((result.body as { runState: string }).runState).toBe("approved");
    const after = loadRunReviewState(transitionRunId, evidenceDir);
    const reopenEntry = after?.auditLog.find((entry) => entry.action === "reopen");
    expect(reopenEntry?.reason).toBe("Changes were addressed.");
  });

  it("rejects withdrawn→reopen because withdrawn is terminal", async () => {
    const d = deps(evidenceDir);
    await handleQiReview(ctx(transitionRunId, makeReq({ action: "withdraw" })), d);
    const result = asResult(
      await handleQiReview(
        ctx(transitionRunId, makeReq({ action: "reopen", reason: "Need to reopen." })),
        d,
      ),
    );
    expect(result.status).toBe(409);
    const after = loadRunReviewState(transitionRunId, evidenceDir);
    expect(runReviewStateOf(after)).toBe("withdrawn");
    expect(after?.auditLog).toHaveLength(1);
  });
});

describe("handleQiReview — illegal transitions are rejected (candidate scope)", () => {
  it("rejects approve→reject on a candidate with 409 and leaves its state approved", async () => {
    const d = deps(evidenceDir);
    await handleQiReview(
      ctx("run-review-001", makeReq({ action: "approve", candidateId: "cand-x" })),
      d,
    );
    const result = asResult(
      await handleQiReview(
        ctx("run-review-001", makeReq({ action: "reject", candidateId: "cand-x" })),
        d,
      ),
    );
    expect(result.status).toBe(409);
    const after = loadRunReviewState("run-review-001", evidenceDir);
    expect(after?.candidateStates["cand-x"]).toBe("approved");
    expect(after?.auditLog).toHaveLength(1);
  });
});

describe("handleQiReview — four-eyes governance", () => {
  it("rejects approval by the same server actor that edited the candidate, even with a spoofed label", async () => {
    appendEditAudit({
      runId: "run-review-001",
      evidenceDir,
      candidateId: "cand-1",
      reviewerLabel: "Alice display",
      actor: { actorId: "alice", displayLabel: "Alice", source: "test", kind: "human" },
      now: "2026-06-01T10:30:00.000Z",
      redact: (value: unknown): unknown => value,
    });

    const result = asResult(
      await handleQiReview(
        ctx(
          "run-review-001",
          makeReq({ action: "approve", candidateId: "cand-1", reviewerLabel: "Bob" }),
        ),
        depsWithPrincipal(evidenceDir, "alice", "Alice"),
      ),
    );

    expect(result.status).toBe(409);
    expect(errorOf(result)).toEqual({
      code: "QI_REVIEW_FOUR_EYES_FORBIDDEN",
      message: "Review governance requires a different server principal for this approval.",
    });
    const after = loadRunReviewState("run-review-001", evidenceDir);
    expect(candidateReviewStateOf(after, "cand-1")).toBe("open");
    expect(after?.auditLog).toHaveLength(1);
  });

  it("allows a different server actor to approve and keeps browser label separate", async () => {
    appendEditAudit({
      runId: "run-review-001",
      evidenceDir,
      candidateId: "cand-1",
      reviewerLabel: "Alice display",
      actor: { actorId: "alice", displayLabel: "Alice", source: "test", kind: "human" },
      now: "2026-06-01T10:30:00.000Z",
      redact: (value: unknown): unknown => value,
    });

    const result = asResult(
      await handleQiReview(
        ctx(
          "run-review-001",
          makeReq({ action: "approve", candidateId: "cand-1", reviewerLabel: "Alice" }),
        ),
        depsWithPrincipal(evidenceDir, "bob", "Bob"),
      ),
    );

    expect(result.status).toBe(200);
    const after = loadRunReviewState("run-review-001", evidenceDir);
    expect(candidateReviewStateOf(after, "cand-1")).toBe("approved");
    const approval = after?.auditLog[1];
    expect(approval?.actorId).toBe("bob");
    expect(approval?.reviewerLabel).toBe("Bob");
    expect(approval?.selfAssertedReviewerLabel).toBe("Alice");
  });

  it("loads legacy review artifacts but rejects approval when the prior editor actor is unknown", async () => {
    seedLegacyEditAuditWithoutActor("run-review-001", "cand-1");
    const result = asResult(
      await handleQiReview(
        ctx("run-review-001", makeReq({ action: "approve", candidateId: "cand-1" })),
        depsWithPrincipal(evidenceDir, "bob", "Bob"),
      ),
    );

    expect(result.status).toBe(409);
    expect(errorOf(result)).toEqual({
      code: "QI_REVIEW_FOUR_EYES_FORBIDDEN",
      message: "Review governance requires a different server principal for this approval.",
    });
    const after = loadRunReviewState("run-review-001", evidenceDir);
    expect(after?.auditLog).toHaveLength(1);
    expect(candidateReviewStateOf(after, "cand-1")).toBe("open");
  });
});

// ─── reviewerLabel is capped and defaults ────────────────────────────────────

describe("handleQiReview — reviewerLabel handling", () => {
  it("uses the server principal display label when the browser label is absent", async () => {
    const req = makeReq({ action: "approve", candidateId: "cand-1" });
    const result = asResult(await handleQiReview(ctx("run-review-001", req), deps(evidenceDir)));
    expect(result.status).toBe(200);
    const after = loadRunReviewState("run-review-001", evidenceDir);
    const entry = after?.auditLog[0];
    expect(entry?.reviewerLabel).toBe("local-operator");
    expect(entry?.actorId).toMatch(/^local:[a-f0-9]{16}$/);
    expect(entry?.actorSource).toBe("server-local");
    expect(entry?.selfAssertedReviewerLabel).toBeUndefined();
  });

  it("persists a custom reviewerLabel only as display metadata", async () => {
    const req = makeReq({ action: "approve", candidateId: "cand-1", reviewerLabel: "Alice" });
    const result = asResult(await handleQiReview(ctx("run-review-001", req), deps(evidenceDir)));
    expect(result.status).toBe(200);
    const after = loadRunReviewState("run-review-001", evidenceDir);
    const entry = after?.auditLog[0];
    expect(entry?.reviewerLabel).toBe("local-operator");
    expect(entry?.selfAssertedReviewerLabel).toBe("Alice");
  });

  // FIX M1 (Issue #282) — the `.review.json` companion was the only QI artifact that bypassed the
  // persist redactor: a secret-shaped reviewerLabel landed verbatim in the append-only audit log.
  it("redacts a secret-shaped reviewerLabel before it lands in the persisted audit entry", async () => {
    const secretLabel = `AKIA${"A".repeat(16)}`; // 20-char AWS-access-key shape
    const req = makeReq({ action: "approve", candidateId: "cand-1", reviewerLabel: secretLabel });
    const result = asResult(await handleQiReview(ctx("run-review-001", req), deps(evidenceDir)));
    expect(result.status).toBe(200);
    const after = loadRunReviewState("run-review-001", evidenceDir);
    const entry = after?.auditLog[0];
    expect(entry).toBeDefined();
    // The raw secret must NOT survive into the persisted artifact.
    expect(entry?.reviewerLabel).not.toContain(secretLabel);
    expect(entry?.selfAssertedReviewerLabel).not.toContain(secretLabel);
  });
});

// ─── Bidi/zero-width normalisation of reviewerLabel (WP-REVIEW item 1) ──────
//
// A reviewerLabel containing U+202E (RIGHT-TO-LEFT OVERRIDE) must be stripped before the value
// lands in the append-only .review.json audit log.  editRoutes.ts already passes the label
// through normaliseCandidateText; reviewRoutes.ts now mirrors that (FIX: apply
// normaliseCandidateText before slice).  RED reason: the old code used only trim()+slice() so
// U+202E survived into the persisted audit entry.

describe("handleQiReview — reviewerLabel bidi normalisation", () => {
  it("strips U+202E (RLO) from reviewerLabel before it lands in the audit log", async () => {
    // 'Admin' + U+202E + 'rotidua' — the classic Trojan-source RLO spoofing pattern.
    const rlo = "‮";
    const spoofedLabel = `Admin${rlo}rotidua`;
    const req = makeReq({
      action: "approve",
      candidateId: "cand-bidi",
      reviewerLabel: spoofedLabel,
    });
    const result = asResult(await handleQiReview(ctx("run-review-001", req), deps(evidenceDir)));
    expect(result.status).toBe(200);
    const after = loadRunReviewState("run-review-001", evidenceDir);
    const entry = after?.auditLog[0];
    expect(entry).toBeDefined();
    // The RLO code point must NOT be present in the persisted label.
    expect(entry?.reviewerLabel).not.toContain(rlo);
    expect(entry?.selfAssertedReviewerLabel).not.toContain(rlo);
  });

  it("omits the self-asserted label when reviewerLabel consists only of bidi/format characters", async () => {
    // A label made entirely of format characters normalises to empty string → default fallback.
    const formatOnly = "‮​‌";
    const req = makeReq({
      action: "approve",
      candidateId: "cand-format",
      reviewerLabel: formatOnly,
    });
    const result = asResult(await handleQiReview(ctx("run-review-001", req), deps(evidenceDir)));
    expect(result.status).toBe(200);
    const after = loadRunReviewState("run-review-001", evidenceDir);
    const entry = after?.auditLog[0];
    expect(entry?.reviewerLabel).toBe("local-operator");
    expect(entry?.selfAssertedReviewerLabel).toBeUndefined();
  });
});

// ─── FIX L1 (Issue #282) — prototype-pollution defense for candidate ids ─────

describe("handleQiReview — prototype-pollution defense", () => {
  it("stores a candidate literally named __proto__ without polluting the prototype", async () => {
    const req = makeReq({ action: "approve", candidateId: "__proto__" });
    const result = asResult(await handleQiReview(ctx("run-review-001", req), deps(evidenceDir)));
    expect(result.status).toBe(200);
    const after = loadRunReviewState("run-review-001", evidenceDir);
    // The candidate's own state is readable as approved (no collision with Object.prototype).
    expect(candidateReviewStateOf(after, "__proto__")).toBe("approved");
    // The global prototype was not mutated (no `approved` leaked onto Object.prototype).
    expect(({} as Record<string, unknown>).__proto__).toBe(Object.prototype);
  });

  it("stores a candidate named constructor and reads its state back", async () => {
    const req = makeReq({ action: "request-changes", candidateId: "constructor" });
    const result = asResult(await handleQiReview(ctx("run-review-001", req), deps(evidenceDir)));
    expect(result.status).toBe(200);
    const after = loadRunReviewState("run-review-001", evidenceDir);
    expect(candidateReviewStateOf(after, "constructor")).toBe("changes-requested");
  });
});
