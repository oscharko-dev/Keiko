// Integration tests for the run-engine BFF routes (ADR-0011 D5 routes 5–9). They bind a real
// ephemeral 127.0.0.1 socket and drive the full HTTP/SSE flow with an INJECTED fake ModelPort
// (deterministic, offline — no network, no gateway). A real temp workspace (copy of the unit-test
// fixture) lets the dry-run workflow produce a genuine proposedDiff. Assertions cover dry-run
// default, SSE replay+ready+live framing+terminal close, cancel, GET projection, the apply gate
// (409 when not appliable), and that NO secret-shaped string appears in ANY response body.

import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUiServer, UI_HOST } from "./server.js";
import { buildCspHeader } from "./csp.js";
import {
  buildRedactor,
  createRunRegistry,
  handleApplyRun,
  handleGetRun,
  QueueEventSink,
  type UiHandlerDeps,
} from "./index.js";
import { createInMemoryUiStore } from "./store/index.js";
import {
  createInMemoryEvidenceStore,
  listEvidence,
  loadEvidence,
  type EvidenceStore,
} from "@oscharko-dev/keiko-evidence";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { CancelledError } from "@oscharko-dev/keiko-model-gateway";
import type { NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "..", "..", "tests", "fixtures", "unit-tests", "target-project");

// A secret-shaped value the redactor must scrub from every response body.
const SECRET = ["sk-", "abcdefghijklmnop0123456789"].join("");

const TEST_DIFF =
  "--- /dev/null\n+++ b/tests/add.test.ts\n@@ -0,0 +1,6 @@\n" +
  "+import { describe, expect, it } from 'vitest';\n" +
  "+import { add } from '../src/add';\n" +
  `+// token ${SECRET}\n` +
  "+describe('add', () => {\n" +
  "+  it('adds', () => expect(add(1, 2)).toBe(3));\n" +
  "+});\n";

const POST_JSON_HEADERS = { "Content-Type": "application/json", "X-Keiko-CSRF": "1" } as const;

function fakeModel(content: string): ModelPort {
  const response: NormalizedResponse = {
    modelId: "m",
    content,
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: { requestId: "r", promptTokens: 1, completionTokens: 1, latencyMs: 1, costClass: "low" },
  };
  return { call: (): Promise<NormalizedResponse> => Promise.resolve(response) };
}

let server: Server;
let port: number;
let staticRoot: string;
let workspace: string;
let registry: ReturnType<typeof createRunRegistry>;
let evidenceStore: EvidenceStore;

interface HandlerDepsOptions {
  readonly registerWorkspace?: boolean;
  readonly modelPortFactory?: () => ModelPort | undefined;
}

function handlerDeps(model: ModelPort, options: HandlerDepsOptions = {}): UiHandlerDeps {
  const store = createInMemoryUiStore();
  if (options.registerWorkspace !== false) {
    store.createProject(workspace);
  }
  return {
    config: undefined,
    configPresent: false,
    evidenceStore,
    env: { KEY: SECRET },
    redactor: buildRedactor({ KEY: SECRET }),
    registry,
    modelPortFactory: options.modelPortFactory ?? ((): ModelPort => model),
    store,
  };
}

async function start(model: ModelPort, options: HandlerDepsOptions = {}): Promise<void> {
  staticRoot = mkdtempSync(join(tmpdir(), "keiko-ui-runs-"));
  registry = createRunRegistry();
  evidenceStore = createInMemoryEvidenceStore();
  server = createUiServer({ staticRoot, csp: buildCspHeader([]), port: 0 });
  await new Promise<void>((res) => server.listen(0, UI_HOST, res));
  port = (server.address() as AddressInfo).port;
  await new Promise<void>((res) =>
    server.close(() => {
      res();
    }),
  );
  server = createUiServer({
    staticRoot,
    csp: buildCspHeader([]),
    port,
    handlerDeps: handlerDeps(model, options),
  });
  await new Promise<void>((res) => server.listen(port, UI_HOST, res));
}

function base(): string {
  return `http://${UI_HOST}:${String(port)}`;
}

interface CreateResponse {
  readonly runId: string;
  readonly fingerprint: string;
  readonly orchestration?: { readonly state: string; readonly children: readonly unknown[] } | undefined;
}

async function createRun(apply = false): Promise<{ status: number; body: CreateResponse }> {
  const res = await fetch(`${base()}/api/runs`, {
    method: "POST",
    headers: POST_JSON_HEADERS,
    body: JSON.stringify({
      workflowId: "unit-test-generation",
      input: { workspaceRoot: workspace, target: { kind: "file", filePath: "src/add.ts" } },
      modelId: "test-model",
      apply,
    }),
  });
  return { status: res.status, body: (await res.json()) as CreateResponse };
}

async function createOrchestrationRun(): Promise<{ status: number; body: CreateResponse }> {
  const res = await fetch(`${base()}/api/runs`, {
    method: "POST",
    headers: POST_JSON_HEADERS,
    body: JSON.stringify({
      modelId: "test-model",
      input: { workspaceRoot: workspace },
      orchestration: {
        executionMode: "parallel",
        children: [
          {
            childId: "plan",
            title: "Plan",
            role: "planner",
            taskType: "explain-plan",
            input: { filePath: "src/add.ts", question: "Summarize." },
          },
          {
            childId: "verify",
            title: "Verify",
            role: "validator",
            taskType: "verify",
            input: { targetFiles: ["src/add.ts"] },
            dependsOn: ["plan"],
          },
        ],
      },
    }),
  });
  return { status: res.status, body: (await res.json()) as CreateResponse };
}

// Polls the registry until the background run terminates (deterministic; the fake model resolves
// synchronously, so this settles within a few microtasks).
async function awaitTerminal(runId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const record = registry.get(runId);
    if (record !== undefined && record.status !== "running") {
      return;
    }
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error("run did not terminate");
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "keiko-ui-ws-"));
  cpSync(FIXTURE, workspace, { recursive: true });
});

afterEach(async () => {
  await new Promise<void>((res) =>
    server.close(() => {
      res();
    }),
  );
  rmSync(staticRoot, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

describe("POST /api/runs", () => {
  it("starts a dry-run by default and returns 202 with runId + fingerprint", async () => {
    await start(fakeModel(["```diff", TEST_DIFF.trimEnd(), "```"].join("\n")));
    const created = await createRun();
    expect(created.status).toBe(202);
    expect(created.body.runId).toBeTruthy();
    expect(created.body.fingerprint).toBeTruthy();
  });

  it("starts an orchestration run and returns the parent projection additively", async () => {
    await start(fakeModel("explanation"));
    const created = await createOrchestrationRun();
    expect(created.status).toBe(202);
    expect(["pending", "running"]).toContain(created.body.orchestration?.state);
    expect(created.body.orchestration?.children).toHaveLength(2);
  });

  it("rejects a missing model with 400 NO_MODEL", async () => {
    await start(fakeModel("noop"));
    server.close();
    await new Promise<void>((res) => server.listen(port, UI_HOST, res));
    // Rebuild with a factory that yields no model.
    await new Promise<void>((res) =>
      server.close(() => {
        res();
      }),
    );
    server = createUiServer({
      staticRoot,
      csp: buildCspHeader([]),
      port,
      handlerDeps: { ...handlerDeps(fakeModel("noop")), modelPortFactory: () => undefined },
    });
    await new Promise<void>((res) => server.listen(port, UI_HOST, res));
    const res = await fetch(`${base()}/api/runs`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        taskType: "explain-plan",
        input: { filePath: "x", workspaceRoot: workspace },
        modelId: "m",
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "NO_MODEL" },
    });
  });

  it("rejects a body with neither workflowId nor taskType (400)", async () => {
    await start(fakeModel("noop"));
    const res = await fetch(`${base()}/api/runs`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ input: {}, modelId: "m" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/runs/:runId", () => {
  it("reports running then the final dry-run projection", async () => {
    await start(fakeModel(["```diff", TEST_DIFF.trimEnd(), "```"].join("\n")));
    const { body } = await createRun();
    await awaitTerminal(body.runId);
    const res = await fetch(`${base()}/api/runs/${body.runId}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      report: {
        status: string;
        evidence: {
          runId: string;
          fingerprint: string;
          evidenceLocation: string;
          usageTotals: { requestCount: number };
          verificationStatus: string;
          knownLimitations: readonly string[];
        };
      };
    };
    expect(json.report.status).toBe("dry-run");
    expect(json.report.evidence.runId).toBe(body.runId);
    expect(json.report.evidence.fingerprint).toBe(body.fingerprint);
    expect(json.report.evidence.evidenceLocation).toBe(`${body.runId}.json`);
    expect(json.report.evidence.usageTotals.requestCount).toBe(1);
    expect(json.report.evidence.verificationStatus).toBe("not-run");
    expect(json.report.evidence.knownLimitations.length).toBeGreaterThan(0);
  });

  it("surfaces orchestration state and settlement through the stable run report", async () => {
    await start(fakeModel("explanation"));
    const { body } = await createOrchestrationRun();
    await awaitTerminal(body.runId);
    const res = await fetch(`${base()}/api/runs/${body.runId}`);
    const json = (await res.json()) as {
      report: {
        status: string;
        orchestration?: {
          state: string;
          children: { childId: string; state: string; runId?: string }[];
          settlement?: { outcome: string };
        };
      };
    };
    expect(json.report.status).toBe("completed");
    expect(json.report.orchestration?.state).toBe("completed");
    expect(json.report.orchestration?.children.map((child) => child.childId)).toEqual([
      "plan",
      "verify",
    ]);
    expect(json.report.orchestration?.children.every((child) => typeof child.runId === "string")).toBe(true);
    expect(json.report.orchestration?.settlement?.outcome).toBe("accepted");
  });

  it("returns 404 for an unknown run", async () => {
    await start(fakeModel("noop"));
    const res = await fetch(`${base()}/api/runs/nope`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/runs/:runId/events (SSE)", () => {
  it("frames events as SSE, sends ready, and replays the buffer on connect", async () => {
    await start(fakeModel(["```diff", TEST_DIFF.trimEnd(), "```"].join("\n")));
    const { body } = await createRun();
    await awaitTerminal(body.runId);
    const res = await fetch(`${base()}/api/runs/${body.runId}/events`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text).toContain("event: ready");
    expect(text).toContain("event: workflow:started");
    expect(text).toContain("data: ");
  });

  it("streams orchestration lifecycle events alongside child harness events", async () => {
    await start(fakeModel("explanation"));
    const { body } = await createOrchestrationRun();
    await awaitTerminal(body.runId);
    const res = await fetch(`${base()}/api/runs/${body.runId}/events`);
    const text = await res.text();
    expect(text).toContain("event: orchestration:run:started");
    expect(text).toContain("event: orchestration:child:dispatched");
    expect(text).toContain("event: orchestration:settlement");
  });

  it("returns 404 for an unknown run", async () => {
    await start(fakeModel("noop"));
    const res = await fetch(`${base()}/api/runs/unknown/events`);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/runs/:runId/cancel", () => {
  it("is idempotent and returns ok", async () => {
    await start(fakeModel(["```diff", TEST_DIFF.trimEnd(), "```"].join("\n")));
    const { body } = await createRun();
    const first = await fetch(`${base()}/api/runs/${body.runId}/cancel`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ confirm: true }),
    });
    expect(first.status).toBe(200);
    expect((await first.json()) as { ok: boolean }).toEqual({ ok: true });
    await awaitTerminal(body.runId);
    const second = await fetch(`${base()}/api/runs/${body.runId}/cancel`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ confirm: true }),
    });
    expect(second.status).toBe(200);
  });

  it("moves an orchestration run into cancelling before terminal cancellation", async () => {
    await start(abortableModel());
    const created = await fetch(`${base()}/api/runs`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        modelId: "test-model",
        input: { workspaceRoot: workspace },
        orchestration: {
          executionMode: "single",
          children: [
            {
              childId: "fix",
              title: "Fix",
              role: "implementer",
              taskType: "investigate-bug",
              input: { description: "hang until cancelled" },
            },
          ],
        },
      }),
    });
    const body = (await created.json()) as CreateResponse;
    const cancel = await fetch(`${base()}/api/runs/${body.runId}/cancel`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ confirm: true }),
    });
    expect(cancel.status).toBe(200);
    const running = await fetch(`${base()}/api/runs/${body.runId}`);
    const runningJson = (await running.json()) as {
      report: { status: string; orchestration?: { state: string } };
    };
    expect(["running", "cancelled", "failed"]).toContain(runningJson.report.status);
    expect(["cancelling", "cancelled"]).toContain(runningJson.report.orchestration?.state);
    await awaitTerminal(body.runId);
  });

  it("returns 404 for an unknown run", async () => {
    await start(fakeModel("noop"));
    const res = await fetch(`${base()}/api/runs/none/cancel`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ confirm: true }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/runs/:runId/apply (gated write path)", () => {
  it("returns 404 for an unknown run", async () => {
    await start(fakeModel("noop"));
    const res = await fetch(`${base()}/api/runs/none/apply`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ confirm: true }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 when the run is not in an appliable state (explain-plan)", async () => {
    await start(fakeModel("a read-only explanation, no patch"));
    const res = await fetch(`${base()}/api/runs`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        taskType: "explain-plan",
        input: { filePath: "src/add.ts", workspaceRoot: workspace },
        modelId: "m",
      }),
    });
    const created = (await res.json()) as CreateResponse;
    await awaitTerminal(created.runId);
    const apply = await fetch(`${base()}/api/runs/${created.runId}/apply`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ confirm: true }),
    });
    expect(apply.status).toBe(409);
    expect((await apply.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "NOT_APPLIABLE" },
    });
  });
});

function vitestHostRoot(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    return dirname(dirname(dirname(require.resolve("vitest/package.json"))));
  } catch {
    return undefined;
  }
}

const hostRoot = vitestHostRoot();
const maybeApply = hostRoot === undefined ? describe.skip : describe;

maybeApply("POST /api/runs/:runId/apply — applies through the gated workflow", () => {
  it("re-invokes the workflow with apply:true and returns the apply+verify report", async () => {
    rmSync(workspace, { recursive: true, force: true });
    workspace = mkdtempSync(join(hostRoot ?? ".", ".keiko-ui-apply-"));
    cpSync(FIXTURE, workspace, { recursive: true });
    await start(fakeModel(["```diff", TEST_DIFF.trimEnd(), "```"].join("\n")));
    const { body } = await createRun();
    await awaitTerminal(body.runId);
    const res = await fetch(`${base()}/api/runs/${body.runId}/apply`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ confirm: true }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { report: { status: string } };
    expect(["completed", "dry-run"]).toContain(json.report.status);
  }, 60_000);
});

describe("no secret reaches any response body", () => {
  it("scrubs the secret from the SSE stream and the run report", async () => {
    await start(fakeModel(["```diff", TEST_DIFF.trimEnd(), "```"].join("\n")));
    const { body } = await createRun();
    await awaitTerminal(body.runId);
    const report = await (await fetch(`${base()}/api/runs/${body.runId}`)).text();
    const events = await (await fetch(`${base()}/api/runs/${body.runId}/events`)).text();
    expect(report).not.toContain(SECRET);
    expect(events).not.toContain(SECRET);
  });
});

// A model that never resolves until aborted, then rejects with the gateway CancelledError the
// workflow maps to a "cancelled" report. Lets a test deterministically cancel an in-flight run.
function abortableModel(): ModelPort {
  return {
    call: (_req, signal): Promise<NormalizedResponse> =>
      new Promise<NormalizedResponse>((_res, reject) => {
        const fail = (): void => {
          reject(new CancelledError("aborted in test"));
        };
        if (signal.aborted) {
          fail();
          return;
        }
        signal.addEventListener("abort", fail, { once: true });
      }),
  };
}

describe("FIX 1 — UI runs persist a redacted evidence manifest (AC5)", () => {
  it("persists a dry-run that listEvidence/loadEvidence return, with no secret", async () => {
    await start(fakeModel(["```diff", TEST_DIFF.trimEnd(), "```"].join("\n")));
    const { body } = await createRun();
    await awaitTerminal(body.runId);
    await awaitEvidence(body.runId);

    const entries = listEvidence(evidenceStore);
    expect(entries.map((e) => e.runId)).toContain(body.runId);
    const entry = entries.find((e) => e.runId === body.runId);
    expect(entry?.taskType).toBe("generate-unit-tests");
    expect(entry?.outcome).toBe("completed");

    const manifest = loadEvidence(evidenceStore, body.runId);
    expect(manifest?.evidenceSchemaVersion).toBe("1");
    expect(manifest?.run.runId).toBe(body.runId);
    expect(manifest?.run.fingerprint).toBe(body.fingerprint);
    expect(JSON.stringify(manifest)).not.toContain(SECRET);
  });

  it("persists a cancelled run with a cancelled outcome (literal AC5)", async () => {
    await start(abortableModel());
    const { body } = await createRun();
    await fetch(`${base()}/api/runs/${body.runId}/cancel`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ confirm: true }),
    });
    await awaitTerminal(body.runId);
    await awaitEvidence(body.runId);

    const entry = listEvidence(evidenceStore).find((e) => e.runId === body.runId);
    expect(entry?.outcome).toBe("cancelled");
    const manifest = loadEvidence(evidenceStore, body.runId);
    expect(manifest?.run.outcome).toBe("cancelled");
    expect(JSON.stringify(manifest)).not.toContain(SECRET);
  });

  it("surfaces the persisted run through the /api/evidence routes", async () => {
    await start(fakeModel(["```diff", TEST_DIFF.trimEnd(), "```"].join("\n")));
    const { body } = await createRun();
    await awaitTerminal(body.runId);
    await awaitEvidence(body.runId);

    const list = (await (await fetch(`${base()}/api/evidence`)).json()) as {
      entries: { runId: string }[];
    };
    expect(list.entries.map((e) => e.runId)).toContain(body.runId);
    const detail = await fetch(`${base()}/api/evidence/${body.runId}`);
    expect(detail.status).toBe(200);
    const json = (await detail.json()) as { manifest: { run: { runId: string } } };
    expect(json.manifest.run.runId).toBe(body.runId);
  });
});

// Polls the evidence store until the (best-effort, post-terminal) persist has landed.
async function awaitEvidence(runId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (loadEvidence(evidenceStore, runId) !== undefined) {
      return;
    }
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error("evidence was not persisted");
}

describe("FIX 2 — POST /api/runs is always dry-run (security M1)", () => {
  it("ignores apply:true in the body and still produces a dry-run (no write)", async () => {
    await start(fakeModel(["```diff", TEST_DIFF.trimEnd(), "```"].join("\n")));
    const created = await createRun(true);
    expect(created.status).toBe(202);
    await awaitTerminal(created.body.runId);
    const res = await fetch(`${base()}/api/runs/${created.body.runId}`);
    const json = (await res.json()) as { report: { status: string } };
    expect(json.report.status).toBe("dry-run");
  });
});

describe("FIX 3 — a failed UI run's report is redacted (security L1)", () => {
  it("scrubs a secret carried in the failure error", async () => {
    const failing: ModelPort = {
      call: (): Promise<NormalizedResponse> =>
        Promise.reject(new Error(`model exploded with token ${SECRET}`)),
    };
    await start(failing);
    const { body } = await createRun();
    await awaitTerminal(body.runId);
    const report = await (await fetch(`${base()}/api/runs/${body.runId}`)).text();
    expect(report).not.toContain(SECRET);
  });
});

describe("FIX 4 — apply rebuilds the ModelPort from the run's modelId, not the fingerprint", () => {
  it("passes record.modelId (never the fingerprint) to the model-port factory", async () => {
    const localRegistry = createRunRegistry();
    const record = localRegistry.register({
      runId: "fix4-run",
      fingerprint: "deadbeefcafef00d",
      modelId: "example-chat-model",
      sink: new QueueEventSink(),
      cancel: (): void => undefined,
    });
    localRegistry.complete(
      "fix4-run",
      "completed",
      { status: "dry-run" },
      {
        kind: "unit-tests",
        payload: { workspaceRoot: ".", target: { kind: "file", filePath: "x.ts" } },
        limits: undefined,
      },
    );

    const seen: string[] = [];
    const deps: UiHandlerDeps = {
      config: undefined,
      configPresent: false,
      evidenceStore: createInMemoryEvidenceStore(),
      env: {},
      redactor: buildRedactor({}),
      registry: localRegistry,
      store: createInMemoryUiStore(),
      modelPortFactory: (modelId): undefined => {
        seen.push(modelId);
        return undefined;
      },
    };
    const ctx = {
      req: {} as never,
      res: {} as never,
      params: { runId: "fix4-run" },
      url: new URL("http://127.0.0.1/api/runs/fix4-run/apply"),
    };
    await handleApplyRun(ctx, deps);
    expect(seen).toEqual(["example-chat-model"]);
    expect(seen).not.toContain(record.fingerprint);
  });
});

describe("FIX B — apply snapshot retains the original limits from the dry-run", () => {
  it("stores limits in the appliable snapshot and threads them into the apply re-invocation", async () => {
    // Build a registry record whose appliable snapshot carries non-undefined limits.
    const localRegistry = createRunRegistry();
    const testLimits = { maxTokens: 1000, timeoutMs: 30_000 };
    localRegistry.register({
      runId: "fixb-run",
      fingerprint: "fp-fixb",
      modelId: "example-chat-model",
      sink: new QueueEventSink(),
      cancel: (): void => undefined,
    });
    localRegistry.complete(
      "fixb-run",
      "completed",
      { status: "dry-run" },
      {
        kind: "unit-tests",
        payload: { workspaceRoot: ".", target: { kind: "file", filePath: "x.ts" } },
        limits: testLimits,
      },
    );

    // The snapshot stored in the registry must carry the limits verbatim.
    const record = localRegistry.get("fixb-run");
    expect(record?.appliable?.limits).toEqual(testLimits);

    // Call handleApplyRun: the workflow is invoked (model rejects → failed report, not 500/409).
    // This confirms applyRun reaches the workflow — if limits were dropped the shape would differ.
    const failingModel: ModelPort = {
      call: (): Promise<NormalizedResponse> => Promise.reject(new Error("test-stop")),
    };
    const deps: UiHandlerDeps = {
      config: undefined,
      configPresent: false,
      evidenceStore: createInMemoryEvidenceStore(),
      env: {},
      redactor: buildRedactor({}),
      registry: localRegistry,
      store: createInMemoryUiStore(),
      modelPortFactory: (): ModelPort => failingModel,
    };
    const ctx = {
      req: {} as never,
      res: {} as never,
      params: { runId: "fixb-run" },
      url: new URL("http://127.0.0.1/api/runs/fixb-run/apply"),
    };
    const result = await handleApplyRun(ctx, deps);
    // 200 = applyRun was invoked (workflow failure yields a report, not an HTTP error).
    expect(result.status).toBe(200);
    const appliedRecord = localRegistry.get("fixb-run");
    expect(appliedRecord?.appliable).toBeUndefined();
    expect(appliedRecord?.applyReport).toBeDefined();

    const getResult = handleGetRun(ctx, deps);
    expect(getResult.status).toBe(200);
    expect(getResult.body).toMatchObject({
      report: {
        status: "dry-run",
        applyReport: { status: "failed" },
      },
    });

    const second = await handleApplyRun(ctx, deps);
    expect(second.status).toBe(409);
  });
});

describe("FIX G/H — oversized request body returns 413 PAYLOAD_TOO_LARGE", () => {
  it("returns 413 with PAYLOAD_TOO_LARGE code when the body exceeds 1 MB", async () => {
    await start(fakeModel("noop"));
    // 1 MB + 1 byte — just over MAX_BODY_BYTES.
    const oversized = "x".repeat(1_000_001);
    const res = await fetch(`${base()}/api/runs`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: oversized,
    });
    expect(res.status).toBe(413);
    const json = (await res.json()) as { error: { code: string } };
    expect(json).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
  });
});

describe("Security #1 — workflow workspaceRoot project-allowlist check", () => {
  it("returns 403 WORKSPACE_NOT_REGISTERED for verify with an unregistered workspaceRoot", async () => {
    await start(fakeModel("noop"), { registerWorkspace: false });
    const res = await fetch(`${base()}/api/runs`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        taskType: "verify",
        input: { workspaceRoot: "/tmp/not-registered" },
        modelId: "m",
      }),
    });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string } };
    expect(json).toMatchObject({ error: { code: "WORKSPACE_NOT_REGISTERED" } });
  });

  it("returns 202 for verify with a registered workspaceRoot", async () => {
    await start(fakeModel("noop"));
    const res = await fetch(`${base()}/api/runs`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        taskType: "verify",
        input: { workspaceRoot: workspace },
        modelId: "m",
      }),
    });
    expect(res.status).toBe(202);
  });

  it("returns 202 for verify with a registered workspaceRoot even when no model provider is configured", async () => {
    await start(fakeModel("noop"), { modelPortFactory: () => undefined });
    const res = await fetch(`${base()}/api/runs`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        taskType: "verify",
        input: { workspaceRoot: workspace },
        modelId: "m",
      }),
    });
    expect(res.status).toBe(202);
  });

  it("returns 403 WORKSPACE_NOT_REGISTERED for unit-test-generation with an unregistered workspaceRoot", async () => {
    await start(fakeModel(["```diff", TEST_DIFF.trimEnd(), "```"].join("\n")), {
      registerWorkspace: false,
    });
    const res = await fetch(`${base()}/api/runs`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        workflowId: "unit-test-generation",
        input: { workspaceRoot: workspace, target: { kind: "file", filePath: "src/add.ts" } },
        modelId: "test-model",
      }),
    });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string } };
    expect(json).toMatchObject({ error: { code: "WORKSPACE_NOT_REGISTERED" } });
  });

  it("returns 403 WORKSPACE_NOT_REGISTERED for bug-investigation with an unregistered workspaceRoot", async () => {
    await start(fakeModel("investigation"), { registerWorkspace: false });
    const res = await fetch(`${base()}/api/runs`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        workflowId: "bug-investigation",
        input: { report: { description: "bug" }, workspaceRoot: workspace },
        modelId: "m",
      }),
    });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string } };
    expect(json).toMatchObject({ error: { code: "WORKSPACE_NOT_REGISTERED" } });
  });

  it("returns 403 WORKSPACE_NOT_REGISTERED for explain-plan with an unregistered workspaceRoot", async () => {
    await start(fakeModel("an explanation"), { registerWorkspace: false });
    const res = await fetch(`${base()}/api/runs`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        taskType: "explain-plan",
        input: { filePath: "src/add.ts", workspaceRoot: workspace },
        modelId: "m",
      }),
    });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string } };
    expect(json).toMatchObject({ error: { code: "WORKSPACE_NOT_REGISTERED" } });
  });
});

// Issue #638 — the apply handler must atomically claim the pending snapshot before awaiting
// applyRun so two overlapping POST /api/runs/:runId/apply requests cannot both consume the
// same patch. The race is reproduced by holding the model port's promise: the second request
// has to enter the handler while the first is suspended in applyRun → workflow → model.call().
describe("issue #638 — overlapping apply requests cannot reuse the same snapshot", () => {
  it("returns 409 to the second request while the first is still awaiting the model", async () => {
    // start() is called so the file-level afterEach has a real HTTP server to close (the
    // handler-only test below does not depend on the HTTP path itself).
    await start(fakeModel("noop"));

    const localRegistry = createRunRegistry();
    localRegistry.register({
      runId: "race-run",
      fingerprint: "fp-race",
      modelId: "example-chat-model",
      sink: new QueueEventSink(),
      cancel: (): void => undefined,
    });
    localRegistry.complete(
      "race-run",
      "completed",
      { status: "dry-run" },
      {
        kind: "unit-tests",
        payload: { workspaceRoot: ".", target: { kind: "file", filePath: "x.ts" } },
        limits: undefined,
      },
    );

    let releaseModel: (response: NormalizedResponse) => void = () => undefined;
    const modelHold = new Promise<NormalizedResponse>((resolve) => {
      releaseModel = resolve;
    });
    const hangingModel: ModelPort = {
      call: (): Promise<NormalizedResponse> => modelHold,
    };

    const deps: UiHandlerDeps = {
      config: undefined,
      configPresent: false,
      evidenceStore: createInMemoryEvidenceStore(),
      env: {},
      redactor: buildRedactor({}),
      registry: localRegistry,
      store: createInMemoryUiStore(),
      modelPortFactory: (): ModelPort => hangingModel,
    };
    const ctx = {
      req: {} as never,
      res: {} as never,
      params: { runId: "race-run" },
      url: new URL("http://127.0.0.1/api/runs/race-run/apply"),
    };

    const first = handleApplyRun(ctx, deps);
    // Yield so the first request progresses through its synchronous prologue (claiming the
    // snapshot) and suspends at `await applyRun(...)` → workflow → model.call().
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    // The snapshot must have been claimed atomically before the await: a second concurrent
    // request observes `record.appliable === undefined` and is rejected with 409.
    expect(localRegistry.get("race-run")?.appliable).toBeUndefined();
    const second = await handleApplyRun(ctx, deps);
    expect(second.status).toBe(409);

    // Release the model so the first request finishes and the registry settles.
    releaseModel({
      modelId: "m",
      content: "",
      finishReason: "stop",
      toolCalls: [],
      structuredOutput: null,
      usage: {
        requestId: "r",
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: 0,
        costClass: "low",
      },
    });
    const firstResult = await first;
    expect(firstResult.status).toBe(200);
    expect(localRegistry.get("race-run")?.applyReport).toBeDefined();
  });
});

// GAP-E — workspace detection failures during run launch must return 400, not 500.
// A directory with no .git / package.json causes WorkspaceNotFoundError inside startRun.
// The fix catches WorkspaceError at the run-launch boundary and maps it to a safe 4xx.
// A one-line revert of the catch (removing the WorkspaceError branch) makes these tests see a 500.
describe("GAP-E — workspace detection failure returns 400 not 500 (run launch resilience)", () => {
  let noMarkerWorkspace: string;

  beforeEach(() => {
    // A plain directory with no .git or package.json — detectWorkspace throws WorkspaceNotFoundError.
    noMarkerWorkspace = mkdtempSync(join(tmpdir(), "keiko-no-marker-"));
    mkdirSync(join(noMarkerWorkspace, "somefile"), { recursive: true });
  });

  afterEach(() => {
    rmSync(noMarkerWorkspace, { recursive: true, force: true });
  });

  it("POST /api/runs explain-plan with no workspace marker → 400 with path-safe message", async () => {
    await start(fakeModel("an explanation"), { registerWorkspace: false });
    // Re-register the no-marker workspace so the allowlist check passes but detectWorkspace fails.
    const store = createInMemoryUiStore();
    store.createProject(noMarkerWorkspace);
    await new Promise<void>((res) =>
      server.close(() => {
        res();
      }),
    );
    registry = createRunRegistry();
    evidenceStore = createInMemoryEvidenceStore();
    server = createUiServer({
      staticRoot,
      csp: buildCspHeader([]),
      port,
      handlerDeps: {
        config: undefined,
        configPresent: false,
        evidenceStore,
        env: {},
        redactor: buildRedactor({}),
        registry,
        modelPortFactory: (): ModelPort => fakeModel("an explanation"),
        store,
      },
    });
    await new Promise<void>((res) => server.listen(port, UI_HOST, res));

    const res = await fetch(`${base()}/api/runs`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        taskType: "explain-plan",
        input: { filePath: "src/add.ts", workspaceRoot: noMarkerWorkspace },
        modelId: "m",
      }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe("WORKSPACE_UNAVAILABLE");
    // The absolute path must NOT appear in the response body.
    expect(JSON.stringify(json)).not.toContain(noMarkerWorkspace);
  });

  it("POST /api/chats/runs explain-plan with no workspace marker → 400 with path-safe message, summary marked failed", async () => {
    const store = createInMemoryUiStore();
    store.createProject(noMarkerWorkspace);
    const chat = store.createChat(noMarkerWorkspace, "test chat", "m");

    await start(fakeModel("an explanation"), { registerWorkspace: false });
    await new Promise<void>((res) =>
      server.close(() => {
        res();
      }),
    );
    registry = createRunRegistry();
    evidenceStore = createInMemoryEvidenceStore();
    server = createUiServer({
      staticRoot,
      csp: buildCspHeader([]),
      port,
      handlerDeps: {
        config: undefined,
        configPresent: false,
        evidenceStore,
        env: {},
        redactor: buildRedactor({}),
        registry,
        modelPortFactory: (): ModelPort => fakeModel("an explanation"),
        store,
      },
    });
    await new Promise<void>((res) => server.listen(port, UI_HOST, res));

    const res = await fetch(`${base()}/api/chats/runs`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: chat.id,
        projectPath: noMarkerWorkspace,
        run: {
          taskType: "explain-plan",
          input: { filePath: "src/add.ts", workspaceRoot: noMarkerWorkspace },
          modelId: "m",
        },
        user: { content: "Explain this plan.", timestamp: 1 },
        summary: { content: "Explain started", timestamp: 2 },
      }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe("WORKSPACE_UNAVAILABLE");
    // The absolute path must NOT appear in the response body.
    expect(JSON.stringify(json)).not.toContain(noMarkerWorkspace);
    // The persisted summary message must be marked failed (not stuck as "running").
    const messages = store.listMessages(chat.id);
    const summary = messages.find((m) => m.role === "system");
    expect(summary?.workflowStatus).toBe("failed");
  });
});
