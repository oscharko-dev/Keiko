import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CodingWorkbenchCodexAuthSetupPlan,
  CodingWorkbenchCodexSubscriptionProfile,
  CodingWorkbenchRuntimeSnapshot,
  CodingWorkbenchSidecarGatewayResult,
} from "@oscharko-dev/keiko-contracts";
import { CODING_WORKBENCH_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import {
  fetchCodingWorkbenchCodexSubscriptionProfile,
  fetchCodingWorkbenchSidecarGatewayProfile,
  prepareCodingWorkbenchCodexSubscriptionSetup,
} from "./coding-workbench-provider-api";
import { ApiError } from "./api";
import { useCodingAppSessionRedemptions } from "./coding-app-session-client";
import { reportClientDiagnostic } from "./client-diagnostics";
import {
  decideCodingWorkbenchRuntimeApproval,
  getCodingWorkbenchRuntimeReadiness,
  getCodingWorkbenchRuntimeStatus,
  isCodingWorkbenchPreempted,
  retryCodingWorkbenchRuntime,
  startCodingWorkbenchRuntime,
  stopCodingWorkbenchRuntime,
  takeOverCodingWorkbenchRuntime,
  acknowledgeCodingWorkbenchRuntimeRecovery,
  submitCodingWorkbenchRuntimeInboxAction,
} from "./coding-workbench-runtime-api";
import {
  createInitialCodingWorkbenchRuntimeState,
  type CodingWorkbenchRuntimeState,
} from "./coding-workbench-live-state";
import {
  useCodingWorkbenchRuntimeMutations,
  useCodingWorkbenchRuntimeResources,
  CODING_WORKBENCH_VERIFYING_REFRESH_MS,
} from "./coding-workbench-runtime-hooks";

vi.mock("./client-diagnostics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client-diagnostics")>()),
  reportClientDiagnostic: vi.fn(),
}));

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
    decideCodingWorkbenchRuntimeApproval: vi.fn(),
    getCodingWorkbenchRuntimeReadiness: vi.fn(),
    getCodingWorkbenchRuntimeStatus: vi.fn(),
    startCodingWorkbenchRuntime: vi.fn(),
    retryCodingWorkbenchRuntime: vi.fn(),
    stopCodingWorkbenchRuntime: vi.fn(),
    takeOverCodingWorkbenchRuntime: vi.fn(),
    acknowledgeCodingWorkbenchRuntimeRecovery: vi.fn(),
    submitCodingWorkbenchRuntimeInboxAction: vi.fn(),
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
  readonly unmount: () => void;
} {
  const dispatch = vi.fn();
  const stateRef = { current: state };
  const view = renderHook(() => useCodingWorkbenchRuntimeResources(stateRef, dispatch));
  return { resources: view.result.current, dispatch, unmount: view.unmount };
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
  it("does not rediscover the catalog on repeated pending verification timer reads", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const catalogRefresh = vi.fn();
    window.addEventListener("keiko:gateway-model-catalog-refresh-requested", catalogRefresh);
    try {
      vi.mocked(fetchCodingWorkbenchSidecarGatewayProfile)
        .mockResolvedValueOnce({ status: "unavailable", reason: "model-verification-pending" })
        .mockResolvedValueOnce({ status: "unavailable", reason: "model-verification-pending" })
        .mockResolvedValueOnce({ status: "available" } as CodingWorkbenchSidecarGatewayResult);
      const { resources, dispatch, unmount } = renderResources(runtimeState());
      await act(() => resources.refreshSource());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CODING_WORKBENCH_VERIFYING_REFRESH_MS * 2);
      });
      expect(fetchCodingWorkbenchSidecarGatewayProfile).toHaveBeenCalledTimes(3);
      expect(catalogRefresh).toHaveBeenCalledOnce();
      expect(dispatch).toHaveBeenLastCalledWith({
        kind: "source-set",
        source: expect.objectContaining({ available: true }),
      });
      unmount();
    } finally {
      window.removeEventListener("keiko:gateway-model-catalog-refresh-requested", catalogRefresh);
      vi.useRealTimers();
    }
  });

  it("projects the managed gateway source truth", async () => {
    vi.mocked(fetchCodingWorkbenchSidecarGatewayProfile).mockResolvedValue({
      status: "available",
    } as CodingWorkbenchSidecarGatewayResult);
    const { resources, dispatch } = renderResources(runtimeState());
    // The server may renew a model's proofs during this read, so the picker's catalog is re-read.
    const catalogRefresh = vi.fn();
    window.addEventListener("keiko:gateway-model-catalog-refresh-requested", catalogRefresh);
    await act(() => resources.refreshSource());
    window.removeEventListener("keiko:gateway-model-catalog-refresh-requested", catalogRefresh);
    expect(catalogRefresh).toHaveBeenCalledTimes(1);
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

  it("adopts a background catalog update without requesting another catalog refresh", async () => {
    vi.mocked(fetchCodingWorkbenchSidecarGatewayProfile).mockResolvedValue({
      status: "available",
    } as CodingWorkbenchSidecarGatewayResult);
    const { resources, dispatch } = renderResources(runtimeState());
    const requested = vi.fn();
    window.addEventListener("keiko:gateway-model-catalog-refresh-requested", requested);
    try {
      await act(() => resources.refreshSource(true));
      expect(requested).not.toHaveBeenCalled();
      expect(dispatch).toHaveBeenLastCalledWith({
        kind: "source-set",
        source: expect.objectContaining({ available: true }),
      });
    } finally {
      window.removeEventListener("keiko:gateway-model-catalog-refresh-requested", requested);
    }
  });

  it.each(["unmounted", "superseded"] as const)(
    "does not refresh the global catalog when a %s source read finally lands",
    async (obsolete) => {
      const available = { status: "available" } as CodingWorkbenchSidecarGatewayResult;
      let release: (profile: CodingWorkbenchSidecarGatewayResult) => void = () => undefined;
      vi.mocked(fetchCodingWorkbenchSidecarGatewayProfile)
        .mockReset()
        .mockImplementationOnce(() => new Promise((resolve) => void (release = resolve)))
        .mockResolvedValue(available);
      const { resources, dispatch, unmount } = renderResources(runtimeState());
      const catalogRefresh = vi.fn();
      window.addEventListener("keiko:gateway-model-catalog-refresh-requested", catalogRefresh);
      try {
        let stale: Promise<void> = Promise.resolve();
        act(() => {
          stale = resources.refreshSource();
        });
        if (obsolete === "unmounted") unmount();
        else {
          await act(() => resources.refreshSource());
          expect(catalogRefresh).toHaveBeenCalledTimes(1);
          expect(dispatch).toHaveBeenLastCalledWith({
            kind: "source-set",
            source: expect.objectContaining({ available: true }),
          });
        }
        catalogRefresh.mockClear();
        dispatch.mockClear();
        await act(async () => {
          release(available);
          await stale;
        });

        expect(catalogRefresh).not.toHaveBeenCalled();
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener("keiko:gateway-model-catalog-refresh-requested", catalogRefresh);
      }
    },
  );

  // #3591 (1.1.7): while the server is still verifying the elected model against a slow gateway
  // it answers `model-verification-pending`; the Workbench reads again after the pause instead
  // of leaving a refusal that the next read would have lifted.
  it("re-reads the managed gateway source while verification is pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      vi.mocked(fetchCodingWorkbenchSidecarGatewayProfile)
        .mockResolvedValueOnce({
          status: "unavailable",
          reason: "model-verification-pending",
        } as CodingWorkbenchSidecarGatewayResult)
        .mockResolvedValueOnce({ status: "available" } as CodingWorkbenchSidecarGatewayResult);
      const { resources, dispatch } = renderResources(runtimeState());
      await act(() => resources.refreshSource());
      expect(fetchCodingWorkbenchSidecarGatewayProfile).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledWith({
        kind: "source-set",
        source: expect.objectContaining({
          available: false,
          unavailableReason: "model-verification-pending",
        }),
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CODING_WORKBENCH_VERIFYING_REFRESH_MS);
      });
      expect(fetchCodingWorkbenchSidecarGatewayProfile).toHaveBeenCalledTimes(2);
      expect(dispatch).toHaveBeenLastCalledWith({
        kind: "source-set",
        source: expect.objectContaining({ available: true }),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // A closed Workbench must not keep reading the profile every ten seconds until the page closes.
  it("stops the verification re-read when the Workbench unmounts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      vi.mocked(fetchCodingWorkbenchSidecarGatewayProfile).mockResolvedValue({
        status: "unavailable",
        reason: "model-verification-pending",
      } as CodingWorkbenchSidecarGatewayResult);
      const { resources, unmount } = renderResources(runtimeState());
      await act(() => resources.refreshSource());
      expect(fetchCodingWorkbenchSidecarGatewayProfile).toHaveBeenCalledTimes(1);
      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CODING_WORKBENCH_VERIFYING_REFRESH_MS * 3);
      });
      expect(fetchCodingWorkbenchSidecarGatewayProfile).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // The Workbench can close while the profile read is still in flight: the read that lands must
  // neither dispatch into the unmounted hook nor schedule a re-read (#3591 review).
  it("ignores a profile read that lands after the Workbench unmounted", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let release: (profile: CodingWorkbenchSidecarGatewayResult) => void = () => undefined;
      vi.mocked(fetchCodingWorkbenchSidecarGatewayProfile).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const { resources, dispatch, unmount } = renderResources(runtimeState());
      let inFlight: Promise<void> = Promise.resolve();
      act(() => {
        inFlight = resources.refreshSource();
      });
      unmount();
      dispatch.mockClear();
      await act(async () => {
        release({
          status: "unavailable",
          reason: "model-verification-pending",
        } as CodingWorkbenchSidecarGatewayResult);
        await inFlight;
        await vi.advanceTimersByTimeAsync(CODING_WORKBENCH_VERIFYING_REFRESH_MS * 3);
      });
      expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "source-set" }));
      expect(fetchCodingWorkbenchSidecarGatewayProfile).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not schedule a re-read when the source settled", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      vi.mocked(fetchCodingWorkbenchSidecarGatewayProfile).mockResolvedValue({
        status: "unavailable",
        reason: "model-context-window-insufficient",
      } as CodingWorkbenchSidecarGatewayResult);
      const { resources } = renderResources(runtimeState());
      await act(() => resources.refreshSource());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CODING_WORKBENCH_VERIFYING_REFRESH_MS * 3);
      });
      expect(fetchCodingWorkbenchSidecarGatewayProfile).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
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
      selectableAgents: ["build"],
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

  // #3632: calls during an in-flight read coalesce into ONE follow-up read after it (never one read
  // per call, never overlapping reads), so an event that arrived mid-read is not lost.
  it("coalesces concurrent run refreshes into one follow-up read and maps a status failure", async () => {
    let release: (value: CodingWorkbenchRuntimeSnapshot) => void = () => undefined;
    vi.mocked(getCodingWorkbenchRuntimeStatus)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValueOnce(snapshot({ revision: 5 }));
    const { resources, dispatch } = renderResources(runtimeState());
    await act(async () => {
      const first = resources.refreshRun();
      const second = resources.refreshRun();
      const third = resources.refreshRun();
      release(snapshot({ revision: 4 }));
      await Promise.all([first, second, third]);
    });
    expect(getCodingWorkbenchRuntimeStatus).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenLastCalledWith({
      kind: "run-set",
      snapshot: snapshot({ revision: 5 }),
    });

    const refused = new ApiError("CODING_RUNTIME_UNAVAILABLE", "runtime offline", 503);
    refused.correlationId = "corr-run-status";
    vi.mocked(getCodingWorkbenchRuntimeStatus).mockRejectedValueOnce(refused);
    await act(() => resources.refreshRun());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "resource-failed", resource: "run", status: "unavailable" }),
    );
    // The failed read leaves its own body-free line, joined to the refused request.
    expect(reportClientDiagnostic).toHaveBeenCalledWith(
      "[keiko] coding workbench run status read failed",
      { kind: "other", errorKind: "unavailable", correlationId: "corr-run-status" },
    );
  });

  // #4109: a status read that hit its own deadline is recorded by the API layer with its call kind
  // and deadline; the read adds no second, generic note for the same timeout.
  it("maps a status read that hit its deadline without a second generic note", async () => {
    vi.mocked(getCodingWorkbenchRuntimeStatus).mockRejectedValueOnce(
      new DOMException("The operation timed out.", "TimeoutError"),
    );
    const { resources, dispatch } = renderResources(runtimeState());

    await act(() => resources.refreshRun());

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "resource-failed",
        resource: "run",
        error: expect.objectContaining({ code: "CODING_RUNTIME_REQUEST_TIMEOUT" }),
      }),
    );
    expect(reportClientDiagnostic).not.toHaveBeenCalled();
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
    await act(() =>
      mutations.start("write the failing test first", { projectMemoryEnabled: true }),
    );
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
    await act(() => mutations.start("blocked", { projectMemoryEnabled: true }));
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

  // ADR-0141 D6: a run control from a browser whose app session was revoked is answered with the
  // existence-concealing not-found result. The refusal alone cannot say which it was, so every
  // session-dependent read runs again and reports the honest pairing state (#2478).
  it("re-inspects the app session when a run control is refused as not found", async () => {
    vi.mocked(stopCodingWorkbenchRuntime).mockRejectedValueOnce(
      new ApiError("CODING_RUNTIME_RUN_NOT_FOUND", "Runtime run was not found.", 404),
    );
    const session = renderHook(() => useCodingAppSessionRedemptions());
    const before = session.result.current;
    const { mutations, dispatch } = renderMutations(readyRunState(snapshot({ state: "running" })));

    await act(() => mutations.stop());

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "mutation-failed",
        error: expect.objectContaining({ code: "CODING_RUNTIME_RUN_NOT_FOUND" }),
      }),
    );
    expect(session.result.current).toBe(before + 1);
  });

  it("leaves the app session reads alone for any other refused run control", async () => {
    vi.mocked(stopCodingWorkbenchRuntime).mockRejectedValueOnce(
      new ApiError("CODING_RUNTIME_REVISION_CONFLICT", "Runtime revision is stale.", 409),
    );
    const session = renderHook(() => useCodingAppSessionRedemptions());
    const before = session.result.current;
    const { mutations } = renderMutations(readyRunState(snapshot({ state: "running" })));

    await act(() => mutations.stop());

    expect(session.result.current).toBe(before);
  });

  // Stability audit item 7: a 409 means the server holds a state this window has not seen yet, so
  // the failed action's alert is followed by a re-read that lets the newer snapshot supersede it.
  it("re-reads the run after a conflict-class refusal, once the failure is recorded", async () => {
    vi.mocked(stopCodingWorkbenchRuntime).mockRejectedValueOnce(
      new ApiError("CODING_RUNTIME_REVISION_CONFLICT", "Runtime revision is stale.", 409),
    );
    const { mutations, dispatch, refreshRun } = renderMutations(
      readyRunState(snapshot({ state: "running" })),
    );

    await act(() => mutations.stop());

    expect(refreshRun).toHaveBeenCalledTimes(1);
    const failedAt = dispatch.mock.calls.findIndex(([a]) => a.kind === "mutation-failed");
    expect(failedAt).toBeGreaterThanOrEqual(0);
    expect(refreshRun.mock.invocationCallOrder[0]).toBeGreaterThan(
      dispatch.mock.invocationCallOrder[failedAt] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("does not re-read the run for a transport failure or a client-side gate refusal", async () => {
    vi.mocked(stopCodingWorkbenchRuntime).mockRejectedValueOnce(
      new ApiError("CODING_RUNTIME_UNAVAILABLE", "runtime offline", 503),
    );
    const { mutations, refreshRun } = renderMutations(
      readyRunState(snapshot({ state: "running" })),
    );
    await act(() => mutations.stop());
    await act(() => mutations.start("blocked", { projectMemoryEnabled: true }));
    expect(refreshRun).not.toHaveBeenCalled();
  });

  // Stability audit item 1: a control the BFF never answered fails on the client's own deadline,
  // which fails its queue item (re-enabling Stop/Approve/Deny) and lets the next one run.
  it("fails a control that hit its deadline, records it, and lets the next queued control run", async () => {
    vi.mocked(stopCodingWorkbenchRuntime)
      .mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"))
      .mockResolvedValueOnce(snapshot({ state: "stopping" }));
    const { mutations, dispatch } = renderMutations(readyRunState(snapshot({ state: "running" })));

    await act(async () => {
      await Promise.all([mutations.stop(), mutations.stop()]);
    });

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "mutation-failed",
        error: expect.objectContaining({
          code: "CODING_RUNTIME_REQUEST_TIMEOUT",
          retryable: true,
        }),
      }),
    );
    // The API layer records the expiry with its call kind and deadline (coding-workbench-runtime-api
    // .deadline.test.ts); the queue adds no second, generic note for the same timeout (#4109).
    expect(reportClientDiagnostic).not.toHaveBeenCalled();
    expect(stopCodingWorkbenchRuntime).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenLastCalledWith({ kind: "mutation-complete" });
  });

  // #4109: Stop is never queued behind a mutation that is still waiting for the server.
  describe("Stop preemption", () => {
    afterEach(() => {
      vi.mocked(decideCodingWorkbenchRuntimeApproval).mockReset();
      vi.mocked(startCodingWorkbenchRuntime).mockReset();
      vi.mocked(stopCodingWorkbenchRuntime).mockReset();
      vi.mocked(takeOverCodingWorkbenchRuntime).mockReset();
    });

    interface HeldCall {
      readonly signal: AbortSignal | undefined;
      readonly resolve: (value: CodingWorkbenchRuntimeSnapshot) => void;
    }

    // A call the server never answers: it settles only when the caller releases it or its signal
    // aborts, exactly as the real fetch behind it would.
    function holdCalls(): HeldCall[] {
      const held: HeldCall[] = [];
      const hold = (...args: readonly unknown[]): Promise<CodingWorkbenchRuntimeSnapshot> =>
        new Promise((resolve, reject) => {
          const signal = args.find((arg): arg is AbortSignal => arg instanceof AbortSignal);
          held.push({ signal, resolve });
          signal?.addEventListener("abort", () => {
            reject(signal.reason as unknown);
          });
        });
      vi.mocked(decideCodingWorkbenchRuntimeApproval).mockImplementation(hold);
      vi.mocked(startCodingWorkbenchRuntime).mockImplementation(hold);
      vi.mocked(stopCodingWorkbenchRuntime).mockImplementation(hold);
      vi.mocked(takeOverCodingWorkbenchRuntime).mockImplementation(hold);
      return held;
    }

    const PENDING_PERMISSION = {
      requestId: "permission-1",
      tool: "edit",
      risk: "high",
    } as unknown as CodingWorkbenchRuntimeSnapshot["pendingPermission"];

    function awaitingApprovalState(): CodingWorkbenchRuntimeState {
      return readyRunState(
        snapshot({ state: "awaiting-approval", pendingPermission: PENDING_PERMISSION }),
      );
    }

    function startedKinds(dispatch: ReturnType<typeof vi.fn>): unknown[] {
      return dispatch.mock.calls
        .map(([action]) => action as { kind: string; mutation?: string })
        .filter((action) => action.kind === "mutation-start")
        .map((action) => action.mutation);
    }

    it("aborts a pending approval's wait, starts Stop at once and raises no alert", async () => {
      const held = holdCalls();
      const { mutations, dispatch, refreshRun } = renderMutations(awaitingApprovalState());

      await act(async () => {
        const approval = mutations.decideApproval("approved");
        await vi.waitFor(() => {
          expect(held).toHaveLength(1);
        });
        const stop = mutations.stop();
        // The approval's client wait ended with the preemption reason; the Stop call is on the wire.
        await vi.waitFor(() => {
          expect(held).toHaveLength(2);
        });
        expect(held[0]?.signal?.aborted).toBe(true);
        expect(isCodingWorkbenchPreempted(held[0]?.signal?.reason)).toBe(true);
        expect(held[1]?.signal?.aborted).toBe(false);
        held[1]?.resolve(snapshot({ state: "stopping", revision: 9 }));
        await Promise.all([approval, stop]);
      });

      expect(startedKinds(dispatch)).toEqual(["approval", "stop"]);
      expect(dispatch).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: "mutation-failed" }),
      );
      expect(dispatch).toHaveBeenLastCalledWith({ kind: "mutation-complete" });
      // Server truth reconciles through the Stop answer, never through the preempted approval.
      expect(dispatch).toHaveBeenCalledWith({
        kind: "run-set",
        snapshot: snapshot({ state: "stopping", revision: 9 }),
      });
      expect(refreshRun).not.toHaveBeenCalled();
      expect(reportClientDiagnostic).not.toHaveBeenCalled();
    });

    it("drops what an approval that already answered would have done once Stop took its place", async () => {
      const held = holdCalls();
      const { mutations, dispatch } = renderMutations(awaitingApprovalState());

      await act(async () => {
        const approval = mutations.decideApproval("approved");
        await vi.waitFor(() => {
          expect(held).toHaveLength(1);
        });
        // The answer lands in the same turn as the preemption: it is dropped, not installed.
        held[0]?.resolve(snapshot({ state: "running", revision: 5 }));
        const stop = mutations.stop();
        await vi.waitFor(() => {
          expect(held).toHaveLength(2);
        });
        held[1]?.resolve(snapshot({ state: "stopping", revision: 6 }));
        await Promise.all([approval, stop]);
      });

      expect(dispatch).not.toHaveBeenCalledWith({
        kind: "run-set",
        snapshot: snapshot({ state: "running", revision: 5 }),
      });
      expect(dispatch).toHaveBeenCalledWith({
        kind: "run-set",
        snapshot: snapshot({ state: "stopping", revision: 6 }),
      });
      expect(dispatch).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: "mutation-failed" }),
      );
    });

    it("does not preempt another Stop, which waits for the first", async () => {
      const held = holdCalls();
      const { mutations, dispatch } = renderMutations(
        readyRunState(snapshot({ state: "running" })),
      );

      await act(async () => {
        const first = mutations.stop();
        await vi.waitFor(() => {
          expect(held).toHaveLength(1);
        });
        const second = mutations.stop();
        await Promise.resolve();
        await Promise.resolve();
        // The second Stop neither aborted the first nor started beside it.
        expect(held).toHaveLength(1);
        expect(held[0]?.signal?.aborted).toBe(false);

        held[0]?.resolve(snapshot({ state: "stopping" }));
        await vi.waitFor(() => {
          expect(held).toHaveLength(2);
        });
        held[1]?.resolve(snapshot({ state: "stopping" }));
        await Promise.all([first, second]);
      });

      expect(stopCodingWorkbenchRuntime).toHaveBeenCalledTimes(2);
      expect(held[0]?.signal?.aborted).toBe(false);
      expect(held[1]?.signal?.aborted).toBe(false);
      expect(dispatch).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: "mutation-failed" }),
      );
    });

    it("drops a mutation that was still queued behind the preempted one", async () => {
      const held = holdCalls();
      const { mutations, dispatch } = renderMutations(awaitingApprovalState());

      await act(async () => {
        const approval = mutations.decideApproval("approved");
        await vi.waitFor(() => {
          expect(held).toHaveLength(1);
        });
        const takeover = mutations.takeover();
        const stop = mutations.stop();
        await vi.waitFor(() => {
          expect(held).toHaveLength(2);
        });
        held[1]?.resolve(snapshot({ state: "stopping" }));
        await Promise.all([approval, takeover, stop]);
      });

      expect(takeOverCodingWorkbenchRuntime).not.toHaveBeenCalled();
      expect(stopCodingWorkbenchRuntime).toHaveBeenCalledTimes(1);
      expect(startedKinds(dispatch)).toEqual(["approval", "stop"]);
      expect(dispatch).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: "mutation-failed" }),
      );
    });

    it("leaves a pending mutation alone when Stop has no run to stop", async () => {
      const held = holdCalls();
      const { mutations, dispatch } = renderMutations(readyRunState(null, { canStart: true }));

      await act(async () => {
        const start = mutations.start("write the failing test first", {
          projectMemoryEnabled: true,
        });
        await vi.waitFor(() => {
          expect(held).toHaveLength(1);
        });
        const stop = mutations.stop();
        await Promise.resolve();
        await Promise.resolve();
        expect(held[0]?.signal?.aborted).toBe(false);
        held[0]?.resolve(snapshot({ state: "starting" }));
        await Promise.all([start, stop]);
      });

      expect(stopCodingWorkbenchRuntime).not.toHaveBeenCalled();
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "mutation-failed",
          error: expect.objectContaining({ code: "CODING_RUNTIME_ACTION_UNAVAILABLE" }),
        }),
      );
    });

    it("ends a preempted mutation's re-read at once instead of holding Stop behind it", async () => {
      const held = holdCalls();
      const { mutations, refreshRun, dispatch } = renderMutations(awaitingApprovalState());
      // The approval answers for another run, so it re-reads the run, and the re-read never
      // returns: a join on a hung status read must not delay Stop either.
      refreshRun.mockImplementationOnce(() => new Promise<void>(() => undefined));

      await act(async () => {
        const approval = mutations.decideApproval("approved");
        await vi.waitFor(() => {
          expect(held).toHaveLength(1);
        });
        held[0]?.resolve(snapshot({ runId: "run-2" }));
        await vi.waitFor(() => {
          expect(refreshRun).toHaveBeenCalledTimes(1);
        });
        const stop = mutations.stop();
        await vi.waitFor(() => {
          expect(held).toHaveLength(2);
        });
        held[1]?.resolve(snapshot({ state: "stopping" }));
        await Promise.all([approval, stop]);
      });

      expect(startedKinds(dispatch)).toEqual(["approval", "stop"]);
      expect(dispatch).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: "mutation-failed" }),
      );
    });
  });

  it("routes a waiting-message action through the queue, bound to the observed revision", async () => {
    vi.mocked(submitCodingWorkbenchRuntimeInboxAction).mockResolvedValue(snapshot({ revision: 5 }));
    const { mutations, dispatch } = renderMutations(
      readyRunState(snapshot({ state: "running", revision: 4 })),
    );

    await act(() => mutations.inboxAction("promote", "msg_16b08469d001DaT0xxHG2PAKe6"));

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "mutation-start", mutation: "inbox" }),
    );
    expect(submitCodingWorkbenchRuntimeInboxAction).toHaveBeenCalledWith(
      "run-1",
      {
        requestId: expect.any(String) as unknown,
        expectedRevision: 4,
        action: "promote",
        itemId: "msg_16b08469d001DaT0xxHG2PAKe6",
      },
      expect.any(AbortSignal),
    );
    expect(dispatch).toHaveBeenCalledWith({ kind: "mutation-complete" });
  });

  it("reports a waiting-message action against a run that is not running without sending it", async () => {
    vi.mocked(submitCodingWorkbenchRuntimeInboxAction).mockClear();
    const { mutations, dispatch } = renderMutations(readyRunState(snapshot({ state: "paused" })));

    await act(() => mutations.inboxAction("cancel", "msg_16b08469d001DaT0xxHG2PAKe6"));

    expect(submitCodingWorkbenchRuntimeInboxAction).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "mutation-failed",
        error: expect.objectContaining({ code: "CODING_RUNTIME_ACTION_UNAVAILABLE" }),
      }),
    );
  });

  it("routes takeover, retry and recovery acknowledgement through the queue", async () => {
    vi.mocked(takeOverCodingWorkbenchRuntime).mockResolvedValue(snapshot({ state: "taken-over" }));
    vi.mocked(retryCodingWorkbenchRuntime).mockResolvedValue(snapshot({ revision: 5 }));
    vi.mocked(acknowledgeCodingWorkbenchRuntimeRecovery).mockResolvedValue(
      snapshot({ state: "recovery-required", recoveryAcknowledged: true }),
    );

    const { mutations: takeoverMutations } = renderMutations(readyRunState(snapshot()));
    await act(() => takeoverMutations.takeover());
    expect(takeOverCodingWorkbenchRuntime).toHaveBeenCalledWith(
      "run-1",
      { requestId: "run-1" },
      expect.any(AbortSignal),
    );

    const { mutations: retryMutations } = renderMutations(
      readyRunState(snapshot(), { canRetry: true }),
    );
    await act(() => retryMutations.retry("try again"));
    expect(retryCodingWorkbenchRuntime).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ taskIntent: "try again" }),
      expect.any(AbortSignal),
    );

    const { mutations: recoveryMutations, dispatch } = renderMutations(
      readyRunState(snapshot({ state: "recovery-required" })),
    );
    await act(() => recoveryMutations.acknowledgeRecovery());
    expect(acknowledgeCodingWorkbenchRuntimeRecovery).toHaveBeenCalledWith(
      "run-1",
      { requestId: "run-1", acknowledged: true },
      expect.any(AbortSignal),
    );
    expect(dispatch).toHaveBeenCalledWith({ kind: "mutation-complete" });
  });
});

it("records the actual current profile read, elapsed outcome and original catalog parent", async () => {
  const received: (import("./client-diagnostics").ClientDiagnosticMeta | undefined)[] = [];
  const { setClientDiagnosticWriter, resetClientDiagnosticWriter } =
    await import("./client-diagnostics");
  setClientDiagnosticWriter((_message, meta) => received.push(meta));
  vi.mocked(fetchCodingWorkbenchSidecarGatewayProfile).mockResolvedValue({
    status: "unavailable",
    reason: "model-verification-pending",
  });
  const { resources, unmount } = renderResources(runtimeState());
  try {
    await act(() => resources.refreshSource(true, "actual-catalog-123"));
    const sent = vi.mocked(fetchCodingWorkbenchSidecarGatewayProfile).mock.calls.at(-1)?.[0];
    expect(sent).toEqual(expect.any(String));
    const stages = received.filter(
      (meta) => meta?.stageReport?.stage === "gateway profile refresh",
    );
    expect(stages).toHaveLength(2);
    expect(stages[0]?.correlationId).toBe(sent);
    expect(stages[1]?.correlationId).toBe(sent);
    expect(stages[1]).toMatchObject({
      parentCorrelationId: "actual-catalog-123",
      stageReport: {
        phase: "settled",
        durationMs: expect.any(Number),
        gatewayProfile: { outcome: "unavailable", catalogReread: "skipped" },
      },
    });
    expect(JSON.stringify(stages)).not.toContain("modelAlias");
  } finally {
    unmount();
    resetClientDiagnosticWriter();
  }
});
