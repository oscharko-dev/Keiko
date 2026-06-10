import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentGateCard } from "./AgentGateCard";

const gate = {
  title: "Write src/index.ts",
  detail: "keiko apply --run r-1",
  kind: "write" as const,
};

describe("AgentGateCard", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders as an alertdialog labelled by the gate title and moves focus to Reject", () => {
    render(<AgentGateCard gate={gate} escalated={false} onApprove={vi.fn()} onReject={vi.fn()} />);

    const dialog = screen.getByRole("alertdialog", { name: gate.title });
    expect(dialog).toHaveAttribute("aria-describedby");
    expect(screen.getByRole("button", { name: "Reject" })).toHaveFocus();
  });

  it("treats Escape as Reject and wires the action buttons", async () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const user = userEvent.setup();
    render(
      <AgentGateCard gate={gate} escalated={true} onApprove={onApprove} onReject={onReject} />,
    );

    await user.keyboard("{Escape}");
    expect(onReject).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });
});
