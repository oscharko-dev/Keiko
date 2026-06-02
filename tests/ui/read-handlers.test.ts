import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleConfig,
  handleModels,
  handleWorkflows,
  handleWorkspace,
  handleEvidenceList,
  handleEvidenceDetail,
} from "../../src/ui/read-handlers.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "../../src/ui/index.js";
import { createInMemoryUiStore } from "../../src/ui/store/index.js";
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

function redactTopSecret(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replaceAll("topsecret", "[REDACTED]");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactTopSecret(entry));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = redactTopSecret(entry);
  }
  return out;
}

function createWorkspaceFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-ui-workspace-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "topsecret",
      version: "1.0.0",
      devDependencies: { vitest: "^4.1.7" },
    }),
    "utf8",
  );
  writeFileSync(join(root, "src", "index.ts"), "export const x = 1;\n", "utf8");
  writeFileSync(join(root, "tests", "index.test.ts"), "it('ok', () => {});\n", "utf8");
  return root;
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
    store: createInMemoryUiStore(),
    ...overrides,
  };
}

function depsWithRegisteredProject(
  root: string,
  overrides: Partial<UiHandlerDeps> = {},
): UiHandlerDeps {
  const store = createInMemoryUiStore();
  store.createProject(root);
  return depsWith({ store, ...overrides });
}

const SAMPLE_CONFIG: GatewayConfig = {
  providers: [
    {
      modelId: "example-chat-model",
      baseUrl: "https://api.example.com",
      apiKey: "example-test-token-1234567890",
      timeoutMs: 1000,
      maxRetries: 2,
      retryBaseDelayMs: 10,
    },
  ],
  circuitBreaker: { failureThreshold: 5, cooldownMs: 1000, halfOpenProbes: 1 },
  capabilities: [
    {
      id: "example-chat-model",
      kind: "chat",
      contextWindow: 8_192,
      maxOutputTokens: 1_024,
      toolCalling: true,
      structuredOutput: true,
      streaming: true,
      costClass: "medium",
      latencyClass: "standard",
      throughputHint: "test fixture",
      preferredUseCases: ["UI tests"],
      knownLimitations: [],
    },
  ],
};

describe("GET /api/config", () => {
  it("returns null config when none resolved", () => {
    const result = handleConfig(ctx("/api/config"), depsWith({}));
    expect(result.body).toEqual({ config: null, configPresent: false });
  });

  it("returns a safe config that never contains the apiKey or provider endpoint", () => {
    const result = handleConfig(
      ctx("/api/config"),
      depsWith({ config: SAMPLE_CONFIG, configPresent: true }),
    );
    const json = JSON.stringify(result.body);
    expect(json).not.toContain("example-test-token-1234567890");
    expect(json).not.toContain("https://api.example.com");
    expect(json).not.toContain("apiKey");
    expect(json).not.toContain("baseUrl");
    expect(result.body).toMatchObject({ configPresent: true });
  });
});

describe("GET /api/models", () => {
  it("returns only configured models", () => {
    const result = handleModels(
      ctx("/api/models"),
      depsWith({
        config: {
          ...SAMPLE_CONFIG,
          providers: [
            {
              modelId: "example-chat-model",
              baseUrl: "https://api.example.com",
              apiKey: "example-test-token-1234567890",
              timeoutMs: 1000,
              maxRetries: 2,
              retryBaseDelayMs: 10,
            },
          ],
        },
        configPresent: true,
      }),
    );
    const body = result.body as { models: { id: string }[] };
    expect(body.models.map((model) => model.id)).toEqual(["example-chat-model"]);
  });

  it("returns runtime-declared configured models", () => {
    const result = handleModels(
      ctx("/api/models"),
      depsWith({ config: SAMPLE_CONFIG, configPresent: true }),
    );
    const body = result.body as { models: { id: string }[] };
    expect(body.models.map((model) => model.id)).toEqual(["example-chat-model"]);
  });

  it("returns no models when no config is resolved", () => {
    const result = handleModels(ctx("/api/models"), depsWith({}));
    const body = result.body as { models: unknown[] };
    expect(body.models).toEqual([]);
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

  it("exposes a verify synth entry with workspaceRoot required and targetFiles optional", () => {
    const result = handleWorkflows();
    const body = result.body as {
      verify: {
        inputs: { name: string; type: string; required: boolean }[];
        defaultLimits: Record<string, unknown>;
      };
    };
    expect(body.verify.inputs).toHaveLength(2);
    expect(body.verify.inputs[0]).toMatchObject({
      name: "workspaceRoot",
      type: "string",
      required: true,
    });
    expect(body.verify.inputs[1]).toMatchObject({
      name: "targetFiles",
      type: "string[]",
      required: false,
    });
    expect(body.verify.defaultLimits).toEqual(expect.any(Object));
  });
});

describe("GET /api/workspace", () => {
  it("returns a workspace summary and redacts the response body", () => {
    const root = createWorkspaceFixture();
    try {
      const result = handleWorkspace(
        ctx(`/api/workspace?dir=${encodeURIComponent(root)}`),
        depsWithRegisteredProject(root, { redactor: redactTopSecret }),
      );
      expect(result.status).toBe(200);
      const body = result.body as {
        summary: {
          root: string;
          name: string;
          context?: { entries: { path: string; excerpt: string }[] };
        };
      };
      expect(body.summary.root).toBe(root);
      expect(body.summary.name).toBe("[REDACTED]");
      expect(body.summary.context).toBeUndefined();
      expect(JSON.stringify(result.body)).not.toContain("topsecret");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("includes a context pack when task or budget is provided", () => {
    const root = createWorkspaceFixture();
    try {
      const result = handleWorkspace(
        ctx(`/api/workspace?dir=${encodeURIComponent(root)}&task=src/index.ts&budget=128`),
        depsWithRegisteredProject(root, { redactor: redactTopSecret }),
      );
      expect(result.status).toBe(200);
      const body = result.body as {
        summary: {
          context: {
            budgetBytes: number;
            entries: { path: string; selectionReason: string }[];
            droppedForBudget: number;
          };
        };
      };
      expect(body.summary.context).toBeDefined();
      expect(body.summary.context.entries.length).toBeGreaterThan(0);
      expect(body.summary.context.budgetBytes).toBe(128);
      expect(body.summary.context.entries[0]?.selectionReason).toBe("entrypoint");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an invalid budget with BAD_REQUEST", () => {
    const result = handleWorkspace(ctx("/api/workspace?budget=0"), depsWith({}));
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  it("rejects a non-JSON-safe budget with BAD_REQUEST", () => {
    const result = handleWorkspace(ctx("/api/workspace?budget=9007199254740992"), depsWith({}));
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  it("requires an explicit workspace dir", () => {
    const result = handleWorkspace(ctx("/api/workspace"), depsWith({}));
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  it("rejects workspace reads for unregistered projects", () => {
    const root = createWorkspaceFixture();
    try {
      const result = handleWorkspace(
        ctx(`/api/workspace?dir=${encodeURIComponent(root)}`),
        depsWith({}),
      );
      expect(result.status).toBe(403);
      expect(result.body).toMatchObject({ error: { code: "WORKSPACE_NOT_REGISTERED" } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects non-local workspace path forms with BAD_REQUEST", () => {
    const result = handleWorkspace(ctx("/api/workspace?dir=https%3A%2F%2Fexample.test"), depsWith({}));
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  it("surfaces safe workspace errors for missing workspaces", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-ui-missing-"));
    try {
      const deps = depsWithRegisteredProject(root);
      rmSync(root, { recursive: true, force: true });
      const result = handleWorkspace(
        ctx(`/api/workspace?dir=${encodeURIComponent(root)}`),
        deps,
      );
      expect(result.status).toBe(404);
      expect(result.body).toMatchObject({
        error: {
          code: "WORKSPACE_NOT_FOUND",
          message: "The workspace could not be found.",
        },
      });
      expect(JSON.stringify(result.body)).not.toContain(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a registered nested directory inside a parent workspace", () => {
    const root = createWorkspaceFixture();
    const nested = join(root, "nested");
    mkdirSync(nested, { recursive: true });
    try {
      const result = handleWorkspace(
        ctx(`/api/workspace?dir=${encodeURIComponent(nested)}`),
        depsWithRegisteredProject(nested),
      );
      expect(result.status).toBe(403);
      expect(result.body).toMatchObject({
        error: {
          code: "WORKSPACE_NOT_REGISTERED",
          message: "The workspace directory is not a registered project.",
        },
      });
      expect(JSON.stringify(result.body)).not.toContain(root);
      expect(JSON.stringify(result.body)).not.toContain("context");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    modelId = "m",
    workspaceRoot?: string,
  ): string {
    return JSON.stringify({
      evidenceSchemaVersion: "1",
      run: {
        runId,
        fingerprint: "fp",
        harnessVersion: "0.1.3",
        taskType,
        outcome,
        startedAt,
        finishedAt: startedAt + 100,
        durationMs: 100,
      },
      model: { modelId, costClass: "low" },
      usageTotals: { promptTokens: 0, completionTokens: 0, requestCount: 0, totalLatencyMs: 0 },
      ...(workspaceRoot === undefined
        ? {}
        : {
            context: {
              workspaceRoot,
              totalCandidates: 0,
              usedBytes: 0,
              budgetBytes: 0,
              droppedForBudget: 0,
              entries: [],
            },
          }),
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

  it("filters by workflow", () => {
    const store = storeFrom([
      manifestJson("run-a", "generate-unit-tests", "completed", Date.parse("2026-05-01T10:00:00Z")),
      manifestJson("run-b", "investigate-bug", "failed", Date.parse("2026-05-02T10:00:00Z")),
    ]);
    const result = handleEvidenceList(
      ctx("/api/evidence?workflow=generate-unit-tests"),
      depsWith({ evidenceStore: store }),
    );
    const entries = (result.body as { entries: { runId: string }[] }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.runId).toBe("run-a");
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

  it("filters by model and workspace metadata", () => {
    const store = storeFrom([
      manifestJson(
        "run-a",
        "generate-unit-tests",
        "completed",
        Date.parse("2026-05-01T10:00:00Z"),
        "model-a",
        "/workspaces/customer-a",
      ),
      manifestJson(
        "run-b",
        "investigate-bug",
        "completed",
        Date.parse("2026-05-02T10:00:00Z"),
        "model-b",
        "/workspaces/customer-b",
      ),
    ]);
    const result = handleEvidenceList(
      ctx("/api/evidence?model=model-b&workspace=customer-b"),
      depsWith({ evidenceStore: store }),
    );
    const entries = (result.body as { entries: { runId: string; modelId: string }[] }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ runId: "run-b", modelId: "model-b" });
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
    const json = JSON.stringify({
      evidenceSchemaVersion: "1",
      run: {
        runId: "run-x",
        fingerprint: "fp",
        harnessVersion: "0.1.3",
        taskType: "explain-plan",
        outcome: "completed",
        startedAt: 1,
        finishedAt: 2,
        durationMs: 1,
      },
      model: { modelId: "m", costClass: "unknown" },
      usageTotals: {
        promptTokens: 0,
        completionTokens: 0,
        requestCount: 0,
        totalLatencyMs: 0,
      },
      stateTransitions: [],
      toolCalls: [],
      commandExecutions: [],
    });
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
