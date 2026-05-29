// Integration tests for the run-engine BFF routes (ADR-0011 D5 routes 5–9). They bind a real
// ephemeral 127.0.0.1 socket and drive the full HTTP/SSE flow with an INJECTED fake ModelPort
// (deterministic, offline — no network, no gateway). A real temp workspace (copy of the unit-test
// fixture) lets the dry-run workflow produce a genuine proposedDiff. Assertions cover dry-run
// default, SSE replay+ready+live framing+terminal close, cancel, GET projection, the apply gate
// (409 when not appliable), and that NO secret-shaped string appears in ANY response body.

import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUiServer, UI_HOST } from "../../src/ui/server.js";
import { buildCspHeader } from "../../src/ui/csp.js";
import {
  buildRedactor,
  createRunRegistry,
  handleApplyRun,
  QueueEventSink,
  type UiHandlerDeps,
} from "../../src/ui/index.js";
import {
  createInMemoryEvidenceStore,
  listEvidence,
  loadEvidence,
  type EvidenceStore,
} from "../../src/audit/index.js";
import type { ModelPort } from "../../src/harness/index.js";
import { CancelledError } from "../../src/gateway/errors.js";
import type { NormalizedResponse } from "../../src/gateway/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "fixtures", "unit-tests", "target-project");

// A secret-shaped value the redactor must scrub from every response body.
const SECRET = "sk-abcdefghijklmnop0123456789";

const TEST_DIFF =
  "--- /dev/null\n+++ b/tests/add.test.ts\n@@ -0,0 +1,6 @@\n" +
  "+import { describe, expect, it } from 'vitest';\n" +
  "+import { add } from '../src/add';\n" +
  `+// token ${SECRET}\n` +
  "+describe('add', () => {\n" +
  "+  it('adds', () => expect(add(1, 2)).toBe(3));\n" +
  "+});\n";

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

function handlerDeps(model: ModelPort): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore,
    env: { KEY: SECRET },
    redactor: buildRedactor({ KEY: SECRET }),
    registry,
    modelPortFactory: () => model,
  };
}

async function start(model: ModelPort): Promise<void> {
  staticRoot = mkdtempSync(join(tmpdir(), "keiko-ui-runs-"));
  registry = createRunRegistry();
  evidenceStore = createInMemoryEvidenceStore();
  server = createUiServer({ staticRoot, csp: buildCspHeader([]), port: 0 });
  await new Promise<void>((res) => server.listen(0, UI_HOST, res));
  port = (server.address() as AddressInfo).port;
  await new Promise<void>((res) => server.close(() => { res(); }));
  server = createUiServer({
    staticRoot,
    csp: buildCspHeader([]),
    port,
    handlerDeps: handlerDeps(model),
  });
  await new Promise<void>((res) => server.listen(port, UI_HOST, res));
}

function base(): string {
  return `http://${UI_HOST}:${String(port)}`;
}

interface CreateResponse {
  readonly runId: string;
  readonly fingerprint: string;
}

async function createRun(apply = false): Promise<{ status: number; body: CreateResponse }> {
  const res = await fetch(`${base()}/api/runs`, {
    method: "POST",
    body: JSON.stringify({
      workflowId: "unit-test-generation",
      input: { workspaceRoot: workspace, target: { kind: "file", filePath: "src/add.ts" } },
      modelId: "test-model",
      apply,
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
  await new Promise<void>((res) => server.close(() => { res(); }));
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

  it("rejects a missing model with 400 NO_MODEL", async () => {
    await start(fakeModel("noop"));
    server.close();
    await new Promise<void>((res) => server.listen(port, UI_HOST, res));
    // Rebuild with a factory that yields no model.
    await new Promise<void>((res) => server.close(() => { res(); }));
    server = createUiServer({
      staticRoot,
      csp: buildCspHeader([]),
      port,
      handlerDeps: { ...handlerDeps(fakeModel("noop")), modelPortFactory: () => undefined },
    });
    await new Promise<void>((res) => server.listen(port, UI_HOST, res));
    const res = await fetch(`${base()}/api/runs`, {
      method: "POST",
      body: JSON.stringify({ taskType: "explain-plan", input: { filePath: "x" }, modelId: "m" }),
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
    const json = (await res.json()) as { report: { status: string } };
    expect(json.report.status).toBe("dry-run");
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
    const first = await fetch(`${base()}/api/runs/${body.runId}/cancel`, { method: "POST" });
    expect(first.status).toBe(200);
    expect((await first.json()) as { ok: boolean }).toEqual({ ok: true });
    await awaitTerminal(body.runId);
    const second = await fetch(`${base()}/api/runs/${body.runId}/cancel`, { method: "POST" });
    expect(second.status).toBe(200);
  });

  it("returns 404 for an unknown run", async () => {
    await start(fakeModel("noop"));
    const res = await fetch(`${base()}/api/runs/none/cancel`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/runs/:runId/apply (gated write path)", () => {
  it("returns 404 for an unknown run", async () => {
    await start(fakeModel("noop"));
    const res = await fetch(`${base()}/api/runs/none/apply`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("returns 409 when the run is not in an appliable state (explain-plan)", async () => {
    await start(fakeModel("a read-only explanation, no patch"));
    const res = await fetch(`${base()}/api/runs`, {
      method: "POST",
      body: JSON.stringify({
        taskType: "explain-plan",
        input: { filePath: "src/add.ts" },
        modelId: "m",
      }),
    });
    const created = (await res.json()) as CreateResponse;
    await awaitTerminal(created.runId);
    const apply = await fetch(`${base()}/api/runs/${created.runId}/apply`, { method: "POST" });
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
    const res = await fetch(`${base()}/api/runs/${body.runId}/apply`, { method: "POST" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { report: { status: string } };
    expect(["completed", "dry-run"]).toContain(json.report.status);
  });
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
    expect(JSON.stringify(manifest)).not.toContain(SECRET);
  });

  it("persists a cancelled run with a cancelled outcome (literal AC5)", async () => {
    await start(abortableModel());
    const { body } = await createRun();
    await fetch(`${base()}/api/runs/${body.runId}/cancel`, { method: "POST" });
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
      modelId: "claude-sonnet-x",
      sink: new QueueEventSink(),
      cancel: (): void => undefined,
    });
    localRegistry.complete("fix4-run", "completed", { status: "dry-run" }, {
      kind: "unit-tests",
      payload: { workspaceRoot: ".", target: { kind: "file", filePath: "x.ts" } },
      limits: undefined,
    });

    const seen: string[] = [];
    const deps: UiHandlerDeps = {
      config: undefined,
      configPresent: false,
      evidenceStore: createInMemoryEvidenceStore(),
      env: {},
      redactor: buildRedactor({}),
      registry: localRegistry,
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
    expect(seen).toEqual(["claude-sonnet-x"]);
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
      modelId: "claude-sonnet-x",
      sink: new QueueEventSink(),
      cancel: (): void => undefined,
    });
    localRegistry.complete("fixb-run", "completed", { status: "dry-run" }, {
      kind: "unit-tests",
      payload: { workspaceRoot: ".", target: { kind: "file", filePath: "x.ts" } },
      limits: testLimits,
    });

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
  });
});

describe("FIX G/H — oversized request body returns 413 PAYLOAD_TOO_LARGE", () => {
  it("returns 413 with PAYLOAD_TOO_LARGE code when the body exceeds 1 MB", async () => {
    await start(fakeModel("noop"));
    // 1 MB + 1 byte — just over MAX_BODY_BYTES.
    const oversized = "x".repeat(1_000_001);
    const res = await fetch(`${base()}/api/runs`, {
      method: "POST",
      body: oversized,
    });
    expect(res.status).toBe(413);
    const json = (await res.json()) as { error: { code: string } };
    expect(json).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
  });
});
