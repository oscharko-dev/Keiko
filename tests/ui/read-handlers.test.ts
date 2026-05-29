import { describe, expect, it } from "vitest";
import {
  handleConfig,
  handleModels,
  handleWorkflows,
  handleEvidenceList,
  handleEvidenceDetail,
} from "../../src/ui/read-handlers.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "../../src/ui/index.js";
import type { RouteContext, RouteResult } from "../../src/ui/routes.js";
import { STREAMING } from "../../src/ui/routes.js";
import type { GatewayConfig } from "../../src/gateway/index.js";
import { EvidenceReadError, EvidenceSchemaError, type EvidenceStore } from "../../src/audit/index.js";

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
    throw new Error("expected a RouteResult, got STREAMING");
  }
  return outcome;
}

function emptyStore(): EvidenceStore {
  return { put: () => "", list: () => [], get: () => undefined, delete: () => undefined };
}

function depsWith(overrides: Partial<UiHandlerDeps>): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: emptyStore(),
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    ...overrides,
  };
}

const SAMPLE_CONFIG: GatewayConfig = {
  providers: [
    {
      modelId: "gpt-test",
      baseUrl: "https://api.example.com",
      apiKey: "sk-super-secret-value-1234567890",
      timeoutMs: 1000,
      maxRetries: 2,
      retryBaseDelayMs: 10,
    },
  ],
  circuitBreaker: { failureThreshold: 5, cooldownMs: 1000, halfOpenProbes: 1 },
};

describe("GET /api/config", () => {
  it("returns null config when none resolved", () => {
    const result = handleConfig(ctx("/api/config"), depsWith({}));
    expect(result.body).toEqual({ config: null, configPresent: false });
  });

  it("returns a safe config that never contains the apiKey", () => {
    const result = handleConfig(
      ctx("/api/config"),
      depsWith({ config: SAMPLE_CONFIG, configPresent: true }),
    );
    const json = JSON.stringify(result.body);
    expect(json).not.toContain("sk-super-secret-value-1234567890");
    expect(json).not.toContain("apiKey");
    expect(result.body).toMatchObject({ configPresent: true });
  });
});

describe("GET /api/models", () => {
  it("returns the full capability registry", () => {
    const result = handleModels();
    const body = result.body as { models: unknown[] };
    expect(body.models.length).toBeGreaterThan(0);
  });
});

describe("GET /api/workflows", () => {
  it("returns both descriptors and the explain-plan inputs", () => {
    const result = handleWorkflows();
    const body = result.body as {
      descriptors: { workflowId: string }[];
      explainPlan: { inputs: { name: string; required: boolean }[] };
    };
    expect(body.descriptors.map((d) => d.workflowId)).toEqual([
      "unit-test-generation",
      "bug-investigation",
    ]);
    expect(body.explainPlan.inputs[0]).toMatchObject({ name: "filePath", required: true });
    expect(body.explainPlan.inputs[1]).toMatchObject({ name: "question", required: false });
  });
});

describe("GET /api/evidence", () => {
  function runIdOf(json: string): string {
    const parsed = JSON.parse(json) as { run: { runId: string } };
    return parsed.run.runId;
  }

  function storeFrom(entries: readonly string[]): EvidenceStore {
    const map = new Map(entries.map((json) => [runIdOf(json), json]));
    return {
      put: () => "",
      list: () => [...map.keys()].sort(),
      get: (runId) => map.get(runId),
      delete: () => undefined,
    };
  }

  function manifestJson(
    runId: string,
    taskType: string,
    outcome: string,
    startedAt: number,
  ): string {
    return JSON.stringify({
      evidenceSchemaVersion: "1",
      run: {
        runId,
        fingerprint: "fp",
        harnessVersion: "0.1.0",
        taskType,
        outcome,
        startedAt,
        finishedAt: startedAt + 100,
        durationMs: 100,
      },
      model: { modelId: "m", costClass: "low" },
      usageTotals: { promptTokens: 0, completionTokens: 0, requestCount: 0, totalLatencyMs: 0 },
      stateTransitions: [],
      toolCalls: [],
      commandExecutions: [],
    });
  }

  it("returns every entry when no filter is given", () => {
    const store = storeFrom([
      manifestJson("run-a", "generate-unit-tests", "completed", Date.parse("2026-05-01T10:00:00Z")),
      manifestJson("run-b", "investigate-bug", "failed", Date.parse("2026-05-02T10:00:00Z")),
    ]);
    const result = handleEvidenceList(ctx("/api/evidence"), depsWith({ evidenceStore: store }));
    expect((result.body as { entries: unknown[] }).entries).toHaveLength(2);
  });

  it("filters by outcome", () => {
    const store = storeFrom([
      manifestJson("run-a", "generate-unit-tests", "completed", Date.parse("2026-05-01T10:00:00Z")),
      manifestJson("run-b", "investigate-bug", "failed", Date.parse("2026-05-02T10:00:00Z")),
    ]);
    const result = handleEvidenceList(
      ctx("/api/evidence?outcome=failed"),
      depsWith({ evidenceStore: store }),
    );
    const entries = (result.body as { entries: { runId: string }[] }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.runId).toBe("run-b");
  });

  it("filters by started-at calendar day", () => {
    const store = storeFrom([
      manifestJson("run-a", "generate-unit-tests", "completed", Date.parse("2026-05-01T10:00:00Z")),
      manifestJson("run-b", "investigate-bug", "failed", Date.parse("2026-05-02T10:00:00Z")),
    ]);
    const result = handleEvidenceList(
      ctx("/api/evidence?date=2026-05-02"),
      depsWith({ evidenceStore: store }),
    );
    const entries = (result.body as { entries: { runId: string }[] }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.runId).toBe("run-b");
  });
});

describe("GET /api/evidence/:runId", () => {
  it("rejects an invalid runId with 400", () => {
    const result = handleEvidenceDetail(
      ctx("/api/evidence/..%2f", { runId: "../etc" }),
      depsWith({}),
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  it("returns 404 when the manifest is absent", () => {
    const result = handleEvidenceDetail(
      ctx("/api/evidence/run-x", { runId: "run-x" }),
      depsWith({}),
    );
    expect(result.status).toBe(404);
  });

  it("returns 422 on a schema error with a safe message", () => {
    const store: EvidenceStore = {
      put: () => "",
      list: () => ["run-x"],
      get: () => {
        throw new EvidenceSchemaError("manifest schema version mismatch", "0");
      },
      delete: () => undefined,
    };
    const result = handleEvidenceDetail(
      ctx("/api/evidence/run-x", { runId: "run-x" }),
      depsWith({ evidenceStore: store }),
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ error: { code: "EVIDENCE_SCHEMA" } });
  });

  it("returns 422 on a read error", () => {
    const store: EvidenceStore = {
      put: () => "",
      list: () => ["run-x"],
      get: () => {
        throw new EvidenceReadError("manifest could not be read");
      },
      delete: () => undefined,
    };
    const result = handleEvidenceDetail(
      ctx("/api/evidence/run-x", { runId: "run-x" }),
      depsWith({ evidenceStore: store }),
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ error: { code: "EVIDENCE_READ" } });
  });

  it("serves a present manifest as-is", () => {
    const json = JSON.stringify({ evidenceSchemaVersion: "1", run: { runId: "run-x" } });
    const store: EvidenceStore = {
      put: () => "",
      list: () => ["run-x"],
      get: (runId) => (runId === "run-x" ? json : undefined),
      delete: () => undefined,
    };
    const result = asResult(
      handleEvidenceDetail(
        ctx("/api/evidence/run-x", { runId: "run-x" }),
        depsWith({ evidenceStore: store }),
      ),
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ manifest: { evidenceSchemaVersion: "1" } });
  });
});
