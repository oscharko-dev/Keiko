import { beforeEach, describe, expect, it, vi } from "vitest";
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

const { handleListQiRuns, handleGetQiRun } = await import("../uiRoutes.js");

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
    expect(result.body).toEqual({ runs: [] });
    expect(loadMock).not.toHaveBeenCalled();
  });

  it("returns a static LIST_FAILED hint and never echoes the error message on list failure", () => {
    listMock.mockImplementation(() => {
      throw new Error(`ENOENT: no such file or directory, open '${SECRET_FS_PATH}'`);
    });

    const result = asResult(handleListQiRuns(ctx("/api/quality-intelligence/runs"), deps()));
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      runs: [],
      _listError: {
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
