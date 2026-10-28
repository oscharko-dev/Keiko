import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SDK_VERSION } from "@oscharko-dev/keiko-sdk";
import {
  CODING_TASK_IMPORT_MAX_BYTES,
  type CodingTaskExportDocument,
  type CodingTaskImportResponse,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import type { UiHandlerDeps } from "../deps.js";
import type { RouteContext } from "../routes.js";
import { matchRoute } from "../routes.js";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import {
  createFakeSessionPairingPort,
  fakePairingRequestBody,
} from "../coding-app-session/_support.js";
import { createCodingAppSessionChannel } from "../coding-app-session/sessionChannel.js";
import { createSessionRegistry } from "../coding-app-session/sessionRegistry.js";
import { APP_SESSION_COOKIE_NAME } from "../coding-app-session/sessionCookie.js";
import { TaskWorkspaceError } from "../task-workspace/errors.js";
import { CodingRuntimeHistory } from "./codingRuntimeHistory.js";
import { OPENCODE_PINNED_VERSION } from "./opencodeRuntimeVersions.js";
import {
  exportCodingHistory,
  importCodingHistory,
  listCodingHistory,
  readCodingHistory,
  updateCodingHistory,
} from "./codingHistoryRoutes.js";

let store: UiStore;
let root: string;
let id: string;
let cookie: string;
const CONFIGURED_KEY = "configured-provider-credential-0123456789";
let deps: UiHandlerDeps;
let history: CodingRuntimeHistory;
const live = vi.fn(() => false);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "coding-history-route-"));
  store = createInMemoryUiStore();
  history = new CodingRuntimeHistory(store, () => "operator", undefined);
  const task = store.codingHistory?.create({
    projectPath: root,
    title: "Generate tests",
    modelId: "coding",
    workspaceId: "ws-one",
    taskId: "task-one",
    branch: "feature/tests",
    operatorDigest: createHash("sha256").update("operator").digest("hex"),
  });
  if (task === undefined) throw new Error("Missing history fixture");
  id = task.id;
  const channel = createCodingAppSessionChannel({
    registry: createSessionRegistry(),
    pairingPort: createFakeSessionPairingPort(),
  });
  const paired = channel.pair(fakePairingRequestBody());
  if (!paired.paired) throw new Error("Pairing failed");
  cookie = `${APP_SESSION_COOKIE_NAME}=${paired.cookieToken}`;
  live.mockReturnValue(false);
  deps = {
    codingAppSessionChannel: channel,
    codingRuntimeOrchestrator: { getHistory: () => history, hasLiveRun: live },
    env: { KEIKO_DEFAULT_API_KEY: CONFIGURED_KEY },
  } as unknown as UiHandlerDeps;
});

afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

function context(body = "{}", taskId = id, paired = true): RouteContext {
  const stream = new PassThrough();
  const req = stream as unknown as RouteContext["req"];
  req.headers = paired ? { cookie } : {};
  queueMicrotask(() => stream.end(body));
  return {
    req,
    res: new PassThrough() as unknown as RouteContext["res"],
    params: { id: taskId },
    url: new URL("http://localhost/api/coding-workbench/history"),
    correlationId: "history-route-test",
  };
}

describe("paired coding history routes", () => {
  it("mounts every history operation on the production route table", () => {
    for (const [method, path] of [
      ["GET", ""],
      ["GET", "/task"],
      ["PATCH", "/task"],
      ["GET", "/task/export"],
    ]) {
      expect(matchRoute(method ?? "", `/api/coding-workbench/history${path ?? ""}`)).toMatchObject({
        definition: { method },
      });
    }
  });

  it("conceals existence and never reads history for unpaired callers", async () => {
    const read = vi.spyOn(history, "detail");
    const list = vi.spyOn(history, "list");
    const results = [
      listCodingHistory(context("{}", id, false), deps),
      readCodingHistory(context("{}", id, false), deps),
      await updateCodingHistory(context('{"title":"changed"}', id, false), deps),
    ];
    expect(results.map((result) => result.status)).toEqual([404, 404, 404]);
    expect(new Set(results.map((result) => JSON.stringify(result.body))).size).toBe(1);
    expect(read).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("reads stored task content only for the current local operator", () => {
    expect(listCodingHistory(context(), deps)).toMatchObject({
      status: 200,
      body: { tasks: [{ id }] },
    });
    expect(readCodingHistory(context(), deps)).toMatchObject({
      status: 200,
      body: { task: { id, title: "Generate tests" }, messages: [] },
    });
    history = new CodingRuntimeHistory(store, () => "different-operator", undefined);
    expect(listCodingHistory(context(), deps)).toMatchObject({ status: 200, body: { tasks: [] } });
    expect(readCodingHistory(context(), deps).status).toBe(404);
  });

  it("returns unavailable when composition or the task is missing", async () => {
    expect(
      listCodingHistory(context(), { ...deps, codingRuntimeOrchestrator: undefined }).status,
    ).toBe(404);
    expect(readCodingHistory(context("{}", "unknown"), deps).status).toBe(404);
    expect(readCodingHistory({ ...context(), params: {} }, deps).status).toBe(404);
    expect((await updateCodingHistory({ ...context(), params: {} }, deps)).status).toBe(404);
  });

  it("renames, completes and reopens the durable task", async () => {
    for (const patch of [{ title: "New title" }, { status: "completed" }, { status: "active" }]) {
      const result = await updateCodingHistory(context(JSON.stringify(patch)), deps);
      expect(result).toMatchObject({ status: 200, body: { task: { id, ...patch } } });
      expect(history.detail(id, "verify")?.task).toMatchObject(patch);
    }
  });

  it("blocks completion while execution is live without blocking a rename", async () => {
    live.mockReturnValue(true);
    expect(await updateCodingHistory(context('{"status":"completed"}'), deps)).toMatchObject({
      status: 409,
      body: { error: { code: "ACTIVE_RUN_CONFLICT" } },
    });
    expect(history.detail(id, "verify")?.task.status).toBe("active");
    expect((await updateCodingHistory(context('{"title":"Still running"}'), deps)).status).toBe(
      200,
    );
  });

  it.each([
    "{}",
    "[]",
    "null",
    "42",
    "{",
    '{"title":" "}',
    '{"title":3}',
    '{"status":"deleted"}',
    '{"extra":true}',
    JSON.stringify({ title: "x".repeat(101) }),
  ])("rejects invalid patches without changing stored history: %s", async (body) => {
    expect((await updateCodingHistory(context(body), deps)).status).toBe(400);
    expect(history.detail(id, "verify")?.task).toMatchObject({
      title: "Generate tests",
      status: "active",
    });
  });

  it("enforces the request size boundary and accepts the maximum title length", async () => {
    expect(
      (await updateCodingHistory(context(JSON.stringify({ title: "x".repeat(4097) })), deps))
        .status,
    ).toBe(413);
    expect(
      (await updateCodingHistory(context(JSON.stringify({ title: "x".repeat(100) })), deps)).status,
    ).toBe(200);
  });
});

describe("history request response-shape isolation", () => {
  it.each([200, 400, 413, 99999])(
    "validates caller status %i instead of echoing it",
    async (status) => {
      const body = { error: { code: "CALLER_CONTROLLED" } };
      const update = vi.spyOn(history, "update");
      const result = await updateCodingHistory(context(JSON.stringify({ status, body })), deps);
      expect(result).toMatchObject({ status: 400, body: { error: { code: "INVALID_REQUEST" } } });
      expect(result.body).not.toEqual(body);
      expect(update).not.toHaveBeenCalled();
    },
  );
});

describe("paired coding history export", () => {
  const runId = "b98ffdea-fc67-4e81-b1da-c5a987198123";

  function exportContext(format: string | undefined, taskId = id, paired = true): RouteContext {
    const query = format === undefined ? "" : `?format=${encodeURIComponent(format)}`;
    return {
      ...context("", taskId, paired),
      url: new URL(`http://localhost/api/coding-workbench/history/${taskId}/export${query}`),
    };
  }

  function seed(): void {
    const history = store.codingHistory;
    if (history === undefined) throw new Error("Missing history fixture");
    history.bindRun(id, runId);
    history.append(id, runId, "intent", "user", `Rotate ${CONFIGURED_KEY} in ${root}/config.json`);
    history.append(
      id,
      runId,
      "answer",
      "assistant",
      `Done. Look at ${root}/src/a.ts and /Users/alice/.ssh/config now. Key sk-abcdefghijklmnopqrstuvwxyz012345.`,
    );
  }

  function exported(format?: string): {
    readonly status: number;
    readonly body: Record<string, unknown>;
    readonly headers?: Readonly<Record<string, string | readonly string[]>> | undefined;
  } {
    const result = exportCodingHistory(exportContext(format), deps);
    return { ...result, body: result.body as Record<string, unknown> };
  }

  it("answers unpaired callers and unknown tasks exactly like an unavailable task", () => {
    const detail = store.codingHistory ? vi.spyOn(store.codingHistory, "detail") : undefined;
    const unpaired = exportCodingHistory(exportContext("json", id, false), deps);
    const unknown = exportCodingHistory(exportContext("json", "unknown"), deps);
    const noRuntime = exportCodingHistory(exportContext("json"), {
      ...deps,
      codingRuntimeOrchestrator: undefined,
    });
    expect([unpaired.status, unknown.status, noRuntime.status]).toEqual([404, 404, 404]);
    expect(new Set([unpaired, unknown, noRuntime].map((r) => JSON.stringify(r.body))).size).toBe(1);
    expect(detail).toHaveBeenCalledTimes(1);
  });

  it("never exports another operator's task", () => {
    seed();
    history = new CodingRuntimeHistory(store, () => "different-operator", undefined);
    expect(exported("json").status).toBe(404);
  });

  it("returns the versioned JSON file with redacted text and the build's version facts", () => {
    seed();
    const result = exported();
    expect(result.status).toBe(200);
    expect(result.headers).toEqual({ "Cache-Control": "no-store" });
    expect(result.body).toMatchObject({
      format: "json",
      mediaType: "application/json",
      messageCount: 2,
      truncated: false,
    });
    const content = String(result.body.content);
    expect(result.body.byteCount).toBe(Buffer.byteLength(content));
    expect(String(result.body.fileName)).toMatch(/^keiko-coding-task-.+\.json$/u);
    const document = JSON.parse(content) as CodingTaskExportDocument;
    expect(document).toMatchObject({
      schema: "keiko-coding-task-export",
      schemaVersion: 1,
      generator: {
        keikoVersion: SDK_VERSION,
        opencodeRuntimePinnedVersion: OPENCODE_PINNED_VERSION,
      },
      task: { id, title: "Generate tests", branch: "feature/tests", runIds: [runId] },
    });
    expect(document.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(document.messages[0]?.text).toBe("Rotate [REDACTED] in config.json");
    expect(document.messages[1]?.text).toContain("Done. Look at src/a.ts and [REDACTED_PATH]");
    for (const leaked of [CONFIGURED_KEY, "sk-abcdefghijklmnop", "alice", root, "projectPath"]) {
      expect(content).not.toContain(leaked);
    }
  });

  it("returns the Markdown rendering on request", () => {
    seed();
    const result = exported("markdown");
    expect(result.body).toMatchObject({ format: "markdown", mediaType: "text/markdown" });
    expect(String(result.body.fileName)).toMatch(/\.md$/u);
    const content = String(result.body.content);
    expect(content).toContain("# Keiko coding task export");
    expect(content).not.toContain(CONFIGURED_KEY);
    expect(content).not.toContain(root);
  });

  it("refuses an unknown format before reading any history", () => {
    const detail = store.codingHistory ? vi.spyOn(store.codingHistory, "detail") : undefined;
    expect(exported("docx")).toMatchObject({
      status: 400,
      body: { error: { code: "INVALID_REQUEST", correlationId: "history-route-test" } },
    });
    expect(detail).not.toHaveBeenCalled();
  });

  it("turns an unexpected storage failure into an opaque, correlated 500", () => {
    seed();
    if (store.codingHistory === undefined) throw new Error("Missing history fixture");
    vi.spyOn(store.codingHistory, "detail").mockImplementation(() => {
      throw new Error(`database said no at ${root}`);
    });
    const result = exported("json");
    expect(result).toMatchObject({
      status: 500,
      body: { error: { code: "INTERNAL", correlationId: "history-route-test" } },
    });
    expect(JSON.stringify(result.body)).not.toContain(root);
  });

  it("records the request, its outcome and the counts under the request's correlation", () => {
    seed();
    const sink = createBufferedServerLogSink();
    history = new CodingRuntimeHistory(store, () => "operator", sink);
    expect(exported("markdown").status).toBe(200);
    expect(exported("docx").status).toBe(400);
    const lines = sink.events.map((event) =>
      expectActivityLogProof(
        "coding-runtime.history.export.emitted-line",
        formatActivityLogProofLine(event),
      ),
    );
    expect(lines.map((line) => [line.correlationId, line.event, line.format, line.reason])).toEqual(
      [
        ["history-route-test", "requested", "markdown", undefined],
        ["history-route-test", "completed", "markdown", undefined],
        ["history-route-test", "requested", undefined, undefined],
        ["history-route-test", "refused", undefined, "invalid-format"],
      ],
    );
    expect(lines[1]).toMatchObject({
      conversationId: id,
      messageCount: 2,
      redactedMessageCount: 2,
      omittedMessageCount: 0,
    });
    const logged = JSON.stringify(sink.events);
    for (const body of [CONFIGURED_KEY, "Generate tests", "alice", root]) {
      expect(logged).not.toContain(body);
    }
  });
});

describe("paired coding history import", () => {
  const runId = "c5a98719-8123-4e81-b1da-b98ffdeafc67";
  const workspace = {
    instance: {
      repositoryRoot: "",
      workspaceId: "ws-import",
      taskId: "task-import",
      taskBranch: "feature/imported",
    },
  };
  let importDeps: UiHandlerDeps;

  beforeEach(() => {
    workspace.instance.repositoryRoot = root;
    importDeps = {
      ...deps,
      workspaceLifecycle: { getActive: () => workspace },
    } as unknown as UiHandlerDeps;
  });

  function importContext(body: string, paired = true): RouteContext {
    return {
      ...context(body, id, paired),
      url: new URL("http://localhost/api/coding-workbench/history/import"),
    };
  }

  function exportedFile(): string {
    const history = store.codingHistory;
    if (history === undefined) throw new Error("Missing history fixture");
    history.bindRun(id, runId);
    history.append(id, runId, "intent", "user", "Generate the parser tests");
    history.append(id, runId, "answer", "assistant", `Done with ${CONFIGURED_KEY}.`);
    const result = exportCodingHistory(
      {
        ...context("", id),
        url: new URL(`http://localhost/api/coding-workbench/history/${id}/export?format=json`),
      },
      deps,
    );
    return String((result.body as Record<string, unknown>).content);
  }

  function taskCount(): number {
    return history.list("operator").length;
  }

  it("mounts the import on the production route table ahead of the task routes", () => {
    expect(matchRoute("POST", "/api/coding-workbench/history/import")).toMatchObject({
      definition: { method: "POST", handler: importCodingHistory },
    });
  });

  it("answers an unpaired caller like an unavailable history and stores nothing", async () => {
    const before = taskCount();
    const unpaired = await importCodingHistory(importContext(exportedFile(), false), importDeps);
    const noRuntime = await importCodingHistory(importContext(exportedFile()), {
      ...importDeps,
      codingRuntimeOrchestrator: undefined,
    });
    const unknown = readCodingHistory(context("{}", "unknown"), deps);
    expect([unpaired.status, noRuntime.status]).toEqual([404, 404]);
    expect(JSON.stringify(unpaired.body)).toBe(JSON.stringify(unknown.body));
    expect(JSON.stringify(noRuntime.body)).toBe(JSON.stringify(unknown.body));
    expect(taskCount()).toBe(before);
  });

  it("refuses with 409 when there is no workspace whose identity is proven", async () => {
    const file = exportedFile();
    const proofFailure = new TaskWorkspaceError("IDENTITY_PROOF_FAILED", "proof failed");
    for (const lifecycle of [
      undefined,
      { getActive: (): undefined => undefined },
      {
        getActive: (): never => {
          throw proofFailure;
        },
      },
    ]) {
      const result = await importCodingHistory(importContext(file), {
        ...deps,
        workspaceLifecycle: lifecycle,
      } as unknown as UiHandlerDeps);
      expect(result).toMatchObject({
        status: 409,
        body: { error: { code: "CODING_HISTORY_IMPORT_NO_WORKSPACE" } },
      });
    }
    expect(taskCount()).toBe(1);
  });

  it("does not hide an unexpected workspace failure", async () => {
    const failing = {
      ...deps,
      workspaceLifecycle: {
        getActive: () => {
          throw new Error("lifecycle broke");
        },
      },
    } as unknown as UiHandlerDeps;
    await expect(importCodingHistory(importContext("{}"), failing)).rejects.toThrow(
      "lifecycle broke",
    );
  });

  it("stores an exported task as a new imported task in the active workspace", async () => {
    const result = await importCodingHistory(importContext(exportedFile()), importDeps);
    expect(result.status).toBe(201);
    expect(result.headers).toEqual({ "Cache-Control": "no-store" });
    const body = result.body as CodingTaskImportResponse;
    expect(body).toMatchObject({
      source: "keiko-task-export",
      messageCount: 2,
      omittedMessageCount: 0,
      skippedMessageCount: 0,
      task: { title: "Generate tests", origin: "imported", status: "active" },
    });
    expect(body.task.id).not.toBe(id);
    const detail = history.detail(body.task.id, "verify");
    expect(detail?.task).toMatchObject({ branch: "feature/imported", origin: "imported" });
    expect(detail?.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "Generate the parser tests"],
      ["assistant", "Done with [REDACTED]."],
    ]);
    expect(body.task.projectPath).toBe(root);
  });

  it.each([
    ["not JSON", "{", 400, "CODING_HISTORY_IMPORT_INVALID"],
    ["another document", '{"kind":"unrelated"}', 400, "CODING_HISTORY_IMPORT_INVALID"],
    [
      "a newer export",
      JSON.stringify({ schema: "keiko-coding-task-export", schemaVersion: 2 }),
      400,
      "CODING_HISTORY_IMPORT_UNSUPPORTED_VERSION",
    ],
    [
      "a transcript without text",
      JSON.stringify({ info: { title: "t" }, messages: [] }),
      400,
      "CODING_HISTORY_IMPORT_EMPTY",
    ],
  ])("refuses %s without storing a task", async (_name, file, status, code) => {
    const result = await importCodingHistory(importContext(file), importDeps);
    expect(result).toMatchObject({
      status,
      body: { error: { code, correlationId: "history-route-test" } },
    });
    expect(taskCount()).toBe(1);
  });

  it("refuses a file above the import bound with 413", async () => {
    const result = await importCodingHistory(
      importContext("x".repeat(CODING_TASK_IMPORT_MAX_BYTES + 1)),
      importDeps,
    );
    expect(result).toMatchObject({
      status: 413,
      body: { error: { code: "CODING_HISTORY_IMPORT_TOO_LARGE" } },
    });
    expect(taskCount()).toBe(1);
  });

  it("records the import under the request's correlation without any file content", async () => {
    const file = JSON.stringify({
      info: { title: "Generate tests" },
      messages: [
        {
          info: { role: "user", time: { created: 1 } },
          parts: [{ type: "text", text: "parser tests" }],
        },
        {
          info: { role: "assistant", time: { created: 2 } },
          parts: [{ type: "text", text: `Rotated ${CONFIGURED_KEY} in ${root}/a.ts` }],
        },
      ],
    });
    const sink = createBufferedServerLogSink();
    history = new CodingRuntimeHistory(store, () => "operator", sink);
    expect((await importCodingHistory(importContext(file), importDeps)).status).toBe(201);
    expect((await importCodingHistory(importContext("{"), importDeps)).status).toBe(400);
    const lines = sink.events.map((event) =>
      expectActivityLogProof(
        "coding-runtime.history.import.emitted-line",
        formatActivityLogProofLine(event),
      ),
    );
    expect(lines.map((line) => [line.correlationId, line.event, line.source, line.reason])).toEqual(
      [
        ["history-route-test", "requested", undefined, undefined],
        ["history-route-test", "completed", "opencode-session", undefined],
        ["history-route-test", "requested", undefined, undefined],
        ["history-route-test", "refused", undefined, "invalid-document"],
      ],
    );
    expect(lines[1]).toMatchObject({ messageCount: 2, redactedMessageCount: 1 });
    const logged = JSON.stringify(sink.events);
    for (const content of [CONFIGURED_KEY, "Generate tests", "parser tests", root]) {
      expect(logged).not.toContain(content);
    }
  });
});
