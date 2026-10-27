import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import type { ChatToolReadGrantView } from "@oscharko-dev/keiko-contracts";
import { JiraReadConsent } from "./JiraChatTools";
const grant = (): ChatToolReadGrantView => ({
  kind: "jira-chat-read",
  grantId: "grant-1",
  chatId: "chat-1",
  podId: "pod-1",
  bindingGeneration: 1,
  authenticationGeneration: 1,
  state: "pending",
  disclosureVersion: "jira-chat-read-v1",
  requestedAt: Date.now(),
  expiresAt: Date.now() + 60000,
});
describe("Jira Chat read consent", () => {
  it("requires explicit keyboard consent and explains model disclosure and retention", async () => {
    const current = grant();
    const decide = vi.fn().mockResolvedValue({ ...current, state: "granted" });
    const { container } = render(<JiraReadConsent grant={current} decide={decide} />);
    expect(screen.getByText(/sent to the selected model and retained/i)).toBeInTheDocument();
    expect(decide).not.toHaveBeenCalled();
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole("button", { name: "Allow reading" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(screen.getByText("Reading allowed")).toBeInTheDocument();
    });
    expect(decide).toHaveBeenCalledExactlyOnceWith(current, "approve");
    expect(await axe(container)).toHaveNoViolations();
  });
  it("preserves explicit rejection and lets fresh revocation override an earlier approval", async () => {
    const current = grant();
    const decide = vi.fn().mockResolvedValue({ ...current, state: "rejected" });
    const { rerender } = render(<JiraReadConsent grant={current} decide={decide} />);
    await userEvent.click(screen.getByRole("button", { name: "Do not allow" }));
    await waitFor(() => {
      expect(screen.getByText("Reading declined")).toBeInTheDocument();
    });
    expect(decide).toHaveBeenCalledExactlyOnceWith(current, "reject");
    rerender(<JiraReadConsent grant={{ ...current, state: "revoked" }} decide={decide} />);
    expect(screen.getByText("Permission revoked")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
  it("never treats a failed request as consent", async () => {
    const decide = vi.fn().mockRejectedValue(new Error("synthetic"));
    render(<JiraReadConsent grant={grant()} decide={decide} />);
    await userEvent.click(screen.getByRole("button", { name: "Allow reading" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be saved");
    expect(screen.getByText("Waiting for your permission")).toBeInTheDocument();
  });
});
