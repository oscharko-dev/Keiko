// ADR-0018 D8 — /api/terminal/* route integration tests. A FakeTerminalExecutionManager replaces
// the real spawn-backed manager so these tests never spawn a real child. The createUiServer
// fixture mirrors browser-routes.test.ts so CSRF guard, host-check, and SSE framer run live.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCspHeader } from "./csp.js";
import { buildRedactor, createInMemoryUiStore, type UiHandlerDeps } from "./index.js";
import { createRunRegistry } from "./runs.js";
import { createUiServer, UI_HOST } from "./server.js";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { handleTerminalEvents, openTerminalSseStream } from "./terminal-routes.js";
import type { SseBackpressureSignal } from "./sse-write.js";
import type { RouteContext } from "./routes.js";
import type { ServerDiagnosticRecord, ServerDiagnosticSink } from "./diagnostics-log.js";
import {
  TerminalToolError,
  type TerminalEventEmitter,
  type TerminalEventEnvelope,
  type TerminalExecutionInput,
  type TerminalExecutionManager,
  type TerminalExecutionResult,
} from "./index.js";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
} from "./observability/index.js";

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
    const requestId = (input as TerminalExecutionInput & { readonly requestId?: string }).requestId;
    this.emit({
      kind: "execution-started",
      executionId,
      payload: {
        projectId: input.projectId,
        command: input.command,
        argCount: input.args.length,
        startedAt: 1700000000000,
        ...(requestId === undefined ? {} : { requestId }),
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
        ...(requestId === undefined ? {} : { requestId }),
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
    srv.close(() => {
      resolve();
    });
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
    const body = (await res.json()) as {
      path: string;
      roots: { label: string; path: string }[];
    };
    expect(typeof body.path).toBe("string");
    // A3 — roots must contain only the project root, no Home or Filesystem root entries.
    expect(body.roots.every((r) => r.label !== "Home" && r.label !== "Filesystem root")).toBe(true);
    expect(body.roots.some((r) => r.label === "Project root")).toBe(true);
  });

  it("fails closed when the registered project root has been deleted instead of falling back to process.cwd()", async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
    const res = await fetch(
      `${baseUrl()}/api/terminal/directories?projectId=${encodeURIComponent(workspaceRoot)}`,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("A3 — returns 403 CWD_OUTSIDE_PROJECT for an absolute path outside the project", async () => {
    const res = await fetch(
      `${baseUrl()}/api/terminal/directories?projectId=${encodeURIComponent(workspaceRoot)}&path=${encodeURIComponent("/etc")}`,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CWD_OUTSIDE_PROJECT");
  });

  it("A3 — returns 200 for a subdirectory inside the project root", async () => {
    // mkdtemp creates a subdirectory; create one inside workspaceRoot to navigate into it.
    const { mkdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const sub = join(workspaceRoot, "subdir");
    await mkdir(sub, { recursive: true });
    const res = await fetch(
      `${baseUrl()}/api/terminal/directories?projectId=${encodeURIComponent(workspaceRoot)}&path=${encodeURIComponent(sub)}`,
    );
    expect(res.status).toBe(200);
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

  it("forwards an optional requestId to execute()", async () => {
    const res = await fetch(`${baseUrl()}/api/terminal/executions`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({
        projectId: workspaceRoot,
        command: "ls",
        args: [],
        requestId: "req-123",
      }),
    });
    expect(res.status).toBe(200);
    expect(terminal.executed[0]).toMatchObject({ requestId: "req-123" });
  });

  it("maps a TerminalToolError thrown by execute() to the right status", async () => {
    const localTerminal = new FakeTerminalExecutionManager({
      executeShouldThrow: new TerminalToolError(
        "COMMAND_DENIED",
        "Command is not in the allowlist.",
      ),
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

  it("A4 — applies Layer-2 redaction to stdout and stderr in the POST response", async () => {
    // A fake redactor that replaces any occurrence of "SECRET-VALUE" with "[REDACTED]".
    const secretRedactor = (value: unknown): unknown => {
      if (typeof value === "string") {
        return value.replaceAll("SECRET-VALUE", "[REDACTED]");
      }
      if (typeof value === "object" && value !== null) {
        const result: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) {
          result[k] = secretRedactor(v);
        }
        return result;
      }
      return value;
    };
    const localTerminal = new FakeTerminalExecutionManager({
      executeResult: {
        executionId: "e-redact",
        exitCode: 0,
        stdout: "output contains SECRET-VALUE here",
        stderr: "error SECRET-VALUE trace",
        durationMs: 1,
        truncated: false,
        timedOut: false,
      },
    });
    deps = { ...deps, terminal: localTerminal, redactor: secretRedactor };
    await closeServer();
    const rebuilt = await buildServer(deps);
    server = rebuilt.server;
    port = rebuilt.port;
    const res = await fetch(`${baseUrl()}/api/terminal/executions`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ projectId: workspaceRoot, command: "ls", args: [] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stdout: string; stderr: string };
    expect(body.stdout).not.toContain("SECRET-VALUE");
    expect(body.stdout).toContain("[REDACTED]");
    expect(body.stderr).not.toContain("SECRET-VALUE");
    expect(body.stderr).toContain("[REDACTED]");
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

// KEIKO-0142: terminal-routes hand-rolled the write+destroy backpressure check instead of the
// shared writeOrDestroy helper, so it had no per-connection AbortController, no unsubscribe on a
// backpressure kill, and no observable signal — a slow-client termination was indistinguishable
// from an intentional cancel. Mirrors command-runner-routes.test.ts's already-migrated block.
interface FakeSseRes {
  res: ServerResponse;
  readonly writes: string[];
  destroyCount: number;
  writeReturns: boolean;
  readonly emitClose: () => void;
}

function makeFakeSseRes(): FakeSseRes {
  const writes: string[] = [];
  const emitter = new EventEmitter();
  const state: FakeSseRes = {
    res: undefined as unknown as ServerResponse,
    writes,
    destroyCount: 0,
    writeReturns: true,
    emitClose: (): void => {
      emitter.emit("close");
    },
  };
  const res = {
    writeHead(): ServerResponse {
      return res as unknown as ServerResponse;
    },
    write(chunk: string): boolean {
      writes.push(chunk);
      return state.writeReturns;
    },
    end(): ServerResponse {
      return res as unknown as ServerResponse;
    },
    destroy(): void {
      state.destroyCount += 1;
    },
    on(event: string, listener: (...args: unknown[]) => void): ServerResponse {
      emitter.on(event, listener);
      return res as unknown as ServerResponse;
    },
  };
  state.res = res as unknown as ServerResponse;
  return state;
}

describe("openTerminalSseStream backpressure (KEIKO-0142)", () => {
  it("aborts, unsubscribes, destroys once, and signals when res.write returns false", () => {
    const fake = makeFakeSseRes();
    const manager = new FakeTerminalExecutionManager();
    const signals: SseBackpressureSignal[] = [];
    fake.writeReturns = false;
    openTerminalSseStream(
      fake.res,
      manager,
      (value) => value,
      (signal) => {
        signals.push(signal);
      },
    );

    manager.emitExternal({
      kind: "execution-completed",
      executionId: "exec-bp",
      payload: { exitCode: 0, durationMs: 1, truncated: false, timedOut: false },
    } as unknown as TerminalEventEnvelope);

    expect(fake.destroyCount).toBe(1);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.accepted).toBe(false);
    expect(signals[0]?.frameBytes).toBeGreaterThan(0);

    // The abort unsubscribed, so a second event produces no further writes or destroys.
    const writesAfterKill = fake.writes.length;
    manager.emitExternal({
      kind: "execution-completed",
      executionId: "exec-bp-2",
      payload: { exitCode: 0, durationMs: 1, truncated: false, timedOut: false },
    } as unknown as TerminalEventEnvelope);
    expect(fake.writes).toHaveLength(writesAfterKill);
    expect(fake.destroyCount).toBe(1);
    expect(signals).toHaveLength(1);

    // close firing after an abort-driven unsubscribe must not double-unsubscribe or throw.
    expect(() => {
      fake.emitClose();
    }).not.toThrow();
  });

  it("protects the ready frame itself, not just later events (KEIKO-0142)", () => {
    // The ready frame is written before any manager event. If it is rejected and bypasses
    // writeOrDestroy, the subscription stays live on a socket that is already not draining.
    const fake = makeFakeSseRes();
    const manager = new FakeTerminalExecutionManager();
    const signals: SseBackpressureSignal[] = [];
    fake.writeReturns = false;
    openTerminalSseStream(
      fake.res,
      manager,
      (value) => value,
      (signal) => {
        signals.push(signal);
      },
    );

    // Destroyed and signalled immediately, with no manager event required.
    expect(fake.destroyCount).toBe(1);
    expect(signals).toHaveLength(1);
  });

  it("kills on an event frame when the ready frame was accepted (KEIKO-0142)", () => {
    // The complementary path: ready frame accepted, a later event frame rejected.
    const fake = makeFakeSseRes();
    const manager = new FakeTerminalExecutionManager();
    const signals: SseBackpressureSignal[] = [];
    openTerminalSseStream(
      fake.res,
      manager,
      (value) => value,
      (signal) => {
        signals.push(signal);
      },
    );
    expect(fake.destroyCount).toBe(0);

    fake.writeReturns = false;
    manager.emitExternal({
      kind: "execution-completed",
      executionId: "exec-late",
      payload: { exitCode: 0, durationMs: 1, truncated: false, timedOut: false },
    } as unknown as TerminalEventEnvelope);

    expect(fake.destroyCount).toBe(1);
    expect(signals).toHaveLength(1);
  });

  it("keeps the normal write path intact when res.write returns true", () => {
    const fake = makeFakeSseRes();
    const manager = new FakeTerminalExecutionManager();
    const signals: SseBackpressureSignal[] = [];
    openTerminalSseStream(
      fake.res,
      manager,
      (value) => value,
      (signal) => {
        signals.push(signal);
      },
    );

    manager.emitExternal({
      kind: "execution-completed",
      executionId: "exec-ok",
      payload: { exitCode: 0, durationMs: 1, truncated: false, timedOut: false },
    } as unknown as TerminalEventEnvelope);

    expect(fake.destroyCount).toBe(0);
    expect(signals).toHaveLength(0);
    expect(fake.writes.length).toBeGreaterThan(1);
  });
});

// Finding 0 (#2902 audit): the request-scoped correlationId never reached the terminal
// `sse.stream.closed` line because openTerminalSseStream had no parameter to receive it, even
// though handleTerminalEvents' RouteContext carries one. The heartbeat is the first write on
// every stream (sse-write.ts's per-stream state is set-once-wins), so threading it through the
// heartbeat's backpressure object is sufficient for the whole stream's terminal line.
describe("openTerminalSseStream correlationId threading (#2902 audit finding 0)", () => {
  afterEach(() => {
    resetServerLogger();
  });

  it("attaches the supplied correlationId to the sse.stream.closed terminal line", () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const fake = makeFakeSseRes();
    const manager = new FakeTerminalExecutionManager();

    openTerminalSseStream(fake.res, manager, (value) => value, undefined, "corr-terminal-1");
    fake.emitClose();

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      op: "sse.stream.closed",
      correlationId: "corr-terminal-1",
    });
  });

  it("omits correlationId from the terminal line when none is supplied (unchanged behavior)", () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const fake = makeFakeSseRes();
    const manager = new FakeTerminalExecutionManager();

    openTerminalSseStream(fake.res, manager, (value) => value);
    fake.emitClose();

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.correlationId).toBeUndefined();
  });
});

describe("handleTerminalEvents backpressure correlation (ADR-0173 D5 / g12)", () => {
  it("threads the request's own correlation id into the backpressure diagnostic instead of minting one", () => {
    const fake = makeFakeSseRes();
    fake.writeReturns = false; // rejects the ready frame -> immediate backpressure kill.
    const manager = new FakeTerminalExecutionManager();
    const records: ServerDiagnosticRecord[] = [];
    const diagnostics: ServerDiagnosticSink = {
      record: (entry) => {
        records.push(entry);
      },
    };
    const ctx: RouteContext = {
      req: { on: (): void => undefined } as unknown as RouteContext["req"],
      res: fake.res,
      params: {},
      url: new URL("http://127.0.0.1/api/terminal/events"),
      correlationId: "req-terminal-thread-01",
    };
    const routeDeps: UiHandlerDeps = { ...deps, terminal: manager, diagnostics };

    handleTerminalEvents(ctx, routeDeps);

    expect(records).toHaveLength(1);
    expect(records[0]?.source).toBe("sse.terminal.backpressure");
    expect(records[0]?.correlationId).toBe("req-terminal-thread-01");
  });
});
