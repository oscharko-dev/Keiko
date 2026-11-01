import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CodingWorkbenchCodexSubscriptionProfile,
  CodingWorkbenchRuntimeSnapshot,
  CodingWorkbenchRuntimeSseEvent,
  WorkspaceManifestAccess,
} from "@oscharko-dev/keiko-contracts";
import {
  fetchCodingWorkbenchCodexSubscriptionProfile,
  fetchCodingWorkbenchSidecarGatewayProfile,
} from "./coding-workbench-provider-api";
import {
  createCodingWorkbenchRuntimeEventSource,
  decideCodingWorkbenchRuntimeApproval,
  getCodingWorkbenchRuntimeReadiness,
  getCodingWorkbenchRuntimeStatus,
  startCodingWorkbenchRuntime,
  stopCodingWorkbenchRuntime,
  submitCodingWorkbenchRuntimeFollowUp,
  takeOverCodingWorkbenchRuntime,
} from "./coding-workbench-runtime-api";
import { ApiError } from "./api-shared-primitives";
import {
  CODING_WORKBENCH_OBSERVATION_BATCH_MS,
  useCodingWorkbenchRuntimeEventStream,
} from "./coding-workbench-event-retention";
import {
  useCodingWorkbenchRuntime,
  type UseCodingWorkbenchRuntimeInput,
} from "./useCodingWorkbenchRuntime";

vi.mock("./coding-workbench-provider-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./coding-workbench-provider-api")>();
  return {
    ...actual,
    fetchCodingWorkbenchCodexSubscriptionProfile: vi.fn(),
    fetchCodingWorkbenchSidecarGatewayProfile: vi.fn(),
  };
});

vi.mock("./coding-workbench-runtime-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./coding-workbench-runtime-api")>();
  return {
    ...actual,
    createCodingWorkbenchRuntimeEventSource: vi.fn(),
    decideCodingWorkbenchRuntimeApproval: vi.fn(),
    getCodingWorkbenchRuntimeReadiness: vi.fn(),
    getCodingWorkbenchRuntimeStatus: vi.fn(),
    startCodingWorkbenchRuntime: vi.fn(),
    stopCodingWorkbenchRuntime: vi.fn(),
    submitCodingWorkbenchRuntimeFollowUp: vi.fn(),
    takeOverCodingWorkbenchRuntime: vi.fn(),
  };
});

// Release-audit F-08/RG-12: the boot pairing dimension is fed by the honest workspaces read
// (`session: "paired" | "unpaired"`), never guessed client-side.
const manifestAccessMock = vi.hoisted(() => vi.fn());
vi.mock("./workspace-manifest-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workspace-manifest-api")>();
  return { ...actual, fetchWorkspaceManifestAccess: manifestAccessMock };
});

const UPDATED_AT = "2026-07-13T12:00:00.000Z";

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly close = vi.fn();
  private readonly listeners = new Map<string, EventListener[]>();

  constructor() {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener),
    );
  }

  dispatch(type: "status" | "runtime-event" | "reset", data = "{}"): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data }));
    }
  }
}

function snapshot(
  overrides: Partial<CodingWorkbenchRuntimeSnapshot> = {},
): CodingWorkbenchRuntimeSnapshot {
  return {
    schemaVersion: "1",
    state: "awaiting-approval",
    revision: 4,
    updatedAt: UPDATED_AT,
    runId: "run-1",
    pendingPermission: {
      requestId: "permission-old",
      kind: "delivery-substrate",
      actionClass: "delivery-substrate",
      reasonCode: "approval-required",
      actionKind: "push",
      scopeLabel: "workspace-scope",
      risk: "high",
      policyReason: "approval-required",
      expiresAt: "2026-07-13T12:05:00.000Z",
    },
    ...overrides,
  } as CodingWorkbenchRuntimeSnapshot;
}

function event(sequence: number): CodingWorkbenchRuntimeSseEvent {
  return {
    schemaVersion: "1",
    cursor: `cursor-${String(sequence)}`,
    sequence,
    occurredAt: UPDATED_AT,
    kind: "status",
    runId: "run-1",
    state: "awaiting-approval",
    revision: 4,
  };
}

function observation(sequence: number): CodingWorkbenchRuntimeSseEvent {
  return {
    ...event(sequence),
    kind: "runtime-event",
    state: "running",
    revision: sequence,
    eventKind: "observation-streamed",
  };
}

function connectedCodexProfile(): CodingWorkbenchCodexSubscriptionProfile {
  return {
    schemaVersion: "1",
    profileId: "codex-subscription",
    modelSource: "chatgpt-codex-subscription-profile",
    runtimeSource: "codex-cli-adapter",
    status: "connected",
    authMethod: "chatgpt-device-code",
    credentialStore: "keyring",
    stateScope: "os-credential-store",
    stateRoot: "os-credential-store",
    usesGlobalCodexHome: false,
    runtimeBinarySources: ["managed-sidecar-runtime"],
    supportsBrowserLogin: true,
    supportsDeviceCode: true,
    supportsAccessToken: true,
    deploymentPolicyDisabled: false,
    headless: false,
  };
}

function workspace(): UseCodingWorkbenchRuntimeInput["workspace"] {
  return {
    activeBinding: { workspaceId: "workspace-1", taskId: "task-1" },
    activeInstance: { taskBranch: "issue/2257", health: "healthy" },
    loading: false,
    switching: false,
    error: null,
    refresh: vi.fn(),
  } as unknown as UseCodingWorkbenchRuntimeInput["workspace"];
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve: (value) => resolve?.(value) };
}

function installBootstrap(initial: CodingWorkbenchRuntimeSnapshot, refreshed = initial): void {
  vi.mocked(fetchCodingWorkbenchSidecarGatewayProfile).mockResolvedValue({
    status: "available",
    profileId: "gateway-redacted",
    modelAlias: "model-redacted",
    localEndpointPath: "/api/coding-sidecar/gateway",
    supportsStreaming: true,
    supportsToolCalling: true,
    runMetadata: {
      maxPromptTokens: 128_000,
      maxOutputTokens: 4_096,
      maxInputMessages: 64,
      maxRequestBytes: 64_000,
    },
    verification: "verified",
  });
  vi.mocked(getCodingWorkbenchRuntimeReadiness).mockResolvedValue({
    schemaVersion: "1",
    requestedMode: "governed-assist",
    deploymentCeiling: "autonomous-delivery",
    effectiveMode: "governed-assist",
    runtimeAvailable: true,
    selectableAgents: ["build"],
  });
  vi.mocked(getCodingWorkbenchRuntimeStatus)
    .mockResolvedValueOnce(initial)
    .mockResolvedValue(refreshed);
}

describe("useCodingWorkbenchRuntime", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.mocked(createCodingWorkbenchRuntimeEventSource).mockImplementation(
      (): EventSource => new FakeEventSource() as unknown as EventSource,
    );
    manifestAccessMock.mockResolvedValue({ session: "paired", manifests: [] });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("keeps one stream through three reconnects and resynchronises after reset", async () => {
    const resynchronised = snapshot({
      revision: 5,
      state: "running",
      pendingPermission: undefined,
    });
    installBootstrap(snapshot(), resynchronised);
    const activeWorkspace = workspace();
    const view = renderHook(() => useCodingWorkbenchRuntime({ workspace: activeWorkspace }));

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    expect(source).toBeDefined();
    act(() => {
      source?.onopen?.(new Event("open"));
      source?.dispatch("status", JSON.stringify(event(1)));
      for (let attempt = 0; attempt < 3; attempt += 1) {
        source?.onerror?.(new Event("error"));
        source?.onopen?.(new Event("open"));
      }
      source?.dispatch("status", JSON.stringify(event(1)));
    });

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(view.result.current.state.events).toHaveLength(1);
    expect(view.result.current.state.stream.status).toBe("ready");

    act(() => source?.dispatch("reset"));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(source?.close).toHaveBeenCalled();
    expect(view.result.current.state.events).toEqual([]);
    expect(view.result.current.state.run.value).toMatchObject({ revision: 5, state: "running" });

    view.unmount();
  });

  it("closes the stream after a terminal resnapshot and never creates a reconnecting stream", async () => {
    const running = snapshot({ state: "running", pendingPermission: undefined });
    const terminal = snapshot({ state: "succeeded", revision: 5, pendingPermission: undefined });
    installBootstrap(running, terminal);
    const activeWorkspace = workspace();
    const view = renderHook(() => useCodingWorkbenchRuntime({ workspace: activeWorkspace }));

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    act(() => {
      source?.dispatch("status", JSON.stringify({ ...event(1), state: "succeeded", revision: 5 }));
    });

    await waitFor(() => expect(view.result.current.state.run.value?.state).toBe("succeeded"));
    expect(source?.close).toHaveBeenCalledOnce();
    expect(view.result.current.state.stream.status).toBe("idle");
    act(() => source?.onerror?.(new Event("error")));
    expect(view.result.current.state.stream.status).toBe("idle");
    expect(FakeEventSource.instances).toHaveLength(1);

    view.unmount();
  });

  it("retains SSE terminal truth when post-settlement status is idle", async (): Promise<void> => {
    const running = snapshot({ state: "running", pendingPermission: undefined });
    const terminal = snapshot({ state: "succeeded", revision: 5, pendingPermission: undefined });
    const idle = snapshot({
      state: "idle",
      revision: 0,
      runId: undefined,
      pendingPermission: undefined,
    });
    installBootstrap(running, idle);
    const activeWorkspace = workspace();
    const view = renderHook((): ReturnType<typeof useCodingWorkbenchRuntime> =>
      useCodingWorkbenchRuntime({ workspace: activeWorkspace }),
    );

    await waitFor((): void => expect(FakeEventSource.instances).toHaveLength(1));
    act((): void => {
      FakeEventSource.instances[0]?.dispatch(
        "status",
        JSON.stringify({ ...event(1), state: "succeeded", revision: 5 }),
      );
    });
    await waitFor((): void => {
      expect(view.result.current.state.run).toEqual({
        status: "ready",
        value: terminal,
        error: null,
      });
    });
    const terminalEvents = view.result.current.state.events;
    expect(terminalEvents).toHaveLength(1);
    expect(view.result.current.state.events).toEqual(terminalEvents);
    view.unmount();
  });

  it("commits observations at no more than 10Hz even when status facts are interleaved", () => {
    vi.useFakeTimers();
    const observationCommitTimes: number[] = [];
    const view = renderHook(() =>
      useCodingWorkbenchRuntimeEventStream("run-1", 0, {
        onOpen: vi.fn(),
        onEvents: (events) => {
          if (events.some((entry) => entry.kind === "runtime-event")) {
            observationCommitTimes.push(Date.now());
          }
        },
        onError: vi.fn(),
        onReset: vi.fn(() => Promise.resolve()),
      }),
    );
    const source = FakeEventSource.instances[0];

    act(() => {
      for (let sequence = 1; sequence <= 20; sequence += 1) {
        source?.dispatch("runtime-event", JSON.stringify(observation(sequence)));
        if (sequence % 2 === 0) {
          source?.dispatch("status", JSON.stringify(event(100 + sequence)));
        }
        vi.advanceTimersByTime(20);
      }
      vi.advanceTimersByTime(CODING_WORKBENCH_OBSERVATION_BATCH_MS);
    });

    expect(observationCommitTimes.length).toBeLessThanOrEqual(5);
    expect(
      observationCommitTimes.slice(1).every((time, index) => {
        const previous = observationCommitTimes[index];
        return previous !== undefined && time - previous >= CODING_WORKBENCH_OBSERVATION_BATCH_MS;
      }),
    ).toBe(true);
    view.unmount();
  });

  it("binds approval to the current revision and ignores a stale completion after resnapshot", async () => {
    const replaced = snapshot({
      revision: 5,
      pendingPermission: { ...snapshot().pendingPermission!, requestId: "permission-new" },
    });
    installBootstrap(snapshot(), replaced);
    const approval = deferred<CodingWorkbenchRuntimeSnapshot>();
    vi.mocked(decideCodingWorkbenchRuntimeApproval).mockReturnValue(approval.promise);
    const activeWorkspace = workspace();
    const view = renderHook(() => useCodingWorkbenchRuntime({ workspace: activeWorkspace }));

    await waitFor(() => expect(view.result.current.state.run.value?.revision).toBe(4));
    const pending = view.result.current.actions.decideApproval("approved");
    await waitFor(() => expect(decideCodingWorkbenchRuntimeApproval).toHaveBeenCalledOnce());
    expect(decideCodingWorkbenchRuntimeApproval).toHaveBeenCalledWith(
      "run-1",
      {
        requestId: "permission-old",
        expectedRevision: 4,
        decision: "approved",
      },
      expect.any(AbortSignal),
    );

    await act(async () => {
      await view.result.current.actions.refreshRun();
    });
    expect(view.result.current.state.run.value?.pendingPermission?.requestId).toBe(
      "permission-new",
    );

    await act(async () => {
      approval.resolve(snapshot({ revision: 3, state: "running", pendingPermission: undefined }));
      await pending;
    });
    expect(view.result.current.state.run.value?.revision).toBe(5);
    expect(view.result.current.state.run.value?.pendingPermission?.requestId).toBe(
      "permission-new",
    );

    view.unmount();
  });

  it("does not install a stale run-scoped mutation completion after the active run changes", async () => {
    const replacement = snapshot({ runId: "run-2", revision: 1 });
    installBootstrap(snapshot(), replacement);
    const approval = deferred<CodingWorkbenchRuntimeSnapshot>();
    vi.mocked(decideCodingWorkbenchRuntimeApproval).mockReturnValue(approval.promise);
    const activeWorkspace = workspace();
    const view = renderHook(() => useCodingWorkbenchRuntime({ workspace: activeWorkspace }));

    await waitFor(() => expect(view.result.current.state.run.value?.runId).toBe("run-1"));
    const pending = view.result.current.actions.decideApproval("approved");
    await waitFor(() => expect(decideCodingWorkbenchRuntimeApproval).toHaveBeenCalledOnce());
    await act(async () => view.result.current.actions.refreshRun());
    expect(view.result.current.state.run.value?.runId).toBe("run-2");

    await act(async () => {
      approval.resolve(snapshot({ state: "running", revision: 5, pendingPermission: undefined }));
      await pending;
    });
    expect(view.result.current.state.run.value).toMatchObject({ runId: "run-2", revision: 1 });
    view.unmount();
  });

  it.each(["stop", "takeover"] as const)(
    "binds %s request identity to the current run id",
    async (action) => {
      const running = snapshot({ state: "running", pendingPermission: undefined });
      installBootstrap(running);
      vi.mocked(stopCodingWorkbenchRuntime).mockResolvedValue(running);
      vi.mocked(takeOverCodingWorkbenchRuntime).mockResolvedValue(running);
      const activeWorkspace = workspace();
      const view = renderHook(() => useCodingWorkbenchRuntime({ workspace: activeWorkspace }));

      await waitFor(() => expect(view.result.current.state.run.value?.state).toBe("running"));
      await act(async () => view.result.current.actions[action]());
      const api = action === "stop" ? stopCodingWorkbenchRuntime : takeOverCodingWorkbenchRuntime;
      expect(api).toHaveBeenCalledWith("run-1", { requestId: "run-1" }, expect.any(AbortSignal));
      view.unmount();
    },
  );

  it("does not install a managed source response after preference switches to Codex", async () => {
    installBootstrap(snapshot({ state: "idle", runId: undefined, pendingPermission: undefined }));
    const managed =
      deferred<Awaited<ReturnType<typeof fetchCodingWorkbenchSidecarGatewayProfile>>>();
    vi.mocked(fetchCodingWorkbenchSidecarGatewayProfile).mockReturnValueOnce(managed.promise);
    vi.mocked(fetchCodingWorkbenchCodexSubscriptionProfile).mockResolvedValue(
      connectedCodexProfile(),
    );
    const activeWorkspace = workspace();
    const view = renderHook(() => useCodingWorkbenchRuntime({ workspace: activeWorkspace }));

    await waitFor(() => expect(fetchCodingWorkbenchSidecarGatewayProfile).toHaveBeenCalledOnce());
    act(() => view.result.current.actions.setRuntimePreference("codex-subscription"));
    await waitFor(() =>
      expect(view.result.current.state.source.value).toMatchObject({
        runtimePreference: "codex-subscription",
        available: true,
      }),
    );

    await act(async () => {
      managed.resolve({
        status: "available",
        profileId: "managed-stale",
        modelAlias: "managed-stale",
        localEndpointPath: "/api/coding-sidecar/gateway",
        supportsStreaming: true,
        supportsToolCalling: true,
        runMetadata: {
          maxPromptTokens: 128_000,
          maxOutputTokens: 4_096,
          maxInputMessages: 64,
          maxRequestBytes: 64_000,
        },
        verification: "verified",
      });
      await managed.promise;
    });
    expect(view.result.current.state.source.value).toMatchObject({
      runtimePreference: "codex-subscription",
      modelSource: "chatgpt-codex-subscription-profile",
    });
    view.unmount();
  });

  it("recovers an unavailable source through its typed refresh action without resetting runtime truth", async () => {
    installBootstrap(snapshot());
    const activeWorkspace = workspace();
    const view = renderHook(() => useCodingWorkbenchRuntime({ workspace: activeWorkspace }));

    await waitFor(() => expect(view.result.current.state.source.status).toBe("ready"));
    vi.mocked(fetchCodingWorkbenchSidecarGatewayProfile).mockRejectedValueOnce(
      new Error("source temporarily unavailable"),
    );
    await act(async () => {
      await view.result.current.actions.refreshSource();
    });
    expect(view.result.current.state.source).toMatchObject({ status: "error", value: null });
    expect(view.result.current.state.run.value).toMatchObject({ runId: "run-1", revision: 4 });

    await act(async () => {
      await view.result.current.actions.refreshSource();
    });
    expect(view.result.current.state.source).toMatchObject({
      status: "ready",
      value: { available: true },
    });
    expect(view.result.current.state.run.value).toMatchObject({ runId: "run-1", revision: 4 });

    view.unmount();
  });

  // Customer 1.3.4: the Workbench judged the server's default model while the person had chosen
  // another one. The profile read carries the chosen model, and choosing reads it again.
  it("reads the gateway profile for the model chosen in the picker", async () => {
    installBootstrap(snapshot({ state: "idle", runId: undefined, pendingPermission: undefined }));
    const activeWorkspace = workspace();
    const view = renderHook(() => useCodingWorkbenchRuntime({ workspace: activeWorkspace }));
    await waitFor(() => expect(fetchCodingWorkbenchSidecarGatewayProfile).toHaveBeenCalled());
    expect(vi.mocked(fetchCodingWorkbenchSidecarGatewayProfile).mock.calls[0]?.[1]).toBeUndefined();

    act(() => view.result.current.actions.setSelectedModel("model-chosen"));

    await waitFor(() =>
      expect(fetchCodingWorkbenchSidecarGatewayProfile).toHaveBeenLastCalledWith(
        expect.any(String),
        "model-chosen",
      ),
    );
    view.unmount();
  });

  it("keeps Start blocked when a registered workspace is ready but the browser is unpaired", async () => {
    manifestAccessMock.mockResolvedValue({ session: "unpaired", manifests: [] });
    installBootstrap(snapshot({ state: "idle", runId: undefined, pendingPermission: undefined }));
    const activeWorkspace = workspace();
    const view = renderHook(() =>
      useCodingWorkbenchRuntime({
        workspace: activeWorkspace,
        initialRequestedMode: "governed-assist",
      }),
    );

    act(() => view.result.current.actions.setSelectedModel("model-redacted"));

    await waitFor(() => expect(view.result.current.state.pairing).toBe("unpaired"));
    await waitFor(() => expect(view.result.current.state.run.status).toBe("ready"));
    expect(view.result.current.state.canStart).toBe(false);

    view.unmount();
  });

  it("confirms the paired window through the same honest read before arming Start", async () => {
    const pairing = deferred<WorkspaceManifestAccess>();
    manifestAccessMock.mockReturnValueOnce(pairing.promise);
    installBootstrap(snapshot({ state: "idle", runId: undefined, pendingPermission: undefined }));
    const activeWorkspace = workspace();
    const view = renderHook(() =>
      useCodingWorkbenchRuntime({
        workspace: activeWorkspace,
        initialRequestedMode: "governed-assist",
      }),
    );

    act(() => view.result.current.actions.setSelectedModel("model-redacted"));
    await waitFor(() => expect(view.result.current.state.run.status).toBe("ready"));
    expect(view.result.current.state.pairing).toBe("unknown");
    expect(view.result.current.state.canStart).toBe(false);
    await act(async () => {
      pairing.resolve({ session: "paired", manifests: [] });
      await pairing.promise;
    });

    await waitFor(() => expect(view.result.current.state.pairing).toBe("paired"));
    await waitFor(() => expect(view.result.current.state.canStart).toBe(true));

    act(() => view.result.current.actions.setSelectedModel(null));
    expect(view.result.current.state.canStart).toBe(false);

    view.unmount();
  });

  // ADR-0137 D10: a message sent while a turn runs reaches the server as a delivery bound to the
  // running run's revision, and the answer installs the revision-bumped snapshot.
  describe("prompt inputs (ADR-0137 D10)", () => {
    it("sends a steering message with its references to a running turn and installs the answer", async () => {
      installBootstrap(snapshot({ state: "running", pendingPermission: undefined }));
      vi.mocked(getCodingWorkbenchRuntimeReadiness).mockResolvedValue({
        schemaVersion: "1",
        requestedMode: "governed-assist",
        deploymentCeiling: "autonomous-delivery",
        effectiveMode: "governed-assist",
        runtimeAvailable: true,
        selectableAgents: ["build", "plan"],
        promptInputs: { delivery: true, references: true },
      });
      vi.mocked(submitCodingWorkbenchRuntimeFollowUp).mockResolvedValue(
        snapshot({ state: "running", revision: 5, pendingPermission: undefined }),
      );
      const activeWorkspace = workspace();
      const view = renderHook(() =>
        useCodingWorkbenchRuntime({
          workspace: activeWorkspace,
          initialRequestedMode: "governed-assist",
        }),
      );
      await waitFor(() =>
        expect(view.result.current.state.promptInputs).toEqual({
          delivery: true,
          references: true,
        }),
      );
      act(() => view.result.current.actions.setAgent("plan"));
      await act(async () => {
        await view.result.current.actions.submitFollowUp("also look at @src/app.ts", {
          delivery: "steer",
          references: [{ path: "src/app.ts" }],
        });
      });
      expect(submitCodingWorkbenchRuntimeFollowUp).toHaveBeenLastCalledWith(
        "run-1",
        {
          requestId: expect.any(String) as unknown,
          expectedRevision: expect.any(Number) as unknown,
          taskIntent: "also look at @src/app.ts",
          delivery: "steer",
          references: [{ path: "src/app.ts" }],
        },
        expect.any(AbortSignal),
      );
      await waitFor(() => expect(view.result.current.state.run.value?.revision).toBe(5));
      expect(view.result.current.state.mutation.status).toBe("idle");
      view.unmount();
    });

    it("starts a task whose first prompt references files and opens with a command, through the mutation queue", async () => {
      installBootstrap(snapshot({ state: "idle", runId: undefined, pendingPermission: undefined }));
      vi.mocked(startCodingWorkbenchRuntime).mockResolvedValue(
        snapshot({ state: "starting", runId: "run-2", pendingPermission: undefined }),
      );
      const activeWorkspace = workspace();
      const view = renderHook(() =>
        useCodingWorkbenchRuntime({
          workspace: activeWorkspace,
          initialRequestedMode: "governed-assist",
        }),
      );
      act(() => view.result.current.actions.setSelectedModel("model-redacted"));
      await waitFor(() => expect(view.result.current.state.canStart).toBe(true));

      await act(async () => {
        await view.result.current.actions.start("@src/app.ts", {
          projectMemoryEnabled: true,
          references: [{ path: "src/app.ts" }],
          command: { name: "review" },
        });
      });

      expect(startCodingWorkbenchRuntime).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          requestId: expect.any(String) as unknown,
          taskIntent: "@src/app.ts",
          references: [{ path: "src/app.ts" }],
          command: { name: "review" },
        }),
        expect.any(AbortSignal),
      );
      await waitFor(() => expect(view.result.current.state.run.value?.runId).toBe("run-2"));
      expect(view.result.current.state.mutation.status).toBe("idle");
      view.unmount();
    });

    it("sends a command with an empty text to a paused run, bound to its revision", async () => {
      installBootstrap(snapshot({ state: "paused", pendingPermission: undefined }));
      vi.mocked(submitCodingWorkbenchRuntimeFollowUp).mockResolvedValue(
        snapshot({ state: "running", revision: 5, pendingPermission: undefined }),
      );
      const activeWorkspace = workspace();
      const view = renderHook(() =>
        useCodingWorkbenchRuntime({
          workspace: activeWorkspace,
          initialRequestedMode: "governed-assist",
        }),
      );
      await waitFor(() => expect(view.result.current.state.run.value?.state).toBe("paused"));

      await act(async () => {
        await view.result.current.actions.submitFollowUp("", { command: { name: "init" } });
      });

      expect(submitCodingWorkbenchRuntimeFollowUp).toHaveBeenLastCalledWith(
        "run-1",
        {
          requestId: expect.any(String) as unknown,
          expectedRevision: 4,
          taskIntent: "",
          command: { name: "init" },
        },
        expect.any(AbortSignal),
      );
      await waitFor(() => expect(view.result.current.state.run.value?.revision).toBe(5));
      view.unmount();
    });

    it("surfaces a refused message as a mutation error and keeps the run as it was", async () => {
      installBootstrap(snapshot({ state: "running", pendingPermission: undefined }));
      vi.mocked(submitCodingWorkbenchRuntimeFollowUp).mockRejectedValue(
        new ApiError("INVALID_INTENT", "The request is not valid.", 400),
      );
      const activeWorkspace = workspace();
      const view = renderHook(() =>
        useCodingWorkbenchRuntime({
          workspace: activeWorkspace,
          initialRequestedMode: "governed-assist",
        }),
      );
      await waitFor(() => expect(view.result.current.state.run.status).toBe("ready"));
      await act(async () => {
        await view.result.current.actions.submitFollowUp("queue it", { delivery: "queue" });
      });
      expect(view.result.current.state.mutation).toMatchObject({
        status: "error",
        kind: "follow-up",
        error: { code: "INVALID_INTENT" },
      });
      expect(view.result.current.state.run.value).toMatchObject({ state: "running", revision: 4 });
      view.unmount();
    });
  });

  describe("primary agent (#3897)", () => {
    function offerPlan(): void {
      vi.mocked(getCodingWorkbenchRuntimeReadiness).mockResolvedValue({
        schemaVersion: "1",
        requestedMode: "governed-assist",
        deploymentCeiling: "autonomous-delivery",
        effectiveMode: "governed-assist",
        runtimeAvailable: true,
        selectableAgents: ["build", "plan"],
      });
    }

    it("offers only the default agent until readiness lists plan, then carries the choice into start", async () => {
      installBootstrap(snapshot({ state: "idle", runId: undefined, pendingPermission: undefined }));
      const started = snapshot({ state: "starting", runId: "run-2", pendingPermission: undefined });
      vi.mocked(startCodingWorkbenchRuntime).mockResolvedValue(started);
      const activeWorkspace = workspace();
      const view = renderHook(() =>
        useCodingWorkbenchRuntime({
          workspace: activeWorkspace,
          initialRequestedMode: "governed-assist",
        }),
      );
      await waitFor(() => expect(view.result.current.state.runtime.status).toBe("ready"));
      expect(view.result.current.state.selectableAgents).toEqual(["build"]);
      act(() => view.result.current.actions.setAgent("plan"));
      expect(view.result.current.state.agent).toBe("build");
      view.unmount();

      offerPlan();
      installBootstrap(snapshot({ state: "idle", runId: undefined, pendingPermission: undefined }));
      offerPlan();
      const planning = renderHook(() =>
        useCodingWorkbenchRuntime({
          workspace: activeWorkspace,
          initialRequestedMode: "governed-assist",
        }),
      );
      act(() => planning.result.current.actions.setSelectedModel("model-redacted"));
      await waitFor(() => expect(planning.result.current.state.canStart).toBe(true));
      expect(planning.result.current.state.selectableAgents).toEqual(["build", "plan"]);
      act(() => planning.result.current.actions.setAgent("plan"));
      await act(async () => {
        await planning.result.current.actions.start("outline the change", {
          projectMemoryEnabled: true,
        });
      });
      expect(startCodingWorkbenchRuntime).toHaveBeenCalledWith(
        expect.objectContaining({ taskIntent: "outline the change", agent: "plan" }),
        expect.any(AbortSignal),
      );
      planning.unmount();
    });

    it("carries the agent chosen between turns into each follow-up, including back to build", async () => {
      installBootstrap(snapshot({ state: "paused", pendingPermission: undefined }));
      offerPlan();
      vi.mocked(submitCodingWorkbenchRuntimeFollowUp).mockResolvedValue(
        snapshot({ state: "paused", revision: 5, pendingPermission: undefined }),
      );
      const activeWorkspace = workspace();
      const view = renderHook(() =>
        useCodingWorkbenchRuntime({
          workspace: activeWorkspace,
          initialRequestedMode: "governed-assist",
        }),
      );
      await waitFor(() =>
        expect(view.result.current.state.selectableAgents).toEqual(["build", "plan"]),
      );
      act(() => view.result.current.actions.setAgent("plan"));
      await act(async () => {
        await view.result.current.actions.submitFollowUp("write the plan");
      });
      expect(submitCodingWorkbenchRuntimeFollowUp).toHaveBeenLastCalledWith(
        "run-1",
        expect.objectContaining({ taskIntent: "write the plan", agent: "plan" }),
        expect.any(AbortSignal),
      );

      act(() => view.result.current.actions.setAgent("build"));
      await act(async () => {
        await view.result.current.actions.submitFollowUp("now implement it");
      });
      expect(submitCodingWorkbenchRuntimeFollowUp).toHaveBeenLastCalledWith(
        "run-1",
        expect.objectContaining({ taskIntent: "now implement it", agent: "build" }),
        expect.any(AbortSignal),
      );
      view.unmount();
    });
  });
});
