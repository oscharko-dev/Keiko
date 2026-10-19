import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startObservedBff } from "../testing/chat-skills-lab/runtime.mjs";

const ports = vi.hoisted(() => ({ fork: vi.fn(), session: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original()),
  fork: ports.fork,
}));
vi.mock("../testing/coding-workbench-lab/lab-common.mjs", async (original) => ({
  ...(await original()),
  openApiSession: ports.session,
}));
vi.mock("node:timers", () => ({
  setTimeout: (...args) => globalThis.setTimeout(...args),
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
}));

let directory, child, proxy, forked;
const originalFailure = new Error("synthetic-session-refusal");
const cleanupFailure = new Error("synthetic-cleanup-refusal");

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "keiko-skill-lifecycle-"));
  child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null });
  child.kill = vi.fn(() => {
    globalThis.queueMicrotask(() => {
      child.exitCode = 0;
      child.emit("exit", 0, null);
    });
    return true;
  });
  proxy = {
    address: () => ({ port: 1 }),
    close: vi.fn((done) => done()),
    closeAllConnections: vi.fn(),
  };
  forked = Promise.withResolvers();
  ports.fork.mockImplementation(() => {
    forked.resolve();
    return child;
  });
  ports.session.mockResolvedValue({ request: vi.fn() });
});

afterEach(() => {
  child.exitCode = 0;
  child.emit("exit", 0, null);
  vi.useRealTimers();
  vi.clearAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function start() {
  return startObservedBff(
    directory,
    proxy,
    { key: "synthetic", served: { max_output_tokens: 8192 } },
    131072,
  );
}

async function readyRuntime() {
  const attempt = start();
  await forked.promise;
  child.emit("message", { kind: "ready", port: 1 });
  return attempt;
}

describe("Chat skill lab owns process startup and resource cleanup", () => {
  it("waits for owned normal termination before completing cleanup", async () => {
    const runtime = await readyRuntime();
    await runtime.close();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(proxy.close).toHaveBeenCalledOnce();
    expect(proxy.closeAllConnections).toHaveBeenCalledOnce();
  });

  it("does not wait again for a child already terminated by a signal", async () => {
    const runtime = await readyRuntime();
    child.signalCode = "SIGABRT";
    child.emit("exit", null, "SIGABRT");
    const completion = runtime.close();
    await Promise.resolve();
    expect(child.kill).not.toHaveBeenCalled();
    await completion;
    expect(proxy.close).toHaveBeenCalledOnce();
  });

  it("preserves a session startup refusal while closing both resources", async () => {
    ports.session.mockRejectedValue(originalFailure);
    await expect(readyRuntime()).rejects.toBe(originalFailure);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(proxy.close).toHaveBeenCalledOnce();
  });

  it("retains startup and synchronous stop failures together", async () => {
    ports.session.mockRejectedValue(originalFailure);
    child.kill.mockImplementation(() => {
      throw cleanupFailure;
    });
    const error = await readyRuntime().catch((failure) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([originalFailure, cleanupFailure]);
    expect(error.cause).toBe(originalFailure);
    expect(proxy.close).toHaveBeenCalledOnce();
  });

  it("still closes the proxy when stopping the child throws", async () => {
    const runtime = await readyRuntime();
    child.kill.mockImplementation(() => {
      throw cleanupFailure;
    });
    await expect(runtime.close()).rejects.toBe(cleanupFailure);
    expect(proxy.close).toHaveBeenCalledOnce();
  });

  it("owns an asynchronous spawn error without requiring an exit event", async () => {
    const attempt = start().catch((error) => error);
    await forked.promise;
    child.pid = undefined;
    child.exitCode = -11;
    expect(() => child.emit("error", originalFailure)).not.toThrow();
    expect(await attempt).toBe(originalFailure);
    expect(child.kill).not.toHaveBeenCalled();
    expect(proxy.close).toHaveBeenCalledOnce();
  });

  it("owns a stop error event and still attempts proxy cleanup", async () => {
    const runtime = await readyRuntime();
    child.kill.mockImplementation(() => true);
    const completion = runtime.close().catch((error) => error);
    expect(() => child.emit("error", cleanupFailure)).not.toThrow();
    expect(await completion).toBe(cleanupFailure);
    expect(proxy.close).toHaveBeenCalledOnce();
  });

  it("removes startup listeners and the unchanged readiness deadline after success", async () => {
    vi.useFakeTimers();
    const runtime = await readyRuntime();
    expect(vi.getTimerCount()).toBe(0);
    expect(child.listenerCount("message")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
    await runtime.close();
  });

  it("clears the original readiness deadline after an early child failure", async () => {
    vi.useFakeTimers();
    const attempt = start().catch((error) => error);
    await forked.promise;
    child.exitCode = -11;
    child.emit("error", originalFailure);
    expect(await attempt).toBe(originalFailure);
    expect(vi.getTimerCount()).toBe(0);
    expect(child.listenerCount("message")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
  });

  it("retains the original readiness timeout and still cleans both resources", async () => {
    vi.useFakeTimers();
    const attempt = start().catch((error) => error);
    await forked.promise;
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(45000);
    expect(await attempt).toMatchObject({ message: "bff-start-timeout" });
    expect(child.kill).toHaveBeenCalledOnce();
    expect(proxy.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses exit before readiness without waiting for the deadline", async () => {
    const attempt = start().catch((error) => error);
    await forked.promise;
    child.exitCode = 1;
    child.emit("exit", 1, null);
    expect(await attempt).toMatchObject({ message: "bff-start-failed" });
    expect(child.kill).not.toHaveBeenCalled();
    expect(proxy.close).toHaveBeenCalledOnce();
  });

  it("preserves startup and asynchronous stop failures together", async () => {
    const stopping = Promise.withResolvers();
    ports.session.mockRejectedValue(originalFailure);
    child.kill.mockImplementation(() => {
      stopping.resolve();
      return true;
    });
    const attempt = readyRuntime().catch((error) => error);
    await stopping.promise;
    expect(() => child.emit("error", cleanupFailure)).not.toThrow();
    const error = await attempt;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([originalFailure, cleanupFailure]);
    expect(error.cause).toBe(originalFailure);
    expect(proxy.close).toHaveBeenCalledOnce();
  });

  it("refuses a child error observed while opening the session", async () => {
    const opening = Promise.withResolvers(),
      session = Promise.withResolvers();
    ports.session.mockImplementation(() => {
      opening.resolve();
      return session.promise;
    });
    const attempt = readyRuntime().catch((error) => error);
    await opening.promise;
    expect(() => child.emit("error", originalFailure)).not.toThrow();
    session.resolve({ request: vi.fn() });
    expect(await attempt).toBe(originalFailure);
    expect(proxy.close).toHaveBeenCalledOnce();
  });

  it("retains independent child and proxy cleanup failures", async () => {
    const proxyFailure = new Error("synthetic-proxy-refusal");
    const runtime = await readyRuntime();
    child.kill.mockImplementation(() => {
      throw cleanupFailure;
    });
    proxy.close.mockImplementation((done) => done(proxyFailure));
    const error = await runtime.close().catch((failure) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([cleanupFailure, proxyFailure]);
    expect(proxy.closeAllConnections).toHaveBeenCalledOnce();
  });

  it("does not lose a synchronous connection cleanup failure after the close callback", async () => {
    const runtime = await readyRuntime();
    proxy.closeAllConnections.mockImplementation(() => {
      throw cleanupFailure;
    });
    await expect(runtime.close()).rejects.toBe(cleanupFailure);
    expect(proxy.close).toHaveBeenCalledOnce();
  });

  it("closes the proxy after environment preparation refuses without creating a child", async () => {
    const prepare = vi.fn(async () => {
      throw originalFailure;
    });
    await expect(startObservedBff(directory, proxy, {}, 131072, prepare)).rejects.toBe(
      originalFailure,
    );
    expect(ports.fork).not.toHaveBeenCalled();
    expect(proxy.close).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledExactlyOnceWith(directory, 1, {}, 131072);
  });

  it("closes the proxy after synchronous fork failure", async () => {
    ports.fork.mockImplementation(() => {
      throw originalFailure;
    });
    await expect(start()).rejects.toBe(originalFailure);
    expect(child.kill).not.toHaveBeenCalled();
    expect(proxy.close).toHaveBeenCalledOnce();
  });

  it("preserves a caller's environment and configuration limits through the shared owner", async () => {
    const env = { SYNTHETIC_GRANT: "131072" };
    const prepare = vi.fn(async () => ({ project: directory, env }));
    const attempt = startObservedBff(directory, proxy, {}, 131072, prepare);
    await forked.promise;
    child.emit("message", { kind: "ready", port: 1 });
    const runtime = await attempt;
    expect(runtime.env).toBe(env);
    expect(ports.fork.mock.calls[0][2].env).toBe(env);
    expect(ports.session).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:1", env);
    await runtime.close();
  });

  it("surfaces a lifetime error after successful startup even when stop succeeds", async () => {
    const runtime = await readyRuntime();
    expect(() => child.emit("error", originalFailure)).not.toThrow();
    await expect(runtime.close()).rejects.toBe(originalFailure);
    expect(proxy.close).toHaveBeenCalledOnce();
  });

  it("preserves a late lifetime error and a different stop error together", async () => {
    const runtime = await readyRuntime();
    child.emit("error", originalFailure);
    child.kill.mockImplementation(() => {
      throw cleanupFailure;
    });
    const error = await runtime.close().catch((failure) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([originalFailure, cleanupFailure]);
    expect(proxy.close).toHaveBeenCalledOnce();
  });
});
