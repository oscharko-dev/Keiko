// Issue #1387 — /api/commands/* route integration tests. A FakeCommandRunnerManager replaces the
// real spawn-backed manager so these tests never spawn a real child. The createUiServer fixture
// mirrors terminal-routes.test.ts so the CSRF guard, host-check, and SSE framer run live.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COMMAND_RUNNER_SCHEMA_VERSION,
  type CommandRunnerEvent,
  type CommandTaskCatalog,
  type CommandTaskRunResult,
} from "@oscharko-dev/keiko-contracts";
import { buildCspHeader } from "./csp.js";
import { buildRedactor, createInMemoryUiStore, type UiHandlerDeps } from "./index.js";
import { createRunRegistry } from "./runs.js";
import { createUiServer, UI_HOST } from "./server.js";
import type {
  CommandRunInput,
  CommandRunnerEventEmitter,
  CommandRunnerManager,
} from "./command-runner.js";

interface FakeOptions {
  readonly result?: Partial<CommandTaskRunResult>;
  readonly abortReturns?: boolean;
}

class FakeCommandRunnerManager implements CommandRunnerManager {
  public readonly executed: CommandRunInput[] = [];
  public readonly aborted: string[] = [];
  private readonly subscribers = new Set<CommandRunnerEventEmitter>();
  private readonly opts: FakeOptions;
  private nextId = 1;

  public constructor(opts: FakeOptions = {}) {
    this.opts = opts;
  }

  public readonly discover = (projectId: string): CommandTaskCatalog => ({
    schemaVersion: COMMAND_RUNNER_SCHEMA_VERSION,
    projectId,
    tasks: [
      {
        id: "npm-script:test",
        kind: "test",
        label: "npm run test",
        executable: "npm",
        args: ["run", "test"],
        source: "package-json-script",
      },
    ],
  });

  public readonly execute = (input: CommandRunInput): Promise<CommandTaskRunResult> => {
    this.executed.push(input);
    const runId = `run-${String(this.nextId++)}`;
    this.emit({
      kind: "run-started",
      runId,
      payload: {
        taskId: input.taskId,
        kind: "test",
        startedAt: 1700000000000,
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      },
    });
    const result: CommandTaskRunResult = {
      schemaVersion: COMMAND_RUNNER_SCHEMA_VERSION,
      runId,
      taskId: input.taskId,
      kind: "test",
      exitCode: 0,
      durationMs: 1,
      truncated: false,
      timedOut: false,
      failureReason: "none",
      stdout: "ok",
      stderr: "",
      ...this.opts.result,
    };
    return Promise.resolve(result);
  };

  public readonly abort = (runId: string): boolean => {
    this.aborted.push(runId);
    return this.opts.abortReturns ?? true;
  };

  public readonly subscribe = (listener: CommandRunnerEventEmitter): (() => void) => {
    this.subscribers.add(listener);
    return (): void => {
      this.subscribers.delete(listener);
    };
  };

  public readonly inFlightCount = (): number => 0;

  public emitExternal(event: CommandRunnerEvent): void {
    this.emit(event);
  }

  private emit(event: CommandRunnerEvent): void {
    for (const listener of [...this.subscribers]) {
      listener(event);
    }
  }
}

let server: Server;
let staticRoot: string;
let workspaceRoot: string;
let port: number;
let deps: UiHandlerDeps;
let commandRunner: FakeCommandRunnerManager;

async function listen(srv: Server): Promise<number> {
  await new Promise<void>((resolve) => srv.listen(0, UI_HOST, resolve));
  return (srv.address() as AddressInfo).port;
}

async function closeServer(srv: Server = server): Promise<void> {
  await new Promise<void>((resolve) => {
    srv.close(() => {
      resolve();
    });
  });
}

async function buildServer(handlerDeps: UiHandlerDeps): Promise<{ server: Server; port: number }> {
  const probe = createUiServer({
    staticRoot,
    csp: buildCspHeader([]),
    port: 0,
    handlerDeps,
  });
  const chosenPort = await listen(probe);
  await closeServer(probe);
  const next = createUiServer({
    staticRoot,
    csp: buildCspHeader([]),
    port: chosenPort,
    handlerDeps,
  });
  await new Promise<void>((resolve) => next.listen(chosenPort, UI_HOST, resolve));
  return { server: next, port: chosenPort };
}

function baseUrl(): string {
  return `http://${UI_HOST}:${String(port)}`;
}

function csrfHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", "X-Keiko-CSRF": "1" };
}

function baseDeps(): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: {
      put: (): string => "",
      list: (): readonly string[] => [],
      get: (): string | undefined => undefined,
      delete: (): void => undefined,
    },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: (): undefined => undefined,
    store: createInMemoryUiStore(),
    commandRunner,
  };
}

async function rebuild(override: Partial<UiHandlerDeps> = {}): Promise<void> {
  await closeServer();
  deps = { ...baseDeps(), ...override };
  const built = await buildServer(deps);
  server = built.server;
  port = built.port;
}

beforeEach(async () => {
  staticRoot = await mkdtemp(join(tmpdir(), "keiko-cmd-routes-"));
  workspaceRoot = await mkdtemp(join(tmpdir(), "keiko-cmd-ws-"));
  commandRunner = new FakeCommandRunnerManager();
  deps = baseDeps();
  const built = await buildServer(deps);
  server = built.server;
  port = built.port;
});

afterEach(async () => {
  await closeServer();
  await rm(staticRoot, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe("GET /api/commands/catalog", () => {
  it("returns the discovered task catalog for a projectId", async () => {
    const res = await fetch(
      `${baseUrl()}/api/commands/catalog?projectId=${encodeURIComponent(workspaceRoot)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as CommandTaskCatalog;
    expect(body.tasks.map((task) => task.id)).toContain("npm-script:test");
  });

  it("requires a projectId query parameter", async () => {
    const res = await fetch(`${baseUrl()}/api/commands/catalog`);
    expect(res.status).toBe(400);
  });

  it("returns 503 when the command runner is not configured", async () => {
    await rebuild({ commandRunner: undefined });
    const res = await fetch(
      `${baseUrl()}/api/commands/catalog?projectId=${encodeURIComponent(workspaceRoot)}`,
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("COMMAND_RUNNER_UNAVAILABLE");
  });
});

describe("POST /api/commands/runs", () => {
  it("runs a task and returns the structured result", async () => {
    const res = await fetch(`${baseUrl()}/api/commands/runs`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ projectId: workspaceRoot, taskId: "npm-script:test" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CommandTaskRunResult;
    expect(body.failureReason).toBe("none");
    expect(body.exitCode).toBe(0);
    expect(commandRunner.executed[0]?.taskId).toBe("npm-script:test");
  });

  it("applies Layer-2 redaction to stdout/stderr before the response", async () => {
    commandRunner = new FakeCommandRunnerManager({ result: { stdout: "token=SECRET-VALUE" } });
    await rebuild({
      commandRunner,
      redactor: (value: unknown): unknown =>
        typeof value === "string" ? value.replace("SECRET-VALUE", "[REDACTED]") : value,
    });
    const res = await fetch(`${baseUrl()}/api/commands/runs`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ projectId: workspaceRoot, taskId: "npm-script:test" }),
    });
    const body = (await res.json()) as CommandTaskRunResult;
    expect(body.stdout).toBe("token=[REDACTED]");
  });

  it("rejects without the CSRF header", async () => {
    const res = await fetch(`${baseUrl()}/api/commands/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: workspaceRoot, taskId: "npm-script:test" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects an invalid request body", async () => {
    const res = await fetch(`${baseUrl()}/api/commands/runs`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ projectId: workspaceRoot }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a non-JSON body", async () => {
    const res = await fetch(`${baseUrl()}/api/commands/runs`, {
      method: "POST",
      headers: csrfHeaders(),
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects an oversized body with 413", async () => {
    const res = await fetch(`${baseUrl()}/api/commands/runs`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ projectId: workspaceRoot, taskId: "x".repeat(20_000) }),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("returns 503 when the command runner is not configured", async () => {
    await rebuild({ commandRunner: undefined });
    const res = await fetch(`${baseUrl()}/api/commands/runs`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ projectId: workspaceRoot, taskId: "npm-script:test" }),
    });
    expect(res.status).toBe(503);
  });
});

describe("DELETE /api/commands/runs/:runId", () => {
  it("cancels a known in-flight run", async () => {
    const res = await fetch(`${baseUrl()}/api/commands/runs/run-1`, {
      method: "DELETE",
      headers: csrfHeaders(),
    });
    expect(res.status).toBe(200);
    expect(commandRunner.aborted).toContain("run-1");
  });

  it("returns 404 for an unknown run", async () => {
    commandRunner = new FakeCommandRunnerManager({ abortReturns: false });
    await rebuild({ commandRunner });
    const res = await fetch(`${baseUrl()}/api/commands/runs/run-x`, {
      method: "DELETE",
      headers: csrfHeaders(),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RUN_NOT_FOUND");
  });
});

describe("GET /api/commands/events", () => {
  it("opens an SSE stream and frames emitted events as command:<kind> messages", async () => {
    const res = await fetch(`${baseUrl()}/api/commands/events`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")?.startsWith("text/event-stream")).toBe(true);
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    const chunks: string[] = [];
    const decoder = new TextDecoder();
    setTimeout(() => {
      commandRunner.emitExternal({ kind: "run-completed", runId: "run-99", payload: {} });
    }, 30);
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const { value } = (await reader?.read()) ?? { value: undefined };
      if (value !== undefined) chunks.push(decoder.decode(value));
      if (chunks.join("").includes("command:run-completed")) break;
    }
    void reader?.cancel();
    const stream = chunks.join("");
    expect(stream).toContain("event: ready");
    expect(stream).toContain("event: command:run-completed");
    expect(stream).toContain('"runId":"run-99"');
  });
});
