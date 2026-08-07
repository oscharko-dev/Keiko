import { Buffer } from "node:buffer";
import { join, posix, win32 } from "node:path";

import {
  CODING_WORKBENCH_SCHEMA_VERSION,
  KEIKO_PRODUCT_VERSION,
  validateCodingWorkbenchCodexSubscriptionProfile,
  validateCodingWorkbenchRuntimeEvent,
  type CodingWorkbenchRuntimeEvent,
} from "@oscharko-dev/keiko-contracts";

import {
  type CodexAuthNavigationIntentCoordinator,
  type CodexAuthNavigationIntent,
  type CodexSubscriptionProfileCoordinator,
} from "../coding-codex-subscription.js";
import {
  CodexAppServerClient,
  type CodexAppServerClientFailureCode,
  type CodexAppServerScheduler,
  type CodexAppServerTransport,
} from "./codexAppServerClient.js";
import {
  CODEX_APP_SERVER_SCHEMA,
  type CodexAppServerId,
  type CodexAppServerProjection,
  type CodexAppServerToolCallOutcome,
} from "./codexAppServerProtocol.js";
import type { CodexLifecycleAdapter } from "./codingRuntimeManager.js";
import type { CodingToolFacade } from "./codingToolFacadePorts.js";
import type { RuntimeProcessTree } from "./runtimeProcessSupervisor.js";

/* eslint-disable max-lines-per-function -- closed lifecycle/control state machines are reviewed together. */
/* eslint-disable complexity -- protocol projection variants intentionally fail closed independently. */
/* eslint-disable @typescript-eslint/explicit-function-return-type -- contextual port types are authoritative. */

// Derived, never restated: a literal here silently drifts from the product version at every
// release bump, and no gate compares the two (0.3.0 release audit).
const CLIENT_VERSION = KEIKO_PRODUCT_VERSION;
const MAX_TOOL_TEXT_BYTES = 32 * 1024;
const MAX_USER_AGENT_BYTES = 64 * 1024;

export interface CodexRuntimeIdentityInput {
  readonly runId: string;
  readonly version: typeof CODEX_APP_SERVER_SCHEMA.version;
  readonly digest: typeof CODEX_APP_SERVER_SCHEMA.digest;
  readonly algorithm: typeof CODEX_APP_SERVER_SCHEMA.algorithm;
  readonly signal: AbortSignal;
}

export interface CodexRuntimeTransportHandle {
  readonly transport: CodexAppServerTransport;
  readonly close: () => void | Promise<void>;
}

export interface CodexRuntimeOperationOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs: number;
}

export interface CodexRuntimeControlFailure {
  readonly ok: false;
  readonly code: "unavailable";
}
export type CodexRuntimeTerminalStatus = "completed" | "failed" | "interrupted";

export interface CodexRuntimeControl {
  readonly startBrowserLogin: (
    runId: string,
    options: CodexRuntimeOperationOptions,
  ) => Promise<
    | {
        readonly ok: true;
        readonly loginId: string;
        readonly navigation: CodexAuthNavigationIntent;
      }
    | CodexRuntimeControlFailure
  >;
  readonly startDeviceLogin: (
    runId: string,
    options: CodexRuntimeOperationOptions,
  ) => Promise<
    | {
        readonly ok: true;
        readonly loginId: string;
        readonly userCode: string;
        readonly navigation: CodexAuthNavigationIntent;
      }
    | CodexRuntimeControlFailure
  >;
  readonly cancelLogin: (
    runId: string,
    loginId: string,
    options: CodexRuntimeOperationOptions,
  ) => Promise<{ readonly ok: true } | CodexRuntimeControlFailure>;
  readonly logout: (
    runId: string,
    options: CodexRuntimeOperationOptions,
  ) => Promise<{ readonly ok: true } | CodexRuntimeControlFailure>;
  readonly consumeNavigation: (input: {
    readonly runId: string;
    readonly loginId: string;
    readonly nonce: string;
  }) => string | undefined;
  readonly startThread: (
    runId: string,
    options: CodexRuntimeOperationOptions,
  ) => Promise<{ readonly ok: true; readonly threadId: string } | CodexRuntimeControlFailure>;
  readonly startTurn: (
    runId: string,
    threadId: string,
    text: string,
    options: CodexRuntimeOperationOptions,
  ) => Promise<{ readonly ok: true; readonly turnId: string } | CodexRuntimeControlFailure>;
  readonly interruptTurn: (
    runId: string,
    threadId: string,
    turnId: string,
    options: CodexRuntimeOperationOptions,
  ) => Promise<{ readonly ok: true } | CodexRuntimeControlFailure>;
  readonly terminalStatus: (
    runId: string,
    turnId: string,
  ) => CodexRuntimeTerminalStatus | undefined;
}

export interface CodexRuntimeCompositionInput {
  readonly qualification: {
    readonly verify: (input: CodexRuntimeIdentityInput) => boolean | Promise<boolean>;
  };
  readonly provenance: {
    readonly verify: (input: CodexRuntimeIdentityInput) => boolean | Promise<boolean>;
  };
  readonly canonicalSchemaVerifier: {
    readonly verify: (input: CodexRuntimeIdentityInput) => boolean | Promise<boolean>;
  };
  readonly profileCoordinator: CodexSubscriptionProfileCoordinator;
  readonly navigationIntents: CodexAuthNavigationIntentCoordinator;
  readonly prepareSecureStateRoot: (input: {
    readonly runId: string;
    readonly stateRoot: string;
    readonly signal: AbortSignal;
  }) => Promise<string | undefined>;
  readonly createTransport: (input: {
    readonly runId: string;
    readonly tree: RuntimeProcessTree;
  }) => CodexRuntimeTransportHandle;
  readonly toolFacade: CodingToolFacade;
  readonly toolCapability: (input: {
    readonly runId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly tool: string;
  }) => string | undefined;
  readonly interruptBarrier: (input: {
    readonly runId: string;
    readonly threadId: string;
    readonly turnId: string;
  }) => Promise<boolean>;
  readonly scheduler: CodexAppServerScheduler;
  readonly nowIso: () => string;
  readonly onRuntimeEvent: (event: CodingWorkbenchRuntimeEvent) => void;
  readonly onTransientDelta?:
    ((delta: Extract<CodexAppServerProjection, { kind: "delta" }>) => void) | undefined;
  readonly onAdapterFailure: (runId: string, code: CodexAppServerClientFailureCode) => void;
}

export interface CodexRuntimeComposition {
  readonly lifecycle: CodexLifecycleAdapter;
  readonly control: CodexRuntimeControl;
  readonly close: () => Promise<void>;
  readonly dispose: () => Promise<void>;
}

interface PreparedRun {
  readonly stateRoot: string;
}

interface AttachedRun extends PreparedRun {
  readonly client: CodexAppServerClient;
  readonly transport: CodexRuntimeTransportHandle;
  readonly terminal: Map<string, CodexRuntimeTerminalStatus>;
  readonly turnControllers: Map<string, AbortController>;
  readonly activeToolCalls: Map<string, Map<CodexAppServerId, Promise<void> | undefined>>;
  sequence: number;
  attached: boolean;
}

export function createCodexRuntimeComposition(
  input: CodexRuntimeCompositionInput,
): CodexRuntimeComposition {
  const prepared = new Map<string, PreparedRun>();
  const attached = new Map<string, AttachedRun>();
  const identity = (runId: string, signal: AbortSignal): CodexRuntimeIdentityInput => ({
    runId,
    ...CODEX_APP_SERVER_SCHEMA,
    signal,
  });
  const lifecycle: CodexLifecycleAdapter = {
    qualify: async ({ runId, signal }) =>
      (await check(signal, () => input.qualification.verify(identity(runId, signal)))) &&
      (await check(signal, () => input.provenance.verify(identity(runId, signal))))
        ? { ok: true }
        : { ok: false },
    inspectProfile: async ({ signal }) => {
      try {
        const profile = await abortable(signal, input.profileCoordinator.getProfile());
        const valid = validateCodingWorkbenchCodexSubscriptionProfile(profile);
        return valid.ok &&
          valid.value.status !== "redistribution-unapproved" &&
          valid.value.status !== "disabled-by-deployment"
          ? { ok: true }
          : { ok: false };
      } catch {
        return { ok: false };
      }
    },
    prepare: async ({ runId, stateRoot, signal }) => {
      if (
        !(await check(signal, () => input.canonicalSchemaVerifier.verify(identity(runId, signal))))
      )
        return { ok: false };
      try {
        const secured = await abortable(
          signal,
          input.prepareSecureStateRoot({ runId, stateRoot, signal }),
        );
        if (secured === undefined || signal.aborted) return { ok: false };
        prepared.set(runId, { stateRoot: secured });
        return { ok: true, stateRoot: secured };
      } catch {
        return { ok: false };
      }
    },
    attach: async ({ runId, tree, signal, timeoutMs }) => {
      const state = prepared.get(runId);
      if (state === undefined || tree.stdin === undefined || signal.aborted || attached.has(runId))
        return { ok: false };
      let transport: CodexRuntimeTransportHandle;
      try {
        transport = input.createTransport({ runId, tree });
      } catch {
        return { ok: false };
      }
      const run = {} as AttachedRun;
      const client = new CodexAppServerClient({
        transport: transport.transport,
        scheduler: input.scheduler,
        requestDeadlineMs: timeoutMs,
        onProjection: (projection) => {
          void project(input, runId, run, projection);
        },
        onFailure: (code): void => {
          failRun(input, runId, run, code);
        },
      });
      Object.assign(run, state, {
        client,
        transport,
        terminal: new Map<string, CodexRuntimeTerminalStatus>(),
        turnControllers: new Map<string, AbortController>(),
        activeToolCalls: new Map<string, Map<CodexAppServerId, Promise<void> | undefined>>(),
        sequence: 0,
        attached: true,
      });
      attached.set(runId, run);
      try {
        const initialized = await abortable(
          signal,
          client.request(
            "initialize",
            {
              clientInfo: { name: "keiko", version: CLIENT_VERSION },
              capabilities: {
                experimentalApi: false,
                requestAttestation: false,
                mcpServerOpenaiFormElicitation: false,
                optOutNotificationMethods: [],
              },
            },
            { signal },
          ),
        );
        if (!validInitialize(initialized, state.stateRoot)) throw new Error("initialize-failed");
        await abortable(signal, client.notify("initialized"));
        if (!validAccount(await abortable(signal, client.request("account/read", {}, { signal }))))
          throw new Error("account-failed");
        return {
          ok: true,
          detach: async (): Promise<boolean> => detachRun(input, runId, run),
        };
      } catch {
        await detachRun(input, runId, run);
        attached.delete(runId);
        return { ok: false };
      }
    },
    dispose: (runId): boolean => {
      const run = attached.get(runId);
      if (run?.attached === true) return false;
      input.navigationIntents.invalidateRun(runId);
      attached.delete(runId);
      prepared.delete(runId);
      return true;
    },
  };
  const close = async (): Promise<void> => {
    await Promise.all(
      [...attached.entries()].map(async ([runId, run]) => {
        await detachRun(input, runId, run);
      }),
    );
    for (const runId of prepared.keys()) input.navigationIntents.invalidateRun(runId);
    attached.clear();
    prepared.clear();
    input.navigationIntents.dispose();
  };
  return { lifecycle, control: createControl(input, attached), close, dispose: close };
}

function createControl(
  input: CodexRuntimeCompositionInput,
  runs: Map<string, AttachedRun>,
): CodexRuntimeControl {
  const request = async (
    runId: string,
    method: string,
    params: unknown,
    options: CodexRuntimeOperationOptions,
  ): Promise<unknown> => {
    const run = runs.get(runId);
    if (run?.attached !== true) return undefined;
    const deadline = deadlineSignal(input.scheduler, options);
    try {
      return await run.client.request(method, params, { signal: deadline.signal });
    } catch {
      return undefined;
    } finally {
      deadline.dispose();
    }
  };
  return {
    startBrowserLogin: async (runId, options) => {
      input.profileCoordinator.browserLoginStarted();
      const value = await request(runId, "account/login/start", { type: "chatgpt" }, options);
      if (!isBrowserLogin(value)) return unavailable();
      const navigation = input.navigationIntents.create({
        url: value.authUrl,
        runId,
        loginId: value.loginId,
      });
      return navigation === undefined
        ? unavailable()
        : { ok: true, loginId: value.loginId, navigation };
    },
    startDeviceLogin: async (runId, options) => {
      input.profileCoordinator.deviceCodeLoginStarted();
      const value = await request(
        runId,
        "account/login/start",
        { type: "chatgptDeviceCode" },
        options,
      );
      if (!isDeviceLogin(value)) return unavailable();
      const navigation = input.navigationIntents.create({
        url: value.verificationUrl,
        runId,
        loginId: value.loginId,
      });
      return navigation === undefined
        ? unavailable()
        : {
            ok: true,
            loginId: value.loginId,
            userCode: value.userCode,
            navigation,
          };
    },
    cancelLogin: async (runId, loginId, options) => {
      const value = await request(runId, "account/login/cancel", { loginId }, options);
      if (!isRecord(value) || (value.status !== "canceled" && value.status !== "notFound"))
        return unavailable();
      input.profileCoordinator.loginCancelled();
      input.profileCoordinator.loginClosed("cancelled");
      input.navigationIntents.invalidateLogin(runId, loginId);
      return { ok: true };
    },
    logout: async (runId, options) => {
      const value = await request(runId, "account/logout", undefined, options);
      if (!isRecord(value) || value.completed !== true) return unavailable();
      input.profileCoordinator.logout();
      input.navigationIntents.invalidateRun(runId);
      return { ok: true };
    },
    consumeNavigation: ({ runId, loginId, nonce }): string | undefined => {
      const url = input.navigationIntents.consume({ runId, loginId, nonce });
      if (url === undefined) input.profileCoordinator.loginClosed("expired");
      return url;
    },
    startThread: async (runId, options) => {
      const value = await request(runId, "thread/start", {}, options);
      return isRecord(value) && nonEmpty(value.threadId)
        ? { ok: true, threadId: value.threadId }
        : unavailable();
    },
    startTurn: async (runId, threadId, text, options) => {
      const value = await request(
        runId,
        "turn/start",
        { threadId, input: [{ type: "text", text }] },
        options,
      );
      if (!isRecord(value) || !nonEmpty(value.turnId)) return unavailable();
      runs.get(runId)?.turnControllers.set(value.turnId, new AbortController());
      return { ok: true, turnId: value.turnId };
    },
    interruptTurn: async (runId, threadId, turnId, options) => {
      const run = runs.get(runId);
      if (run?.attached !== true) return unavailable();
      abortTurn(run, turnId);
      retireTurnToolCalls(run, turnId);
      if (!(await allowInterrupt(input, runId, threadId, turnId))) return unavailable();
      const value = await request(runId, "turn/interrupt", { threadId, turnId }, options);
      return isRecord(value) && value.completed === true ? { ok: true } : unavailable();
    },
    terminalStatus: (runId, turnId) => runs.get(runId)?.terminal.get(turnId),
  };
}

async function project(
  input: CodexRuntimeCompositionInput,
  runId: string,
  run: AttachedRun,
  projection: CodexAppServerProjection,
): Promise<void> {
  if (!run.attached) return;
  if (projection.kind === "auth-lifecycle") {
    projectAuthLifecycle(input, runId, projection);
    return;
  }
  if (projection.kind === "tool-call") {
    registerToolCall(run, projection.turnId, projection.id);
    await mediateTool(input, runId, run, projection);
    return;
  }
  if (projection.kind === "delta") {
    if (run.terminal.has(projection.turnId)) return;
    input.onTransientDelta?.(projection);
    emit(input, runId, run, "observation-streamed", {
      channel: "status",
      sequence: ++run.sequence,
      byteCount: Buffer.byteLength(projection.delta, "utf8"),
      truncated: false,
    });
    return;
  }
  if (projection.event === "turn/started" && projection.turnId !== undefined) {
    emit(input, runId, run, "task-submitted", {
      taskRef: "codex-task",
      requestedMode: "governed-assist",
      effectiveMode: "governed-assist",
    });
  }
  if (projection.terminalStatus !== undefined && projection.turnId !== undefined) {
    if (run.terminal.has(projection.turnId)) return;
    run.terminal.set(projection.turnId, projection.terminalStatus);
    abortTurn(run, projection.turnId);
    retireTurnToolCalls(run, projection.turnId);
    if (projection.terminalStatus !== "completed")
      emit(input, runId, run, "failure-redacted", {
        failureCode: "failure-redacted",
        failureSummary: "runtime-failed",
        retryable: projection.terminalStatus === "failed",
      });
    else
      emit(input, runId, run, "runtime-health", {
        runtimeSource: "codex-cli-adapter",
        modelSource: "chatgpt-codex-subscription-profile",
        health: "ready",
      });
  }
}

async function mediateTool(
  input: CodexRuntimeCompositionInput,
  runId: string,
  run: AttachedRun,
  call: Extract<CodexAppServerProjection, { kind: "tool-call" }>,
): Promise<void> {
  if (!run.attached || run.terminal.has(call.turnId)) return;
  const controller = turnController(run, call.turnId);
  const capability = input.toolCapability({
    runId,
    threadId: call.threadId,
    turnId: call.turnId,
    tool: call.tool,
  });
  try {
    const result = await input.toolFacade.execute({
      body: JSON.stringify({
        ...call.arguments,
        actionId: call.callId,
        idempotencyKey: `${runId}:${call.threadId}:${call.turnId}:${call.callId}`,
      }),
      capability,
      signal: controller.signal,
    });
    if (!canRespondToToolCall(run, call.turnId, controller)) return;
    if (result.status !== "completed") {
      await settleToolCall(run, call.turnId, call.id, { success: false });
      return;
    }
    const text = "read" in result ? boundedText(result.read.text) : "completed";
    await settleToolCall(run, call.turnId, call.id, {
      success: true,
      contentItems: [{ type: "inputText", text }],
    });
  } catch {
    if (canRespondToToolCall(run, call.turnId, controller)) {
      await settleToolCall(run, call.turnId, call.id, { success: false });
    }
  }
}

function projectAuthLifecycle(
  input: CodexRuntimeCompositionInput,
  runId: string,
  projection: Extract<CodexAppServerProjection, { kind: "auth-lifecycle" }>,
): void {
  input.profileCoordinator.loginCompleted();
  if (projection.authenticated) {
    input.profileCoordinator.loginSucceeded();
    return;
  }
  const outcome = projection.event === "account/updated" ? "revoked" : "failed";
  input.profileCoordinator.loginClosed(outcome);
  input.navigationIntents.invalidateRun(runId);
}

async function allowInterrupt(
  input: CodexRuntimeCompositionInput,
  runId: string,
  threadId: string,
  turnId: string,
): Promise<boolean> {
  try {
    return await input.interruptBarrier({ runId, threadId, turnId });
  } catch {
    return false;
  }
}

function turnController(run: AttachedRun, turnId: string): AbortController {
  const existing = run.turnControllers.get(turnId);
  if (existing !== undefined) return existing;
  const controller = new AbortController();
  run.turnControllers.set(turnId, controller);
  return controller;
}

function abortTurn(run: AttachedRun, turnId: string): void {
  turnController(run, turnId).abort();
}

function abortAllTurns(run: AttachedRun): void {
  for (const controller of run.turnControllers.values()) controller.abort();
}

function registerToolCall(run: AttachedRun, turnId: string, id: CodexAppServerId): void {
  const calls =
    run.activeToolCalls.get(turnId) ?? new Map<CodexAppServerId, Promise<void> | undefined>();
  calls.set(id, undefined);
  run.activeToolCalls.set(turnId, calls);
}

async function settleToolCall(
  run: AttachedRun,
  turnId: string,
  id: CodexAppServerId,
  outcome: CodexAppServerToolCallOutcome,
): Promise<void> {
  const calls = run.activeToolCalls.get(turnId);
  if (!calls?.has(id)) return;
  const existing = calls.get(id);
  if (existing !== undefined) return existing;
  const settlement = settleActiveToolCall(run, turnId, id, outcome);
  calls.set(id, settlement);
  return settlement;
}

async function settleActiveToolCall(
  run: AttachedRun,
  turnId: string,
  id: CodexAppServerId,
  outcome: CodexAppServerToolCallOutcome,
): Promise<void> {
  try {
    await run.client.respondToolCall(id, outcome);
  } catch {
    // The client has already failed closed or rejected a superseded admission.
  } finally {
    const calls = run.activeToolCalls.get(turnId);
    if (calls !== undefined) {
      calls.delete(id);
      if (calls.size === 0) run.activeToolCalls.delete(turnId);
    }
  }
}

function retireTurnToolCalls(run: AttachedRun, turnId: string): void {
  const calls = run.activeToolCalls.get(turnId);
  if (calls === undefined) return;
  for (const id of calls.keys()) run.client.abandonToolCall(id);
  run.activeToolCalls.delete(turnId);
}

function retireAllToolCalls(run: AttachedRun): void {
  for (const turnId of run.activeToolCalls.keys()) retireTurnToolCalls(run, turnId);
}

function canRespondToToolCall(
  run: AttachedRun,
  turnId: string,
  controller: AbortController,
): boolean {
  return isRunAttached(run) && !run.terminal.has(turnId) && !controller.signal.aborted;
}

function emit(
  input: CodexRuntimeCompositionInput,
  runId: string,
  run: AttachedRun,
  kind: CodingWorkbenchRuntimeEvent["kind"],
  details: Partial<CodingWorkbenchRuntimeEvent>,
): void {
  if (!run.attached) return;
  const event: CodingWorkbenchRuntimeEvent = {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    eventId: `codex-runtime-${runId}-${String(++run.sequence)}`,
    runId,
    occurredAt: input.nowIso(),
    kind,
    ...details,
  };
  if (validateCodingWorkbenchRuntimeEvent(event).ok) input.onRuntimeEvent(event);
}

function failRun(
  input: CodexRuntimeCompositionInput,
  runId: string,
  run: AttachedRun,
  code: CodexAppServerClientFailureCode,
): void {
  if (!run.attached) return;
  input.onAdapterFailure(runId, code);
  emit(input, runId, run, "failure-redacted", {
    failureCode: "failure-redacted",
    failureSummary: "runtime-failed",
    retryable: false,
  });
}

async function detachRun(
  input: CodexRuntimeCompositionInput,
  runId: string,
  run: AttachedRun,
): Promise<boolean> {
  if (!run.attached) return true;
  run.attached = false;
  input.navigationIntents.invalidateRun(runId);
  abortAllTurns(run);
  retireAllToolCalls(run);
  run.client.close();
  try {
    await run.transport.close();
    return true;
  } catch {
    return false;
  }
}

function deadlineSignal(
  scheduler: CodexAppServerScheduler,
  options: CodexRuntimeOperationOptions,
): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
  };
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const timer = scheduler.setTimeout(abort, Math.max(0, options.timeoutMs));
  return {
    signal: controller.signal,
    dispose: (): void => {
      scheduler.clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    },
  };
}

async function check(
  signal: AbortSignal,
  operation: () => boolean | Promise<boolean>,
): Promise<boolean> {
  if (signal.aborted) return false;
  try {
    return (await abortable(signal, Promise.resolve().then(operation))) && !signal.aborted;
  } catch {
    return false;
  }
}

function abortable<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("cancelled"));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      reject(new Error("cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      () => {
        signal.removeEventListener("abort", abort);
        reject(new Error("unavailable"));
      },
    );
  });
}

function validInitialize(value: unknown, stateRoot: string): boolean {
  return (
    isRecord(value) &&
    value.codexHome === codexHomeFor(stateRoot) &&
    nonEmpty(value.userAgent) &&
    Buffer.byteLength(value.userAgent, "utf8") <= MAX_USER_AGENT_BYTES &&
    nonEmpty(value.platformFamily) &&
    nonEmpty(value.platformOs)
  );
}

function codexHomeFor(stateRoot: string): string {
  return win32.isAbsolute(stateRoot) && !posix.isAbsolute(stateRoot)
    ? win32.join(stateRoot, "codex-home")
    : join(stateRoot, "codex-home");
}
function validAccount(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.authenticated === "boolean" &&
    typeof value.requiresOpenaiAuth === "boolean" &&
    (value.authMode === null || value.authMode === "chatgpt")
  );
}
function isBrowserLogin(
  value: unknown,
): value is { readonly type: "chatgpt"; readonly authUrl: string; readonly loginId: string } {
  return (
    isRecord(value) &&
    value.type === "chatgpt" &&
    nonEmpty(value.authUrl) &&
    nonEmpty(value.loginId)
  );
}
function isDeviceLogin(value: unknown): value is {
  readonly type: "chatgptDeviceCode";
  readonly verificationUrl: string;
  readonly userCode: string;
  readonly loginId: string;
} {
  return (
    isRecord(value) &&
    value.type === "chatgptDeviceCode" &&
    nonEmpty(value.verificationUrl) &&
    nonEmpty(value.userCode) &&
    nonEmpty(value.loginId)
  );
}
function boundedText(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= MAX_TOOL_TEXT_BYTES
    ? text
    : bytes
        .subarray(0, MAX_TOOL_TEXT_BYTES)
        .toString("utf8")
        .replace(/\uFFFD$/u, "");
}
function unavailable(): CodexRuntimeControlFailure {
  return { ok: false, code: "unavailable" };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function isRunAttached(run: AttachedRun): boolean {
  return run.attached;
}
