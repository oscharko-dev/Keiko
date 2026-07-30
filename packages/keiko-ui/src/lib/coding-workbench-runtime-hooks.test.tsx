import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODING_WORKBENCH_SCHEMA_VERSION,
  type CodingWorkbenchCodexAuthSetupPlan,
  type CodingWorkbenchCodexSubscriptionProfile,
  type CodingWorkbenchRuntimeSnapshot,
  type CodingWorkbenchSidecarGatewayResult,
} from "@oscharko-dev/keiko-contracts";
import {
  fetchCodingWorkbenchCodexSubscriptionProfile,
  fetchCodingWorkbenchSidecarGatewayProfile,
  prepareCodingWorkbenchCodexSubscriptionSetup,
} from "./coding-workbench-provider-api";
import { ApiError } from "./api";
import {
  getCodingWorkbenchRuntimeReadiness,
  getCodingWorkbenchRuntimeStatus,
  retryCodingWorkbenchRuntime,
  startCodingWorkbenchRuntime,
  stopCodingWorkbenchRuntime,
  takeOverCodingWorkbenchRuntime,
  acknowledgeCodingWorkbenchRuntimeRecovery,
} from "./coding-workbench-runtime-api";
import {
  createInitialCodingWorkbenchRuntimeState,
  type CodingWorkbenchRuntimeState,
} from "./coding-workbench-live-state";
import {
  useCodingWorkbenchRuntimeMutations,
  useCodingWorkbenchRuntimeResources,
} from "./coding-workbench-runtime-hooks";

vi.mock("./coding-workbench-provider-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./coding-workbench-provider-api")>();
  return {
    ...actual,
    fetchCodingWorkbenchCodexSubscriptionProfile: vi.fn(),
    fetchCodingWorkbenchSidecarGatewayProfile: vi.fn(),
    prepareCodingWorkbenchCodexSubscriptionSetup: vi.fn(),
  };
});

vi.mock("./coding-workbench-runtime-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./coding-workbench-runtime-api")>();
  return {
    ...actual,
    getCodingWorkbenchRuntimeReadiness: vi.fn(),
    getCodingWorkbenchRuntimeStatus: vi.fn(),
    startCodingWorkbenchRuntime: vi.fn(),
    retryCodingWorkbenchRuntime: vi.fn(),
    stopCodingWorkbenchRuntime: vi.fn(),
    takeOverCodingWorkbenchRuntime: vi.fn(),
    acknowledgeCodingWorkbenchRuntimeRecovery: vi.fn(),
  };
});

const UPDATED_AT = "2026-07-13T12:00:00.000Z";
const UNAVAILABLE_ERROR = new ApiError("CODING_RUNTIME_UNAVAILABLE", "runtime offline", 503);

function subscriptionProfile(
  status: CodingWorkbenchCodexSubscriptionProfile["status"],
): CodingWorkbenchCodexSubscriptionProfile {
  return {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    profileId: "profile-1",
    modelSource: "chatgpt-codex-subscription-profile",
    runtimeSource: "codex-cli-adapter",
    status,
    credentialStore: "file",
    stateScope: "keiko-owned-state",
    stateRoot: "keiko-codex-runtime-state",
    usesGlobalCodexHome: false,
    runtimeBinarySources: ["managed-sidecar-runtime"],
    supportsBrowserLogin: true,
    supportsDeviceCode: false,
    supportsAccessToken: false,
    deploymentPolicyDisabled: false,
    headless: false,
  };
}

function setupPlan(): CodingWorkbenchCodexAuthSetupPlan {
  return {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    profileId: "profile-1",
    method: "chatgpt-browser-login",
    modelSource: "chatgpt-codex-subscription-profile",
    runtimeSource: "codex-cli-adapter",
    credentialStore: "file",
    stateScope: "keiko-owned-state",
    stateRoot: "keiko-codex-runtime-state",
    usesGlobalCodexHome: false,
    commandLabel: "codex-login",
    requiresSecretInput: false,
  };
}

function snapshot(
  overrides: Partial<CodingWorkbenchRuntimeSnapshot> = {},
): CodingWorkbenchRuntimeSnapshot {
  return {
    schemaVersion: "1",
    state: "running",
    revision: 4,
    updatedAt: UPDATED_AT,
    runId: "run-1",
    ...overrides,
  } as CodingWorkbenchRuntimeSnapshot;
}

function runtimeState(
  overrides: Partial<CodingWorkbenchRuntimeState> = {},
): CodingWorkbenchRuntimeState {
  return { ...createInitialCodingWorkbenchRuntimeState(), ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
});

function renderResources(state: CodingWorkbenchRuntimeState): {
  readonly resources: ReturnType<typeof useCodingWorkbenchRuntimeResources>;
  readonly dispatch: ReturnType<typeof vi.fn>;
} {
  const dispatch = vi.fn();
  const stateRef = { current: state };
  const view = renderHook(() => useCodingWorkbenchRuntimeResources(stateRef, dispatch));
  return { resources: view.result.current, dispatch };
}

describe("useCodingWorkbenchRuntimeResources profile refresh", () => {
  it("clears the profile without a fetch while the managed gateway is selected", async () => {
    const { resources, dispatch } = renderResources(runtimeState());
    await act(() => resources.refreshProfile());
    expect(dispatch).toHaveBeenCalledWith({ kind: "profile-empty" });
    expect(fetchCodingWorkbenchCodexSubscriptionProfile).not.toHaveBeenCalled();
  });

  it("installs the fetched subscription profile", async () => {
    const profile = subscriptionProfile("connected");
    vi.mocked(fetchCodingWorkbenchCodexSubscriptionProfile).mockResolvedValue(profile);
    const { resources, dispatch } = renderResources(
      runtimeState(
        createInitialCodingWorkbenchRuntimeState("governed-assist", "codex-subscription"),
      ),
    );
    await act(() => resources.refreshProfile());
    expect(dispatch).toHaveBeenCalledWith({ kind: "resource-loading", resource: "profile" });
    expect(dispatch).toHaveBeenCalledWith({ kind: "profile-set", profile });
  });

  it("maps a profile fetch failure onto the profile resource", async () => {
    vi.mocked(fetchCodingWorkbenchCodexSubscriptionProfile).mockRejectedValue(UNAVAILABLE_ERROR);
    const { resources, dispatch } = renderResources(
      runtimeState(
        createInitialCodingWorkbenchRuntimeState("governed-assist", "codex-subscription"),
      ),
    );
    await act(() => resources.refreshProfile());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "resource-failed",
        resource: "profile",
        status: "unavailable",
      }),
    );
  });

  it("drops a stale profile response after a newer refresh began", async () => {
    let releaseFirst: (profile: CodingWorkbenchCodexSubscriptionProfile) => void = () => undefined;
    vi.mocked(fetchCodingWorkbenchCodexSubscriptionProfile)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(subscriptionProfile("connected"));
    const { resources, dispatch } = renderResources(
      runtimeState(
        createInitialCodingWorkbenchRuntimeState("governed-assist", "codex-subscription"),
      ),
    );
    let stale: Promise<void> = Promise.resolve();
    await act(async () => {
      stale = resources.refreshProfile();
      await resources.refreshProfile();
      releaseFirst(subscriptionProfile("missing"));
      await stale;
    });
    const installed = dispatch.mock.calls.filter(([action]) => action.kind === "profile-set");
    expect(installed).toHaveLength(1);
    expect(installed[0]?.[0].profile.status).toBe("connected");
  });
});

describe("useCodingWorkbenchRuntimeResources source refresh", () => {
  it("projects the managed gateway source truth", async () => {
    vi.mocked(fetchCodingWorkbenchSidecarGatewayProfile).mockResolvedValue({
      status: "available",
    } as CodingWorkbenchSidecarGatewayResult);
    const { resources, dispatch } = renderResources(runtimeState());
    await act(() => resources.refreshSource());
    expect(dispatch).toHaveBeenCalledWith({ kind: "profile-empty" });
    expect(dispatch).toHaveBeenCalledWith({
      kind: "source-set",
      source: {
        runtimePreference: "managed-gateway",
        modelSource: "keiko-model-gateway",
        runtimeSource: "keiko-sidecar",
        available: true,
      },
    });
  });

  it("projects a disconnected subscription source with its reason", async () => {
    const profile = subscriptionProfile("expired");
    vi.mocked(fetchCodingWorkbenchCodexSubscriptionProfile).mockResolvedValue(profile);
    const { resources, dispatch } = renderResources(
      runtimeState(
        createInitialCodingWorkbenchRuntimeState("governed-assist", "codex-subscription"),
      ),
    );
    await act(() => resources.refreshSource());
    expect(dispatch).toHaveBeenCalledWith({ kind: "profile-set", profile });
    expect(dispatch).toHaveBeenCalledWith({
      kind: "source-set",
      source: {
        runtimePreference: "codex-subscription",
        modelSource: "chatgpt-codex-subscription-profile",
        runtimeSource: "codex-cli-adapter",
        available: false,
        unavailableReason: "expired",
        // F-01: an authenticated CLI session is not a live model round-trip, so this source carries
        // no probe confirmation either way.
        verification: "unverified",
      },
    });
  });

  it("fails both the source and profile resources for a subscription fetch failure", async () => {
    vi.mocked(fetchCodingWorkbenchCodexSubscriptionProfile).mockRejectedValue(UNAVAILABLE_ERROR);
    const { resources, dispatch } = renderResources(
      runtimeState(
        createInitialCodingWorkbenchRuntimeState("governed-assist", "codex-subscription"),
      ),
    );
    await act(() => resources.refreshSource());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "resource-failed", resource: "source" }),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "resource-failed", resource: "profile" }),
    );
  });

  it("fails only the source resource for a managed gateway failure", async () => {
    vi.mocked(fetchCodingWorkbenchSidecarGatewayProfile).mockRejectedValue(
      new ApiError("GATEWAY_ERROR", "gateway broke", 500),
    );
    const { resources, dispatch } = renderResources(runtimeState());
    await act(() => resources.refreshSource());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "resource-failed", resource: "source", status: "error" }),
    );
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "resource-failed", resource: "profile" }),
    );
  });
});

describe("useCodingWorkbenchRuntimeResources codex setup", () => {
  it("installs the prepared plan and refreshes the profile truth", async () => {
    const plan = setupPlan();
    vi.mocked(prepareCodingWorkbenchCodexSubscriptionSetup).mockResolvedValue(plan);
    vi.mocked(fetchCodingWorkbenchCodexSubscriptionProfile).mockResolvedValue(
      subscriptionProfile("connected"),
    );
    const { resources, dispatch } = renderResources(
      runtimeState(
        createInitialCodingWorkbenchRuntimeState("governed-assist", "codex-subscription"),
      ),
    );
    await act(() => resources.prepareCodexSetup("chatgpt-browser-login"));
    expect(prepareCodingWorkbenchCodexSubscriptionSetup).toHaveBeenCalledWith(
      "chatgpt-browser-login",
    );
    expect(dispatch).toHaveBeenCalledWith({ kind: "codex-setup-set", plan });
    expect(fetchCodingWorkbenchCodexSubscriptionProfile).toHaveBeenCalledTimes(1);
  });

  it("maps a setup preparation failure onto the codexSetup resource", async () => {
    vi.mocked(prepareCodingWorkbenchCodexSubscriptionSetup).mockRejectedValue(UNAVAILABLE_ERROR);
    const { resources, dispatch } = renderResources(runtimeState());
    await act(() => resources.prepareCodexSetup("chatgpt-device-code"));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "resource-failed",
        resource: "codexSetup",
        status: "unavailable",
      }),
    );
  });
});

describe("useCodingWorkbenchRuntimeResources runtime and run refresh", () => {
  it("installs server readiness and maps a readiness failure", async () => {
    const readiness = {
      schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
      requestedMode: "governed-assist",
      deploymentCeiling: "autonomous-delivery",
      effectiveMode: "governed-assist",
      runtimeAvailable: true,
    } as const;
    vi.mocked(getCodingWorkbenchRuntimeReadiness).mockResolvedValueOnce(readiness);
    const { resources, dispatch } = renderResources(runtimeState());
    await act(() => resources.refreshRuntime());
    expect(dispatch).toHaveBeenCalledWith({ kind: "runtime-set", readiness });

    vi.mocked(getCodingWorkbenchRuntimeReadiness).mockRejectedValueOnce(UNAVAILABLE_ERROR);
    await act(() => resources.refreshRuntime());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "resource-failed",
        resource: "runtime",
        status: "unavailable",
      }),
    );
  });

  it("dedupes concurrent run refreshes and maps a status failure", async () => {
    let release: (value: CodingWorkbenchRuntimeSnapshot) => void = () => undefined;
    vi.mocked(getCodingWorkbenchRuntimeStatus).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { resources, dispatch } = renderResources(runtimeState());
    await act(async () => {
      const first = resources.refreshRun();
      const second = resources.refreshRun();
      release(snapshot());
      await Promise.all([first, second]);
    });
    expect(getCodingWorkbenchRuntimeStatus).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ kind: "run-set", snapshot: snapshot() });

    vi.mocked(getCodingWorkbenchRuntimeStatus).mockRejectedValueOnce(UNAVAILABLE_ERROR);
    await act(() => resources.refreshRun());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "resource-failed", resource: "run", status: "unavailable" }),
    );
  });
});

describe("useCodingWorkbenchRuntimeMutations", () => {
  function renderMutations(state: CodingWorkbenchRuntimeState): {
    readonly mutations: ReturnType<typeof useCodingWorkbenchRuntimeMutations>;
    readonly dispatch: ReturnType<typeof vi.fn>;
    readonly refreshRun: ReturnType<typeof vi.fn>;
  } {
    const dispatch = vi.fn();
    const refreshRun = vi.fn(() => Promise.resolve());
    const stateRef = { current: state };
    const view = renderHook(() =>
      useCodingWorkbenchRuntimeMutations({ stateRef, refreshRun, dispatch }),
    );
    return { mutations: view.result.current, dispatch, refreshRun };
  }

  function readyRunState(
    run: CodingWorkbenchRuntimeSnapshot | null,
    overrides: Partial<CodingWorkbenchRuntimeState> = {},
  ): CodingWorkbenchRuntimeState {
    return runtimeState({ run: { status: "ready", value: run, error: null }, ...overrides });
  }

  it("starts a run and installs the server truth", async () => {
    vi.mocked(startCodingWorkbenchRuntime).mockResolvedValue(snapshot({ state: "starting" }));
    const { mutations, dispatch } = renderMutations(readyRunState(null, { canStart: true }));
    await act(() => mutations.start("write the failing test first"));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "mutation-start", mutation: "start" }),
    );
    expect(dispatch).toHaveBeenCalledWith({
      kind: "run-set",
      snapshot: snapshot({ state: "starting" }),
    });
    expect(dispatch).toHaveBeenCalledWith({ kind: "mutation-complete" });
  });

  it("reports a mutation failure when the readiness gate rejects the start", async () => {
    const { mutations, dispatch } = renderMutations(readyRunState(null, { canStart: false }));
    await act(() => mutations.start("blocked"));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "mutation-failed",
        error: expect.objectContaining({ code: "CODING_RUNTIME_ACTION_UNAVAILABLE" }),
      }),
    );
  });

  it("re-reads the run when a bound mutation result does not match the live truth", async () => {
    vi.mocked(stopCodingWorkbenchRuntime).mockResolvedValue(snapshot({ runId: "run-2" }));
    const { mutations, dispatch, refreshRun } = renderMutations(readyRunState(snapshot()));
    await act(() => mutations.stop());
    expect(refreshRun).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ kind: "mutation-complete" });
  });

  it("routes takeover, retry and recovery acknowledgement through the queue", async () => {
    vi.mocked(takeOverCodingWorkbenchRuntime).mockResolvedValue(snapshot({ state: "taken-over" }));
    vi.mocked(retryCodingWorkbenchRuntime).mockResolvedValue(snapshot({ revision: 5 }));
    vi.mocked(acknowledgeCodingWorkbenchRuntimeRecovery).mockResolvedValue(
      snapshot({ state: "recovery-required", recoveryAcknowledged: true }),
    );

    const { mutations: takeoverMutations } = renderMutations(readyRunState(snapshot()));
    await act(() => takeoverMutations.takeover());
    expect(takeOverCodingWorkbenchRuntime).toHaveBeenCalledWith("run-1", { requestId: "run-1" });

    const { mutations: retryMutations } = renderMutations(
      readyRunState(snapshot(), { canRetry: true }),
    );
    await act(() => retryMutations.retry("try again"));
    expect(retryCodingWorkbenchRuntime).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ taskIntent: "try again" }),
    );

    const { mutations: recoveryMutations, dispatch } = renderMutations(
      readyRunState(snapshot({ state: "recovery-required" })),
    );
    await act(() => recoveryMutations.acknowledgeRecovery());
    expect(acknowledgeCodingWorkbenchRuntimeRecovery).toHaveBeenCalledWith("run-1", {
      requestId: "run-1",
      acknowledged: true,
    });
    expect(dispatch).toHaveBeenCalledWith({ kind: "mutation-complete" });
  });
});
