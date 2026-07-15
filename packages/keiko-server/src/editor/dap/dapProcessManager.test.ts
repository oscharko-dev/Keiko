import { PassThrough } from "node:stream";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { DebugLifecycleEvidence } from "@oscharko-dev/keiko-contracts";
import type { QualifiedDebugCapsuleHandle } from "./dapCapsuleSupervisor.js";
import type { DapPrivateEndpointConnection } from "./dapPrivateEndpoint.js";
import { createDapFrameReader, DapFrameRejectError, writeDapFrame } from "./dapFrameCodec.js";
import { createDapEventBridge, type DapEventBridge } from "./dapEventBridge.js";
import type { DapAdapterPreflightDeps } from "./dapNodeAdapter.js";
import {
  createDapProcessManager,
  DapProcessManagerError,
  type DapProcessManager,
  type DapProcessStartInput,
  type DapSessionConfigurationPort,
  type DebugCapsuleLauncher,
} from "./dapProcessManager.js";
import {
  type DebugCapsuleLayer2Validator,
  type Layer2DebugCapsulePlan,
  type DebugSpawnEnvelope,
} from "./debugCapsulePlan.js";
import { createDebugSessionRegistry, type DebugSessionRegistry } from "./debugSessionRegistry.js";
import { createDebugLaunchLayer2Validator } from "./debugLaunchPlan.js";
import {
  createDapAdapterProviderCatalog,
  type DebugAdapterSpec,
} from "./providers/dapAdapterProviders.js";
import { createNodeDebugAdapterSpec } from "./providers/nodeDebugAdapter.js";
import { dirname } from "node:path";

const plan = Object.freeze({
  schemaVersion: "1",
  planId: "plan_a",
  epoch: 1,
  expiresAtMs: 10_000,
  workspacePartitionKey: "partition_a",
  activationRevision: 1,
  targetKind: "file",
  provisioningDigest: "a".repeat(64),
  backend: "oci",
  runtimeIdentityDigest: "b".repeat(64),
  spawnEnvelope: { planId: "plan_a" },
  endpoint: {
    kind: "posixSocket",
    runtimeDirectory: "/private/runtime",
    socketPath: "/private/runtime/dap.sock",
    runtimeIdentity: "runtime_a",
  },
  attestation: {
    filesystem: "executionRoot",
    network: "none",
    processScope: "capsule",
    runtimeDirectoryMode: "0700",
    endpointOwnership: "currentUser",
  },
  launchRequest: { command: "launch", arguments: { request: "launch", noDebug: false } },
}) as unknown as Layer2DebugCapsulePlan;

const identity = {
  sessionId: "session_a",
  workspaceId: "workspace_a",
  workspacePartitionKey: "partition_a",
  browserSessionBinding: "browser_a",
  targetKind: "file" as const,
  activationRevision: 1,
  backend: "oci" as const,
  network: "none" as const,
  filesystem: "executionRoot" as const,
  runtimeIdentityDigest: "b".repeat(64),
};

type TestCapsule = QualifiedDebugCapsuleHandle & {
  emitExit(): Promise<void>;
  readonly terminateScope: Mock<
    () => Promise<{ readonly terminated: boolean; readonly descendantsRemaining: number }>
  >;
  readonly cleanup: Mock<QualifiedDebugCapsuleHandle["cleanup"]>;
};

function capsule(): TestCapsule {
  let exit: (() => Promise<void>) | undefined;
  let exited = false;
  let inspectTermination = false;
  const terminateScope = vi.fn(() =>
    Promise.resolve({ terminated: true, descendantsRemaining: 0 }),
  );
  const result: TestCapsule = {
    planId: "plan_a",
    source: new PassThrough(),
    sink: { write: vi.fn() },
    processGroup: {
      pid: 42,
      kill: (): void => {
        exited = true;
        inspectTermination = true;
      },
    },
    exited: () => exited,
    inspectScope: async () => {
      const shouldInspectTermination = inspectTermination;
      inspectTermination = false;
      const status = shouldInspectTermination
        ? await terminateScope()
        : { terminated: false, descendantsRemaining: 1 };
      return {
        qualified: true,
        backend: "oci" as const,
        runtimeIdentityDigest: "b".repeat(64),
        descendants: status.descendantsRemaining,
      };
    },
    terminateContainment: async (): Promise<void> => {
      exited = true;
      await terminateScope();
    },
    terminateScope,
    cleanup: vi.fn(() => Promise.resolve()),
    onExit: (callback): void => {
      exit = callback;
    },
    emitExit: () => exit?.() ?? Promise.resolve(),
  };
  return result;
}

type TestEndpoint = DapPrivateEndpointConnection & {
  readonly commands: string[];
  readonly requests: {
    readonly seq: number;
    readonly command: string;
    readonly arguments?: unknown;
  }[];
  failWrites: boolean;
  respond: boolean;
  emitInitialized: boolean;
  holdLaunchResponse: boolean;
  readonly withheldCommands: Set<string>;
  initializeResponse: unknown;
  emit(message: Record<string, unknown>): void;
  respondTo(request: { readonly seq: number; readonly command: string }, body?: unknown): void;
  releaseLaunchResponse(): void;
  fail(error: Error): void;
  end(): void;
  emitBody(body: string): void;
  readonly close: Mock<() => Promise<void>>;
  readonly destroy: Mock<() => void>;
};

function endpoint(responsive = true, success = true): TestEndpoint {
  const wire = new PassThrough();
  const source = createDapFrameReader(wire);
  const commands: string[] = [];
  const requests: { seq: number; command: string; arguments?: unknown }[] = [];
  let adapterSequence = 100;
  let launchResponse: (() => void) | undefined;
  const retainSequence = (message: Record<string, unknown>): void => {
    if (typeof message.seq === "number" && Number.isSafeInteger(message.seq)) {
      adapterSequence = Math.max(adapterSequence, message.seq + 1);
    }
  };
  const retainBodySequence = (body: string): void => {
    try {
      retainSequence(JSON.parse(body) as Record<string, unknown>);
    } catch {
      return;
    }
  };
  const result: TestEndpoint = {
    source,
    commands,
    requests,
    failWrites: false,
    respond: responsive,
    emitInitialized: true,
    holdLaunchResponse: false,
    withheldCommands: new Set<string>(),
    initializeResponse: {
      supportsConfigurationDoneRequest: true,
      supportsSetVariable: true,
    },
    sendFrame: (body): void => {
      if (result.failWrites) throw new Error("private");
      const request = JSON.parse(body) as { seq: number; command: string; arguments?: unknown };
      commands.push(request.command);
      requests.push(request);
      if (result.withheldCommands.has(request.command)) return;
      if (!result.respond) return;
      const respondToRequest = (): void => {
        if (request.command === "launch" && result.emitInitialized) {
          writeDapFrame(
            wire,
            JSON.stringify({ seq: adapterSequence++, type: "event", event: "initialized" }),
          );
        }
        writeDapFrame(
          wire,
          JSON.stringify({
            seq: adapterSequence++,
            type: "response",
            request_seq: request.seq,
            success,
            command: request.command,
            body: request.command === "initialize" ? result.initializeResponse : {},
          }),
        );
      };
      if (request.command === "launch" && result.holdLaunchResponse) {
        queueMicrotask(() => {
          writeDapFrame(
            wire,
            JSON.stringify({ seq: adapterSequence++, type: "event", event: "initialized" }),
          );
        });
        launchResponse = (): void => {
          writeDapFrame(
            wire,
            JSON.stringify({
              seq: adapterSequence++,
              type: "response",
              request_seq: request.seq,
              success,
              command: request.command,
              body: {},
            }),
          );
        };
        return;
      }
      queueMicrotask(respondToRequest);
    },
    close: vi.fn(() => Promise.resolve()),
    destroy: vi.fn(),
    emit: (message): void => {
      retainSequence(message);
      writeDapFrame(wire, JSON.stringify(message));
    },
    respondTo: (request, body = {}): void => {
      writeDapFrame(
        wire,
        JSON.stringify({
          seq: adapterSequence++,
          type: "response",
          request_seq: request.seq,
          success: true,
          command: request.command,
          body,
        }),
      );
    },
    releaseLaunchResponse: (): void => {
      launchResponse?.();
      launchResponse = undefined;
    },
    fail: (error): void => {
      wire.destroy(error);
    },
    end: (): void => {
      wire.end();
    },
    emitBody: (body): void => {
      retainBodySequence(body);
      writeDapFrame(wire, body);
    },
  };
  return result;
}

interface SetupOptions {
  readonly launch?: (signal: AbortSignal) => Promise<TestCapsule>;
  readonly endpoint?: TestEndpoint;
  readonly endpoints?: TestEndpoint[];
  readonly handles?: TestCapsule[];
  readonly now?: () => number;
  readonly validate?: DebugCapsuleLayer2Validator["validateAndRederive"] | undefined;
  readonly connectEndpoint?: (() => Promise<TestEndpoint>) | undefined;
  readonly commandAllowed?: boolean | undefined;
  readonly specOverrides?: Readonly<Record<string, unknown>> | undefined;
  readonly onEvidence?: ((evidence: DebugLifecycleEvidence) => void) | undefined;
  readonly appendEvidence?: ((evidence: DebugLifecycleEvidence) => Promise<void>) | undefined;
  readonly revalidateTarget?: ((envelope: DebugSpawnEnvelope) => boolean) | undefined;
  readonly events?: DapEventBridge | undefined;
}
interface SetupResult {
  readonly records: DebugLifecycleEvidence[];
  readonly registry: DebugSessionRegistry;
  readonly handle: TestCapsule;
  readonly transport: TestEndpoint;
  readonly launch: Mock<DebugCapsuleLauncher>;
  readonly manager: DapProcessManager;
  readonly connect: Mock<(plan: Layer2DebugCapsulePlan) => Promise<DapPrivateEndpointConnection>>;
  readonly outputLimits: {
    readonly kind: "output-limit";
    readonly sessionId: string;
    readonly acceptedBytes: number;
  }[];
  readonly validatePlan: Mock<DebugCapsuleLayer2Validator["validateAndRederive"]>;
  readonly revalidateTarget: Mock<(envelope: DebugSpawnEnvelope) => boolean>;
  readonly adapterPreflight: Mock<
    (identity: DapProcessStartInput["identity"]) => DapAdapterPreflightDeps
  >;
  readonly resourceCleanups: readonly [Mock<() => void>, Mock<() => void>];
}

function preflightDeps(
  options: SetupOptions | undefined,
  executableRoot: string,
  resourceCleanups: readonly [Mock<() => void>, Mock<() => void>],
): DapAdapterPreflightDeps {
  return {
    workspaceRoot: "/workspace",
    processEnv: { PATH: executableRoot },
    approvedPath: executableRoot,
    createEphemeralHome: (): { readonly path: string; cleanup(): void } => ({
      path: "/private/home",
      cleanup: resourceCleanups[0],
    }),
    createEphemeralTemp: (): { readonly path: string; cleanup(): void } => ({
      path: "/private/temp",
      cleanup: resourceCleanups[1],
    }),
    commandAllowed: (): boolean => options?.commandAllowed ?? true,
  };
}

function launchMock(
  options: SetupOptions | undefined,
  handles: TestCapsule[],
  fallback: TestCapsule,
): Mock<DebugCapsuleLauncher> {
  return vi.fn(
    (_envelope, signal) =>
      options?.launch?.(signal) ?? Promise.resolve(handles.shift() ?? fallback),
  );
}

function connectMock(
  options: SetupOptions | undefined,
  endpoints: TestEndpoint[],
  fallback: TestEndpoint,
): Mock<(plan: Layer2DebugCapsulePlan) => Promise<DapPrivateEndpointConnection>> {
  return vi.fn(
    (_plan) => options?.connectEndpoint?.() ?? Promise.resolve(endpoints.shift() ?? fallback),
  );
}

function validationMock(
  options: SetupOptions | undefined,
): Mock<DebugCapsuleLayer2Validator["validateAndRederive"]> {
  return vi.fn(options?.validate ?? ((): Promise<Layer2DebugCapsulePlan> => Promise.resolve(plan)));
}

function testRegistry(
  options: SetupOptions | undefined,
  records: DebugLifecycleEvidence[],
  outputLimits: { kind: "output-limit"; sessionId: string; acceptedBytes: number }[],
): DebugSessionRegistry {
  return createDebugSessionRegistry({
    appendEvidence: (_partition, evidence) => {
      records.push(evidence);
      options?.onEvidence?.(evidence);
      return options?.appendEvidence?.(evidence) ?? Promise.resolve();
    },
    now: options?.now ?? ((): number => 0),
    emitOutputLimit: (event) => {
      outputLimits.push(event);
    },
  });
}

function testAdapterSpec(
  options: SetupOptions | undefined,
  executableRoot: string,
): DebugAdapterSpec {
  return {
    ...createNodeDebugAdapterSpec("node", ["--fixed"], [executableRoot], "a".repeat(64)),
    ...options?.specOverrides,
  };
}

function setup(options?: SetupOptions): SetupResult {
  const records: DebugLifecycleEvidence[] = [];
  const outputLimits: { kind: "output-limit"; sessionId: string; acceptedBytes: number }[] = [];
  const registry = testRegistry(options, records, outputLimits);
  const handle = capsule();
  const transport: TestEndpoint = options?.endpoint ?? endpoint();
  const endpoints = [...(options?.endpoints ?? [])];
  const handles = [...(options?.handles ?? [])];
  const launch = launchMock(options, handles, handle);
  const connect = connectMock(options, endpoints, transport);
  const executableRoot = dirname(process.execPath);
  const resourceCleanups = [vi.fn(), vi.fn()] as const;
  const validatePlan = validationMock(options);
  const revalidateTarget = vi.fn(options?.revalidateTarget ?? ((): boolean => true));
  const adapterPreflight: SetupResult["adapterPreflight"] = vi.fn((_identity) =>
    preflightDeps(options, executableRoot, resourceCleanups),
  );
  const adapterSpec = testAdapterSpec(options, executableRoot);
  const manager = createDapProcessManager({
    registry,
    adapterCatalog: createDapAdapterProviderCatalog([adapterSpec]),
    adapterPreflight,
    validateCapsulePlan: {
      validateAndRederive: validatePlan,
    },
    launchCapsule: launch,
    connectEndpoint: connect,
    revalidateTarget,
    events: options?.events,
  });
  return {
    records,
    registry,
    handle,
    transport,
    launch,
    manager,
    connect,
    outputLimits,
    validatePlan,
    revalidateTarget,
    adapterPreflight,
    resourceCleanups,
  };
}

function subscribeProjected(events: DapEventBridge): {
  readonly projected: unknown[];
  readonly unsubscribe: () => void;
} {
  const projected: unknown[] = [];
  const subscription = events.subscribe({
    channel: { workspacePartitionKey: "partition_a", browserSessionBinding: "browser_a" },
    onEvent: (event): void => void projected.push(event.event),
  });
  if (subscription.kind !== "ok") throw new Error("invalid test fixture");
  return { projected, unsubscribe: subscription.unsubscribe };
}

function terminalProjections(projected: readonly unknown[]): readonly unknown[] {
  return projected.filter(
    (event) =>
      typeof event === "object" &&
      event !== null &&
      "kind" in event &&
      event.kind === "session-stopped",
  );
}

function holdTermination(handle: TestCapsule): () => void {
  let release: (() => void) | undefined;
  handle.terminateScope.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = (): void => {
          resolve({ terminated: true, descendantsRemaining: 0 });
        };
      }),
  );
  return (): void => release?.();
}

describe("dapProcessManager canonical orchestration", () => {
  it("fails closed when a requested session binding does not exist", async () => {
    const current = setup();

    await expect(current.manager.stop("missing_session")).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
    });
    await expect(current.manager.failMalformed("missing_session")).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
    });
  });

  it("sends initialize then the exact server-built launch request before RUNNING", async () => {
    const { manager, transport, launch, validatePlan, revalidateTarget } = setup();
    await manager.start(startInput);
    expect(transport.commands).toStrictEqual(["initialize", "launch", "configurationDone"]);
    expect(transport.requests[0]?.arguments).toStrictEqual({
      clientID: "keiko",
      adapterID: "node",
      linesStartAt1: true,
      columnsStartAt1: true,
    });
    expect(transport.requests[1]?.arguments).toStrictEqual(plan.launchRequest.arguments);
    expect(launch.mock.calls[0]?.[0]).toBe(plan.spawnEnvelope);
    expect(revalidateTarget).toHaveBeenCalledWith(plan.spawnEnvelope);
    expect(validatePlan.mock.calls[0]?.[0].adapter).toMatchObject({
      executable: process.execPath,
      args: ["--fixed"],
      home: "/private/home",
      temp: "/private/temp",
    });
    expect(manager.health("session_a")).toMatchObject({
      state: "running",
      pendingRequestCount: 0,
      supportsSetVariable: true,
    });
    await expect(manager.request("session_a", "threads", {}, "inspection")).resolves.toStrictEqual(
      {},
    );
    await manager.stop("session_a");
  });

  it("applies bounded instrumentation before configurationDone and RUNNING", async () => {
    const current = setup();
    const configure = vi.fn(async (port: DapSessionConfigurationPort): Promise<void> => {
      expect(current.transport.commands).toStrictEqual(["initialize", "launch"]);
      await port.request("setBreakpoints", {
        source: { path: "/keiko-execution-root/app.js" },
        breakpoints: [{ line: 1 }],
      });
    });

    await current.manager.start({ ...startInput, configure });

    expect(configure).toHaveBeenCalledOnce();
    expect(current.transport.commands).toStrictEqual([
      "initialize",
      "launch",
      "setBreakpoints",
      "configurationDone",
    ]);
    expect(current.manager.health("session_a")).toMatchObject({ state: "running" });
    await current.manager.stop("session_a");
  });

  it("bounds configuration requests to the inspection deadline", async () => {
    vi.useFakeTimers();
    try {
      const current = setup();
      current.transport.withheldCommands.add("setBreakpoints");
      const starting = current.manager.start({
        ...startInput,
        configure: async (port): Promise<void> => {
          try {
            await port.request("setBreakpoints", {
              source: { path: "/keiko-execution-root/app.js" },
              breakpoints: [{ line: 1 }],
            });
          } catch {
            throw new DapProcessManagerError("INVALID_CAPSULE_PLAN");
          }
        },
      });
      let settled = false;
      void starting.then(
        (): void => {
          settled = true;
        },
        (): void => {
          settled = true;
        },
      );
      const rejection = expect(starting).rejects.toMatchObject({ code: "INVALID_CAPSULE_PLAN" });

      await vi.advanceTimersByTimeAsync(0);
      expect(current.transport.commands).toStrictEqual(["initialize", "launch", "setBreakpoints"]);
      await vi.advanceTimersByTimeAsync(2_999);
      expect(current.transport.commands).toStrictEqual(["initialize", "launch", "setBreakpoints"]);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts only boolean initialize capabilities and omits unsupported configurationDone", async () => {
    const transport = endpoint();
    transport.initializeResponse = {
      supportsConfigurationDoneRequest: false,
      supportsSetVariable: false,
    };
    const current = setup({ endpoint: transport });

    await current.manager.start(startInput);

    expect(transport.commands).toStrictEqual(["initialize", "launch"]);
    expect(current.manager.health("session_a")).toMatchObject({
      state: "running",
      supportsSetVariable: false,
    });
    await current.manager.stop("session_a");
  });

  it("accepts an empty initialize capability object as no optional capabilities", async () => {
    const transport = endpoint();
    transport.initializeResponse = {};
    const current = setup({ endpoint: transport });

    await current.manager.start(startInput);

    expect(transport.commands).toStrictEqual(["initialize", "launch"]);
    expect(current.manager.health("session_a")).toMatchObject({
      state: "running",
      supportsSetVariable: false,
    });
    await current.manager.stop("session_a");
  });

  it.each([
    null,
    [],
    "not-an-object",
    { supportsConfigurationDoneRequest: "true" },
    { supportsSetVariable: 1 },
  ])("fails closed on malformed initialize capabilities %#", async (initializeResponse) => {
    const transport = endpoint();
    transport.initializeResponse = initializeResponse;
    const current = setup({ endpoint: transport });

    await expect(current.manager.start(startInput)).rejects.toMatchObject({
      code: "STARTUP_THROTTLED",
    });

    expect(transport.commands).toStrictEqual(["initialize", "initialize"]);
    expect(current.launch).toHaveBeenCalledTimes(2);
    expect(current.manager.health("session_a")).toBeUndefined();
  });

  it("configures after initialized without waiting for the withheld launch response", async () => {
    const transport = endpoint();
    transport.holdLaunchResponse = true;
    const current = setup({ endpoint: transport });
    const configure = vi.fn(async (port: DapSessionConfigurationPort): Promise<void> => {
      await port.request("setBreakpoints", {
        source: { path: "/keiko-execution-root/app.js" },
        breakpoints: [{ line: 1 }],
      });
    });
    let settled = false;
    const starting = current.manager.start({ ...startInput, configure }).then(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(transport.commands).toStrictEqual([
        "initialize",
        "launch",
        "setBreakpoints",
        "configurationDone",
      ]);
    });
    expect(configure).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    expect(current.manager.health("session_a")?.state).toBe("starting");

    transport.releaseLaunchResponse();
    await starting;
    expect(current.manager.health("session_a")?.state).toBe("running");
    await current.manager.stop("session_a");
  });

  it("fails closed when launch never signals initialized", async () => {
    vi.useFakeTimers();
    const transport = endpoint();
    transport.emitInitialized = false;
    const current = setup({ endpoint: transport });
    const starting = current.manager.start(startInput);
    const rejection = expect(starting).rejects.toMatchObject({ code: "STARTUP_THROTTLED" });

    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;

    expect(transport.commands).toStrictEqual(["initialize", "launch", "initialize"]);
    vi.useRealTimers();
  });

  it("does not treat another DAP event as initialized", async () => {
    vi.useFakeTimers();
    try {
      const transport = endpoint();
      transport.emitInitialized = false;
      const current = setup({ endpoint: transport });
      const starting = current.manager.start(startInput);
      const rejection = expect(starting).rejects.toMatchObject({ code: "STARTUP_THROTTLED" });

      await vi.advanceTimersByTimeAsync(0);
      transport.emit({
        seq: 701,
        type: "event",
        event: "output",
        body: { output: "must-not-start" },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(transport.commands).toStrictEqual(["initialize", "launch"]);
      expect(current.manager.health("session_a")?.state).toBe("starting");
      await vi.advanceTimersByTimeAsync(20_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains the exact partial-thread stopped context", async () => {
    const current = setup();
    await current.manager.start(startInput);

    current.transport.emit({
      seq: 450,
      type: "event",
      event: "stopped",
      body: { reason: "step", threadId: 17, allThreadsStopped: false },
    });

    await vi.waitFor(() => {
      expect(current.manager.pauseContext("session_a")).toStrictEqual({
        pauseGeneration: 1,
        threadId: 17,
        allThreadsStopped: false,
      });
    });
    await current.manager.stop("session_a");
  });

  it("invalidates paused inspection context before a delayed response settles", async () => {
    const current = setup();
    await current.manager.start(startInput);
    current.transport.emit({
      seq: 450,
      type: "event",
      event: "stopped",
      body: { reason: "breakpoint", threadId: 17, allThreadsStopped: false },
    });
    await vi.waitFor(() => {
      expect(current.manager.pauseContext("session_a")?.pauseGeneration).toBe(1);
    });
    current.transport.respond = false;
    const inspection = current.manager.request<{ readonly stackFrames: readonly unknown[] }>(
      "session_a",
      "stackTrace",
      { threadId: 17 },
      "inspection",
    );
    await vi.waitFor(() => {
      expect(current.transport.commands.at(-1)).toBe("stackTrace");
    });

    current.transport.emit({
      seq: 451,
      type: "event",
      event: "continued",
      body: { threadId: 17, allThreadsContinued: false },
    });
    await vi.waitFor(() => {
      expect(current.manager.pauseContext("session_a")).toBeUndefined();
    });
    const request = current.transport.requests.at(-1);
    if (request === undefined) throw new Error("missing inspection request");
    current.transport.respondTo(request, { stackFrames: [{ id: 1 }] });

    await expect(inspection).resolves.toStrictEqual({ stackFrames: [{ id: 1 }] });
    expect(current.manager.pauseContext("session_a")).toBeUndefined();
    await current.manager.stop("session_a");
  });

  it("counts explicit control and inspection requests as inactivity activity", async () => {
    let now = 10;
    const current = setup({ now: () => now });
    await current.manager.start(startInput);
    expect(current.manager.health("session_a")?.lastActivityAtMs).toBe(10);

    now = 25;
    await current.manager.request("session_a", "threads", {}, "inspection");

    expect(current.manager.health("session_a")?.lastActivityAtMs).toBe(25);
    await current.manager.stop("session_a");
  });

  it("shuts down idempotently and rejects new work after disposal begins", async () => {
    const current = setup();
    await current.manager.start(startInput);

    const first = current.manager.shutdown();
    const second = current.manager.shutdown();
    expect(second).toBe(first);
    await first;

    await expect(current.manager.start(startInput)).rejects.toMatchObject({
      code: "CLIENT_DISPOSED",
    });
    await expect(
      current.manager.request("session_a", "threads", {}, "inspection"),
    ).rejects.toMatchObject({
      code: "CLIENT_DISPOSED",
    });
    await expect(current.manager.stop("session_a")).rejects.toMatchObject({
      code: "CLIENT_DISPOSED",
    });
    await expect(current.manager.revoke("session_a")).rejects.toMatchObject({
      code: "CLIENT_DISPOSED",
    });
    await expect(current.manager.failMalformed("session_a")).rejects.toMatchObject({
      code: "CLIENT_DISPOSED",
    });
    await expect(current.manager.sweepExpired()).rejects.toMatchObject({
      code: "CLIENT_DISPOSED",
    });
    await expect(current.manager.reconcile()).rejects.toMatchObject({
      code: "CLIENT_DISPOSED",
    });
    expect(current.handle.cleanup).toHaveBeenCalledOnce();
  });

  it("publishes the exact terminal state for explicit stop, revocation, and malformed input", async () => {
    const cases = [
      {
        invoke: (manager: DapProcessManager): Promise<void> => manager.stop("session_a"),
        expected: {
          kind: "session-stopped",
          sessionId: "session_a",
          status: "stopped",
          reason: "requested",
        },
      },
      {
        invoke: (manager: DapProcessManager): Promise<void> => manager.revoke("session_a"),
        expected: {
          kind: "session-stopped",
          sessionId: "session_a",
          status: "revoked",
          reason: "revoked",
        },
      },
      {
        invoke: (manager: DapProcessManager): Promise<void> => manager.failMalformed("session_a"),
        expected: {
          kind: "session-stopped",
          sessionId: "session_a",
          status: "failed",
          reason: "failed",
        },
      },
    ] as const;

    for (const testCase of cases) {
      const events = createDapEventBridge();
      const projected: unknown[] = [];
      const subscription = events.subscribe({
        channel: { workspacePartitionKey: "partition_a", browserSessionBinding: "browser_a" },
        onEvent: (event): void => void projected.push(event.event),
      });
      if (subscription.kind !== "ok") throw new Error("invalid test fixture");
      const current = setup({ events });
      await current.manager.start(startInput);
      await testCase.invoke(current.manager);
      expect(projected).toStrictEqual([
        { kind: "session-started", sessionId: "session_a", status: "running" },
        testCase.expected,
      ]);
      expect(current.records.at(-1)).toMatchObject({
        eventKind: "teardown",
        reason:
          testCase.expected.status === "revoked"
            ? "activationRevoked"
            : testCase.expected.status === "failed"
              ? "malformedFrame"
              : "stopped",
      });
      subscription.unsubscribe();
    }
  });

  it("publishes one terminal event across concurrent Stop/Stop and Stop/revoke calls", async () => {
    const cases = [
      {
        invoke: (manager: DapProcessManager): readonly [Promise<void>, Promise<void>] => [
          manager.stop("session_a"),
          manager.stop("session_a"),
        ],
        reason: "requested",
        status: "stopped",
      },
      {
        invoke: (manager: DapProcessManager): readonly [Promise<void>, Promise<void>] => [
          manager.stop("session_a"),
          manager.revoke("session_a"),
        ],
        reason: "requested",
        status: "stopped",
      },
      {
        invoke: (manager: DapProcessManager): readonly [Promise<void>, Promise<void>] => [
          manager.revoke("session_a"),
          manager.stop("session_a"),
        ],
        reason: "revoked",
        status: "revoked",
      },
    ] as const;

    for (const testCase of cases) {
      const events = createDapEventBridge();
      const subscription = subscribeProjected(events);
      const current = setup({ events });
      const release = holdTermination(current.handle);
      await current.manager.start(startInput);

      const terminalCalls = testCase.invoke(current.manager);
      await vi.waitFor(() => {
        expect(current.handle.terminateScope).toHaveBeenCalledOnce();
      });
      release();
      await Promise.all(terminalCalls);

      expect(terminalProjections(subscription.projected)).toStrictEqual([
        {
          kind: "session-stopped",
          sessionId: "session_a",
          status: testCase.status,
          reason: testCase.reason,
        },
      ]);
      subscription.unsubscribe();
    }
  });

  it("publishes one terminal event when output limit and protocol fatal race", async () => {
    const events = createDapEventBridge();
    const subscription = subscribeProjected(events);
    const current = setup({ events });
    const release = holdTermination(current.handle);
    await current.manager.start(startInput);
    for (let index = 0; index < 63; index += 1) {
      current.transport.emit({
        seq: 700 + index,
        type: "event",
        event: "output",
        body: { output: "A".repeat(16 * 1024) },
      });
    }
    await vi.waitFor(() => {
      expect(current.manager.health("session_a")?.outputAcceptedBytes).toBe(63 * 16 * 1024);
    });

    current.transport.emit({
      seq: 800,
      type: "event",
      event: "output",
      body: { output: "A".repeat(16 * 1024) },
    });
    current.transport.fail(new DapFrameRejectError("PAYLOAD_TOO_LARGE"));
    await vi.waitFor(() => {
      expect(current.handle.terminateScope).toHaveBeenCalledOnce();
    });
    release();
    await vi.waitFor(() => {
      expect(current.manager.health("session_a")).toBeUndefined();
    });

    expect(terminalProjections(subscription.projected)).toHaveLength(1);
    expect(terminalProjections(subscription.projected)[0]).toMatchObject({
      kind: "session-stopped",
      sessionId: "session_a",
    });
    subscription.unsubscribe();
  });

  it("publishes one terminal event when exited and terminated arrive concurrently", async () => {
    for (const order of ["exited-first", "terminated-first"] as const) {
      const events = createDapEventBridge();
      const subscription = subscribeProjected(events);
      const current = setup({ events });
      const release = holdTermination(current.handle);
      await current.manager.start(startInput);
      const exited = { seq: 810, type: "event", event: "exited", body: { exitCode: 0 } };
      const terminated = { seq: 811, type: "event", event: "terminated", body: {} };

      current.transport.emit(order === "exited-first" ? exited : terminated);
      current.transport.emit(order === "exited-first" ? terminated : exited);
      await vi.waitFor(() => {
        expect(current.handle.terminateScope).toHaveBeenCalledOnce();
      });
      release();
      await vi.waitFor(() => {
        expect(current.manager.health("session_a")).toBeUndefined();
      });

      expect(terminalProjections(subscription.projected)).toStrictEqual([
        {
          kind: "session-stopped",
          sessionId: "session_a",
          status: "stopped",
          reason: "exited",
        },
      ]);
      subscription.unsubscribe();
    }
  });

  it("fails closed when required startup publication cannot acquire an event channel", async () => {
    const events = createDapEventBridge();
    for (let index = 0; index < 64; index += 1) {
      const subscription = events.subscribe({
        channel: {
          workspacePartitionKey: `partition_${String(index)}`,
          browserSessionBinding: "browser_a",
        },
        onEvent: (): void => undefined,
      });
      expect(subscription.kind).toBe("ok");
    }
    const current = setup({ events });

    await expect(current.manager.start(startInput)).rejects.toMatchObject({
      code: "INVALID_CAPSULE_PLAN",
    });

    expect(current.manager.health("session_a")).toBeUndefined();
    expect(current.handle.terminateScope).toHaveBeenCalledOnce();
    expect(current.records.at(-1)).toMatchObject({
      eventKind: "teardown",
      reason: "malformedFrame",
    });
  });

  it("projects bounded protocol lifecycle through the browser-bound live event bridge", async () => {
    const events = createDapEventBridge();
    const projected: string[] = [];
    const descriptions: unknown[] = [];
    const subscription = events.subscribe({
      channel: { workspacePartitionKey: "partition_a", browserSessionBinding: "browser_a" },
      onEvent: (envelope): void => {
        projected.push(envelope.event.kind);
        if (envelope.event.kind === "stopped") descriptions.push(envelope.event.description);
      },
    });
    if (subscription.kind !== "ok") throw new Error("invalid test fixture");
    const current = setup({ events });
    await current.manager.start(startInput);

    current.transport.emitBody(
      JSON.stringify({ seq: 500, type: "event", event: "output", body: { output: "hello" } }),
    );
    current.transport.emitBody(
      JSON.stringify({
        seq: 501,
        type: "event",
        event: "stopped",
        body: {
          reason: "exception",
          threadId: 1,
          hitBreakpointIds: [1],
          description: "Fixture uncaught exception",
        },
      }),
    );
    current.transport.emitBody(
      JSON.stringify({ seq: 502, type: "event", event: "continued", body: {} }),
    );
    current.transport.emitBody(
      JSON.stringify({ seq: 503, type: "event", event: "exited", body: { exitCode: 0 } }),
    );
    current.transport.emitBody(
      JSON.stringify({ seq: 504, type: "event", event: "terminated", body: {} }),
    );

    await vi.waitFor(() => {
      expect(descriptions).toStrictEqual([
        {
          value: "Fixture uncaught exception",
          truncated: false,
          originalBytes: 26,
          retainedBytes: 26,
          omittedBytes: 0,
        },
      ]);
      expect(projected).toStrictEqual([
        "session-started",
        "output",
        "stopped",
        "continued",
        "exited",
        "session-stopped",
      ]);
      expect(current.manager.health("session_a")).toBeUndefined();
    });
    subscription.unsubscribe();
  });

  it("projects output, all supported stop reasons, and continued generations exactly", async () => {
    const events = createDapEventBridge();
    const projected: unknown[] = [];
    const subscription = events.subscribe({
      channel: { workspacePartitionKey: "partition_a", browserSessionBinding: "browser_a" },
      onEvent: (event): void => void projected.push(event.event),
    });
    if (subscription.kind !== "ok") throw new Error("invalid test fixture");
    const current = setup({ events });
    await current.manager.start(startInput);

    current.transport.emit({
      seq: 600,
      type: "event",
      event: "output",
      body: { output: "visible", category: "stdout" },
    });
    for (const [index, reason] of [
      "breakpoint",
      "exception",
      "step",
      "entry",
      "pause",
      "adapter-private-reason",
    ].entries()) {
      current.transport.emit({
        seq: 601 + index,
        type: "event",
        event: "stopped",
        body: { reason, threadId: index + 1, allThreadsStopped: index % 2 === 0 },
      });
    }
    current.transport.emit({ seq: 610, type: "event", event: "continued", body: {} });

    await vi.waitFor(() => {
      expect(projected).toContainEqual({
        kind: "output",
        sessionId: "session_a",
        category: "stdout",
        text: "visible",
        truncated: false,
        originalBytes: 7,
        omittedBytes: 0,
      });
      expect(projected.filter((event) => (event as { kind?: string }).kind === "stopped")).toEqual([
        expect.objectContaining({ reason: "breakpoint", allThreadsStopped: true }),
        expect.objectContaining({ reason: "exception", allThreadsStopped: false }),
        expect.objectContaining({ reason: "step", allThreadsStopped: true }),
        expect.objectContaining({ reason: "entry", allThreadsStopped: false }),
        expect.objectContaining({ reason: "pause", allThreadsStopped: true }),
        expect.objectContaining({ reason: "pause", allThreadsStopped: false }),
      ]);
      const firstStopped = projected.find(
        (event) => (event as { kind?: string }).kind === "stopped",
      );
      expect(firstStopped).toBeDefined();
      expect(Object.hasOwn(firstStopped as object, "description")).toBe(false);
      expect(projected).toContainEqual({
        kind: "continued",
        sessionId: "session_a",
        pauseGeneration: 7,
      });
    });
    subscription.unsubscribe();
    await current.manager.stop("session_a");
  });

  it("projects supported output categories and rejects telemetry or malformed bodies", async () => {
    const events = createDapEventBridge();
    const projected: unknown[] = [];
    const subscription = events.subscribe({
      channel: { workspacePartitionKey: "partition_a", browserSessionBinding: "browser_a" },
      onEvent: (event): void => void projected.push(event.event),
    });
    if (subscription.kind !== "ok") throw new Error("invalid test fixture");
    const current = setup({ events });
    await current.manager.start(startInput);

    current.transport.emit({
      seq: 611,
      type: "event",
      event: "output",
      body: { output: "console" },
    });
    current.transport.emit({
      seq: 612,
      type: "event",
      event: "output",
      body: { output: "error", category: "stderr" },
    });
    current.transport.emit({
      seq: 613,
      type: "event",
      event: "output",
      body: { output: "private", category: "telemetry" },
    });
    current.transport.emit({ seq: 614, type: "event", event: "output", body: { output: "" } });
    current.transport.emit({ seq: 615, type: "event", event: "output", body: null });
    current.transport.emit({ seq: 616, type: "event", event: "output", body: { output: 1 } });

    await vi.waitFor(() => {
      expect(projected).toStrictEqual([
        { kind: "session-started", sessionId: "session_a", status: "running" },
        {
          kind: "output",
          sessionId: "session_a",
          category: "console",
          text: "console",
          truncated: false,
          originalBytes: 7,
          omittedBytes: 0,
        },
        {
          kind: "output",
          sessionId: "session_a",
          category: "stderr",
          text: "error",
          truncated: false,
          originalBytes: 5,
          omittedBytes: 0,
        },
      ]);
    });
    subscription.unsubscribe();
    await current.manager.stop("session_a");
  });

  it("marks oversized output as truncated without changing its UTF-8 byte accounting", async () => {
    const events = createDapEventBridge();
    const projected: unknown[] = [];
    const subscription = events.subscribe({
      channel: { workspacePartitionKey: "partition_a", browserSessionBinding: "browser_a" },
      onEvent: (event): void => void projected.push(event.event),
    });
    if (subscription.kind !== "ok") throw new Error("invalid test fixture");
    const current = setup({ events });
    await current.manager.start(startInput);
    current.transport.emit({
      seq: 620,
      type: "event",
      event: "output",
      body: { output: "A".repeat(20 * 1024), category: "stderr" },
    });

    await vi.waitFor(() => {
      expect(projected).toContainEqual(
        expect.objectContaining({
          kind: "output",
          sessionId: "session_a",
          category: "stderr",
          truncated: true,
          originalBytes: 20 * 1024,
        }),
      );
    });
    subscription.unsubscribe();
    await current.manager.stop("session_a");
  });

  it("publishes validated exit codes before terminal teardown and terminates without an exit code", async () => {
    const exitedEvents = createDapEventBridge();
    const exited: unknown[] = [];
    const exitedSubscription = exitedEvents.subscribe({
      channel: { workspacePartitionKey: "partition_a", browserSessionBinding: "browser_a" },
      onEvent: (event): void => void exited.push(event.event),
    });
    if (exitedSubscription.kind !== "ok") throw new Error("invalid test fixture");
    const exitedCurrent = setup({ events: exitedEvents });
    await exitedCurrent.manager.start(startInput);
    exitedCurrent.transport.emit({
      seq: 630,
      type: "event",
      event: "exited",
      body: { exitCode: 0 },
    });
    await vi.waitFor(() => {
      expect(exitedCurrent.manager.health("session_a")).toBeUndefined();
    });
    expect(exitedCurrent.records.at(-1)).toMatchObject({
      eventKind: "teardown",
      reason: "debuggeeExit",
    });
    exitedCurrent.transport.emit({ seq: 631, type: "event", event: "terminated", body: {} });
    await new Promise((resolve) => setImmediate(resolve));
    expect(exited).toStrictEqual([
      { kind: "session-started", sessionId: "session_a", status: "running" },
      { kind: "exited", sessionId: "session_a", exitCode: 0 },
      { kind: "session-stopped", sessionId: "session_a", status: "stopped", reason: "exited" },
    ]);
    exitedSubscription.unsubscribe();

    const terminatedEvents = createDapEventBridge();
    const terminated: unknown[] = [];
    const terminatedSubscription = terminatedEvents.subscribe({
      channel: { workspacePartitionKey: "partition_a", browserSessionBinding: "browser_a" },
      onEvent: (event): void => void terminated.push(event.event),
    });
    if (terminatedSubscription.kind !== "ok") throw new Error("invalid test fixture");
    const terminatedCurrent = setup({ events: terminatedEvents });
    await terminatedCurrent.manager.start(startInput);
    terminatedCurrent.transport.emit({ seq: 640, type: "event", event: "terminated", body: {} });
    await vi.waitFor(() => {
      expect(terminatedCurrent.manager.health("session_a")).toBeUndefined();
    });
    expect(terminatedCurrent.records.at(-1)).toMatchObject({
      eventKind: "teardown",
      reason: "debuggeeExit",
    });
    terminatedCurrent.transport.emit({ seq: 642, type: "event", event: "terminated", body: {} });
    await new Promise((resolve) => setImmediate(resolve));
    expect(terminated).toStrictEqual([
      { kind: "session-started", sessionId: "session_a", status: "running" },
      { kind: "session-stopped", sessionId: "session_a", status: "stopped", reason: "exited" },
    ]);
    terminatedSubscription.unsubscribe();

    const invalidEvents = createDapEventBridge();
    const invalid: unknown[] = [];
    const invalidSubscription = invalidEvents.subscribe({
      channel: { workspacePartitionKey: "partition_a", browserSessionBinding: "browser_a" },
      onEvent: (event): void => void invalid.push(event.event),
    });
    if (invalidSubscription.kind !== "ok") throw new Error("invalid test fixture");
    const invalidCurrent = setup({ events: invalidEvents });
    await invalidCurrent.manager.start(startInput);
    invalidCurrent.transport.emit({
      seq: 641,
      type: "event",
      event: "exited",
      body: { exitCode: "0" },
    });
    await vi.waitFor(() => {
      expect(invalidCurrent.manager.health("session_a")).toBeUndefined();
    });
    expect(invalid).toStrictEqual([
      { kind: "session-started", sessionId: "session_a", status: "running" },
      { kind: "session-stopped", sessionId: "session_a", status: "stopped", reason: "exited" },
    ]);
    invalidSubscription.unsubscribe();

    const fractionalEvents = createDapEventBridge();
    const fractional: unknown[] = [];
    const fractionalSubscription = fractionalEvents.subscribe({
      channel: { workspacePartitionKey: "partition_a", browserSessionBinding: "browser_a" },
      onEvent: (event): void => void fractional.push(event.event),
    });
    if (fractionalSubscription.kind !== "ok") throw new Error("invalid test fixture");
    const fractionalCurrent = setup({ events: fractionalEvents });
    await fractionalCurrent.manager.start(startInput);
    fractionalCurrent.transport.emit({
      seq: 642,
      type: "event",
      event: "exited",
      body: { exitCode: 0.5 },
    });
    await vi.waitFor(() => {
      expect(fractionalCurrent.manager.health("session_a")).toBeUndefined();
    });
    expect(fractional).toStrictEqual([
      { kind: "session-started", sessionId: "session_a", status: "running" },
      { kind: "session-stopped", sessionId: "session_a", status: "stopped", reason: "exited" },
    ]);
    fractionalSubscription.unsubscribe();

    const missingBody = setup();
    await missingBody.manager.start(startInput);
    missingBody.transport.emit({ seq: 643, type: "event", event: "exited", body: null });
    await vi.waitFor(() => {
      expect(missingBody.manager.health("session_a")).toBeUndefined();
    });
    expect(missingBody.records.at(-1)).toMatchObject({
      eventKind: "teardown",
      reason: "debuggeeExit",
    });
  });

  it("classifies an unexpected capsule exit as a failed session", async () => {
    const events = createDapEventBridge();
    const projected: unknown[] = [];
    const subscription = events.subscribe({
      channel: { workspacePartitionKey: "partition_a", browserSessionBinding: "browser_a" },
      onEvent: (event): void => void projected.push(event.event),
    });
    if (subscription.kind !== "ok") throw new Error("invalid test fixture");
    const current = setup({ events });
    await current.manager.start(startInput);

    await current.handle.emitExit();

    expect(projected).toStrictEqual([
      { kind: "session-started", sessionId: "session_a", status: "running" },
      { kind: "session-stopped", sessionId: "session_a", status: "failed", reason: "failed" },
    ]);
    expect(current.manager.health("session_a")).toBeUndefined();
    await expect(current.handle.emitExit()).resolves.toBeUndefined();
    subscription.unsubscribe();
  });

  it("does not duplicate failure projection when a capsule exits during requested teardown", async () => {
    let releaseTermination: (() => void) | undefined;
    const handle = capsule();
    handle.terminateScope.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseTermination = (): void => {
            resolve({ terminated: true, descendantsRemaining: 0 });
          };
        }),
    );
    const events = createDapEventBridge();
    const projected: unknown[] = [];
    const subscription = events.subscribe({
      channel: { workspacePartitionKey: "partition_a", browserSessionBinding: "browser_a" },
      onEvent: (event): void => void projected.push(event.event),
    });
    if (subscription.kind !== "ok") throw new Error("invalid test fixture");
    const current = setup({ events, handles: [handle] });
    await current.manager.start(startInput);

    const stopping = current.manager.stop("session_a");
    await vi.waitFor(() => {
      expect(current.manager.health("session_a")?.state).toBe("stopping");
    });
    await handle.emitExit();
    releaseTermination?.();
    await stopping;

    expect(projected).toStrictEqual([
      { kind: "session-started", sessionId: "session_a", status: "running" },
      { kind: "session-stopped", sessionId: "session_a", status: "stopped", reason: "requested" },
    ]);
    subscription.unsubscribe();
  });

  it("does not classify a capsule exit as a second failure while teardown is pending", async () => {
    const handle = capsule();
    let terminated = false;
    handle.terminateScope.mockImplementation(() =>
      Promise.resolve({ terminated, descendantsRemaining: terminated ? 0 : 1 }),
    );
    const events = createDapEventBridge();
    const projected: unknown[] = [];
    const subscription = events.subscribe({
      channel: { workspacePartitionKey: "partition_a", browserSessionBinding: "browser_a" },
      onEvent: (event): void => void projected.push(event.event),
    });
    if (subscription.kind !== "ok") throw new Error("invalid test fixture");
    const current = setup({ events, handles: [handle] });
    await current.manager.start(startInput);

    const stopping = current.manager.stop("session_a");
    await vi.waitFor(() => {
      expect(current.manager.health("session_a")?.state).toBe("terminationPending");
    });
    await handle.emitExit();
    expect(projected).toStrictEqual([
      { kind: "session-started", sessionId: "session_a", status: "running" },
    ]);

    terminated = true;
    await current.manager.reconcile();
    await stopping;
    expect(projected).toStrictEqual([
      { kind: "session-started", sessionId: "session_a", status: "running" },
      { kind: "session-stopped", sessionId: "session_a", status: "stopped", reason: "requested" },
    ]);
    subscription.unsubscribe();
  });

  it("exposes canonical bindings and reconciles malformed-response teardown", async () => {
    const events = createDapEventBridge();
    const current = setup({ events });
    await current.manager.start(startInput);

    expect(current.manager.binding("session_a")).toStrictEqual({
      workspaceId: "workspace_a",
      workspacePartitionKey: "partition_a",
      browserSessionBinding: "browser_a",
    });
    expect(current.manager.boundSessionId("partition_a", "browser_a")).toBe("session_a");
    expect(current.manager.workspaceSessionId("partition_a")).toBe("session_a");
    await current.manager.reconcile();
    current.transport.emit({
      seq: 450,
      type: "event",
      event: "stopped",
      body: { reason: "pause", threadId: 17, allThreadsStopped: true },
    });
    await vi.waitFor(() => {
      expect(current.manager.pauseContext("session_a")?.pauseGeneration).toBe(1);
    });

    await current.manager.failMalformed("session_a");

    expect(current.manager.health("session_a")).toBeUndefined();
    expect(
      events.snapshot({
        workspacePartitionKey: "partition_a",
        browserSessionBinding: "browser_a",
      }),
    ).toMatchObject({ sequence: 3, retainedCount: 1 });
    expect(current.records.at(-1)).toMatchObject({
      eventKind: "teardown",
      reason: "malformedFrame",
    });
  });

  it("revalidates the closed target after initialize and before sending launch", async () => {
    let commandsAtRevalidation: readonly string[] = [];
    const current = setup({
      revalidateTarget: (): boolean => {
        commandsAtRevalidation = [...current.transport.commands];
        return true;
      },
    });

    await current.manager.start(startInput);

    expect(commandsAtRevalidation).toStrictEqual(["initialize"]);
    expect(current.transport.commands).toStrictEqual(["initialize", "launch", "configurationDone"]);
    expect(current.revalidateTarget).toHaveBeenCalledTimes(1);
    expect(current.revalidateTarget).toHaveBeenCalledWith(plan.spawnEnvelope);
    await current.manager.stop("session_a");
  });

  it.each(["false", "throws"] as const)(
    "fails closed when launch-boundary target revalidation %s",
    async (failure) => {
      const current = setup({
        revalidateTarget: (): boolean => {
          if (failure === "throws") throw new Error("private");
          return false;
        },
      });

      await expect(current.manager.start(startInput)).rejects.toMatchObject({
        name: "DapProcessManagerError",
        message: "INVALID_CAPSULE_PLAN",
        code: "INVALID_CAPSULE_PLAN",
      });
      expect(current.transport.commands).toStrictEqual(["initialize"]);
      expect(current.records.slice(-2)).toMatchObject([
        { eventKind: "failure", reason: "startupFailed" },
        { eventKind: "teardown", reason: "startupFailed" },
      ]);
      expect(current.registry.sessionIds()).toStrictEqual([]);
    },
  );

  it("denies a delayed first launch when the promoted plan expires before its attempt", async () => {
    let now = 0;
    const current = setup({
      now: () => now,
      onEvidence: (evidence) => {
        if (evidence.eventKind === "start") now = plan.expiresAtMs;
      },
    });
    await expect(current.manager.start(startInput)).rejects.toMatchObject({
      code: "INVALID_CAPSULE_PLAN",
    });
    expect(current.launch).not.toHaveBeenCalled();
    expect(current.connect).not.toHaveBeenCalled();
    expect(current.records.slice(-2)).toMatchObject([
      { eventKind: "failure", reason: "startupFailed" },
      { eventKind: "teardown", reason: "startupFailed" },
    ]);
    expect(current.registry.sessionIds()).toStrictEqual([]);
  });

  it("denies a retry after initialization advances beyond plan expiry", async () => {
    let now = 0;
    const firstHandle = capsule();
    const current = setup({
      now: () => now,
      endpoints: [endpoint(true, false)],
      launch: () => {
        now = plan.expiresAtMs;
        return Promise.resolve(firstHandle);
      },
    });
    await expect(current.manager.start(startInput)).rejects.toMatchObject({
      code: "INVALID_CAPSULE_PLAN",
    });
    expect(current.launch).toHaveBeenCalledTimes(1);
    expect(current.connect).toHaveBeenCalledTimes(1);
    expect(firstHandle.terminateScope).toHaveBeenCalledTimes(1);
    expect(firstHandle.cleanup).toHaveBeenCalledTimes(1);
    expect(current.records.slice(-2)).toMatchObject([
      { eventKind: "failure", reason: "startupFailed" },
      { eventKind: "teardown", reason: "startupFailed" },
    ]);
    expect(current.registry.sessionIds()).toStrictEqual([]);
  });

  it("explicit stop and runtime crash both await whole-scope teardown without an orphan", async () => {
    const stopped = setup();
    await stopped.manager.start(startInput);
    await stopped.manager.stop("session_a");
    expect(stopped.handle.terminateScope).toHaveBeenCalledTimes(1);
    expect(stopped.handle.cleanup).toHaveBeenCalledTimes(1);

    const crashed = setup();
    await crashed.manager.start(startInput);
    await crashed.handle.emitExit();
    expect(crashed.handle.terminateScope).toHaveBeenCalledTimes(1);
    expect(crashed.handle.cleanup).toHaveBeenCalledTimes(1);
    expect(crashed.manager.health("session_a")).toBeUndefined();
  });

  it("tears down and holds capacity when active evidence is not durable", async () => {
    let evidenceAvailable = false;
    const current = setup({
      appendEvidence: (evidence) =>
        evidence.eventKind === "start" || evidenceAvailable
          ? Promise.resolve()
          : Promise.reject(new Error("private")),
    });

    await expect(current.manager.start(startInput)).rejects.toThrow("private");
    expect(current.handle.terminateScope).toHaveBeenCalledTimes(1);
    expect(current.handle.cleanup).toHaveBeenCalledTimes(1);
    expect(current.transport.close).toHaveBeenCalledTimes(1);
    expect(current.resourceCleanups[0]).toHaveBeenCalledTimes(1);
    expect(current.resourceCleanups[1]).toHaveBeenCalledTimes(1);
    expect(current.manager.health("session_a")).toMatchObject({
      state: "failed",
      health: "evidencePending",
      terminalReason: "startupFailed",
    });
    expect(() => current.manager.request("session_a", "threads", {}, "inspection")).toThrow(
      expect.objectContaining({ code: "SESSION_TERMINATING" }),
    );
    expect(() =>
      current.registry.reserveProvisional({
        ...startInput.identity,
        sessionId: "session_b",
        workspacePartitionKey: "partition_b",
      }),
    ).toThrow(expect.objectContaining({ code: "EVIDENCE_PENDING" }));

    evidenceAvailable = true;
    await current.registry.reconcile();
    expect(current.registry.health()).toBe("ready");
    expect(current.manager.health("session_a")).toBeUndefined();
    expect(current.handle.terminateScope).toHaveBeenCalledTimes(1);
    expect(current.transport.close).toHaveBeenCalledTimes(1);
    expect(current.resourceCleanups[0]).toHaveBeenCalledTimes(1);
    expect(current.resourceCleanups[1]).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale exit callback from a terminated startup attempt", async () => {
    const first = capsule();
    const second = capsule();
    const firstEndpoint = endpoint(true, false);
    const current = setup({
      handles: [first, second],
      endpoints: [firstEndpoint, endpoint()],
    });
    await current.manager.start(startInput);
    expect(first.terminateScope).toHaveBeenCalledTimes(1);
    await first.emitExit();
    firstEndpoint.end();
    await new Promise((resolve) => setImmediate(resolve));
    expect(current.manager.health("session_a")?.state).toBe("running");
    expect(second.terminateScope).not.toHaveBeenCalled();
    await current.manager.stop("session_a");
  });

  it("routes unexpected endpoint EOF through awaited failure teardown without an orphan", async () => {
    const events = createDapEventBridge();
    const projected: unknown[] = [];
    const subscription = events.subscribe({
      channel: { workspacePartitionKey: "partition_a", browserSessionBinding: "browser_a" },
      onEvent: (event): void => void projected.push(event.event),
    });
    if (subscription.kind !== "ok") throw new Error("invalid test fixture");
    const current = setup({ events });
    await current.manager.start(startInput);
    current.transport.end();
    await vi.waitFor(() => {
      expect(current.handle.terminateScope).toHaveBeenCalledTimes(1);
    });
    expect(current.handle.cleanup).toHaveBeenCalledTimes(1);
    expect(current.records.some((record) => record.reason === "unexpectedEof")).toBe(true);
    expect(current.manager.health("session_a")).toBeUndefined();
    expect(projected).toStrictEqual([
      { kind: "session-started", sessionId: "session_a", status: "running" },
      { kind: "session-stopped", sessionId: "session_a", status: "failed", reason: "failed" },
    ]);
    subscription.unsubscribe();
  });

  it("routes frame overflow and fatal writes through the same awaited terminal path", async () => {
    const overflow = setup();
    await overflow.manager.start(startInput);
    overflow.transport.fail(new DapFrameRejectError("PAYLOAD_TOO_LARGE"));
    await vi.waitFor(() => {
      expect(overflow.handle.terminateScope).toHaveBeenCalledTimes(1);
    });
    expect(overflow.records.some((record) => record.reason === "frameOverflow")).toBe(true);

    const write = setup();
    await write.manager.start(startInput);
    write.transport.failWrites = true;
    await expect(
      write.manager.request("session_a", "threads", {}, "inspection"),
    ).rejects.toMatchObject({ code: "WRITE_FAILED" });
    await vi.waitFor(() => {
      expect(write.handle.terminateScope).toHaveBeenCalledTimes(1);
      expect(write.records.some((record) => record.reason === "writeFailure")).toBe(true);
    });
  });

  it("starts whole-scope kill before a hanging endpoint close and returns WRITE_FAILED promptly", async () => {
    vi.useFakeTimers();
    const hanging = endpoint();
    const close = vi.spyOn(hanging, "close").mockImplementation(() => new Promise(() => undefined));
    const current = setup({ endpoint: hanging });
    await current.manager.start(startInput);
    hanging.failWrites = true;
    await expect(
      current.manager.request("session_a", "threads", {}, "inspection"),
    ).rejects.toMatchObject({ code: "WRITE_FAILED" });
    expect(current.handle.terminateScope).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(current.manager.health("session_a")).toMatchObject({
      health: "terminationPending",
      terminalReason: "writeFailure",
    });
    expect(() => current.registry.protocol("session_a")).toThrow(
      expect.objectContaining({ code: "SESSION_TERMINATING" }),
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(hanging.destroy).toHaveBeenCalledTimes(1);
    expect(current.registry.health()).toBe("terminationPending");
    vi.useRealTimers();
  });

  it("finishes teardown when forced endpoint destruction completes its pending close", async () => {
    vi.useFakeTimers();
    let releaseClose: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const pending = endpoint();
    vi.spyOn(pending, "close").mockReturnValue(closed);
    vi.spyOn(pending, "destroy").mockImplementation(() => {
      releaseClose?.();
    });
    const current = setup({ endpoint: pending });
    await current.manager.start(startInput);
    pending.failWrites = true;

    await expect(
      current.manager.request("session_a", "threads", {}, "inspection"),
    ).rejects.toMatchObject({ code: "WRITE_FAILED" });
    await vi.advanceTimersByTimeAsync(250);

    await vi.waitFor(() => {
      expect(pending.destroy).toHaveBeenCalledTimes(1);
      expect(current.manager.health("session_a")).toBeUndefined();
    });
    vi.useRealTimers();
  });

  it("awaits output-overflow and revocation teardown through manager entrypoints", async () => {
    const outputEvents = createDapEventBridge();
    const projected: unknown[] = [];
    const subscription = outputEvents.subscribe({
      channel: { workspacePartitionKey: "partition_a", browserSessionBinding: "browser_a" },
      onEvent: (event): void => void projected.push(event.event),
    });
    if (subscription.kind !== "ok") throw new Error("invalid test fixture");
    const output = setup({ events: outputEvents });
    await output.manager.start(startInput);
    output.transport.emit({
      seq: 499,
      type: "event",
      event: "continued",
      body: { output: "A".repeat(16 * 1024) },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(output.handle.terminateScope).not.toHaveBeenCalled();
    for (let index = 0; index < 63; index += 1) {
      output.transport.emit({
        seq: 500 + index,
        type: "event",
        event: "output",
        body: { output: "A".repeat(16 * 1024) },
      });
    }
    await vi.waitFor(() => {
      expect(output.manager.health("session_a")?.outputAcceptedBytes).toBe(63 * 16 * 1024);
    });
    await expect(output.manager.request("session_a", "pause", {}, "control")).resolves.toEqual({});
    output.transport.emit({
      seq: 600,
      type: "event",
      event: "output",
      body: { output: "A".repeat(16 * 1024) },
    });
    await vi.waitFor(() => {
      expect(output.handle.terminateScope).toHaveBeenCalledTimes(1);
    });
    expect(output.records.some((record) => record.reason === "outputOverflow")).toBe(true);
    expect(output.outputLimits).toStrictEqual([
      { kind: "output-limit", sessionId: "session_a", acceptedBytes: 1024 * 1024 },
    ]);
    const terminal = projected.filter(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        "kind" in event &&
        event.kind === "session-stopped",
    );
    expect(terminal).toStrictEqual([
      {
        kind: "session-stopped",
        sessionId: "session_a",
        status: "stopped",
        reason: "limit",
      },
    ]);
    expect(projected.at(-2)).toMatchObject({ kind: "output", sessionId: "session_a" });
    expect(projected.at(-1)).toStrictEqual(terminal[0]);
    subscription.unsubscribe();

    const revoked = setup();
    await revoked.manager.start(startInput);
    await revoked.manager.revoke("session_a");
    expect(revoked.records.some((record) => record.eventKind === "session-revoked")).toBe(true);
  });

  it("sweeps registry-owned wall expiry", async () => {
    let now = 0;
    const current = setup({ now: () => now });
    await current.manager.start(startInput);
    now = 30 * 60 * 1_000 + 1;
    await current.manager.sweepExpired();
    expect(current.handle.terminateScope).toHaveBeenCalledTimes(1);
    expect(current.records.some((record) => record.reason === "wallTimeout")).toBe(true);
  });

  it("enforces manager control/inspection deadlines and forwards cancellation signals", async () => {
    vi.useFakeTimers();
    const current = setup();
    await current.manager.start(startInput);
    current.transport.respond = false;
    const control = current.manager.request("session_a", "pause", {}, "control");
    const controlRejection = expect(control).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(current.manager.health("session_a")?.pendingRequestCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await controlRejection;

    const inspection = current.manager.request("session_a", "threads", {}, "inspection");
    const inspectionRejection = expect(inspection).rejects.toMatchObject({
      code: "REQUEST_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(current.manager.health("session_a")?.pendingRequestCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await inspectionRejection;

    const controller = new AbortController();
    const cancelled = current.manager.request(
      "session_a",
      "stackTrace",
      {},
      "inspection",
      controller.signal,
    );
    const cancelledRejection = expect(cancelled).rejects.toMatchObject({
      code: "REQUEST_CANCELLED",
    });
    controller.abort();
    await cancelledRejection;
    await current.manager.stop("session_a");
    vi.useRealTimers();
  });

  it("stops retrying when failed startup scope termination remains pending", async () => {
    const uncontained = capsule();
    uncontained.terminateScope.mockResolvedValue({
      terminated: false,
      descendantsRemaining: 1,
    });
    const current = setup({
      handles: [uncontained],
      endpoints: [endpoint(true, false)],
    });
    await expect(current.manager.start(startInput)).rejects.toMatchObject({
      code: "ADAPTER_REJECTED",
    });
    expect(current.launch).toHaveBeenCalledTimes(1);
    expect(current.registry.health()).toBe("terminationPending");
  });

  it("uses malformedFrame as the closed default fatal reason", async () => {
    const current = setup();
    await current.manager.start(startInput);
    current.transport.emitBody("{bad");
    await vi.waitFor(() => {
      expect(current.handle.terminateScope).toHaveBeenCalledTimes(1);
    });
    expect(current.records.some((record) => record.reason === "malformedFrame")).toBe(true);
  });

  it("owns and terminates a late capsule exactly once after shutdown", async () => {
    let resolveLaunch: ((handle: TestCapsule) => void) | undefined;
    const late = capsule();
    const launch = (): Promise<TestCapsule> =>
      new Promise<TestCapsule>((resolve) => {
        resolveLaunch = resolve;
      });
    const current = setup({ launch });
    const starting = current.manager.start(startInput);
    const rejectedStart = expect(starting).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    await vi.waitFor(() => {
      expect(current.launch).toHaveBeenCalledTimes(1);
    });
    let shutdownSettled = false;
    const shutdown = current.manager.shutdown().then(() => {
      shutdownSettled = true;
    });
    await vi.waitFor(() => {
      expect(current.manager.health("session_a")).toMatchObject({
        state: "terminationPending",
        health: "terminationPending",
      });
    });
    expect(shutdownSettled).toBe(false);
    await expect(
      current.registry.reserve({
        ...identity,
        sessionId: "session_b",
        planId: "plan_b",
        planEpoch: 1,
        planExpiresAtMs: 10_000,
        provisioningDigest: "a".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "TERMINATION_PENDING" });
    resolveLaunch?.(late);
    await shutdown;
    await rejectedStart;
    expect(current.connect).not.toHaveBeenCalled();
    expect(late.terminateScope).toHaveBeenCalledTimes(1);
    expect(late.cleanup).toHaveBeenCalledTimes(1);
    expect(current.records.filter((record) => record.reason === "serverShutdown")).toHaveLength(2);
  });

  it("closes a private endpoint that arrives after shutdown exactly once", async () => {
    let resolveEndpoint: ((value: TestEndpoint) => void) | undefined;
    const lateEndpoint = endpoint();
    const current = setup({
      connectEndpoint: () =>
        new Promise<TestEndpoint>((resolve) => {
          resolveEndpoint = resolve;
        }),
    });
    const starting = current.manager.start(startInput);
    const rejectedStart = expect(starting).rejects.toMatchObject({ code: "SESSION_TERMINATING" });
    await vi.waitFor(() => {
      expect(current.connect).toHaveBeenCalledTimes(1);
    });
    await current.manager.shutdown();
    resolveEndpoint?.(lateEndpoint);
    await rejectedStart;
    expect(lateEndpoint.close).toHaveBeenCalledTimes(1);
    expect(lateEndpoint.destroy).not.toHaveBeenCalled();
    expect(current.handle.terminateScope).toHaveBeenCalledTimes(1);
  });

  it("fails an unresponsive adapter closed and records restartThrottled", async () => {
    vi.useFakeTimers();
    const current = setup({ endpoint: endpoint(false) });
    const starting = current.manager.start(startInput);
    const observed = starting.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(current.launch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(current.launch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(current.registry.session("session_a")).toBeDefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(await observed).toMatchObject({ code: "STARTUP_THROTTLED" });
    expect(current.launch).toHaveBeenCalledTimes(2);
    expect(current.records).toContainEqual(
      expect.objectContaining({
        eventKind: "failure",
        state: "restartThrottled",
        reason: "restartThrottled",
      }),
    );
    vi.useRealTimers();
  });

  it("rejects a Layer-2 denial before reservation or spawn", async () => {
    const current = setup({ validate: () => Promise.reject(new Error("private")) });
    await expect(current.manager.start(startInput)).rejects.toMatchObject({
      code: "INVALID_CAPSULE_PLAN",
    });
    expect(current.launch).not.toHaveBeenCalled();
    expect(current.registry.sessionIds()).toStrictEqual([]);
  });

  it("denies provider command preflight with zero Layer-2, evidence, or launcher calls", async () => {
    const current = setup({ commandAllowed: false });
    await expect(current.manager.start(startInput)).rejects.toMatchObject({
      code: "EXECUTABLE_NOT_FOUND",
    });
    expect(current.validatePlan).not.toHaveBeenCalled();
    expect(current.records).toStrictEqual([]);
    expect(current.launch).not.toHaveBeenCalled();
    expect(current.registry.sessionIds()).toStrictEqual([]);
  });

  it("reserves canonical capacity before preflight and blocks concurrent over-cap allocation", async () => {
    let releaseValidation: ((value: Layer2DebugCapsulePlan) => void) | undefined;
    const current = setup({
      validate: () =>
        new Promise<Layer2DebugCapsulePlan>((resolve) => {
          releaseValidation = resolve;
        }),
    });
    const first = current.manager.start(startInput);
    await vi.waitFor(() => {
      expect(current.validatePlan).toHaveBeenCalledTimes(1);
    });
    await expect(
      current.manager.start({
        ...startInput,
        identity: { ...identity, sessionId: "session_b" },
      }),
    ).rejects.toMatchObject({ code: "CAPACITY" });
    expect(current.adapterPreflight).toHaveBeenCalledTimes(1);
    expect(current.validatePlan).toHaveBeenCalledTimes(1);
    expect(current.launch).not.toHaveBeenCalled();
    releaseValidation?.(plan);
    await first;
    await current.manager.stop("session_a");
  });

  it("rejects an unknown provider with an exact closed manager error", async () => {
    const current = setup();
    try {
      await current.manager.start({
        ...startInput,
        adapterProviderId: "missing",
      });
      throw new Error("expected rejection");
    } catch (error: unknown) {
      expect(error).toMatchObject({
        name: "DapProcessManagerError",
        message: "INVALID_CAPSULE_PLAN",
        code: "INVALID_CAPSULE_PLAN",
      });
    }
    expect(current.validatePlan).not.toHaveBeenCalled();
    expect(current.adapterPreflight).not.toHaveBeenCalled();
    expect(current.launch).not.toHaveBeenCalled();
    expect(current.registry.sessionIds()).toStrictEqual([]);
  });

  it.each([
    { networkPolicy: "inherit" },
    { supportedTargetKinds: [] },
    { supportedLaunchKinds: [] },
    { supportedAttachKinds: ["process"] },
    { reverseRequestAllowlist: ["spawn"] },
    { requiredExecutables: [] },
  ])("rejects an open or incomplete adapter spec %# before preflight", async (specOverrides) => {
    const current = setup({ specOverrides });
    await expect(current.manager.start(startInput)).rejects.toMatchObject({
      code: "INVALID_CAPSULE_PLAN",
    });
    expect(current.adapterPreflight).not.toHaveBeenCalled();
    expect(current.validatePlan).not.toHaveBeenCalled();
    expect(current.registry.sessionIds()).toStrictEqual([]);
  });

  it("ignores stale, non-output, null, and non-string output projections", async () => {
    const current = setup();
    await current.manager.start(startInput);
    for (const [index, message] of [
      { event: "continued", body: { output: "hidden" } },
      { event: "output", body: null },
      { event: "output", body: { output: 1 } },
      { event: "output", body: { output: "hidden", category: "telemetry" } },
    ].entries()) {
      current.transport.emit({ seq: 700 + index, type: "event", ...message });
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(current.manager.health("session_a")?.outputAcceptedBytes).toBe(0);
    await current.manager.stop("session_a");
  });

  it.each([
    { args: ["--hostile"] },
    { env: { TOKEN: "hostile" } },
    { cwd: "/host" },
    { runtime: "/host/node" },
    { program: "/host/program" },
  ])("honors Layer-2 rejection of launch drift before reserve or spawn", async (candidate) => {
    const current = setup({
      validate: () => Promise.reject(new Error("drift")),
    });
    await expect(
      current.manager.start({ ...startInput, planCandidate: candidate }),
    ).rejects.toMatchObject({ code: "INVALID_CAPSULE_PLAN" });
    expect(current.records).toStrictEqual([]);
    expect(current.launch).not.toHaveBeenCalled();
  });

  it("rolls back provisional capacity when the real Layer-2 parser rejects execution data", async () => {
    const real = createDebugLaunchLayer2Validator({
      resolveContext: () => Promise.reject(new Error("must not resolve")),
      now: () => 0,
      epoch: () => 1,
    });
    const current = setup({ validate: (input) => real.validateAndRederive(input) });
    await expect(
      current.manager.start({
        ...startInput,
        planCandidate: { kind: "file", fileId: "app.js", backend: "oci" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_CAPSULE_PLAN" });
    expect(current.registry.sessionIds()).toStrictEqual([]);
    expect(current.records).toStrictEqual([]);
    expect(current.launch).not.toHaveBeenCalled();
    expect(current.connect).not.toHaveBeenCalled();
  });

  it("rejects plan replay before a second reservation or launcher call", async () => {
    const current = setup();
    await current.manager.start(startInput);
    await current.manager.stop("session_a");
    await expect(current.manager.start(startInput)).rejects.toMatchObject({ code: "CAPACITY" });
    expect(current.launch).toHaveBeenCalledTimes(1);
    expect(current.records.filter((record) => record.eventKind === "start")).toHaveLength(1);
  });

  it("supports a qualified launcher handle without an exit callback", async () => {
    const withoutExit = capsule();
    delete withoutExit.onExit;
    const current = setup({ handles: [withoutExit] });
    await expect(current.manager.start(startInput)).resolves.toBeUndefined();
    expect(current.manager.health("session_a")?.state).toBe("running");
    await current.manager.stop("session_a");
  });

  it("ignores a fatal protocol signal from an obsolete startup attempt", async () => {
    const first = capsule();
    const second = capsule();
    const staleEndpoint = endpoint(true, false);
    const current = setup({
      handles: [first, second],
      endpoints: [staleEndpoint, endpoint()],
    });
    await current.manager.start(startInput);
    staleEndpoint.emit({
      seq: 900,
      type: "event",
      event: "output",
      body: { output: "hidden" },
    });
    staleEndpoint.emitBody("{bad");
    await new Promise((resolve) => setImmediate(resolve));
    expect(current.manager.health("session_a")?.state).toBe("running");
    expect(current.manager.health("session_a")?.outputAcceptedBytes).toBe(0);
    expect(second.terminateScope).not.toHaveBeenCalled();
    await current.manager.stop("session_a");
  });

  it("settles a pending DAP request when canonical stop disposes the protocol", async () => {
    const current = setup();
    await current.manager.start(startInput);
    current.transport.respond = false;
    const pending = current.manager.request("session_a", "threads", {}, "inspection");
    const rejection = expect(pending).rejects.toMatchObject({ code: "CLIENT_DISPOSED" });
    await vi.waitFor(() => {
      expect(current.manager.health("session_a")?.pendingRequestCount).toBe(1);
    });
    await current.manager.stop("session_a");
    await rejection;
    expect(current.handle.terminateScope).toHaveBeenCalledTimes(1);
  });
});

const startInput = {
  identity,
  adapterRuntime: "node",
  adapterProviderId: "node",
  planCandidate: {},
};
