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

  // KEIKO-0140: the scope-row copy was cited as proven by human-loop-1405.spec.ts, which renders a
  // hand-authored HTML replica rather than this component — so deleting either line below would
  // have gone unnoticed by the whole suite. This is the only assertion on the live markup.
  it("renders both permission scope rows with their exact copy", () => {
    render(<AgentGateCard gate={gate} escalated={false} onApprove={vi.fn()} onReject={vi.fn()} />);

    const scope = screen.getByLabelText("Permission scope");
    expect(scope).toHaveTextContent(`Allow ${gate.kind} action after review`);
    expect(scope).toHaveTextContent("No extra BFF authority or autonomous follow-up");
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
