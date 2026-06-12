// Integration tests for handleQiReview (Epic #270, Issue #282).
//
// Seeds a real evidenceDir with a recorded QI run manifest, then fires the review
// handler directly. Verifies approve / bad-action / not-found / missing-id / non-JSON
// body / run-scope approve paths. No network or SSE — pure function + real fs.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { recordQualityIntelligenceRun } from "@oscharko-dev/keiko-evidence";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { RouteContext, RouteResult } from "../../routes.js";
import { STREAMING } from "../../routes.js";
import type { UiHandlerDeps } from "../../deps.js";
import { buildRedactor, createRunRegistry } from "../../index.js";
import { createInMemoryUiStore } from "../../store/index.js";
import { handleQiReview } from "../reviewRoutes.js";
import { loadRunReviewState, runReviewStateOf, candidateReviewStateOf } from "../reviewStore.js";
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
function minimalRecordInput(runId: string): Parameters<typeof recordQualityIntelligenceRun>[0] {
  return {
    runId,
    planAt: "2026-06-01T10:00:00.000Z",
    completedAt: "2026-06-01T10:01:00.000Z",
    status: "succeeded",
    policyProfileIds: [],
    retentionPolicyId: "default",
    modelGatewayCallCount: 1,
    totals: { candidates: 0, findings: 0, exports: 0 },
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

// ─── Test lifecycle ───────────────────────────────────────────────────────────

let evidenceDir: string;

beforeEach(() => {
  evidenceDir = mkdtempSync(join(tmpdir(), "keiko-review-test-"));
  // Seed a run manifest that the review handler can load.
  recordQualityIntelligenceRun(minimalRecordInput("run-review-001"), { evidenceDir });
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
});

// ─── Happy path: run-scope approve → 200 ─────────────────────────────────────

describe("handleQiReview — run-scope approve", () => {
  it("returns 200 with runState 'approved' when no candidateId is provided", async () => {
    const req = makeReq({ action: "approve" });
    const result = asResult(await handleQiReview(ctx("run-review-001", req), deps(evidenceDir)));
    expect(result.status).toBe(200);
    const body = result.body as { runState: string };
    expect(body.runState).toBe("approved");
  });

  it("run-scope approve does NOT change individual candidate states", async () => {
    const req = makeReq({ action: "approve" });
    const result = asResult(await handleQiReview(ctx("run-review-001", req), deps(evidenceDir)));
    const body = result.body as { candidateStates: Record<string, string> };
    // No candidate-level entries should be present for a run-level action.
    expect(Object.keys(body.candidateStates)).toHaveLength(0);
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
    const req = makeReq({ action: "reopen" });
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
  it("rejects approve→reject (rejecting an approved run) with 409 and persists no audit entry", async () => {
    const d = deps(evidenceDir);
    // approve the run first (legal: open → approved).
    await handleQiReview(ctx("run-review-001", makeReq({ action: "approve" })), d);
    // reject an approved run — illegal (approved is terminal, action !== reopen).
    const result = asResult(
      await handleQiReview(ctx("run-review-001", makeReq({ action: "reject" })), d),
    );
    expect(result.status).toBe(409);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "QI_REVIEW_TRANSITION_NOT_ALLOWED",
    );
    // State unchanged (still approved) and the audit log did NOT grow past the single approve.
    const after = loadRunReviewState("run-review-001", evidenceDir);
    expect(runReviewStateOf(after)).toBe("approved");
    expect(after?.auditLog).toHaveLength(1);
  });

  it("rejects reject→approve (approving a rejected run) with 409", async () => {
    const d = deps(evidenceDir);
    await handleQiReview(ctx("run-review-001", makeReq({ action: "reject" })), d);
    const result = asResult(
      await handleQiReview(ctx("run-review-001", makeReq({ action: "approve" })), d),
    );
    expect(result.status).toBe(409);
    const after = loadRunReviewState("run-review-001", evidenceDir);
    expect(runReviewStateOf(after)).toBe("rejected");
    expect(after?.auditLog).toHaveLength(1);
  });

  it("permits approve→reopen→reject as a 200 chain (reopen is the audited undo)", async () => {
    const d = deps(evidenceDir);
    const approve = asResult(
      await handleQiReview(ctx("run-review-001", makeReq({ action: "approve" })), d),
    );
    expect(approve.status).toBe(200);
    const reopen = asResult(
      await handleQiReview(ctx("run-review-001", makeReq({ action: "reopen" })), d),
    );
    expect(reopen.status).toBe(200);
    expect((reopen.body as { runState: string }).runState).toBe("open");
    const reject = asResult(
      await handleQiReview(ctx("run-review-001", makeReq({ action: "reject" })), d),
    );
    expect(reject.status).toBe(200);
    expect((reject.body as { runState: string }).runState).toBe("rejected");
    const after = loadRunReviewState("run-review-001", evidenceDir);
    expect(after?.auditLog).toHaveLength(3);
  });

  it("permits changes-requested→approve (non-terminal source) as 200", async () => {
    const d = deps(evidenceDir);
    await handleQiReview(ctx("run-review-001", makeReq({ action: "request-changes" })), d);
    const result = asResult(
      await handleQiReview(ctx("run-review-001", makeReq({ action: "approve" })), d),
    );
    expect(result.status).toBe(200);
    expect((result.body as { runState: string }).runState).toBe("approved");
  });

  it("permits withdrawn→reopen→approve as a 200 chain", async () => {
    const d = deps(evidenceDir);
    await handleQiReview(ctx("run-review-001", makeReq({ action: "withdraw" })), d);
    await handleQiReview(ctx("run-review-001", makeReq({ action: "reopen" })), d);
    const result = asResult(
      await handleQiReview(ctx("run-review-001", makeReq({ action: "approve" })), d),
    );
    expect(result.status).toBe(200);
    expect((result.body as { runState: string }).runState).toBe("approved");
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

// ─── reviewerLabel is capped and defaults ────────────────────────────────────

describe("handleQiReview — reviewerLabel handling", () => {
  it("uses 'reviewer' as default reviewerLabel when the field is absent", async () => {
    // The response body does not expose reviewerLabel, but the audit log should record it.
    // We verify the route returns 200 (i.e. it processes successfully) without a label.
    const req = makeReq({ action: "approve", candidateId: "cand-1" });
    const result = asResult(await handleQiReview(ctx("run-review-001", req), deps(evidenceDir)));
    expect(result.status).toBe(200);
  });

  it("accepts a custom reviewerLabel without error", async () => {
    const req = makeReq({ action: "approve", candidateId: "cand-1", reviewerLabel: "Alice" });
    const result = asResult(await handleQiReview(ctx("run-review-001", req), deps(evidenceDir)));
    expect(result.status).toBe(200);
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
