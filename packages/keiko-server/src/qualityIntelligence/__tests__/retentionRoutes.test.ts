// Integration tests for handleQiDeleteRun (Epic #270, Issue #282 follow-up; ADR-0023 D8).
//
// Seeds a real evidenceDir with a recorded QI run manifest plus a `.review.json` companion
// (reviewer labels + audit log), then fires the delete handler directly. Verifies the manifest AND
// the server-owned `.review.json` companion are swept (no orphaned customer-derived content),
// not-found → 404, idempotent re-delete → 404, missing-id → 400, missing-evidenceDir → 500.
// No network — pure handler + real fs.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  recordQualityIntelligenceRun,
  type EvidenceStore,
  type QualityIntelligenceEvidenceManifest,
} from "@oscharko-dev/keiko-evidence";
import type { IncomingMessage } from "node:http";
import type { RouteContext, RouteResult } from "../../routes.js";
import { STREAMING } from "../../routes.js";
import type { UiHandlerDeps } from "../../deps.js";
import { buildRedactor, createRunRegistry } from "../../index.js";
import { createInMemoryUiStore } from "../../store/index.js";
import { handleQiDeleteRun } from "../retentionRoutes.js";
import { applyReviewDecision } from "../reviewStore.js";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function emptyStore(): EvidenceStore {
  return { put: () => "", list: () => [], get: () => undefined, delete: () => undefined };
}

function deps(evidenceDir: string | undefined): UiHandlerDeps {
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

function emptyReq(): IncomingMessage {
  return Readable.from([]) as unknown as IncomingMessage;
}

function ctx(runId: string | undefined): RouteContext {
  return {
    req: emptyReq(),
    res: {} as RouteContext["res"],
    params: runId === undefined ? {} : { id: runId },
    url: new URL(`http://127.0.0.1/api/quality-intelligence/runs/${runId ?? ""}`),
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

const manifestPath = (evidenceDir: string, runId: string): string =>
  join(evidenceDir, "qi", `${runId}.qi.json`);
const reviewPath = (evidenceDir: string, runId: string): string =>
  join(evidenceDir, "qi", `${runId}.review.json`);

// ─── Test lifecycle ───────────────────────────────────────────────────────────

const RUN_ID = "run-delete-001";
let evidenceDir: string;

beforeEach(() => {
  evidenceDir = mkdtempSync(join(tmpdir(), "keiko-delete-test-"));
  recordQualityIntelligenceRun(minimalRecordInput(RUN_ID), { evidenceDir });
  // Seed a `.review.json` companion holding a reviewer label + audit entry — the customer-derived
  // content that must NOT survive deletion.
  applyReviewDecision({
    runId: RUN_ID,
    evidenceDir,
    action: "approve",
    scope: "run",
    reviewerLabel: "alice",
    now: "2026-06-01T10:02:00.000Z",
    redact: (value: unknown): unknown => value,
  });
});

afterEach(() => {
  rmSync(evidenceDir, { recursive: true, force: true });
});

// ─── Happy path: manifest + .review.json swept ──────────────────────────────────

describe("handleQiDeleteRun — delete sweeps the run and its review companion", () => {
  it("removes the manifest AND the .review.json companion, returns 200 + receipt", () => {
    // Pre-condition: both files exist.
    expect(existsSync(manifestPath(evidenceDir, RUN_ID))).toBe(true);
    expect(existsSync(reviewPath(evidenceDir, RUN_ID))).toBe(true);

    const result = asResult(handleQiDeleteRun(ctx(RUN_ID), deps(evidenceDir)));

    expect(result.status).toBe(200);
    const body = result.body as {
      runId: string;
      status: string;
      removedCompanionSuffixes: readonly string[];
    };
    expect(body.runId).toBe(RUN_ID);
    expect(body.status).toBe("deleted");
    expect(body.removedCompanionSuffixes).toContain(".review.json");
    // Post-condition: NOTHING is left on disk for this run (no orphaned reviewer labels).
    expect(existsSync(manifestPath(evidenceDir, RUN_ID))).toBe(false);
    expect(existsSync(reviewPath(evidenceDir, RUN_ID))).toBe(false);
  });

  it("does not report .review.json as removed when no review companion exists", () => {
    rmSync(reviewPath(evidenceDir, RUN_ID), { force: true });
    const result = asResult(handleQiDeleteRun(ctx(RUN_ID), deps(evidenceDir)));
    expect(result.status).toBe(200);
    const body = result.body as { removedCompanionSuffixes: readonly string[] };
    expect(body.removedCompanionSuffixes).not.toContain(".review.json");
  });
});

// ─── Not-found + idempotency ────────────────────────────────────────────────────

describe("handleQiDeleteRun — not found", () => {
  it("returns 404 when the run manifest is absent", () => {
    const result = asResult(handleQiDeleteRun(ctx("run-does-not-exist"), deps(evidenceDir)));
    expect(result.status).toBe(404);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_NOT_FOUND");
  });

  it("returns 404 on a second delete of the same run (manifest already gone)", () => {
    expect(asResult(handleQiDeleteRun(ctx(RUN_ID), deps(evidenceDir))).status).toBe(200);
    const second = asResult(handleQiDeleteRun(ctx(RUN_ID), deps(evidenceDir)));
    expect(second.status).toBe(404);
  });
});

// ─── Guards ─────────────────────────────────────────────────────────────────────

describe("handleQiDeleteRun — guards", () => {
  it("returns 400 when the id param is absent", () => {
    const result = asResult(handleQiDeleteRun(ctx(undefined), deps(evidenceDir)));
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_REQUEST");
  });

  it("returns 400 when the id param is whitespace only", () => {
    const result = asResult(handleQiDeleteRun(ctx("   "), deps(evidenceDir)));
    expect(result.status).toBe(400);
  });

  it("returns 500 when the evidence directory is not configured", () => {
    const result = asResult(handleQiDeleteRun(ctx(RUN_ID), deps(undefined)));
    expect(result.status).toBe(500);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_NO_EVIDENCE_DIR");
  });
});
