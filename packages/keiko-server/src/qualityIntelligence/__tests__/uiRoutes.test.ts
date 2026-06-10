import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import type { RouteContext, RouteResult } from "../../routes.js";
import { STREAMING } from "../../routes.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "../../index.js";
import { createInMemoryUiStore } from "../../store/index.js";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";

// Stubbed @oscharko-dev/keiko-evidence surface used by uiRoutes. We import the handlers AFTER
// `vi.mock` so the doMock factory below is the one consulted at handler call time.
const listMock = vi.fn();
const loadMock = vi.fn();

vi.mock("@oscharko-dev/keiko-evidence", async () => {
  const actual = await vi.importActual<typeof import("@oscharko-dev/keiko-evidence")>(
    "@oscharko-dev/keiko-evidence",
  );
  return {
    ...actual,
    listQualityIntelligenceRuns: (...args: unknown[]): unknown => listMock(...args),
    loadQualityIntelligenceRun: (...args: unknown[]): unknown => loadMock(...args),
  };
});

const { handleListQiRuns, handleGetQiRun, QI_RUN_LIST_DEFAULT_LIMIT, QI_RUN_LIST_MAX_LIMIT } =
  await import("../uiRoutes.js");

// ---------------------------------------------------------------------------
// Fixture helpers — minimal RouteContext + UiHandlerDeps so we exercise only
// what handleListQiRuns/handleGetQiRun read (`ctx.params` and the deps shape).
// ---------------------------------------------------------------------------

function ctx(path: string, params: Record<string, string> = {}): RouteContext {
  return {
    req: {} as RouteContext["req"],
    res: {} as RouteContext["res"],
    params,
    url: new URL(`http://127.0.0.1${path}`),
  };
}

function asResult(outcome: RouteResult | typeof STREAMING): RouteResult {
  if (outcome === STREAMING) {
    throw new Error("expected RouteResult, got STREAMING");
  }
  return outcome;
}

function emptyStore(): EvidenceStore {
  return { put: () => "", list: () => [], get: () => undefined, delete: () => undefined };
}

function deps(): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: emptyStore(),
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
  };
}

// A schema-shaped manifest stub. Only the fields projection touches must be present;
// we still satisfy enough of the contract for the projection helpers to succeed.
function manifest(runId: string): unknown {
  return {
    qiEvidenceSchemaVersion: 1,
    runId,
    planAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    status: "succeeded",
    policyProfileIds: [],
    retentionPolicyId: "default",
    modelGatewayCallCount: 0,
    totals: { candidates: 2, findings: 1, exports: 0 },
    findings: [{ id: "f1", kind: "duplicate-policy", severity: "warn", summaryRedacted: "ok" }],
    exports: [],
    evidenceRefs: [{ envelopeId: "env-1", atomId: "atom-1", lifecycleStatus: "active" }],
    provenanceRefs: { envelopeIds: ["env-1"], auditSummaryId: "audit-1" },
    redactionSummary: { redactionsApplied: 0, redactionPatternIds: [] },
    integrityHashes: {
      findings: "0".repeat(64),
      exports: "0".repeat(64),
      evidenceRefs: "0".repeat(64),
    },
  };
}

// A sentinel sensitive string that simulates the OS-fs path/EvidenceReadError message that
// MUST NOT leak through any catch-block response body.
const SECRET_FS_PATH = "/private/var/folders/secret-evidence-dir/run-x.json";

beforeEach(() => {
  listMock.mockReset();
  loadMock.mockReset();
});

// ---------------------------------------------------------------------------
// handleListQiRuns
// ---------------------------------------------------------------------------

describe("handleListQiRuns", () => {
  it("returns projected run summaries on the happy path", () => {
    listMock.mockReturnValue(["run-a", "run-b"]);
    loadMock.mockImplementation((id: string) => manifest(id));

    const result = asResult(handleListQiRuns(ctx("/api/quality-intelligence/runs"), deps()));
    expect(result.status).toBe(200);
    const body = result.body as { runs: readonly { id: string; status: string }[] };
    expect(body.runs).toHaveLength(2);
    expect(body.runs.map((r) => r.id)).toEqual(["run-a", "run-b"]);
    expect(body.runs[0]?.status).toBe("succeeded");
  });

  it("returns an empty list when the store reports no runs", () => {
    listMock.mockReturnValue([]);

    const result = asResult(handleListQiRuns(ctx("/api/quality-intelligence/runs"), deps()));
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      runs: [],
      limit: QI_RUN_LIST_DEFAULT_LIMIT,
      totalRunIds: 0,
      truncated: false,
    });
    expect(loadMock).not.toHaveBeenCalled();
  });

  // Issue #646 — bound manifest loading so very large evidence stores do not block the BFF.
  describe("bounded list (issue #646)", () => {
    function ids(n: number): readonly string[] {
      return Array.from({ length: n }, (_, i) => `run-${String(i).padStart(4, "0")}`);
    }

    it("applies the default limit of 100 when no limit query parameter is provided", () => {
      listMock.mockReturnValue(ids(QI_RUN_LIST_DEFAULT_LIMIT + 25));
      loadMock.mockImplementation((id: string) => manifest(id));

      const result = asResult(handleListQiRuns(ctx("/api/quality-intelligence/runs"), deps()));
      expect(result.status).toBe(200);
      const body = result.body as {
        runs: readonly { id: string }[];
        limit: number;
        totalRunIds: number;
        truncated: boolean;
      };
      expect(body.limit).toBe(QI_RUN_LIST_DEFAULT_LIMIT);
      expect(body.runs.length).toBe(QI_RUN_LIST_DEFAULT_LIMIT);
      expect(body.totalRunIds).toBe(QI_RUN_LIST_DEFAULT_LIMIT + 25);
      expect(body.truncated).toBe(true);
      // The route must NOT call load for ids past the limit.
      expect(loadMock).toHaveBeenCalledTimes(QI_RUN_LIST_DEFAULT_LIMIT);
    });

    it("accepts an explicit smaller limit and reports it in the response envelope", () => {
      listMock.mockReturnValue(ids(10));
      loadMock.mockImplementation((id: string) => manifest(id));

      const result = asResult(
        handleListQiRuns(ctx("/api/quality-intelligence/runs?limit=3"), deps()),
      );
      expect(result.status).toBe(200);
      const body = result.body as {
        runs: readonly { id: string }[];
        limit: number;
        totalRunIds: number;
        truncated: boolean;
      };
      expect(body.limit).toBe(3);
      expect(body.runs.map((r) => r.id)).toEqual(["run-0000", "run-0001", "run-0002"]);
      expect(body.totalRunIds).toBe(10);
      expect(body.truncated).toBe(true);
      expect(loadMock).toHaveBeenCalledTimes(3);
    });

    it("caps an explicit limit at QI_RUN_LIST_MAX_LIMIT", () => {
      listMock.mockReturnValue(ids(50));
      loadMock.mockImplementation((id: string) => manifest(id));

      const result = asResult(
        handleListQiRuns(
          ctx(`/api/quality-intelligence/runs?limit=${String(QI_RUN_LIST_MAX_LIMIT + 200)}`),
          deps(),
        ),
      );
      expect(result.status).toBe(200);
      const body = result.body as { limit: number; truncated: boolean; totalRunIds: number };
      expect(body.limit).toBe(QI_RUN_LIST_MAX_LIMIT);
      // 50 runs available, capped limit 500 → not truncated.
      expect(body.truncated).toBe(false);
      expect(body.totalRunIds).toBe(50);
    });

    it("sets truncated = false when totalRunIds is at or below the limit", () => {
      listMock.mockReturnValue(ids(QI_RUN_LIST_DEFAULT_LIMIT));
      loadMock.mockImplementation((id: string) => manifest(id));

      const result = asResult(handleListQiRuns(ctx("/api/quality-intelligence/runs"), deps()));
      expect(result.status).toBe(200);
      const body = result.body as { truncated: boolean; totalRunIds: number };
      expect(body.truncated).toBe(false);
      expect(body.totalRunIds).toBe(QI_RUN_LIST_DEFAULT_LIMIT);
    });

    it.each([
      ["0", "non-positive"],
      ["-1", "negative"],
      ["abc", "non-numeric"],
      ["1.5", "fractional"],
      ["1e2", "scientific notation"],
      [" 5", "whitespace"],
      ["", "empty"],
    ])("returns 400 BAD_REQUEST for malformed limit %s (%s)", (raw, _label) => {
      listMock.mockReturnValue(ids(5));
      const result = asResult(
        handleListQiRuns(
          ctx(`/api/quality-intelligence/runs?limit=${encodeURIComponent(raw)}`),
          deps(),
        ),
      );
      expect(result.status).toBe(400);
      expect(result.body).toEqual({
        error: { code: "BAD_REQUEST", message: "limit must be a positive integer" },
      });
      // listQualityIntelligenceRuns must never be called for a malformed limit.
      expect(listMock).not.toHaveBeenCalled();
      expect(loadMock).not.toHaveBeenCalled();
    });
  });

  it("returns a standard LIST_FAILED error envelope and never echoes the error message on list failure", () => {
    listMock.mockImplementation(() => {
      throw new Error(`ENOENT: no such file or directory, open '${SECRET_FS_PATH}'`);
    });

    const result = asResult(handleListQiRuns(ctx("/api/quality-intelligence/runs"), deps()));
    expect(result.status).toBe(500);
    expect(result.body).toEqual({
      error: {
        code: "LIST_FAILED",
        message: "Failed to list Quality Intelligence runs",
      },
    });

    const serialised = JSON.stringify(result.body);
    expect(serialised).not.toContain(SECRET_FS_PATH);
    expect(serialised).not.toContain("ENOENT");
  });
});

// ---------------------------------------------------------------------------
// handleGetQiRun
// ---------------------------------------------------------------------------

describe("handleGetQiRun", () => {
  it("returns a projected run detail on the happy path", () => {
    loadMock.mockReturnValue(manifest("run-x"));

    const result = asResult(
      handleGetQiRun(ctx("/api/quality-intelligence/runs/run-x", { id: "run-x" }), deps()),
    );
    expect(result.status).toBe(200);
    const body = result.body as { id: string; status: string; manifestSchemaVersion: number };
    expect(body.id).toBe("run-x");
    expect(body.status).toBe("succeeded");
    expect(body.manifestSchemaVersion).toBe(1);
  });

  it("projects requirement excerpts onto coverageByAtom and tolerates legacy rows (#790)", () => {
    const withCoverage = {
      ...(manifest("run-x") as Record<string, unknown>),
      coverageMatrix: [
        {
          atomId: "atom-1",
          status: "uncovered",
          confidence: 0,
          coveringCandidateIds: [],
          requirementExcerptRedacted: "Lock the account after five failed logins.",
        },
        // Legacy row recorded before #790: no excerpt field.
        { atomId: "atom-2", status: "covered", confidence: 0.9, coveringCandidateIds: ["tc-1"] },
      ],
    };
    loadMock.mockReturnValue(withCoverage);

    const result = asResult(
      handleGetQiRun(ctx("/api/quality-intelligence/runs/run-x", { id: "run-x" }), deps()),
    );
    expect(result.status).toBe(200);
    const body = result.body as {
      coverageByAtom: readonly {
        atomId: string;
        requirementExcerptRedacted?: string;
      }[];
    };
    const row1 = body.coverageByAtom.find((r) => r.atomId === "atom-1");
    expect(row1?.requirementExcerptRedacted).toBe("Lock the account after five failed logins.");
    const row2 = body.coverageByAtom.find((r) => r.atomId === "atom-2");
    expect(row2).toBeDefined();
    expect(row2?.requirementExcerptRedacted).toBeUndefined();
  });

  it("returns 400 BAD_REQUEST for an empty id", () => {
    const result = asResult(
      handleGetQiRun(ctx("/api/quality-intelligence/runs/", { id: "" }), deps()),
    );
    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: { code: "BAD_REQUEST", message: "Run id is required" },
    });
    expect(loadMock).not.toHaveBeenCalled();
  });

  it("returns 404 NOT_FOUND when the manifest is undefined", () => {
    loadMock.mockReturnValue(undefined);

    const result = asResult(
      handleGetQiRun(
        ctx("/api/quality-intelligence/runs/run-missing", { id: "run-missing" }),
        deps(),
      ),
    );
    expect(result.status).toBe(404);
    expect(result.body).toEqual({
      error: { code: "NOT_FOUND", message: "Quality Intelligence run not found" },
    });
  });

  it("returns a static INTERNAL error and never echoes the error message on load failure", () => {
    loadMock.mockImplementation(() => {
      throw new Error(`EACCES: permission denied, open '${SECRET_FS_PATH}'`);
    });

    const result = asResult(
      handleGetQiRun(ctx("/api/quality-intelligence/runs/run-boom", { id: "run-boom" }), deps()),
    );
    expect(result.status).toBe(500);
    expect(result.body).toEqual({
      error: { code: "INTERNAL", message: "Failed to load Quality Intelligence run" },
    });

    const serialised = JSON.stringify(result.body);
    expect(serialised).not.toContain(SECRET_FS_PATH);
    expect(serialised).not.toContain("EACCES");
  });
});

// ---------------------------------------------------------------------------
// Issue #620 regression — evidenceDir wiring
//
// With deps.evidenceDir populated, the handlers must pass the dir through to
// listQualityIntelligenceRuns / loadQualityIntelligenceRun.  Before the fix,
// resolveEvidenceDir(deps) returned undefined unconditionally, which caused
// resolveLoadStore to throw EvidenceReadError on every call:
//   LIST  → 500 LIST_FAILED              (instead of 200 runs:[])
//   GET   → 500 INTERNAL                  (instead of 404 NOT_FOUND)
// ---------------------------------------------------------------------------

describe("evidenceDir wiring (issue #620)", () => {
  // Use the real keiko-evidence implementations so the fix is observable end-to-end.
  // The module-level vi.mock still intercepts the calls; we configure them to call
  // through to the actual implementations here.
  let actualList: (opts: { evidenceDir?: string }) => readonly string[];
  let actualLoad: (id: string, opts: { evidenceDir?: string }) => unknown;
  let actualRecord: typeof import("@oscharko-dev/keiko-evidence").recordQualityIntelligenceRun;
  let actualRecordCandidates: typeof import("@oscharko-dev/keiko-evidence").recordQualityIntelligenceCandidates;
  let evidenceDir: string;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("@oscharko-dev/keiko-evidence")>(
      "@oscharko-dev/keiko-evidence",
    );
    actualList = actual.listQualityIntelligenceRuns;
    actualLoad = actual.loadQualityIntelligenceRun;
    actualRecord = actual.recordQualityIntelligenceRun;
    actualRecordCandidates = actual.recordQualityIntelligenceCandidates;

    listMock.mockImplementation((opts: { evidenceDir?: string }): readonly string[] =>
      actualList(opts),
    );
    loadMock.mockImplementation((id: string, opts: { evidenceDir?: string }): unknown =>
      actualLoad(id, opts),
    );

    evidenceDir = mkdtempSync(join(tmpdir(), "keiko-qi-test-"));
  });

  afterEach(() => {
    rmSync(evidenceDir, { recursive: true, force: true });
    listMock.mockReset();
    loadMock.mockReset();
  });

  it("handleListQiRuns returns 200 {runs:[]} (not LIST_FAILED) when evidenceDir is wired", () => {
    const depsWithDir: UiHandlerDeps = { ...deps(), evidenceDir };

    const result = asResult(handleListQiRuns(ctx("/api/quality-intelligence/runs"), depsWithDir));

    expect(result.status).toBe(200);
    const body = result.body as { runs: unknown[]; truncated: boolean; totalRunIds: number };
    expect(body.runs).toEqual([]);
    expect(body.truncated).toBe(false);
    expect(body.totalRunIds).toBe(0);
  });

  it("handleGetQiRun returns 404 NOT_FOUND (not 500 INTERNAL) for an unknown id when evidenceDir is wired", () => {
    const depsWithDir: UiHandlerDeps = { ...deps(), evidenceDir };

    const result = asResult(
      handleGetQiRun(
        ctx("/api/quality-intelligence/runs/unknown-id", { id: "unknown-id" }),
        depsWithDir,
      ),
    );

    // Regression: before the fix this was 500 INTERNAL because resolveLoadStore threw
    expect(result.status).toBe(404);
    expect(result.body).toEqual({
      error: { code: "NOT_FOUND", message: "Quality Intelligence run not found" },
    });
  });

  it("handleGetQiRun fails closed when the candidates companion is malformed", () => {
    const runId = "run-corrupt-candidates";
    actualRecord(
      {
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
        evidenceRefs: [],
        provenanceRefs: {
          envelopeIds: [],
          auditSummaryId:
            "qi-audit-ui-routes" as import("@oscharko-dev/keiko-evidence").QualityIntelligenceEvidenceManifest["provenanceRefs"]["auditSummaryId"],
        },
      },
      { evidenceDir },
    );
    actualRecordCandidates({
      runId,
      generatedAt: "2026-06-09T10:01:00.000Z",
      candidates: [
        {
          id: QualityIntelligence.asQualityIntelligenceTestCaseId("cand-corrupt-001"),
          runId: QualityIntelligence.asQualityIntelligenceRunId(runId),
          derivedFromAtomIds: [],
          title: "Corrupt me",
          preconditions: ["ready"],
          steps: ["one"],
          expectedResults: ["done"],
          priority: "P1",
          riskClass: "functional",
          tags: [],
          status: "proposed",
        },
      ],
      evidenceDir,
      redact: (value: unknown): unknown => value,
    });
    writeFileSync(
      join(evidenceDir, "qi", `${runId}.candidates.json`),
      JSON.stringify({
        qiCandidatesSchemaVersion: 1,
        runId,
        generatedAt: "2026-06-09T10:01:00.000Z",
        candidates: [
          {
            id: "cand-corrupt-001",
            title: "Corrupt me",
            preconditions: ["ready"],
            steps: "not-an-array",
            expectedResults: ["done"],
            priority: "P1",
            riskClass: "functional",
            tags: [],
            status: "proposed",
            derivedFromAtomIds: [],
          },
        ],
      }),
      "utf8",
    );

    const depsWithDir: UiHandlerDeps = { ...deps(), evidenceDir };
    const result = asResult(
      handleGetQiRun(ctx(`/api/quality-intelligence/runs/${runId}`, { id: runId }), depsWithDir),
    );

    expect(result.status).toBe(500);
    expect(result.body).toEqual({
      error: { code: "INTERNAL", message: "Failed to load Quality Intelligence run" },
    });
  });

  it("projects persisted weak-test rationale onto the candidate weakTestFlag", () => {
    const runId = "run-weak-flag";
    const candidateId = "cand-weak-001";
    actualRecord(
      {
        runId,
        planAt: "2026-06-09T10:00:00.000Z",
        completedAt: "2026-06-09T10:01:00.000Z",
        status: "succeeded",
        policyProfileIds: [],
        retentionPolicyId: "default",
        modelGatewayCallCount: 1,
        totals: { candidates: 1, findings: 1, exports: 0 },
        findings: [
          {
            id: "finding-weak-001",
            kind: "test-quality",
            severity: "high",
            summaryRedacted:
              "AC fidelity: Misses the stated acceptance criteria.; Determinism: Relies on timing-sensitive behavior.",
            candidateId,
          },
        ],
        exports: [],
        evidenceRefs: [],
        provenanceRefs: {
          envelopeIds: [],
          auditSummaryId:
            "qi-audit-ui-routes-weak" as import("@oscharko-dev/keiko-evidence").QualityIntelligenceEvidenceManifest["provenanceRefs"]["auditSummaryId"],
        },
      },
      { evidenceDir },
    );
    actualRecordCandidates({
      runId,
      generatedAt: "2026-06-09T10:01:00.000Z",
      candidates: [
        {
          id: QualityIntelligence.asQualityIntelligenceTestCaseId(candidateId),
          runId: QualityIntelligence.asQualityIntelligenceRunId(runId),
          derivedFromAtomIds: [],
          title: "Weak candidate",
          preconditions: ["ready"],
          steps: ["open help"],
          expectedResults: ["help center opens"],
          priority: "P1",
          riskClass: "functional",
          tags: [],
          status: "proposed",
        },
      ],
      evidenceDir,
      redact: (value: unknown): unknown => value,
    });

    const depsWithDir: UiHandlerDeps = { ...deps(), evidenceDir };
    const result = asResult(
      handleGetQiRun(ctx(`/api/quality-intelligence/runs/${runId}`, { id: runId }), depsWithDir),
    );

    expect(result.status).toBe(200);
    const body = result.body as {
      findingRefs: readonly { id: string; summaryRedacted: string }[];
      candidates: readonly {
        id: string;
        weakTestFlag?: { severity: string; rationale: string };
      }[];
    };
    expect(body.findingRefs).toEqual([
      expect.objectContaining({
        id: "finding-weak-001",
        summaryRedacted:
          "AC fidelity: Misses the stated acceptance criteria.; Determinism: Relies on timing-sensitive behavior.",
      }),
    ]);
    expect(body.candidates).toEqual([
      expect.objectContaining({
        id: candidateId,
        weakTestFlag: {
          severity: "high",
          rationale:
            "AC fidelity: Misses the stated acceptance criteria.; Determinism: Relies on timing-sensitive behavior.",
        },
      }),
    ]);
  });
});
