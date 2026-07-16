import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  CODING_WORKBENCH_SCHEMA_VERSION,
  type CodingWorkbenchCodexAuthSetupPlan,
  type CodingWorkbenchCodexSubscriptionProfile,
} from "@oscharko-dev/keiko-contracts";
import type { CodingWorkbenchRuntimeActions } from "@/lib/useCodingWorkbenchRuntime";
import {
  createInitialCodingWorkbenchRuntimeState,
  type CodingWorkbenchResourceState,
  type CodingWorkbenchRuntimeState,
} from "@/lib/coding-workbench-live-state";
import { ModelRuntimeStatus } from "./CodingWorkbenchModelCards";

type ModelActions = Pick<
  CodingWorkbenchRuntimeActions,
  "setRuntimePreference" | "prepareCodexSetup" | "refreshProfile" | "refreshSource"
>;

function modelActions(overrides: Partial<ModelActions> = {}): ModelActions {
  return {
    setRuntimePreference: vi.fn(),
    prepareCodexSetup: vi.fn(() => Promise.resolve()),
    refreshProfile: vi.fn(() => Promise.resolve()),
    refreshSource: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

function profile(
  overrides: Partial<CodingWorkbenchCodexSubscriptionProfile> = {},
): CodingWorkbenchCodexSubscriptionProfile {
  return {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    profileId: "profile-1",
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
    ...overrides,
  };
}

function setupPlan(
  overrides: Partial<CodingWorkbenchCodexAuthSetupPlan> = {},
): CodingWorkbenchCodexAuthSetupPlan {
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
    ...overrides,
  };
}

function ready<T>(value: T): CodingWorkbenchResourceState<T> {
  return { status: "ready", value, error: null };
}

function codexState(
  overrides: Partial<CodingWorkbenchRuntimeState> = {},
): CodingWorkbenchRuntimeState {
  return {
    ...createInitialCodingWorkbenchRuntimeState("governed-assist", "codex-subscription"),
    source: ready({
      runtimePreference: "codex-subscription" as const,
      modelSource: "chatgpt-codex-subscription-profile" as const,
      runtimeSource: "codex-cli-adapter" as const,
      available: true,
    }),
    ...overrides,
  };
}

function renderStatus(
  state: CodingWorkbenchRuntimeState,
  actions: ModelActions = modelActions(),
  locked = false,
): ModelActions {
  render(<ModelRuntimeStatus state={state} actions={actions} locked={locked} />);
  return actions;
}

describe("ModelRuntimeStatus source cards", () => {
  it("selects the other source through the radio group", async () => {
    const user = userEvent.setup();
    const actions = renderStatus(
      codexState({
        ...createInitialCodingWorkbenchRuntimeState("governed-assist", "managed-gateway"),
      }),
    );
    await user.click(screen.getByRole("radio", { name: /ChatGPT\/Codex subscription/u }));
    expect(actions.setRuntimePreference).toHaveBeenCalledWith("codex-subscription");
  });

  it("locks both radios while a run is active", () => {
    renderStatus(codexState(), modelActions(), true);
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toBeDisabled();
    }
  });

  it("offers a retry when the confirmed source is unavailable and refreshes it", async () => {
    const user = userEvent.setup();
    const actions = renderStatus(
      codexState({
        source: ready({
          runtimePreference: "codex-subscription" as const,
          modelSource: "chatgpt-codex-subscription-profile" as const,
          runtimeSource: "codex-cli-adapter" as const,
          available: false,
        }),
      }),
    );
    expect(screen.getByText(/Unavailable/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry source" }));
    expect(actions.refreshSource).toHaveBeenCalledTimes(1);
  });

  it("hides the confirmed-source row until the server has answered", () => {
    renderStatus(codexState({ source: { status: "loading", value: null, error: null } }));
    expect(screen.queryByText("Server-confirmed source")).not.toBeInTheDocument();
  });
});

describe("ModelRuntimeStatus subscription authentication truth", () => {
  it.each([
    ["connected", "Connected"],
    ["missing", "Sign-in required"],
    ["expired", "Session expired"],
    ["revoked", "Session revoked"],
    ["failed-login", "Previous login failed"],
    ["disabled-by-deployment", "Disabled by deployment"],
    ["unsupported-headless", "Unavailable in this environment"],
    ["redistribution-unapproved", "Unavailable in this release"],
  ] as const)("labels the %s profile status", (status, label) => {
    renderStatus(
      codexState({
        profile: ready(profile({ status, supportsBrowserLogin: false, supportsDeviceCode: false })),
      }),
    );
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("shows checking without a refresh control while the profile loads", () => {
    renderStatus(codexState({ profile: { status: "loading", value: null, error: null } }));
    expect(screen.getByText("Checking")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Refresh authentication" }),
    ).not.toBeInTheDocument();
  });

  it("falls back to the unavailable label when no profile truth exists", () => {
    renderStatus(codexState({ profile: { status: "unavailable", value: null, error: null } }));
    expect(screen.getByText("Authentication unavailable")).toBeInTheDocument();
  });

  it("refreshes the profile from the auth truth row", async () => {
    const user = userEvent.setup();
    const actions = renderStatus(codexState({ profile: ready(profile()) }));
    await user.click(screen.getByRole("button", { name: "Refresh authentication" }));
    expect(actions.refreshProfile).toHaveBeenCalledTimes(1);
  });

  it("hides the refresh control once the profile is connected", () => {
    renderStatus(codexState({ profile: ready(profile({ status: "connected" })) }));
    expect(
      screen.queryByRole("button", { name: "Refresh authentication" }),
    ).not.toBeInTheDocument();
  });

  it("does not offer setup for non-actionable statuses", () => {
    renderStatus(codexState({ profile: ready(profile({ status: "disabled-by-deployment" })) }));
    expect(screen.queryByText("Server-approved setup methods")).not.toBeInTheDocument();
  });
});

describe("ModelRuntimeStatus codex setup", () => {
  it("prepares the chosen server-approved method", async () => {
    const user = userEvent.setup();
    const actions = renderStatus(codexState({ profile: ready(profile()) }));
    expect(screen.getByRole("button", { name: "Prepare browser login" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Prepare access-token login" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Prepare device-code login" }));
    expect(actions.prepareCodexSetup).toHaveBeenCalledWith("chatgpt-device-code");
  });

  it("explains when the server approves no setup method", () => {
    renderStatus(
      codexState({
        profile: ready(
          profile({
            supportsBrowserLogin: false,
            supportsDeviceCode: false,
            supportsAccessToken: false,
          }),
        ),
      }),
    );
    expect(
      screen.getByText("No setup method is approved for this environment."),
    ).toBeInTheDocument();
  });

  it("disables setup buttons while a plan is being prepared", () => {
    renderStatus(
      codexState({
        profile: ready(profile()),
        codexSetup: { status: "loading", value: null, error: null },
      }),
    );
    for (const button of screen.getAllByRole("button", { name: "Preparing…" })) {
      expect(button).toBeDisabled();
    }
  });

  it("disables setup buttons when no prepare action is wired", () => {
    renderStatus(
      codexState({ profile: ready(profile()) }),
      modelActions({ prepareCodexSetup: undefined }),
    );
    expect(screen.getByRole("button", { name: "Prepare browser login" })).toBeDisabled();
  });

  it("announces a failed or unavailable setup plane", () => {
    renderStatus(
      codexState({
        profile: ready(profile()),
        codexSetup: { status: "error", value: null, error: null },
      }),
    );
    expect(screen.getByText(/setup plan is unavailable/iu)).toBeInTheDocument();
  });

  it("renders the ready plan with managed secret input", () => {
    renderStatus(
      codexState({
        profile: ready(profile()),
        codexSetup: ready(
          setupPlan({
            method: "codex-access-token",
            commandLabel: "codex-login-with-access-token",
            requiresSecretInput: true,
          }),
        ),
      }),
    );
    expect(screen.getByText("Setup plan ready")).toBeInTheDocument();
    expect(
      screen.getByText(/access-token login .* required through managed stdin/u),
    ).toBeInTheDocument();
  });

  it("renders the ready plan without secret input", () => {
    renderStatus(codexState({ profile: ready(profile()), codexSetup: ready(setupPlan()) }));
    expect(screen.getByText(/browser login .* not required/u)).toBeInTheDocument();
  });
});
