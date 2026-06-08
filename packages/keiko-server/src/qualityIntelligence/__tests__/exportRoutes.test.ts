// Integration tests for handleQiExport (Epic #270, Issue #283).
//
// Seeds a temp evidenceDir with a recorded run manifest + candidate artifact, then calls
// the handler directly. Verifies local adapters, unknown adapter, TMS dry-run/live,
// no-candidates, and formula-injection safety. Pure function + real fs.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import {
  recordQualityIntelligenceRun,
  recordQualityIntelligenceCandidates,
} from "@oscharko-dev/keiko-evidence";
import type {
  EvidenceStore,
  QualityIntelligenceEvidenceManifest,
} from "@oscharko-dev/keiko-evidence";
import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import type { QualityIntelligence as QI } from "@oscharko-dev/keiko-contracts";
import type { RouteContext, RouteResult } from "../../routes.js";
import { STREAMING } from "../../routes.js";
import type { UiHandlerDeps } from "../../deps.js";
import { buildRedactor, createRunRegistry } from "../../index.js";
import { createInMemoryUiStore } from "../../store/index.js";
import { handleQiExport } from "../exportRoutes.js";
import { applyReviewDecision } from "../reviewStore.js";

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

function ctx(runId: string, req: IncomingMessage): RouteContext {
  return {
    req,
    res: {} as RouteContext["res"],
    params: { id: runId },
    url: new URL(`http://127.0.0.1/api/quality-intelligence/runs/${runId}/export`),
  };
}

function asResult(outcome: RouteResult | typeof STREAMING): RouteResult {
  if (outcome === STREAMING) throw new Error("expected RouteResult, got STREAMING");
  return outcome;
}

/** Minimal run record input with matched totals. */
function runRecordInput(runId: string): Parameters<typeof recordQualityIntelligenceRun>[0] {
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

/** Build a minimal test-case candidate. */
function makeCandidate(title: string, id = "cand-001"): QI.QualityIntelligenceTestCaseCandidate {
  return {
    id: QualityIntelligence.asQualityIntelligenceTestCaseId(id),
    runId: QualityIntelligence.asQualityIntelligenceRunId("run-export-001"),
    derivedFromAtomIds: [QualityIntelligence.asQualityIntelligenceEvidenceAtomId("atom-1")],
    title,
    preconditions: ["User is on the login page"],
    steps: ["Enter email", "Enter password", "Click Submit"],
    expectedResults: ["User is redirected to dashboard"],
    priority: "P1",
    riskClass: "functional",
    tags: ["smoke"],
    status: "proposed",
  };
}

// ─── Test lifecycle ───────────────────────────────────────────────────────────

let evidenceDir: string;

const RUN_ID = "run-export-001";

beforeEach(() => {
  evidenceDir = mkdtempSync(join(tmpdir(), "keiko-export-test-"));
  // Seed the manifest.
  recordQualityIntelligenceRun(runRecordInput(RUN_ID), { evidenceDir });
  // Seed the candidate artifact with one candidate.
  recordQualityIntelligenceCandidates({
    runId: RUN_ID,
    generatedAt: "2026-06-01T10:01:00.000Z",
    candidates: [makeCandidate("User can log in with valid credentials")],
    evidenceDir,
    redact: (v: unknown): unknown => v,
  });
});

afterEach(() => {
  rmSync(evidenceDir, { recursive: true, force: true });
});

// ─── Error: missing id param ──────────────────────────────────────────────────

describe("handleQiExport — missing id param", () => {
  it("returns 400 QI_BAD_REQUEST when id param is absent", async () => {
    const c: RouteContext = {
      req: makeReq({ adapter: "csv" }),
      res: {} as RouteContext["res"],
      params: {},
      url: new URL("http://127.0.0.1/api/quality-intelligence/runs//export"),
    };
    const result = asResult(await handleQiExport(c, deps(evidenceDir)));
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_REQUEST");
  });

  it("returns 400 QI_BAD_REQUEST when id param is an empty string", async () => {
    const c: RouteContext = {
      req: makeReq({ adapter: "csv" }),
      res: {} as RouteContext["res"],
      params: { id: "" },
      url: new URL("http://127.0.0.1/api/quality-intelligence/runs//export"),
    };
    const result = asResult(await handleQiExport(c, deps(evidenceDir)));
    expect(result.status).toBe(400);
  });
});

// ─── Error: no evidence dir ───────────────────────────────────────────────────

describe("handleQiExport — no evidence dir", () => {
  it("returns 500 QI_NO_EVIDENCE_DIR when evidenceDir is not configured", async () => {
    const result = asResult(
      await handleQiExport(ctx(RUN_ID, makeReq({ adapter: "csv" })), depsNoDir()),
    );
    expect(result.status).toBe(500);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_NO_EVIDENCE_DIR");
  });
});

// ─── Error: non-JSON body ────────────────────────────────────────────────────

describe("handleQiExport — non-JSON body", () => {
  it("returns 400 QI_BAD_REQUEST for a non-JSON body", async () => {
    const result = asResult(
      await handleQiExport(ctx(RUN_ID, makeRawReq("not json")), deps(evidenceDir)),
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_REQUEST");
  });

  it("returns 400 QI_BAD_REQUEST for a JSON array body", async () => {
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeRawReq(JSON.stringify([{ adapter: "csv" }]))),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(400);
  });
});

// ─── Error: unknown adapter ────────────────────────────────────────────────────

describe("handleQiExport — unknown adapter", () => {
  it("returns 400 QI_BAD_ADAPTER for an unrecognised adapter value", async () => {
    const result = asResult(
      await handleQiExport(ctx(RUN_ID, makeReq({ adapter: "not-an-adapter" })), deps(evidenceDir)),
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_ADAPTER");
  });

  it("returns 400 QI_BAD_ADAPTER when adapter field is missing from body", async () => {
    const result = asResult(
      await handleQiExport(ctx(RUN_ID, makeReq({ dryRun: false })), deps(evidenceDir)),
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_BAD_ADAPTER");
  });
});

// ─── Error: run not found ─────────────────────────────────────────────────────

describe("handleQiExport — run not found", () => {
  it("returns 404 QI_NOT_FOUND for an unknown run id", async () => {
    const result = asResult(
      await handleQiExport(
        ctx("run-does-not-exist", makeReq({ adapter: "csv" })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(404);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_NOT_FOUND");
  });
});

// ─── Error: no candidates artifact ───────────────────────────────────────────

describe("handleQiExport — no candidates", () => {
  it("returns 409 QI_NO_CANDIDATES for a run with no candidate artifact", async () => {
    // Record a run WITHOUT a candidate artifact.
    const emptyDir = mkdtempSync(join(tmpdir(), "keiko-export-no-cands-"));
    try {
      recordQualityIntelligenceRun(runRecordInput("run-no-cands"), { evidenceDir: emptyDir });
      // No recordQualityIntelligenceCandidates call — artifact is absent.
      const result = asResult(
        await handleQiExport(ctx("run-no-cands", makeReq({ adapter: "csv" })), deps(emptyDir)),
      );
      expect(result.status).toBe(409);
      expect((result.body as { error: { code: string } }).error.code).toBe("QI_NO_CANDIDATES");
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

// ─── Happy path: CSV adapter (local) ─────────────────────────────────────────

describe("handleQiExport — CSV adapter", () => {
  it("returns 200 with dryRun: false for adapter 'csv'", async () => {
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "csv", dryRun: false })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(200);
    const body = result.body as { dryRun: boolean };
    expect(body.dryRun).toBe(false);
  });

  it("CSV result body has a non-empty 'body' field", async () => {
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "csv", dryRun: false })),
        deps(evidenceDir),
      ),
    );
    const body = result.body as { body: string };
    expect(typeof body.body).toBe("string");
    expect(body.body.length).toBeGreaterThan(0);
  });

  it("CSV result filename ends with .csv", async () => {
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "csv", dryRun: false })),
        deps(evidenceDir),
      ),
    );
    const body = result.body as { filename: string };
    expect(body.filename).toMatch(/\.csv$/);
  });

  it("CSV adapter returns contentType text/csv", async () => {
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "csv", dryRun: false })),
        deps(evidenceDir),
      ),
    );
    const body = result.body as { contentType: string };
    expect(body.contentType).toBe("text/csv");
  });
});

// ─── Happy path: JSON adapter (local) ────────────────────────────────────────

describe("handleQiExport — JSON adapter", () => {
  it("returns 200 with dryRun: false for adapter 'json'", async () => {
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "json", dryRun: false })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(200);
    expect((result.body as { dryRun: boolean }).dryRun).toBe(false);
  });

  it("JSON result filename ends with .json", async () => {
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "json", dryRun: false })),
        deps(evidenceDir),
      ),
    );
    const body = result.body as { filename: string };
    expect(body.filename).toMatch(/\.json$/);
  });
});

// ─── TMS adapter: jira-issues with dryRun: false → 403 ────────────────────────

describe("handleQiExport — TMS adapter live export disabled", () => {
  it("returns 403 QI_EXTERNAL_EXPORT_DISABLED for jira-issues with dryRun: false and approved candidates", async () => {
    // Approve the seeded candidate so it passes the approval filter.
    applyReviewDecision({
      runId: RUN_ID,
      evidenceDir,
      action: "approve",
      scope: "candidate",
      candidateId: "cand-001",
      reviewerLabel: "tester",
      now: new Date().toISOString(),
    });

    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "jira-issues", dryRun: false })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(403);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "QI_EXTERNAL_EXPORT_DISABLED",
    );
  });
});

// ─── TMS adapter: jira-issues dryRun: true with no approved candidates → 409 ──

describe("handleQiExport — TMS dryRun with no approved candidates", () => {
  it("returns 409 QI_NOTHING_TO_EXPORT for jira-issues dryRun: true with zero approved candidates", async () => {
    // No review decision applied — all candidates remain in 'open' state.
    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "jira-issues", dryRun: true })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(409);
    expect((result.body as { error: { code: string } }).error.code).toBe("QI_NOTHING_TO_EXPORT");
  });
});

// ─── TMS adapter: jira-issues dryRun: true with approved candidate → 200 ──────

describe("handleQiExport — TMS dryRun with approved candidate", () => {
  it("returns 200 dryRun: true with candidateCount >= 1 after approval", async () => {
    // Approve the seeded candidate.
    applyReviewDecision({
      runId: RUN_ID,
      evidenceDir,
      action: "approve",
      scope: "candidate",
      candidateId: "cand-001",
      reviewerLabel: "tester",
      now: new Date().toISOString(),
    });

    const result = asResult(
      await handleQiExport(
        ctx(RUN_ID, makeReq({ adapter: "jira-issues", dryRun: true })),
        deps(evidenceDir),
      ),
    );
    expect(result.status).toBe(200);
    const body = result.body as { dryRun: boolean; candidateCount: number };
    expect(body.dryRun).toBe(true);
    expect(body.candidateCount).toBeGreaterThanOrEqual(1);
  });
});

// ─── Formula-injection safety ─────────────────────────────────────────────────

describe("handleQiExport — formula-injection safety in CSV", () => {
  // Seed a candidate whose title starts with a formula-triggering character.
  // The exported CSV must not contain a bare formula-injection prefix in the cell.
  it.each([
    ["=SUM(A1:B1)", "="],
    ["@echo attack", "@"],
    ["+CMD|calc", "+"],
    ["-1+1", "-"],
  ])("title starting with '%s' is safe in CSV output", async (title) => {
    const injDir = mkdtempSync(join(tmpdir(), "keiko-export-inject-"));
    const injRunId = "run-inject-test";
    try {
      recordQualityIntelligenceRun(
        { ...runRecordInput(injRunId), totals: { candidates: 1, findings: 0, exports: 0 } },
        { evidenceDir: injDir },
      );
      recordQualityIntelligenceCandidates({
        runId: injRunId,
        generatedAt: "2026-06-01T10:01:00.000Z",
        candidates: [makeCandidate(title, "cand-inject")],
        evidenceDir: injDir,
        redact: (v: unknown): unknown => v,
      });

      const result = asResult(
        await handleQiExport(
          ctx(injRunId, makeReq({ adapter: "spreadsheet-safe-csv", dryRun: false })),
          deps(injDir),
        ),
      );
      expect(result.status).toBe(200);
      const csvBody = (result.body as { body: string }).body;

      // The raw formula prefix must not appear unescaped at the start of a CSV cell.
      // A bare comma-then-formula-char would be the injection point.
      const triggerChars = ["=", "@", "+", "-"];
      for (const char of triggerChars) {
        if (title.startsWith(char)) {
          // The cell must NOT start directly with the formula char after a comma or at line start.
          // Acceptable: quoted cell "=SUM(...)", prefixed cell '=SUM(...), or any non-bare form.
          // We assert that the raw formula string does not appear unquoted after comma/newline.
          // Escape ALL regex metacharacters (incl. backslash) so the pattern is built safely.
          const escaped = char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const barePattern = new RegExp(`(?:,|\n|^)${escaped}`, "m");
          expect(barePattern.test(csvBody)).toBe(false);
          break;
        }
      }
    } finally {
      rmSync(injDir, { recursive: true, force: true });
    }
  });
});

// ─── All local adapters return 200 ────────────────────────────────────────────

describe("handleQiExport — local adapter coverage", () => {
  it.each(["csv", "json", "spreadsheet-safe-csv"])("adapter '%s' returns 200", async (adapter) => {
    const result = asResult(
      await handleQiExport(ctx(RUN_ID, makeReq({ adapter, dryRun: false })), deps(evidenceDir)),
    );
    expect(result.status).toBe(200);
  });
});

// ─── All TMS adapters with dryRun: false → 403 or 409 ────────────────────────

describe("handleQiExport — all TMS adapters reject live export", () => {
  it.each(["jira-issues", "qtest", "xray", "polarion", "alm"])(
    "TMS adapter '%s' with dryRun: false returns 403 (after approval) or 409 (no approval)",
    async (adapter) => {
      const result = asResult(
        await handleQiExport(ctx(RUN_ID, makeReq({ adapter, dryRun: false })), deps(evidenceDir)),
      );
      // Without approval → 409; the TMS live-export guard fires before the format check.
      // The test asserts the status is NOT 200, i.e. live TMS export is never allowed.
      expect(result.status).not.toBe(200);
    },
  );
});
