import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listenProxy, MODEL, startRuntime } from "../testing/chat-skills-lab/runtime.mjs";

const ports = vi.hoisted(() => ({ proxy: vi.fn(), fork: vi.fn(), session: vi.fn() }));
vi.mock("../testing/coding-workbench-lab/chaos-proxy.mjs", async (original) => ({
  ...(await original()),
  createChaosProxy: ports.proxy,
}));
vi.mock("node:child_process", async (original) => ({ ...(await original()), fork: ports.fork }));
vi.mock("../testing/coding-workbench-lab/lab-common.mjs", async (original) => ({
  ...(await original()),
  openApiSession: ports.session,
}));

let directory, proxy, listening, callback, child, runtime;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "keiko-proxy-startup-"));
  listening = Promise.withResolvers();
  proxy = Object.assign(new EventEmitter(), {
    address: () => ({ port: 1 }),
    close: vi.fn((done) => done()),
    closeAllConnections: vi.fn(),
    listen: vi.fn((_port, _host, done) => {
      callback = done;
      listening.resolve();
    }),
  });
  ports.proxy.mockReturnValue(proxy);
  child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null });
  child.kill = () => {
    child.exitCode = 0;
    child.emit("exit", 0, null);
    return true;
  };
  ports.fork.mockImplementation(() => {
    globalThis.queueMicrotask(() => child.emit("message", { kind: "ready", port: 1 }));
    return child;
  });
  ports.session.mockResolvedValue({ request: vi.fn() });
  vi.stubEnv("KEIKO_SKILL_LAB_API_KEY", "synthetic");
  vi.stubEnv("KEIKO_SKILL_LAB_BASE_URL", "http://127.0.0.1:1");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      json: async () => ({
        data: [
          {
            model_name: MODEL,
            model_info: { context_window: 131072, max_output_tokens: 8192 },
          },
        ],
      }),
    })),
  );
});

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function construction(physical = []) {
  const attempt = startRuntime(directory, { physicalRecorder: physical });
  return attempt.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
}

async function settle(attempt) {
  return Promise.race([attempt, nextTurn().then(() => ({ status: "pending" }))]);
}

function emitError(error) {
  try {
    proxy.emit("error", error);
    return undefined;
  } catch (unhandled) {
    return unhandled;
  }
}

describe("skill lab proxy startup owns its error channel", () => {
  it("starts the BFF only after listening and releases the startup listener", async () => {
    const attempt = construction();
    await listening.promise;
    expect(ports.fork).not.toHaveBeenCalled();
    callback();
    const result = await attempt;
    expect(result.status).toBe("fulfilled");
    runtime = result.value;
    expect(ports.fork).toHaveBeenCalledOnce();
  });

  it("rejects the original asynchronous bind error before BFF construction", async () => {
    const physical = [],
      failure = new Error("synthetic-bind-refusal");
    const attempt = construction(physical);
    await listening.promise;
    expect(emitError(failure)).toBeUndefined();
    expect(await settle(attempt)).toEqual({ status: "rejected", reason: failure });
    expect(ports.fork).not.toHaveBeenCalled();
    expect(physical).toEqual([{ caseId: "setup", error: "proxy-server-failed" }]);
  });

  it("keeps a late callback from constructing a BFF after startup refuses", async () => {
    const failure = new Error("synthetic-bind-refusal"),
      attempt = construction();
    await listening.promise;
    emitError(failure);
    callback();
    expect(await settle(attempt)).toEqual({ status: "rejected", reason: failure });
    expect(ports.fork).not.toHaveBeenCalled();
  });

  it("retains repeated server errors without an unhandled event", async () => {
    const physical = [],
      first = new Error("first"),
      second = new Error("second");
    const attempt = construction(physical);
    await listening.promise;
    expect(emitError(first)).toBeUndefined();
    expect(emitError(second)).toBeUndefined();
    expect(await settle(attempt)).toEqual({ status: "rejected", reason: first });
    expect(proxy.listenerCount("error")).toBe(1);
    expect(physical).toHaveLength(2);
  });

  it("preserves a synchronous listen refusal", async () => {
    const failure = new Error("synthetic-listen-throw");
    proxy.listen.mockImplementation(() => {
      throw failure;
    });
    expect(await construction()).toEqual({ status: "rejected", reason: failure });
    expect(ports.fork).not.toHaveBeenCalled();
  });

  it("records lifetime server failures against the current scope without raw errors", async () => {
    const physical = [],
      attempt = construction(physical);
    await listening.promise;
    callback();
    const result = await attempt;
    runtime = result.value;
    runtime.setActive("synthetic-later-case");
    expect(emitError(new Error("synthetic-private-detail"))).toBeUndefined();
    expect(physical).toEqual([{ caseId: "synthetic-later-case", error: "proxy-server-failed" }]);
    expect(JSON.stringify(physical)).not.toContain("synthetic-private-detail");
  });
});

describe("actual loopback listener startup", () => {
  it("starts on a fixture-owned ephemeral port and removes its startup handler", async () => {
    const server = createServer();
    const initialListeningHandlers = server.listenerCount("listening");
    try {
      await listenProxy(server);
      expect(server.listening).toBe(true);
      expect(server.address().port).toBeGreaterThan(0);
      expect(server.listenerCount("error")).toBe(0);
      expect(server.listenerCount("listening")).toBe(initialListeningHandlers);
    } finally {
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    }
  });

  it("rejects the actual original EADDRINUSE error and preserves the existing listener", async () => {
    const blocker = createServer(),
      server = createServer();
    const initialListeningHandlers = server.listenerCount("listening");
    try {
      await listenProxy(blocker);
      const originalListen = server.listen.bind(server),
        error = Promise.withResolvers();
      server.once("error", error.resolve);
      server.listen = (_port, host, done) => originalListen(blocker.address().port, host, done);
      const attempt = listenProxy(server).then(
        () => ({ status: "fulfilled" }),
        (reason) => ({ status: "rejected", reason }),
      );
      const observed = await error.promise;
      expect(observed.code).toBe("EADDRINUSE");
      expect(await attempt).toEqual({ status: "rejected", reason: observed });
      expect(server.listening).toBe(false);
      expect(server.listenerCount("error")).toBe(0);
      expect(server.listenerCount("listening")).toBe(initialListeningHandlers);
      expect(blocker.listening).toBe(true);
    } finally {
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      if (blocker.listening) await new Promise((resolve) => blocker.close(resolve));
    }
  });
});
