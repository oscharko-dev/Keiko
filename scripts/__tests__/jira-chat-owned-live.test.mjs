import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOwnedLiveChatProcess,
  runOwnedLiveChatLifecycle,
} from "../testing/jira-chat-lab/owned-live-chat.mjs";
import { request, jsonRequest } from "../testing/jira-chat-lab/chat-read.mjs";

const ENTRY = fileURLToPath(new URL("./support/jira-owned-live-child.mjs", import.meta.url));
const owners = [];
const directories = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(owners.splice(0).map((owner) => owner.close()));
  for (const directory of directories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

async function unusedPort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function ownerOptions(mode = "normal") {
  const stateDir = mkdtempSync(join(tmpdir(), "owned-jira-live-child-"));
  directories.push(stateDir);
  return {
    entry: ENTRY,
    port: await unusedPort(),
    initialization: { stateDir, mode },
    environment: { ...process.env, KEIKO_OS_KEYCHAIN: "on" },
    startTimeoutMs: mode === "never-ready" ? 500 : 3000,
    stopTimeoutMs: 300,
    healthTimeoutMs: 500,
  };
}

async function ownerFixture(mode, overrides = {}) {
  const options = { ...(await ownerOptions(mode)), ...overrides };
  const owner = createOwnedLiveChatProcess(options);
  owners.push(owner);
  return { owner, options, trace: join(options.initialization.stateDir, "trace.json") };
}

function events(trace) {
  return JSON.parse(readFileSync(trace, "utf8"));
}

async function waitForFile(path) {
  const deadline = Date.now() + 3000;
  while (!existsSync(path) && Date.now() < deadline) await delay(10);
  expect(existsSync(path)).toBe(true);
}

describe("owned Jira Chat server process", () => {
  it("crashes exactly its own child, preserves the same state and waits for new health", async () => {
    const { owner, options, trace } = await ownerFixture();
    await owner.start();
    const originalOrigin = owner.origin;
    writeFileSync(
      join(options.initialization.stateDir, "retained-state.json"),
      JSON.stringify({ committed: 7 }),
    );
    const result = await owner.restart({ signal: new globalThis.AbortController().signal });
    expect(result).toEqual({ restarted: true, downtimeMs: expect.any(Number) });
    expect(result.downtimeMs).toBeGreaterThanOrEqual(0);
    expect(owner.origin).toBe(originalOrigin);
    expect(owner.status()).toEqual({ phase: "ready", generation: 2, running: true });
    const started = events(trace).filter((event) => event.kind === "started");
    expect(started).toHaveLength(2);
    expect(
      started.map(({ restoring, committed, keychain }) => ({ restoring, committed, keychain })),
    ).toEqual([
      { restoring: false, committed: 3, keychain: "off" },
      { restoring: true, committed: 7, keychain: "off" },
    ]);
    expect(started[0].instance).not.toBe(started[1].instance);
    expect(events(trace).filter(({ kind }) => kind === "stopped")).toEqual([]);
    const health = await globalThis.fetch(`${owner.origin}/api/health`);
    expect(await health.json()).toEqual({ status: "ok", committed: 7 });
    expect(JSON.stringify(owner)).toBe("{}");
  });

  it("rejects every caller-supplied process identity before signalling a healthy owned child", async () => {
    const { owner, options, trace } = await ownerFixture();
    expect(() => createOwnedLiveChatProcess({ ...options, pid: process.pid })).toThrow(
      "owned-lab-invalid-options",
    );
    await owner.start();
    await expect(owner.restart({ pid: process.pid })).rejects.toThrow("owned-lab-invalid-options");
    expect(owner.status()).toEqual({ phase: "ready", generation: 1, running: true });
    expect(events(trace)).toHaveLength(1);
  });

  it("serializes restart ownership and closes the running child exactly once", async () => {
    const { owner, trace } = await ownerFixture();
    await owner.start();
    const first = owner.restart();
    await expect(owner.restart()).rejects.toThrow("owned-lab-operation-unavailable");
    await first;
    await Promise.all([owner.close(), owner.close()]);
    expect(owner.status()).toEqual({ phase: "closed", generation: 2, running: false });
    expect(events(trace).filter(({ kind }) => kind === "stopped")).toHaveLength(1);
    await expect(owner.restart()).rejects.toThrow("owned-lab-operation-unavailable");
  });

  it("latches a closed audit failure before SIGKILL and never resets it for another generation", async () => {
    const { owner, trace } = await ownerFixture();
    await owner.start();
    await globalThis.fetch(`${owner.origin}/emit-audit-failure`);
    const deadline = Date.now() + 3000;
    while (!owner.status().failure && Date.now() < deadline) await delay(10);
    expect(owner.status().failure).toBe("activity-log-unavailable");
    await expect(owner.restart()).rejects.toThrow("owned-lab-activity-log-unavailable");
    expect(owner.status().generation).toBe(1);
    expect(events(trace).filter(({ kind }) => kind === "started")).toHaveLength(1);
    await expect(owner.close()).rejects.toThrow("owned-lab-activity-log-unavailable");
    expect(owner.status()).toMatchObject({ running: false, failure: "activity-log-unavailable" });
  });

  it("does not mistake a foreign listener's healthy response for its own ready child", async () => {
    const { owner, options } = await ownerFixture();
    let healthCalls = 0;
    const foreign = createHttpServer((_request, response) => {
      healthCalls += 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
    });
    await new Promise((resolve) => foreign.listen(options.port, "127.0.0.1", resolve));
    try {
      await expect(owner.start()).rejects.toThrow("owned-lab-start-exited");
      expect(owner.status().running).toBe(false);
      expect(foreign.listening).toBe(true);
      expect(healthCalls).toBe(0);
    } finally {
      await new Promise((resolve) => foreign.close(resolve));
    }
  });

  it.each([
    ["bad-ready", "owned-lab-invalid-readiness", "owned-lab-ipc-contract-failed"],
    ["early-exit", "owned-lab-start-exited", undefined],
    ["bad-health", "owned-lab-health-timeout", undefined],
    ["never-ready", "owned-lab-start-timeout", undefined],
  ])("refuses %s without retaining an uncontrolled child", async (mode, reason, cleanupFailure) => {
    const { owner } = await ownerFixture(mode);
    await expect(owner.start()).rejects.toThrow(reason);
    expect(owner.status()).toMatchObject({ phase: "failed", running: false });
    if (cleanupFailure) {
      await expect(owner.close()).rejects.toThrow(cleanupFailure);
      expect(owner.status().phase).toBe("failed");
    } else {
      await owner.close();
      expect(owner.status().phase).toBe("closed");
    }
  });

  it("cancels in-flight readiness and reaps only the owned child", async () => {
    const { owner, trace } = await ownerFixture("never-ready", { startTimeoutMs: 3000 });
    const controller = new globalThis.AbortController();
    const attempt = owner.start({ signal: controller.signal }).catch((error) => error);
    await waitForFile(trace);
    controller.abort();
    expect(await attempt).toMatchObject({ message: "owned-lab-cancelled" });
    expect(owner.status().running).toBe(false);
  });

  it("forces bounded cleanup but preserves its failed shutdown outcome", async () => {
    const { owner } = await ownerFixture("ignore-term");
    await owner.start();
    await expect(owner.close()).rejects.toThrow("owned-lab-forced-cleanup");
    expect(owner.status().running).toBe(false);
  });

  it("preserves a child shutdown or evidence failure instead of calling cleanup successful", async () => {
    const { owner } = await ownerFixture("fail-close");
    await owner.start();
    await expect(owner.close()).rejects.toThrow("owned-lab-cleanup-failed");
    expect(owner.status()).toMatchObject({ phase: "failed", running: false });
  });
});

describe("owned live Chat finalization and error privacy", () => {
  it("attempts cleanup and closing license audit after a failed run and preserves all failures", async () => {
    const runFailure = new TypeError("synthetic-run-failure");
    const closeFailure = new TypeError("synthetic-close-failure");
    const auditFailure = new TypeError("synthetic-license-failure");
    const run = vi.fn(() => Promise.reject(runFailure));
    const close = vi.fn(() => {
      throw closeFailure;
    });
    const audit = vi.fn(() => Promise.reject(auditFailure));
    const failure = await runOwnedLiveChatLifecycle({ run, close, audit }).catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toEqual([runFailure, closeFailure, auditFailure]);
    expect(run).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledOnce();
  });

  it("keeps the original run refusal when cleanup and license audit complete", async () => {
    const failure = new TypeError("synthetic-start-or-pair-failure");
    const close = vi.fn();
    const audit = vi.fn();
    await expect(
      runOwnedLiveChatLifecycle({
        run: () => Promise.reject(failure),
        close,
        audit,
      }),
    ).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledOnce();
  });

  it("logs only bounded status and a closed class for parent request and JSON request failures", async () => {
    const json = vi.fn(() =>
      Promise.resolve({
        error: {
          code: "synthetic-secret-code",
          message: "https://private.example.invalid/synthetic-secret",
        },
      }),
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, status: 403, json });
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(
      request("http://127.0.0.1:1", "", "private-stage", "/private-path", {}),
    ).rejects.toThrow("Live Chat HTTP stage failed");
    await expect(
      jsonRequest("http://127.0.0.1:1", "", "private-stage", "/private-path", {}),
    ).rejects.toThrow("Live Chat HTTP stage failed");
    expect(logged.mock.calls.map(([line]) => JSON.parse(line))).toEqual(
      Array.from({ length: 2 }, () => ({
        operation: "jira-chat-live-http",
        stage: "request-failed",
        status: 403,
        failureClass: "http-status",
      })),
    );
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/private|secret|https|code|message/u);
    expect(json).not.toHaveBeenCalled();
  });
});
