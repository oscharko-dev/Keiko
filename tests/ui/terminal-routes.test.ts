// ADR-0018 D8 — /api/terminal/* route integration tests. A FakeTerminalExecutionManager replaces
// the real spawn-backed manager so these tests never spawn a real child. The createUiServer
// fixture mirrors browser-routes.test.ts so CSRF guard, host-check, and SSE framer run live.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCspHeader } from "../../src/ui/csp.js";
import {
  buildRedactor,
  createInMemoryUiStore,
  type UiHandlerDeps,
} from "../../src/ui/index.js";
import { createRunRegistry } from "../../src/ui/runs.js";
import { createUiServer, UI_HOST } from "../../src/ui/server.js";
import {
  TerminalToolError,
  type TerminalEventEmitter,
  type TerminalEventEnvelope,
  type TerminalExecutionInput,
  type TerminalExecutionManager,
  type TerminalExecutionResult,
} from "../../src/ui/index.js";

interface FakeOptions {
  readonly executeShouldThrow?: TerminalToolError;
  readonly executeResult?: TerminalExecutionResult;
}

class FakeTerminalExecutionManager implements TerminalExecutionManager {
  public readonly executed: TerminalExecutionInput[] = [];
  public readonly aborted: string[] = [];
  private readonly subscribers = new Set<TerminalEventEmitter>();
  private readonly opts: FakeOptions;
  private nextId = 1;

  public constructor(opts: FakeOptions = {}) {
    this.opts = opts;
  }

  public readonly execute = (input: TerminalExecutionInput): Promise<TerminalExecutionResult> => {
    this.executed.push(input);
    if (this.opts.executeShouldThrow !== undefined) {
      return Promise.reject(this.opts.executeShouldThrow);
    }
    const executionId = `exec-${String(this.nextId++)}`;
    this.emit({
      kind: "execution-started",
      executionId,
      payload: {
        projectId: input.projectId,
        command: input.command,
        argCount: input.args.length,
        startedAt: 1700000000000,
      },
    });
    const result: TerminalExecutionResult = this.opts.executeResult ?? {
      executionId,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 1,
      truncated: false,
      timedOut: false,
    };
    this.emit({
      kind: "execution-completed",
      executionId,
      payload: {
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        truncated: result.truncated,
        timedOut: result.timedOut,
        stdoutByteLength: Buffer.byteLength(result.stdout, "utf8"),
        stderrByteLength: Buffer.byteLength(result.stderr, "utf8"),
      },
    });
    return Promise.resolve(result);
  };

  public readonly abort = (executionId: string): boolean => {
    this.aborted.push(executionId);
    return true;
  };

  public readonly subscribe = (listener: TerminalEventEmitter): (() => void) => {
    this.subscribers.add(listener);
    return (): void => {
      this.subscribers.delete(listener);
    };
  };

  public readonly inFlightCount = (): number => 0;

  public emitExternal(event: TerminalEventEnvelope): void {
    this.emit(event);
  }

  private emit(event: TerminalEventEnvelope): void {
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
let terminal: FakeTerminalExecutionManager;

async function listen(srv: Server): Promise<number> {
  await new Promise<void>((resolve) => srv.listen(0, UI_HOST, resolve));
  return (srv.address() as AddressInfo).port;
}

async function closeServer(srv: Server = server): Promise<void> {
  await new Promise<void>((resolve) => {
    srv.close(() => { resolve(); });
  });
}

// The host-check validates the request's Host header against the configured port. We open a
// dummy listener on port:0 to claim a free port, close it, then re-open with that port pinned so
// the host-check accepts the loopback Host that fetch() sends.
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
  return {
    "Content-Type": "application/json",
    "X-Keiko-CSRF": "1",
  };
}

beforeEach(async () => {
  staticRoot = await mkdtemp(join(tmpdir(), "keiko-term-routes-"));
  workspaceRoot = await mkdtemp(join(tmpdir(), "keiko-term-ws-"));
  const store = createInMemoryUiStore();
  store.createProject(workspaceRoot, "test-project");
  terminal = new FakeTerminalExecutionManager();
  deps = {
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
    store,
    terminal,
  };
  const built = await buildServer(deps);
  server = built.server;
  port = built.port;
});

afterEach(async () => {
  await closeServer();
  await rm(staticRoot, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
});

// ── /api/terminal/policy ───────────────────────────────────────────────────────

describe("GET /api/terminal/policy", () => {
  it("returns the permitted command list and limits", async () => {
    const res = await fetch(`${baseUrl()}/api/terminal/policy`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      commands: string[];
      limits: { maxOutputBytes: number; defaultTimeoutMs: number };
    };
    expect(body.commands).toContain("git");
    expect(body.commands).toContain("grep");
    expect(body.commands).not.toContain("rm");
    expect(body.limits.maxOutputBytes).toBeGreaterThan(0);
    expect(body.limits.defaultTimeoutMs).toBeGreaterThan(0);
  });
});

// ── /api/terminal/directories ──────────────────────────────────────────────────

describe("GET /api/terminal/directories", () => {
  it("requires a projectId query parameter", async () => {
    const res = await fetch(`${baseUrl()}/api/terminal/directories`);
    expect(res.status).toBe(400);
  });

  it("returns 404 PROJECT_NOT_FOUND for an unknown projectId", async () => {
    const res = await fetch(
      `${baseUrl()}/api/terminal/directories?projectId=${encodeURIComponent("/no/such/project")}`,
    );
    expect(res.status).toBe(404);
  });

  it("returns the project root entries for a known projectId", async () => {
    const res = await fetch(
      `${baseUrl()}/api/terminal/directories?projectId=${encodeURIComponent(workspaceRoot)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string };
    expect(typeof body.path).toBe("string");
  });
});

// ── /api/terminal/executions (POST) ────────────────────────────────────────────

describe("POST /api/terminal/executions", () => {
  it("rejects without CSRF header (403 FORBIDDEN_CSRF)", async () => {
    const res = await fetch(`${baseUrl()}/api/terminal/executions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: workspaceRoot, command: "ls", args: [] }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects non-JSON content-type (415)", async () => {
    const res = await fetch(`${baseUrl()}/api/terminal/executions`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "X-Keiko-CSRF": "1" },
      body: "{}",
    });
    expect(res.status).toBe(415);
  });

  it("rejects a missing required field (400 BAD_REQUEST)", async () => {
    const res = await fetch(`${baseUrl()}/api/terminal/executions`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ command: "ls", args: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("forwards a valid request to execute() and returns the result body", async () => {
    const res = await fetch(`${baseUrl()}/api/terminal/executions`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ projectId: workspaceRoot, command: "ls", args: ["-la"] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { exitCode: number; stdout: string };
    expect(body.exitCode).toBe(0);
    expect(body.stdout).toBe("ok");
    expect(terminal.executed[0]).toMatchObject({ projectId: workspaceRoot, command: "ls" });
  });

  it("maps a TerminalToolError thrown by execute() to the right status", async () => {
    const localTerminal = new FakeTerminalExecutionManager({
      executeShouldThrow: new TerminalToolError("COMMAND_DENIED", "Command is not in the allowlist."),
    });
    deps = { ...deps, terminal: localTerminal };
    await closeServer();
    const rebuilt = await buildServer(deps);
    server = rebuilt.server;
    port = rebuilt.port;
    const res = await fetch(`${baseUrl()}/api/terminal/executions`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ projectId: workspaceRoot, command: "rm", args: [] }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("COMMAND_DENIED");
  });
});

// ── /api/terminal/executions/:executionId (DELETE) ─────────────────────────────

describe("DELETE /api/terminal/executions/:executionId", () => {
  it("rejects without CSRF (403)", async () => {
    const res = await fetch(`${baseUrl()}/api/terminal/executions/abc`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(403);
  });

  it("returns 200 when an execution is aborted", async () => {
    const res = await fetch(`${baseUrl()}/api/terminal/executions/exec-1`, {
      method: "DELETE",
      headers: csrfHeaders(),
    });
    expect(res.status).toBe(200);
    expect(terminal.aborted).toContain("exec-1");
  });

  it("returns 404 EXECUTION_NOT_FOUND when no in-flight execution matches", async () => {
    const noopTerminal: TerminalExecutionManager = {
      execute: (): Promise<TerminalExecutionResult> =>
        Promise.reject(new TerminalToolError("INTERNAL", "unused")),
      abort: (): boolean => false,
      subscribe: (): (() => void) => (): void => undefined,
      inFlightCount: (): number => 0,
    };
    deps = { ...deps, terminal: noopTerminal };
    await closeServer();
    const rebuilt = await buildServer(deps);
    server = rebuilt.server;
    port = rebuilt.port;
    const res = await fetch(`${baseUrl()}/api/terminal/executions/missing`, {
      method: "DELETE",
      headers: csrfHeaders(),
    });
    expect(res.status).toBe(404);
  });
});

// ── /api/terminal/events (GET SSE) ─────────────────────────────────────────────

describe("GET /api/terminal/events", () => {
  it("opens an SSE stream and frames emitted events as terminal:<kind> messages", async () => {
    const url = `${baseUrl()}/api/terminal/events`;
    const res = await fetch(url, { headers: { Accept: "text/event-stream" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")?.startsWith("text/event-stream")).toBe(true);
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    const chunks: string[] = [];
    const decoder = new TextDecoder();
    // Emit one external event after the ready frame.
    setTimeout(() => {
      terminal.emitExternal({
        kind: "execution-cancelled",
        executionId: "exec-99",
        payload: {},
      });
    }, 30);
    const readChunk = async (): Promise<void> => {
      if (reader === undefined) return;
      const { value } = await reader.read();
      if (value !== undefined) chunks.push(decoder.decode(value));
    };
    // Read until we see the cancelled event or hit the deadline.
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      await readChunk();
      if (chunks.join("").includes("terminal:execution-cancelled")) break;
    }
    void reader?.cancel();
    const stream = chunks.join("");
    expect(stream).toContain("event: ready");
    expect(stream).toContain("event: terminal:execution-cancelled");
    expect(stream).toContain('"executionId":"exec-99"');
  });
});

// Host-check guard coverage lives in tests/ui/host-check.test.ts (fetch() rewrites the Host
// header before transmission so an in-process test cannot exercise that path through fetch).
