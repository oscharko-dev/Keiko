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

// ─── All valid actions are accepted ──────────────────────────────────────────

describe("handleQiReview — all valid actions", () => {
  it.each(["approve", "reject", "request-changes", "reopen", "withdraw"])(
    "accepts action '%s' without error",
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
});
