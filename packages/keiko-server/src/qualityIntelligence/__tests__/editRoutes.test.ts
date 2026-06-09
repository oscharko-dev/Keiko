// Integration tests for handleQiEditCandidate (Epic #712, Issue #726).
//
// Seeds a real evidenceDir with a recorded QI run manifest AND a candidate artifact, then fires the
// edit handler directly. Verifies: valid edit persists + returns the updated candidate; oversized
// body → 413; invalid field/enum → 400; missing run → 404; missing candidate → 404; the mandatory
// redactor is applied; an `edit` audit entry is recorded; and the IMMUTABLE `<runId>.qi.json`
// manifest file is byte-identical after the edit. No network or SSE — pure function + real fs.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import {
  loadQualityIntelligenceCandidates,
  recordQualityIntelligenceCandidates,
  recordQualityIntelligenceRun,
} from "@oscharko-dev/keiko-evidence";
import type {
  EvidenceStore,
  QualityIntelligenceEvidenceManifest,
} from "@oscharko-dev/keiko-evidence";
import type { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import type { RouteContext, RouteResult } from "../../routes.js";
import { STREAMING } from "../../routes.js";
import type { UiHandlerDeps } from "../../deps.js";
import { buildRedactor, createRunRegistry } from "../../index.js";
import { createInMemoryUiStore } from "../../store/index.js";
import { handleQiEditCandidate } from "../editRoutes.js";
import { applyReviewDecision, loadRunReviewState } from "../reviewStore.js";

type Candidate = QualityIntelligence.QualityIntelligenceTestCaseCandidate;

const RUN_ID = "run-edit-001";
const MANIFEST_PATH = (dir: string): string => join(dir, "qi", `${RUN_ID}.qi.json`);

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function emptyStore(): EvidenceStore {
  return { put: () => "", list: () => [], get: () => undefined, delete: () => undefined };
}

// A tagging redactor that uppercases string leaves — proves the route redacts edited fields.
const upcaseRedact = (value: unknown): unknown => {
  if (typeof value === "string") return value.toUpperCase();
  if (Array.isArray(value)) return value.map(upcaseRedact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, upcaseRedact(v)]),
    );
  }
  return value;
};

function deps(evidenceDir: string, redactor = buildRedactor({})): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: emptyStore(),
    env: {},
    redactor,
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

function ctx(runId: string, req: IncomingMessage): RouteContext {
  return {
    req,
    res: {} as RouteContext["res"],
    params: { id: runId },
    url: new URL(`http://127.0.0.1/api/quality-intelligence/runs/${runId}/edit`),
  };
}

function asResult(outcome: RouteResult | typeof STREAMING): RouteResult {
  if (outcome === STREAMING) throw new Error("expected RouteResult, got STREAMING");
  return outcome;
}

function minimalRecordInput(runId: string): Parameters<typeof recordQualityIntelligenceRun>[0] {
  return {
    runId,
    planAt: "2026-06-01T10:00:00.000Z",
    completedAt: "2026-06-01T10:01:00.000Z",
    status: "succeeded",
    policyProfileIds: [],
    retentionPolicyId: "default",
    modelGatewayCallCount: 1,
    totals: { candidates: 1, findings: 0, exports: 0 },
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

function seedCandidate(id: string): Candidate {
  return {
    id: id as Candidate["id"],
    runId: RUN_ID as Candidate["runId"],
    derivedFromAtomIds: [],
    title: `Original ${id}`,
    preconditions: ["pre-a"],
    steps: ["step-a"],
    expectedResults: ["result-a"],
    priority: "P2",
    riskClass: "functional",
    tags: ["smoke"],
    status: "proposed",
  };
}

// ─── Test lifecycle ───────────────────────────────────────────────────────────

let evidenceDir: string;

beforeEach(() => {
  evidenceDir = mkdtempSync(join(tmpdir(), "keiko-edit-test-"));
  recordQualityIntelligenceRun(minimalRecordInput(RUN_ID), { evidenceDir });
  recordQualityIntelligenceCandidates({
    runId: RUN_ID,
    generatedAt: "2026-06-08T10:00:00.000Z",
    candidates: [seedCandidate("tc-1")],
    evidenceDir,
    redact: (v) => v,
  });
});

afterEach(() => {
  rmSync(evidenceDir, { recursive: true, force: true });
});

// ─── Validation: missing id ─────────────────────────────────────────────────

describe("handleQiEditCandidate — missing id", () => {
  it("returns 400 QI_BAD_REQUEST when id param is absent", async () => {
    const c: RouteContext = {
      req: makeReq({ candidateId: "tc-1", edited: { title: "x" } }),
      res: {} as RouteContext["res"],
      params: {},
      url: new URL("http://127.0.0.1/api/quality-intelligence/runs//edit"),
    };
    const result = asResult(await handleQiEditCandidate(c, deps(evidenceDir)));
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_REQUEST");
  });
});

// ─── No evidence dir → 500 ───────────────────────────────────────────────────

describe("handleQiEditCandidate — no evidence dir", () => {
  it("returns 500 QI_NO_EVIDENCE_DIR when evidenceDir is not configured", async () => {
    const req = makeReq({ candidateId: "tc-1", edited: { title: "x" } });
    const result = asResult(await handleQiEditCandidate(ctx(RUN_ID, req), depsNoDir()));
    expect(result.status).toBe(500);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_NO_EVIDENCE_DIR");
  });
});

// ─── Oversized body → 413 ─────────────────────────────────────────────────────

describe("handleQiEditCandidate — oversized body", () => {
  it("returns 413 QI_BODY_TOO_LARGE for a body exceeding 16KB", async () => {
    const big = "x".repeat(17 * 1024);
    const req = makeReq({ candidateId: "tc-1", edited: { title: big } });
    const result = asResult(await handleQiEditCandidate(ctx(RUN_ID, req), deps(evidenceDir)));
    expect(result.status).toBe(413);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BODY_TOO_LARGE");
  });
});

// ─── Malformed → 400 ──────────────────────────────────────────────────────────

describe("handleQiEditCandidate — malformed requests", () => {
  it("returns 400 QI_BAD_REQUEST for a non-JSON body", async () => {
    const result = asResult(
      await handleQiEditCandidate(ctx(RUN_ID, makeRawReq("not json")), deps(evidenceDir)),
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_REQUEST");
  });

  it("returns 400 QI_BAD_EDIT when no editable field is supplied", async () => {
    const req = makeReq({ candidateId: "tc-1", edited: {}, editorLabel: "Alice" });
    const result = asResult(await handleQiEditCandidate(ctx(RUN_ID, req), deps(evidenceDir)));
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_EDIT");
  });

  it("returns 400 QI_BAD_EDIT when candidateId is missing", async () => {
    const req = makeReq({ edited: { title: "x" } });
    const result = asResult(await handleQiEditCandidate(ctx(RUN_ID, req), deps(evidenceDir)));
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_EDIT");
  });

  it("returns 400 QI_BAD_EDIT for an invalid priority enum", async () => {
    const req = makeReq({
      candidateId: "tc-1",
      edited: { priority: "P9" },
      editorLabel: "Alice",
    });
    const result = asResult(await handleQiEditCandidate(ctx(RUN_ID, req), deps(evidenceDir)));
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_EDIT");
  });

  it("returns 400 QI_BAD_EDIT for an invalid riskClass enum", async () => {
    const req = makeReq({
      candidateId: "tc-1",
      edited: { riskClass: "explosive" },
      editorLabel: "Alice",
    });
    const result = asResult(await handleQiEditCandidate(ctx(RUN_ID, req), deps(evidenceDir)));
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_EDIT");
  });

  it("returns 400 QI_BAD_EDIT for an empty title", async () => {
    const req = makeReq({ candidateId: "tc-1", edited: { title: "" }, editorLabel: "Alice" });
    const result = asResult(await handleQiEditCandidate(ctx(RUN_ID, req), deps(evidenceDir)));
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_EDIT");
  });

  it("returns 400 QI_BAD_EDIT for a steps array with an empty string", async () => {
    const req = makeReq({
      candidateId: "tc-1",
      edited: { steps: ["ok", ""] },
      editorLabel: "Alice",
    });
    const result = asResult(await handleQiEditCandidate(ctx(RUN_ID, req), deps(evidenceDir)));
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_EDIT");
  });

  it("returns 400 QI_BAD_EDIT when editorLabel is missing", async () => {
    const req = makeReq({ candidateId: "tc-1", edited: { title: "x" } });
    const result = asResult(await handleQiEditCandidate(ctx(RUN_ID, req), deps(evidenceDir)));
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_EDIT");
  });

  it("returns 400 QI_BAD_EDIT when editorLabel is blank", async () => {
    const req = makeReq({ candidateId: "tc-1", edited: { title: "x" }, editorLabel: "   " });
    const result = asResult(await handleQiEditCandidate(ctx(RUN_ID, req), deps(evidenceDir)));
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_EDIT");
  });

  it("does not persist when an edit is rejected as malformed", async () => {
    const req = makeReq({
      candidateId: "tc-1",
      edited: { priority: "P9" },
      editorLabel: "Alice",
    });
    await handleQiEditCandidate(ctx(RUN_ID, req), deps(evidenceDir));
    const reloaded = loadQualityIntelligenceCandidates(RUN_ID, { evidenceDir });
    expect(reloaded?.editedRevisions ?? []).toHaveLength(0);
    expect(reloaded?.candidates[0]?.title).toBe("Original tc-1");
  });
});

// ─── Not found → 404 ─────────────────────────────────────────────────────────

describe("handleQiEditCandidate — not found", () => {
  it("returns 404 QI_RUN_NOT_FOUND for a run id that was never recorded", async () => {
    const req = makeReq({ candidateId: "tc-1", edited: { title: "x" }, editorLabel: "Alice" });
    const result = asResult(
      await handleQiEditCandidate(ctx("run-missing", req), deps(evidenceDir)),
    );
    expect(result.status).toBe(404);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_RUN_NOT_FOUND");
  });

  it("returns 404 QI_NOT_FOUND for a candidate id not present in the run", async () => {
    const req = makeReq({
      candidateId: "tc-missing",
      edited: { title: "x" },
      editorLabel: "Alice",
    });
    const result = asResult(await handleQiEditCandidate(ctx(RUN_ID, req), deps(evidenceDir)));
    expect(result.status).toBe(404);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_NOT_FOUND");
  });
});

// ─── Happy path ───────────────────────────────────────────────────────────────

describe("handleQiEditCandidate — valid edit", () => {
  it("returns 200 with the updated candidate reflecting the edit", async () => {
    const req = makeReq({
      candidateId: "tc-1",
      edited: { title: "New title", priority: "P0" },
      editorLabel: "Alice",
    });
    const result = asResult(await handleQiEditCandidate(ctx(RUN_ID, req), deps(evidenceDir)));
    expect(result.status).toBe(200);
    const body = result.body as { candidate: { title: string; priority: string } };
    expect(body.candidate.title).toBe("New title");
    expect(body.candidate.priority).toBe("P0");
  });

  it("persists the edit so a reload reflects the new text", async () => {
    const req = makeReq({
      candidateId: "tc-1",
      edited: { title: "Persisted title" },
      editorLabel: "Alice",
    });
    await handleQiEditCandidate(ctx(RUN_ID, req), deps(evidenceDir));
    const reloaded = loadQualityIntelligenceCandidates(RUN_ID, { evidenceDir });
    expect(reloaded?.candidates[0]?.title).toBe("Persisted title");
  });

  it("applies the mandatory redactor to edited fields before persist", async () => {
    const req = makeReq({
      candidateId: "tc-1",
      edited: { title: "secret-token" },
      editorLabel: "Alice",
    });
    const result = asResult(
      await handleQiEditCandidate(ctx(RUN_ID, req), deps(evidenceDir, upcaseRedact)),
    );
    const body = result.body as { candidate: { title: string } };
    expect(body.candidate.title).toBe("SECRET-TOKEN");
  });

  it("records an `edit` audit entry in the review companion", async () => {
    const req = makeReq({
      candidateId: "tc-1",
      edited: { title: "Audited" },
      editorLabel: "Alice",
    });
    await handleQiEditCandidate(ctx(RUN_ID, req), deps(evidenceDir));
    const review = loadRunReviewState(RUN_ID, evidenceDir);
    const editEntries = (review?.auditLog ?? []).filter((e) => e.action === "edit");
    expect(editEntries).toHaveLength(1);
    expect(editEntries[0]?.candidateId).toBe("tc-1");
    expect(editEntries[0]?.reviewerLabel).toBe("Alice");
  });

  it("does NOT transition the candidate's review state on edit", async () => {
    const req = makeReq({
      candidateId: "tc-1",
      edited: { title: "Still open" },
      editorLabel: "Alice",
    });
    await handleQiEditCandidate(ctx(RUN_ID, req), deps(evidenceDir));
    const review = loadRunReviewState(RUN_ID, evidenceDir);
    expect(review?.candidateStates["tc-1"]).toBeUndefined();
  });

  it("leaves the IMMUTABLE run manifest file byte-identical after the edit", async () => {
    const before = readFileSync(MANIFEST_PATH(evidenceDir));
    const req = makeReq({
      candidateId: "tc-1",
      edited: { title: "Manifest untouched" },
      editorLabel: "Alice",
    });
    await handleQiEditCandidate(ctx(RUN_ID, req), deps(evidenceDir));
    const after = readFileSync(MANIFEST_PATH(evidenceDir));
    expect(after.equals(before)).toBe(true);
  });

  it("does not append a revision or audit entry for an identical repeat edit", async () => {
    const body = {
      candidateId: "tc-1",
      edited: { title: "Idempotent title" },
      editorLabel: "Alice",
    };
    await handleQiEditCandidate(ctx(RUN_ID, makeReq(body)), deps(evidenceDir));
    await handleQiEditCandidate(ctx(RUN_ID, makeReq(body)), deps(evidenceDir));

    const reloaded = loadQualityIntelligenceCandidates(RUN_ID, { evidenceDir });
    expect(reloaded?.editedRevisions).toHaveLength(1);

    const review = loadRunReviewState(RUN_ID, evidenceDir);
    const editEntries = (review?.auditLog ?? []).filter((entry) => entry.action === "edit");
    expect(editEntries).toHaveLength(1);
  });
});

// ─── Boundaries + list semantics + observability (Epic #712 hardening) ──────────

const errorOf = (result: RouteResult): { code: string; message: string } =>
  (result.body as { error: { code: string; message: string } }).error;

describe("handleQiEditCandidate — field boundaries", () => {
  it("accepts a title at exactly 256 chars and rejects 257", async () => {
    const ok = asResult(
      await handleQiEditCandidate(
        ctx(
          RUN_ID,
          makeReq({
            candidateId: "tc-1",
            edited: { title: "x".repeat(256) },
            editorLabel: "Alice",
          }),
        ),
        deps(evidenceDir),
      ),
    );
    expect(ok.status).toBe(200);
    const tooLong = asResult(
      await handleQiEditCandidate(
        ctx(
          RUN_ID,
          makeReq({
            candidateId: "tc-1",
            edited: { title: "x".repeat(257) },
            editorLabel: "Alice",
          }),
        ),
        deps(evidenceDir),
      ),
    );
    expect(tooLong.status).toBe(400);
    expect(errorOf(tooLong).code).toBe("QI_BAD_EDIT");
    expect(errorOf(tooLong).message).toContain("title");
  });

  it("accepts a list at exactly 100 items and rejects 101", async () => {
    const hundred = Array.from({ length: 100 }, (_, i) => `step-${String(i)}`);
    const ok = asResult(
      await handleQiEditCandidate(
        ctx(
          RUN_ID,
          makeReq({ candidateId: "tc-1", edited: { steps: hundred }, editorLabel: "Alice" }),
        ),
        deps(evidenceDir),
      ),
    );
    expect(ok.status).toBe(200);
    const tooMany = asResult(
      await handleQiEditCandidate(
        ctx(
          RUN_ID,
          makeReq({
            candidateId: "tc-1",
            edited: { steps: [...hundred, "step-100"] },
            editorLabel: "Alice",
          }),
        ),
        deps(evidenceDir),
      ),
    );
    expect(tooMany.status).toBe(400);
    expect(errorOf(tooMany).message).toContain("steps");
  });
});

describe("handleQiEditCandidate — list-field clearing semantics", () => {
  it("rejects clearing steps to an empty list with a field-named error", async () => {
    const result = asResult(
      await handleQiEditCandidate(
        ctx(RUN_ID, makeReq({ candidateId: "tc-1", edited: { steps: [] }, editorLabel: "Alice" })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(400);
    expect(errorOf(result).code).toBe("QI_BAD_EDIT");
    expect(errorOf(result).message).toContain("steps");
    // a rejected edit persists nothing
    expect(
      loadQualityIntelligenceCandidates(RUN_ID, { evidenceDir })?.editedRevisions ?? [],
    ).toHaveLength(0);
  });

  it("rejects clearing expectedResults to an empty list", async () => {
    const result = asResult(
      await handleQiEditCandidate(
        ctx(
          RUN_ID,
          makeReq({ candidateId: "tc-1", edited: { expectedResults: [] }, editorLabel: "Alice" }),
        ),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(400);
    expect(errorOf(result).message).toContain("expectedResults");
  });

  it("ACCEPTS clearing the optional preconditions list and persists the empty list", async () => {
    const result = asResult(
      await handleQiEditCandidate(
        ctx(
          RUN_ID,
          makeReq({ candidateId: "tc-1", edited: { preconditions: [] }, editorLabel: "Alice" }),
        ),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(200);
    const reloaded = loadQualityIntelligenceCandidates(RUN_ID, { evidenceDir });
    expect(reloaded?.candidates[0]?.preconditions).toEqual([]);
    expect(reloaded?.editedRevisions?.[0]?.editedFields.preconditions).toEqual([]);
  });

  it("ACCEPTS clearing the optional tags list", async () => {
    const result = asResult(
      await handleQiEditCandidate(
        ctx(RUN_ID, makeReq({ candidateId: "tc-1", edited: { tags: [] }, editorLabel: "Alice" })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(200);
    expect(loadQualityIntelligenceCandidates(RUN_ID, { evidenceDir })?.candidates[0]?.tags).toEqual(
      [],
    );
  });

  it("names the offending field for an invalid enum (actionable error)", async () => {
    const result = asResult(
      await handleQiEditCandidate(
        ctx(
          RUN_ID,
          makeReq({ candidateId: "tc-1", edited: { priority: "P9" }, editorLabel: "Alice" }),
        ),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(400);
    expect(errorOf(result).message).toContain("priority");
  });
});

describe("handleQiEditCandidate — review-state preservation + observability", () => {
  it("preserves an APPROVED candidate's review state across an edit", async () => {
    applyReviewDecision({
      runId: RUN_ID,
      evidenceDir,
      action: "approve",
      scope: "candidate",
      candidateId: "tc-1",
      reviewerLabel: "Alice",
      now: "2026-06-09T10:00:00.000Z",
    });
    const result = asResult(
      await handleQiEditCandidate(
        ctx(
          RUN_ID,
          makeReq({
            candidateId: "tc-1",
            edited: { title: "Edited after approval" },
            editorLabel: "Bob",
          }),
        ),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(200);
    const review = loadRunReviewState(RUN_ID, evidenceDir);
    expect(review?.candidateStates["tc-1"]).toBe("approved");
    const editEntry = (review?.auditLog ?? []).find((e) => e.action === "edit");
    // the edit audit entry records the candidate's CURRENT (approved) state on both sides
    expect(editEntry?.fromState).toBe("approved");
    expect(editEntry?.toState).toBe("approved");
  });

  it("returns 404 QI_CANDIDATES_NOT_FOUND when the run exists but its candidates artifact is missing", async () => {
    rmSync(join(evidenceDir, "qi", `${RUN_ID}.candidates.json`), { force: true });
    const result = asResult(
      await handleQiEditCandidate(
        ctx(RUN_ID, makeReq({ candidateId: "tc-1", edited: { title: "x" }, editorLabel: "Alice" })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(404);
    expect(errorOf(result).code).toBe("QI_CANDIDATES_NOT_FOUND");
  });
});
