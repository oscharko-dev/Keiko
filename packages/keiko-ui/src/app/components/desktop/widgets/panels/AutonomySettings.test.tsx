import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AutonomySettings } from "./AutonomySettings";

const autonomyPolicyMock = vi.hoisted(() => vi.fn());

vi.mock("../../hooks/useAutonomyModePolicy", () => ({
  useAutonomyModePolicy: autonomyPolicyMock,
}));

describe("AutonomySettings", () => {
  const change = vi.fn();

  beforeEach(() => {
    change.mockReset();
    autonomyPolicyMock.mockReturnValue({
      requestedMode: "supervised-coding",
      effectiveMode: "supervised-coding",
      deploymentCeiling: "autonomous-delivery",
      pending: false,
      error: null,
      change,
    });
  });

  it("owns all three product modes and persists a full-access selection", async (): Promise<void> => {
    const user = userEvent.setup();
    render(<AutonomySettings />);

    expect(screen.getByRole("radio", { name: "Supervised workspace" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "Full access" }));

    expect(change).toHaveBeenCalledWith("autonomous-delivery");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows the server-effective clamp without changing the requested selection", () => {
    autonomyPolicyMock.mockReturnValue({
      requestedMode: "autonomous-delivery",
      effectiveMode: "supervised-coding",
      deploymentCeiling: "supervised-coding",
      pending: false,
      error: null,
      change,
    });
    render(<AutonomySettings />);

    expect(screen.getByRole("radio", { name: "Full access" })).toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent(
      "This deployment currently limits the effective mode to Supervised workspace.",
    );
  });

  it("omits effective status while the server policy has no effective mode", (): void => {
    autonomyPolicyMock.mockReturnValue({
      requestedMode: "supervised-coding",
      effectiveMode: null,
      deploymentCeiling: null,
      pending: false,
      error: null,
      change,
    });

    render(<AutonomySettings />);

    expect(screen.queryByText(/^Effective:/u)).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Supervised workspace" })).toBeEnabled();
  });

  it.each([
    ["hydrate", "The current autonomy policy could not be loaded. Keiko remains fail-closed."],
    [
      "persist",
      "The autonomy mode could not be saved. The previous server-confirmed mode remains active.",
    ],
  ] as const)("renders the server policy %s failure", (error, message): void => {
    autonomyPolicyMock.mockReturnValue({
      requestedMode: "supervised-coding",
      effectiveMode: "supervised-coding",
      deploymentCeiling: "autonomous-delivery",
      pending: false,
      error,
      change,
    });

    render(<AutonomySettings />);

    expect(screen.getByRole("alert")).toHaveTextContent(message);
  });

  it("locks all mode controls while a policy request is pending", (): void => {
    autonomyPolicyMock.mockReturnValue({
      requestedMode: "supervised-coding",
      effectiveMode: "supervised-coding",
      deploymentCeiling: "autonomous-delivery",
      pending: true,
      error: null,
      change,
    });

    render(<AutonomySettings />);

    for (const control of screen.getAllByRole("radio")) expect(control).toBeDisabled();
  });
});
