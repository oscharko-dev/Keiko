import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  CodingWorkbenchCodexAuthSetupPlan,
  CodingWorkbenchCodexSubscriptionProfile,
} from "@oscharko-dev/keiko-contracts";
import { CODING_WORKBENCH_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import { UNVERIFIED_GATEWAY } from "@oscharko-dev/keiko-contracts/runtime/gateway-verification";
import type { CodingWorkbenchRuntimeActions } from "@/lib/useCodingWorkbenchRuntime";
import {
  createInitialCodingWorkbenchRuntimeState,
  type CodingWorkbenchResourceState,
  type CodingWorkbenchRuntimeState,
} from "@/lib/coding-workbench-live-state";
import { CodexSubscriptionAuthCard } from "./CodingWorkbenchModelCards";

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
      verification: UNVERIFIED_GATEWAY,
    }),
    ...overrides,
  };
}

// The authentication truth and the Codex setup plan are rendered by `CodexSubscriptionAuthCard`,
// which the window actually mounts. A `ModelRuntimeStatus` panel used to render a duplicate
// `AuthTruth` branch; the #3381 review removed the duplicate and #3382 removed the panel itself,
// which nothing ever mounted. Driving these suites through the mounted card keeps them from passing
// over a surface no operator can reach.
function renderAuthCard(
  state: CodingWorkbenchRuntimeState,
  actions: ModelActions = modelActions(),
): ModelActions {
  render(<CodexSubscriptionAuthCard state={state} actions={actions} />);
  return actions;
}

describe("CodexSubscriptionAuthCard authentication truth", () => {
  // `connected` is deliberately absent: the card renders NOTHING once the subscription is
  // connected ("renders nothing once the subscription is connected" below), so no operator ever
  // reads a "Connected" authentication row.
  it.each([
    ["missing", "Sign-in required"],
    ["expired", "Session expired"],
    ["revoked", "Session revoked"],
    ["failed-login", "Previous login failed"],
    ["disabled-by-deployment", "Disabled by deployment"],
    ["unsupported-headless", "Unavailable in this environment"],
    ["redistribution-unapproved", "Unavailable in this release"],
  ] as const)("labels the %s profile status", (status, label) => {
    renderAuthCard(
      codexState({
        profile: ready(profile({ status, supportsBrowserLogin: false, supportsDeviceCode: false })),
      }),
    );
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("shows checking without a refresh control while the profile loads", () => {
    renderAuthCard(codexState({ profile: { status: "loading", value: null, error: null } }));
    expect(screen.getByText("Checking")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Refresh authentication" }),
    ).not.toBeInTheDocument();
  });

  it("falls back to the unavailable label when no profile truth exists", () => {
    renderAuthCard(codexState({ profile: { status: "unavailable", value: null, error: null } }));
    expect(screen.getByText("Authentication unavailable")).toBeInTheDocument();
  });

  it("refreshes the profile from the auth truth row", async () => {
    const user = userEvent.setup();
    const actions = renderAuthCard(codexState({ profile: ready(profile()) }));
    await user.click(screen.getByRole("button", { name: "Refresh authentication" }));
    expect(actions.refreshProfile).toHaveBeenCalledTimes(1);
  });

  it("hides the refresh control once the profile is connected", () => {
    renderAuthCard(codexState({ profile: ready(profile({ status: "connected" })) }));
    expect(
      screen.queryByRole("button", { name: "Refresh authentication" }),
    ).not.toBeInTheDocument();
  });

  it("does not offer setup for non-actionable statuses", () => {
    renderAuthCard(codexState({ profile: ready(profile({ status: "disabled-by-deployment" })) }));
    expect(screen.queryByText("Server-approved setup methods")).not.toBeInTheDocument();
  });
});

describe("CodexSubscriptionAuthCard codex setup", () => {
  it("prepares the chosen server-approved method", async () => {
    const user = userEvent.setup();
    const actions = renderAuthCard(codexState({ profile: ready(profile()) }));
    expect(screen.getByRole("button", { name: "Prepare browser login" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Prepare access-token login" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Prepare device-code login" }));
    expect(actions.prepareCodexSetup).toHaveBeenCalledWith("chatgpt-device-code");
  });

  it("explains when the server approves no setup method", () => {
    renderAuthCard(
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
    renderAuthCard(
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
    renderAuthCard(
      codexState({ profile: ready(profile()) }),
      modelActions({ prepareCodexSetup: undefined }),
    );
    expect(screen.getByRole("button", { name: "Prepare browser login" })).toBeDisabled();
  });

  it("announces a failed or unavailable setup plane", () => {
    renderAuthCard(
      codexState({
        profile: ready(profile()),
        codexSetup: { status: "error", value: null, error: null },
      }),
    );
    expect(screen.getByText(/setup plan is unavailable/iu)).toBeInTheDocument();
  });

  it("renders the ready plan with managed secret input", () => {
    renderAuthCard(
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
    renderAuthCard(codexState({ profile: ready(profile()), codexSetup: ready(setupPlan()) }));
    expect(screen.getByText(/browser login .* not required/u)).toBeInTheDocument();
  });
});

// The window's only mount of the subscription sign-in surface: selecting the subscription in the
// composer's source select must lead somewhere when the sign-in is missing, expired, revoked or
// failed (audit finding, 2026-09-03 — the sign-in surface had lost its only mount, so Start stayed
// disabled with no explanation and no way to authenticate).
describe("CodexSubscriptionAuthCard", () => {
  it("renders the sign-in status and the refresh control while the subscription is not connected", async () => {
    const user = userEvent.setup();
    const actions = modelActions();
    render(
      <CodexSubscriptionAuthCard
        state={codexState({ profile: ready(profile({ status: "missing" })) })}
        actions={actions}
      />,
    );

    expect(screen.getByTestId("coding-workbench-codex-auth")).toBeInTheDocument();
    expect(screen.getByText("Sign in to the Codex subscription")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh authentication" }));

    expect(actions.refreshProfile).toHaveBeenCalledTimes(1);
  });

  it("offers the server-approved setup methods for an actionable sign-in status", async () => {
    const user = userEvent.setup();
    const actions = modelActions();
    render(
      <CodexSubscriptionAuthCard
        state={codexState({ profile: ready(profile({ status: "expired" })) })}
        actions={actions}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Prepare browser login" }));

    expect(actions.prepareCodexSetup).toHaveBeenCalledWith("chatgpt-browser-login");
  });

  it("renders nothing once the subscription is connected", () => {
    render(
      <CodexSubscriptionAuthCard
        state={codexState({ profile: ready(profile({ status: "connected" })) })}
        actions={modelActions()}
      />,
    );

    expect(screen.queryByTestId("coding-workbench-codex-auth")).not.toBeInTheDocument();
  });

  it("renders nothing for the managed gateway source", () => {
    render(
      <CodexSubscriptionAuthCard
        state={{
          ...codexState({ profile: ready(profile({ status: "missing" })) }),
          runtimePreference: "managed-gateway",
        }}
        actions={modelActions()}
      />,
    );

    expect(screen.queryByTestId("coding-workbench-codex-auth")).not.toBeInTheDocument();
  });
});
