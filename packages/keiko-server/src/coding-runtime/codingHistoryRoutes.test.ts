import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { CodingRuntimeHistory } from "./codingRuntimeHistory.js";
import {
  listCodingHistory,
  readCodingHistory,
  updateCodingHistory,
} from "./codingHistoryRoutes.js";

let store: UiStore;
let root: string;
let id: string;
let cookie: string;
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
