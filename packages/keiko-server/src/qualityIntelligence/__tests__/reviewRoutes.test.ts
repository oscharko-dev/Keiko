// Integration tests for handleQiReview (Epic #270, Issue #282).
//
// Seeds a real evidenceDir with a recorded QI run manifest, then fires the review
// handler directly. Verifies approve / bad-action / not-found / missing-id / non-JSON
// body / run-scope approve paths. No network or SSE — pure function + real fs.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { handleQiReview } from "../reviewRoutes.js";
import {
  applyReviewDecision,
  appendEditAudit,
  loadRunReviewState,
  runReviewStateOf,
  candidateReviewStateOf,
  verifyQiReviewAuditIntegrity,
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

// ─── Missing id param → 400 ───────────────────────────────────────────────────

describe("handleQiReview — missing id param", () => {
  it("returns 400 when id param is absent from ctx.params", async () => {
    const req = makeReq({ action: "approve" });
    const result = asResult(await handleQiReview(ctxNoId(req), deps(evidenceDir)));
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_REQUEST");
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
  });
});

// ─── Non-JSON body → 400 ─────────────────────────────────────────────────────

describe("handleQiReview — non-JSON body", () => {
  it("returns 400 QI_BAD_REQUEST for a non-JSON body", async () => {
    const req = makeRawReq("not json at all");
    const result = asResult(await handleQiReview(ctx("run-review-001", req), deps(evidenceDir)));
    expect(result.status).toBe(400);
    const body = result.body as { error: { code: string } };
    expect(body.error.code).toBe("QI_BAD_REQUEST");
  });

  it("returns 400 QI_BAD_REQUEST when body is a JSON array (not an object)", async () => {
    const req = makeRawReq(JSON.stringify([{ action: "approve" }]));
    const result = asResult(await handleQiReview(ctx("run-review-001", req), deps(evidenceDir)));
    expect(result.status).toBe(400);
    const body = result.body as { error: { code: string } };
    expect(body.error.code).toBe("QI_BAD_REQUEST");
  });
});

// ─── Bad action → 400 QI_BAD_ACTION ──────────────────────────────────────────

describe("handleQiReview — bad action", () => {
  it("returns 400 QI_BAD_ACTION for an unrecognised action value", async () => {
    const req = makeReq({ action: "invalid-action" });
    const result = asResult(await handleQiReview(ctx("run-review-001", req), deps(evidenceDir)));
    expect(result.status).toBe(400);
    const body = result.body as { error: { code: string } };
    expect(body.error.code).toBe("QI_BAD_ACTION");
  });

  it("returns 400 QI_BAD_ACTION when the action field is missing", async () => {
    const req = makeReq({ candidateId: "cand-1" });
    const result = asResult(await handleQiReview(ctx("run-review-001", req), deps(evidenceDir)));
    expect(result.status).toBe(400);
    const body = result.body as { error: { code: string } };
    expect(body.error.code).toBe("QI_BAD_ACTION");
  });

  it("returns 400 QI_BAD_ACTION when action is an empty string", async () => {
    const req = makeReq({ action: "" });
    const result = asResult(await handleQiReview(ctx("run-review-001", req), deps(evidenceDir)));
    expect(result.status).toBe(400);
    const body = result.body as { error: { code: string } };
    expect(body.error.code).toBe("QI_BAD_ACTION");
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
    const body = result.body as { error: { code: string } };
    expect(body.error.code).toBe("QI_NOT_FOUND");
  });

  it("returns 404 QI_CANDIDATE_NOT_FOUND for a candidate id outside the persisted artifact", async () => {
    const req = makeReq({ action: "approve", candidateId: "missing-candidate" });
    const result = asResult(await handleQiReview(ctx("run-review-001", req), deps(evidenceDir)));
    expect(result.status).toBe(404);
    const body = result.body as { error: { code: string } };
    expect(body.error.code).toBe("QI_CANDIDATE_NOT_FOUND");
  });
});

// ─── No evidence dir → 500 ───────────────────────────────────────────────────

describe("handleQiReview — no evidence dir", () => {
  it("returns 500 QI_NO_EVIDENCE_DIR when evidenceDir is not configured", async () => {
    const req = makeReq({ action: "approve" });
    const result = asResult(await handleQiReview(ctx("run-review-001", req), depsNoDir()));
    expect(result.status).toBe(500);
    const body = result.body as { error: { code: string } };
    expect(body.error.code).toBe("QI_NO_EVIDENCE_DIR");
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

// ─── Happy path: run-scope approve → 200 ─────────────────────────────────────

describe("handleQiReview — run-scope approve", () => {
  it("rejects run-level approval while any persisted candidate is still open", async () => {
    const req = makeReq({ action: "approve" });
    const result = asResult(await handleQiReview(ctx("run-review-001", req), deps(evidenceDir)));
    expect(result.status).toBe(409);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "QI_REVIEW_RUN_APPROVAL_BLOCKED",
    );
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
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "QI_REVIEW_TRANSITION_NOT_ALLOWED",
    );
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
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "QI_REVIEW_TRANSITION_NOT_ALLOWED",
    );
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
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "QI_REVIEW_REOPEN_REASON_REQUIRED",
    );
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
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "QI_REVIEW_FOUR_EYES_FORBIDDEN",
    );
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
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "QI_REVIEW_FOUR_EYES_FORBIDDEN",
    );
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
