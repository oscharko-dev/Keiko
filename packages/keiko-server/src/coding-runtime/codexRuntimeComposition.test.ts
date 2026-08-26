import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  KEIKO_PRODUCT_VERSION,
  type CodingWorkbenchCodexSubscriptionProfile,
} from "@oscharko-dev/keiko-contracts";

import {
  createCodexAuthNavigationIntentCoordinator,
  type CodexSubscriptionProfileCoordinator,
} from "../coding-codex-subscription.js";
import type { CodexAppServerScheduler } from "./codexAppServerClient.js";
import {
  createCodexRuntimeComposition,
  type CodexRuntimeCompositionInput,
} from "./codexRuntimeComposition.js";
import type { CodingToolFacade } from "./codingToolFacadePorts.js";
import type { CodingToolResult } from "./codingToolIpc.js";
import type { RuntimeProcessTree } from "./runtimeProcessSupervisor.js";

/* eslint-disable @typescript-eslint/explicit-function-return-type -- harness inference keeps tests compact. */

const signal = new AbortController().signal;
const options = { timeoutMs: 1_000 } as const;

describe("Codex runtime composition", () => {
  it("qualifies the pinned identity, inspects a closed profile, and securely prepares supplied state", async () => {
    const harness = createHarness();
    await expect(
      harness.composition.lifecycle.qualify({ runId: "run-1", signal, timeoutMs: 1_000 }),
    ).resolves.toEqual({ ok: true });
    expect(harness.input.qualification.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        version: "0.144.1",
        digest: "05463d8615d2a277cf3be6ee15a84398c5e2ce2307b93415602499dc3e07880a",
        algorithm: "keiko-codex-schema-bundle-v1",
      }),
    );
    await expect(
      harness.composition.lifecycle.inspectProfile({ runId: "run-1", signal, timeoutMs: 1_000 }),
    ).resolves.toEqual({ ok: true });
    await expect(prepare(harness)).resolves.toEqual({ ok: true, stateRoot: "/state/run-1" });
    expect(harness.input.prepareSecureStateRoot).toHaveBeenCalledWith({
      runId: "run-1",
      stateRoot: "/state/run-1",
      signal,
    });
  });

  it("initializes closed capabilities, notifies initialized, and reads account before ready", async () => {
    const harness = createHarness();
    await prepare(harness);
    const attachment = await attach(harness);
    expect(attachment.ok).toBe(true);
    expect(harness.methods.slice(0, 4)).toEqual([
      "initialize",
      "initialized",
      "account/read",
      "ready",
    ]);
    expect(harness.frames[0]).toMatchObject({
      method: "initialize",
      params: {
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
          mcpServerOpenaiFormElicitation: false,
          optOutNotificationMethods: [],
        },
      },
    });
  });

  it("announces the product version to the sidecar rather than a restated literal", async () => {
    const harness = createHarness();
    await prepare(harness);
    await attach(harness);
    expect(harness.frames[0]).toMatchObject({
      method: "initialize",
      params: { clientInfo: { name: "keiko", version: KEIKO_PRODUCT_VERSION } },
    });
  });

  it("accepts bounded cross-platform initialize user agents and denies empty or oversized values", async () => {
    for (const userAgent of [
      "keiko/0.144.1 (Mac OS 26.5.1; arm64) unknown (keiko; 0.2.15)",
      "keiko/0.144.1 (Windows NT 10.0; x64) unknown (keiko; 0.2.15)",
    ]) {
      const harness = createHarness(undefined, undefined, userAgent);
      await prepare(harness);
      await expect(attach(harness)).resolves.toMatchObject({ ok: true });
    }

    for (const userAgent of ["", "😀".repeat(16 * 1024 + 1)]) {
      const harness = createHarness(undefined, undefined, userAgent);
      await prepare(harness);
      await expect(attach(harness)).resolves.toEqual({ ok: false });
    }
  });

  it("exposes opaque browser/device auth intents and invalidates their lifecycle", async () => {
    const harness = createHarness((frame) => {
      if (frame.method === "account/login/start" && frame.params?.type === "chatgpt")
        return {
          type: "chatgpt",
          authUrl: "https://auth.openai.com/authorize?transient=1",
          loginId: "login-browser",
        };
      if (frame.method === "account/login/start")
        return {
          type: "chatgptDeviceCode",
          verificationUrl: "https://auth.openai.com/device",
          userCode: "ABCD-EFGH",
          loginId: "login-device",
        };
      if (frame.method === "account/login/cancel") return { status: "canceled" };
      if (frame.method === "account/logout" || frame.method === "turn/interrupt") return {};
      if (frame.method === "thread/start") return threadStartResult("thread-1");
      if (frame.method === "turn/start") return { turn: turn("turn-1", "inProgress") };
      return undefined;
    });
    await prepare(harness);
    await attach(harness);
    await expect(harness.composition.control.startBrowserLogin("run-1", options)).resolves.toEqual({
      ok: true,
      loginId: "login-browser",
      navigation: { nonce: "nonce-1" },
    });
    const device = await harness.composition.control.startDeviceLogin("run-1", options);
    expect(device).toEqual({
      ok: true,
      loginId: "login-device",
      userCode: "ABCD-EFGH",
      navigation: { nonce: "nonce-2" },
    });
    expect(JSON.stringify(device)).not.toContain("https://auth.openai.com/device");
    expect(
      harness.composition.control.consumeNavigation({
        runId: "run-1",
        loginId: "login-browser",
        nonce: "nonce-1",
      }),
    ).toBe("https://auth.openai.com/authorize?transient=1");
    await expect(
      harness.composition.control.cancelLogin("run-1", "login-device", options),
    ).resolves.toEqual({ ok: true });
    await expect(harness.composition.control.logout("run-1", options)).resolves.toEqual({
      ok: true,
    });
    await expect(harness.composition.control.startThread("run-1", options)).resolves.toEqual({
      ok: true,
      threadId: "thread-1",
    });
    await expect(
      harness.composition.control.startTurn("run-1", "thread-1", "private prompt", options),
    ).resolves.toEqual({ ok: true, turnId: "turn-1" });
    await expect(
      harness.composition.control.interruptTurn("run-1", "thread-1", "turn-1", options),
    ).resolves.toEqual({ ok: true });
    expect(harness.coordinator.browserLoginStarted).toHaveBeenCalledOnce();
    expect(harness.coordinator.deviceCodeLoginStarted).toHaveBeenCalledOnce();
    expect(harness.coordinator.loginCancelled).toHaveBeenCalledOnce();
    expect(harness.coordinator.loginClosed).toHaveBeenCalledWith("cancelled");
    expect(harness.coordinator.logout).toHaveBeenCalledOnce();
  });

  it("invalidates navigation state on detach and composition close", async () => {
    const response = (frame: WireFrame): unknown =>
      frame.method === "account/login/start"
        ? {
            type: "chatgpt",
            authUrl: "https://auth.openai.com/authorize?transient=1",
            loginId: "login-1",
          }
        : undefined;
    const detached = createHarness(response);
    await prepare(detached);
    const attachment = await attach(detached);
    if (!attachment.ok) throw new Error("attachment failed");
    const detachedLogin = await detached.composition.control.startBrowserLogin("run-1", options);
    if (!detachedLogin.ok) throw new Error("login failed");
    await expect(attachment.detach()).resolves.toBe(true);
    expect(
      detached.composition.control.consumeNavigation({
        runId: "run-1",
        loginId: "login-1",
        nonce: detachedLogin.navigation.nonce,
      }),
    ).toBeUndefined();

    const closing = createHarness(response);
    await prepare(closing);
    await attach(closing);
    const closingLogin = await closing.composition.control.startBrowserLogin("run-1", options);
    if (!closingLogin.ok) throw new Error("login failed");
    await expect(closing.composition.close()).resolves.toBeUndefined();
    expect(
      closing.composition.control.consumeNavigation({
        runId: "run-1",
        loginId: "login-1",
        nonce: closingLogin.navigation.nonce,
      }),
    ).toBeUndefined();
  });

  it("mediates allowed dynamic tools with run/thread/turn authority and bounded replies", async () => {
    const facade: CodingToolFacade = {
      execute: vi.fn(() =>
        Promise.resolve({
          status: "completed" as const,
          evidence: [],
          read: { text: "safe result", byteCount: 11, digest: "a".repeat(64) },
        }),
      ),
    };
    const harness = createHarness(undefined, facade);
    await prepare(harness);
    await attach(harness);
    harness.stdout.write(
      `${JSON.stringify({
        id: "server-1",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-1",
          tool: "keiko_read",
          arguments: { action: "read", relativePath: "src/a.ts" },
        },
      })}\n`,
    );
    await tick();
    expect(facade.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        body: JSON.stringify({
          action: "read",
          relativePath: "src/a.ts",
          actionId: "call-1",
          idempotencyKey: "run-1:thread-1:turn-1:call-1",
        }),
        capability: "cap:run-1:thread-1:turn-1:keiko_read",
      }),
    );
    expect(harness.frames.at(-1)).toEqual({
      id: "server-1",
      result: {
        success: true,
        contentItems: [{ type: "inputText", text: "safe result" }],
      },
    });
  });

  it("KEIKO-0679: task-submitted event carries the run's injected requestedMode/effectiveMode", async () => {
    const harness = createHarness(undefined, undefined, undefined, undefined, undefined, {
      requestedMode: () => "autonomous-delivery" as const,
      effectiveMode: () => "autonomous-delivery" as const,
    });
    await prepare(harness);
    await attach(harness);
    harness.stdout.write(`${JSON.stringify(turnNotification("turn/started", "inProgress"))}\n`);
    await tick();

    const submitted = harness.events.find((event) => event.kind === "task-submitted");
    expect(submitted).toBeDefined();
    expect(submitted).toMatchObject({
      kind: "task-submitted",
      requestedMode: "autonomous-delivery",
      effectiveMode: "autonomous-delivery",
    });
  });

  it("fails the adapter on built-in methods and maps terminal/delta events monotonically", async () => {
    const harness = createHarness();
    await prepare(harness);
    await attach(harness);
    harness.stdout.write(`${JSON.stringify(turnNotification("turn/started", "inProgress"))}\n`);
    harness.stdout.write(
      `${JSON.stringify({
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "secret" },
      })}\n`,
    );
    harness.stdout.write(`${JSON.stringify(turnNotification("turn/completed", "failed"))}\n`);
    harness.stdout.write(
      `${JSON.stringify({
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "late" },
      })}\n`,
    );
    await tick();
    expect(harness.composition.control.terminalStatus("run-1", "turn-1")).toBe("failed");
    expect(harness.deltas.map((delta) => delta.delta)).toEqual(["secret"]);
    expect(harness.events.map((event) => event.kind)).toEqual([
      "task-submitted",
      "observation-streamed",
      "failure-redacted",
    ]);
    expect(JSON.stringify(harness.events)).not.toContain("secret");

    const denied = createHarness();
    await prepare(denied);
    await attach(denied);
    denied.stdout.write(
      `${JSON.stringify({
        id: 99,
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-1",
          tool: "exec/run",
          arguments: {},
        },
      })}\n`,
    );
    await tick();
    expect(denied.failures).toEqual([["run-1", "protocol-invalid"]]);
  });

  it("obeys cancellation, closes transport on detach, suppresses late frames, and disposes after detach", async () => {
    const harness = createHarness(() => undefined);
    await prepare(harness);
    const attachment = await attach(harness);
    if (!attachment.ok) throw new Error("attachment failed");
    const abort = new AbortController();
    const pending = harness.composition.control.startThread("run-1", {
      signal: abort.signal,
      timeoutMs: 1_000,
    });
    abort.abort();
    await expect(pending).resolves.toEqual({ ok: false, code: "unavailable" });
    expect(harness.composition.lifecycle.dispose("run-1")).toBe(false);
    await expect(attachment.detach()).resolves.toBe(true);
    expect(harness.closed).toBe(true);
    harness.stdout.write(`${JSON.stringify(turnNotification("turn/completed", "completed"))}\n`);
    await tick();
    expect(harness.events).toEqual([]);
    expect(harness.composition.lifecycle.dispose("run-1")).toBe(true);
  });

  it("retires aborted tools before the monotonic interrupt barrier and suppresses late success", async () => {
    let resolveTool: ((result: CodingToolResult) => void) | undefined;
    let toolSignal: AbortSignal | undefined;
    const facade: CodingToolFacade = {
      execute: (input) => {
        toolSignal = input.signal;
        return new Promise<CodingToolResult>((resolve) => {
          resolveTool = resolve;
        });
      },
    };
    const order: string[] = [];
    const harness = createHarness(
      (frame) => {
        if (frame.method === "turn/interrupt") {
          order.push("upstream");
          return {};
        }
        return undefined;
      },
      facade,
      undefined,
      () => {
        order.push("barrier");
        return Promise.resolve(true);
      },
    );
    await prepare(harness);
    await attach(harness);
    harness.stdout.write(
      `${JSON.stringify({
        id: "server-1",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-1",
          tool: "keiko_read",
          arguments: {},
        },
      })}\n`,
    );
    await tick();
    const interruption = harness.composition.control.interruptTurn(
      "run-1",
      "thread-1",
      "turn-1",
      options,
    );
    await tick();
    expect(harness.frames.filter((frame) => frame.id === "server-1")).toEqual([]);
    await expect(interruption).resolves.toEqual({ ok: true });
    expect(order).toEqual(["barrier", "upstream"]);
    expect(toolSignal?.aborted).toBe(true);
    resolveTool?.({ status: "completed", evidence: [] });
    await tick();
    expect(harness.frames.filter((frame) => frame.id === "server-1")).toEqual([]);
  });

  it("retires active calls without writes when a turn terminates or the transport detaches", async () => {
    const facade: CodingToolFacade = {
      execute: () => new Promise<CodingToolResult>(() => undefined),
    };
    const terminal = createHarness(undefined, facade);
    await prepare(terminal);
    await attach(terminal);
    terminal.stdout.write(toolCallNotification("terminal-call"));
    await tick();
    terminal.stdout.write(`${JSON.stringify(turnNotification("turn/completed", "completed"))}\n`);
    await tick();
    expect(terminal.frames.filter((frame) => frame.id === "terminal-call")).toEqual([]);

    const detached = createHarness(undefined, facade);
    await prepare(detached);
    const attachment = await attach(detached);
    if (!attachment.ok) throw new Error("attachment failed");
    detached.stdout.write(toolCallNotification("detach-call"));
    await tick();
    await expect(attachment.detach()).resolves.toBe(true);
    expect(detached.frames.filter((frame) => frame.id === "detach-call")).toEqual([]);
  });

  it("fails closed when the interrupt barrier refuses authority", async () => {
    const harness = createHarness(undefined, undefined, undefined, () => Promise.resolve(false));
    await prepare(harness);
    await attach(harness);
    await expect(
      harness.composition.control.interruptTurn("run-1", "thread-1", "turn-1", options),
    ).resolves.toEqual({ ok: false, code: "unavailable" });
    expect(harness.methods).not.toContain("turn/interrupt");
  });

  it("maps closed auth outcomes without parsing errors and invalidates navigation", async () => {
    const harness = createHarness((frame) => {
      if (frame.method === "account/login/start") {
        return {
          type: "chatgpt",
          authUrl: "https://auth.openai.com/authorize?transient=1",
          loginId: "login-1",
        };
      }
      return undefined;
    });
    await prepare(harness);
    await attach(harness);
    const login = await harness.composition.control.startBrowserLogin("run-1", options);
    if (!login.ok) throw new Error("login failed");
    harness.stdout.write(
      `${JSON.stringify({
        method: "account/login/completed",
        params: { loginId: "login-1", success: false, error: "ignored" },
      })}\n`,
    );
    await tick();
    expect(harness.coordinator.loginClosed).toHaveBeenCalledWith("failed");
    expect(
      harness.composition.control.consumeNavigation({
        runId: "run-1",
        loginId: "login-1",
        nonce: login.navigation.nonce,
      }),
    ).toBeUndefined();
    expect(harness.coordinator.loginClosed).toHaveBeenCalledWith("expired");
    harness.stdout.write(`${JSON.stringify({ method: "account/updated", params: {} })}\n`);
    await tick();
    expect(harness.coordinator.loginClosed).toHaveBeenCalledWith("revoked");
  });

  it("accepts Windows initialize paths with a path-aware codex home", async () => {
    const harness = createHarness(
      undefined,
      undefined,
      "keiko/0.144.1 (Windows NT 10.0; x64) unknown (keiko; 0.2.15)",
      undefined,
      { codexHome: "C:\\state\\run-1\\codex-home", platformFamily: "windows", platformOs: "win32" },
    );
    await expect(
      harness.composition.lifecycle.prepare({
        runId: "run-1",
        stateRoot: "C:\\state\\run-1",
        signal,
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ ok: true, stateRoot: "C:\\state\\run-1" });
    await expect(attach(harness)).resolves.toMatchObject({ ok: true });
  });
});

interface WireFrame {
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

function createHarness(
  response?: (frame: WireFrame) => unknown,
  facade: CodingToolFacade = {
    execute: vi.fn(() =>
      Promise.resolve({ status: "denied", evidence: [] } satisfies CodingToolResult),
    ),
  },
  initializeUserAgent = "keiko/0.144.1 (Mac OS 26.5.1; arm64) unknown (keiko; 0.2.15)",
  interruptBarrier: CodexRuntimeCompositionInput["interruptBarrier"] = () => Promise.resolve(true),
  initialize = {
    codexHome: "/state/run-1/codex-home",
    platformFamily: "unix",
    platformOs: "darwin",
  },
  modeOverrides?: {
    readonly requestedMode?: CodexRuntimeCompositionInput["requestedMode"];
    readonly effectiveMode?: CodexRuntimeCompositionInput["effectiveMode"];
  },
) {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const frames: Record<string, unknown>[] = [];
  const methods: string[] = [];
  const events: Parameters<CodexRuntimeCompositionInput["onRuntimeEvent"]>[0][] = [];
  const deltas: Extract<
    Parameters<NonNullable<CodexRuntimeCompositionInput["onTransientDelta"]>>[0],
    { kind: "delta" }
  >[] = [];
  const failures: [string, string][] = [];
  let closed = false;
  const coordinator = profileCoordinator();
  let nextNonce = 0;
  const navigationIntents = createCodexAuthNavigationIntentCoordinator({
    now: () => 100,
    ttlMs: 1_000,
    newNonce: () => {
      nextNonce += 1;
      return `nonce-${String(nextNonce)}`;
    },
  });
  const scheduler: CodexAppServerScheduler = {
    setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimeout: (handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
  stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").trim().split("\n")) {
      const frame = JSON.parse(line) as WireFrame;
      frames.push(frame as Record<string, unknown>);
      if (frame.method !== undefined) methods.push(frame.method);
      if (frame.method === "initialized") continue;
      let result: unknown;
      if (frame.method === "initialize")
        result = {
          ...initialize,
          userAgent: initializeUserAgent,
        };
      else if (frame.method === "account/read")
        result = { account: null, requiresOpenaiAuth: true };
      else result = response?.(frame);
      if (result !== undefined)
        queueMicrotask(() => stdout.write(`${JSON.stringify({ id: frame.id, result })}\n`));
    }
  });
  const tree: RuntimeProcessTree = {
    treeId: "tree-1",
    stdout,
    stderr: new PassThrough(),
    stdin,
    onTreeExit: vi.fn(),
  };
  const input: CodexRuntimeCompositionInput = {
    qualification: { verify: vi.fn(() => true) },
    provenance: { verify: vi.fn(() => true) },
    canonicalSchemaVerifier: { verify: vi.fn(() => true) },
    profileCoordinator: coordinator,
    navigationIntents,
    prepareSecureStateRoot: vi.fn(({ stateRoot }) => Promise.resolve(stateRoot)),
    createTransport: ({ tree: processTree }) => {
      const listeners = new Set<(chunk: string) => void>();
      const onData = (chunk: Buffer): void => {
        listeners.forEach((listener) => {
          listener(chunk.toString("utf8"));
        });
      };
      processTree.stdout.on("data", onData);
      return {
        transport: {
          write: (chunk) => void processTree.stdin?.write(chunk),
          onData: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
        close: () => {
          closed = true;
          processTree.stdout.off("data", onData);
        },
      };
    },
    toolFacade: facade,
    toolCapability: ({ runId, threadId, turnId, tool }) =>
      `cap:${runId}:${threadId}:${turnId}:${tool}`,
    interruptBarrier,
    scheduler,
    nowIso: () => "2026-07-12T12:00:00.000Z",
    onRuntimeEvent: (event) => events.push(event),
    onTransientDelta: (delta) => deltas.push(delta),
    onAdapterFailure: (runId, code) => failures.push([runId, code]),
    ...(modeOverrides?.requestedMode === undefined
      ? {}
      : { requestedMode: modeOverrides.requestedMode }),
    ...(modeOverrides?.effectiveMode === undefined
      ? {}
      : { effectiveMode: modeOverrides.effectiveMode }),
  };
  const composition = createCodexRuntimeComposition(input);
  return {
    composition,
    input,
    coordinator,
    navigationIntents,
    tree,
    stdout,
    frames,
    methods,
    events,
    deltas,
    failures,
    get closed() {
      return closed;
    },
  };
}

function profileCoordinator(): CodexSubscriptionProfileCoordinator {
  const invalidate = vi.fn();
  return {
    getProfile: vi.fn(() =>
      Promise.resolve({
        schemaVersion: "1",
        profileId: "codex-subscription",
        modelSource: "chatgpt-codex-subscription-profile",
        runtimeSource: "codex-cli-adapter",
        status: "missing",
        credentialStore: "file",
        stateScope: "keiko-owned-state",
        stateRoot: "keiko-codex-runtime-state",
        usesGlobalCodexHome: false,
        runtimeBinarySources: ["managed-sidecar-runtime"],
        supportsBrowserLogin: true,
        supportsDeviceCode: true,
        supportsAccessToken: true,
        deploymentPolicyDisabled: false,
        headless: false,
      } satisfies CodingWorkbenchCodexSubscriptionProfile),
    ),
    loginStarted: invalidate,
    browserLoginStarted: vi.fn(),
    deviceCodeLoginStarted: vi.fn(),
    loginCancelled: vi.fn(),
    loginCompleted: vi.fn(),
    loginSucceeded: vi.fn(),
    loginFailed: vi.fn(),
    loginExpired: invalidate,
    loginRevoked: invalidate,
    loginClosed: invalidate,
    logout: vi.fn(),
  };
}

async function prepare(harness: ReturnType<typeof createHarness>) {
  return harness.composition.lifecycle.prepare({
    runId: "run-1",
    stateRoot: "/state/run-1",
    signal,
    timeoutMs: 1_000,
  });
}
async function attach(harness: ReturnType<typeof createHarness>) {
  const result = await harness.composition.lifecycle.attach({
    runId: "run-1",
    tree: harness.tree,
    signal,
    timeoutMs: 1_000,
  });
  if (result.ok) harness.methods.push("ready");
  return result;
}
function turn(id: string, status: "inProgress" | "completed" | "failed" | "interrupted") {
  return { id, items: [], status };
}
function turnNotification(method: string, status: "inProgress" | "completed" | "failed") {
  return { method, params: { threadId: "thread-1", turn: turn("turn-1", status) } };
}
function toolCallNotification(id: string): string {
  return `${JSON.stringify({
    id,
    method: "item/tool/call",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: id,
      tool: "keiko_read",
      arguments: {},
    },
  })}\n`;
}
function threadStartResult(id: string) {
  return {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    cwd: "/workspace",
    model: "codex",
    modelProvider: "openai",
    sandbox: { type: "workspaceWrite", networkAccess: false, writableRoots: [] },
    thread: {
      cliVersion: "0.144.1",
      createdAt: 1,
      cwd: "/workspace",
      ephemeral: true,
      id,
      modelProvider: "openai",
      preview: "",
      sessionId: "session-1",
      source: "appServer",
      status: { type: "idle" },
      turns: [],
      updatedAt: 1,
    },
  };
}
async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
