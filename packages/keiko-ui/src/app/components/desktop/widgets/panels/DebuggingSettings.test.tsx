import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEBUG_ACTIVATION_EFFECTIVE_STATES,
  type DebugActivationSummary,
} from "@oscharko-dev/keiko-contracts";
import { I18nProvider } from "@/lib/i18n";
import type { DebuggingSettingsView } from "./useDebuggingSettings";
import { DebuggingSettings } from "./DebuggingSettings";

const debuggingView = vi.hoisted(() => ({
  current: undefined as unknown as DebuggingSettingsView,
}));

vi.mock("./useDebuggingSettings", () => ({
  useDebuggingSettings: (): DebuggingSettingsView => debuggingView.current,
}));

function summary(
  state: DebugActivationSummary["state"],
  reasonCode: DebugActivationSummary["reasonCode"],
): DebugActivationSummary {
  return {
    ok: true,
    schemaVersion: "1",
    adapterId: "node-typescript",
    revision: 2,
    state,
    reasonCode,
    policyResult: state === "disabledByPolicy" ? "denied" : "allowed",
  };
}

function view(overrides: Partial<DebuggingSettingsView> = {}): DebuggingSettingsView {
  return {
    summary: summary("disabled", "WORKSPACE_ACTIVATION_UNSET"),
    enabled: false,
    canEnable: true,
    canDisable: false,
    loading: false,
    mutating: false,
    issue: undefined,
    announcement: "",
    refresh: vi.fn(),
    setEnabled: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function renderPanel(root = "/workspace"): ReturnType<typeof render> {
  return render(
    <I18nProvider>
      <DebuggingSettings root={root} />
    </I18nProvider>,
  );
}

describe("DebuggingSettings", () => {
  beforeEach(() => {
    debuggingView.current = view();
  });

  it.each([
    [
      "disabled",
      "WORKSPACE_DISABLED",
      "Disabled",
      "Workspace debugging is disabled.",
      "Enable this workspace opt-in to request governed debugging.",
    ],
    [
      "disabledByPolicy",
      "POLICY_DENIED",
      "Disabled by policy",
      "Deployment policy denies debugging.",
      "An operator policy prevents activation. This screen cannot override it.",
    ],
    [
      "notProvisioned",
      "NOT_PROVISIONED",
      "Not provisioned",
      "The approved debugging runtime is not provisioned.",
      "Ask an operator to provision the approved runtime outside the workspace.",
    ],
    [
      "available",
      "AVAILABLE",
      "Available",
      "All debugging prerequisites are currently satisfied.",
      "A local human may start a governed debugging session when the editor surface is available.",
    ],
  ] as const)(
    "renders the closed %s state with distinct label, reason, and guidance",
    async (state, reason, label, reasonText, guidanceText) => {
      debuggingView.current = view({
        summary: summary(state, reason),
        enabled: state === "notProvisioned" || state === "available",
        canEnable: state === "disabled",
        canDisable: state === "notProvisioned" || state === "available",
      });
      const { container } = renderPanel();

      expect(await screen.findByText(label)).toBeInTheDocument();
      expect(screen.getByText(reasonText)).toBeInTheDocument();
      expect(screen.getByText(guidanceText)).toBeInTheDocument();
      expect(
        screen.getByRole("switch", { name: "Enable debugging for this workspace" }),
      ).toBeInTheDocument();
      expect(await axe(container)).toHaveNoViolations();
    },
  );

  it("keeps missing server status fail-closed and does not expose an activation action", () => {
    debuggingView.current = view({ summary: undefined, canEnable: false });
    renderPanel();

    expect(screen.getByText("Status unavailable")).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Enable debugging for this workspace" }),
    ).toBeDisabled();
  });

  it("retains only the four ADR-approved static states and no restart state", () => {
    expect(DEBUG_ACTIVATION_EFFECTIVE_STATES).toEqual([
      "disabled",
      "disabledByPolicy",
      "notProvisioned",
      "available",
    ]);
    renderPanel();
    expect(screen.queryByText(/restart/u)).toBeNull();
  });

  it("submits activation only when the trusted server state permits it", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("switch", { name: "Enable debugging for this workspace" }));

    expect(debuggingView.current.setEnabled).toHaveBeenCalledWith(true);
  });

  it("confirms deactivation before sending the revoke mutation", async () => {
    debuggingView.current = view({
      summary: summary("available", "AVAILABLE"),
      enabled: true,
      canEnable: false,
      canDisable: true,
    });
    renderPanel();
    const toggle = screen.getByRole("switch", { name: "Enable debugging for this workspace" });
    toggle.focus();
    fireEvent.click(toggle);

    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(debuggingView.current.setEnabled).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(toggle).toHaveFocus());
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "Disable debugging" }));

    await waitFor(() => expect(debuggingView.current.setEnabled).toHaveBeenCalledWith(false));
  });

  it("does not show a workspace control before a workspace is selected", () => {
    render(
      <I18nProvider>
        <DebuggingSettings />
      </I18nProvider>,
    );

    expect(
      screen.getByText("Select a workspace before changing debugging access."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
  });
});
