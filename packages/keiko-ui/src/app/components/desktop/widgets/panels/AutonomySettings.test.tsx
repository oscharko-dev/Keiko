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

  it("owns all three product modes and persists a full-access selection", async () => {
    const user = userEvent.setup();
    render(<AutonomySettings />);

    expect(screen.getByRole("radio", { name: "Supervised workspace" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "Full access" }));

    expect(change).toHaveBeenCalledWith("autonomous-delivery");
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
});
