// Issue #504 — presentational Voice session recap controls. Verifies the button's capability-gated
// inert behaviour (no committed content → cannot trigger, AC1), the privacy disclosure, the panel's
// loading / empty / ready states, and that each candidate action (Approve / Edit / Reject / Forget)
// invokes the corresponding handler — the handlers the host wires to the existing memory-api endpoints.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import type { MemoryRecord } from "@oscharko-dev/keiko-contracts";
import type { UserId } from "@oscharko-dev/keiko-contracts/memory";
import { VoiceRecapButton, VoiceRecapPanel } from "./VoiceRecap";

function record(id: string, body: string): MemoryRecord {
  return {
    id: id as MemoryRecord["id"],
    schemaVersion: "1",
    scope: { kind: "user", userId: "u-1" as UserId },
    type: "semantic-fact",
    body,
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: 0,
      confidence: 0.9,
      sensitivity: "public",
    },
    validity: { validFrom: 0 },
    status: "proposed",
    pinned: false,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("VoiceRecapButton", () => {
  it("triggers when there is committed content", async () => {
    const onTrigger = vi.fn();
    render(<VoiceRecapButton committedSegmentCount={2} busy={false} onTrigger={onTrigger} />);
    const button = screen.getByRole("button", { name: /review voice session/iu });
    expect(button).toHaveAttribute("aria-disabled", "false");
    await userEvent.click(button);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it("is inert (no trigger) when nothing is committed — AC1", async () => {
    const onTrigger = vi.fn();
    render(<VoiceRecapButton committedSegmentCount={0} busy={false} onTrigger={onTrigger} />);
    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(button);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("is inert while a recap build is in flight", async () => {
    const onTrigger = vi.fn();
    render(<VoiceRecapButton committedSegmentCount={3} busy onTrigger={onTrigger} />);
    const button = screen.getByRole("button", { name: /reviewing your voice session/iu });
    expect(button).toHaveAttribute("aria-busy", "true");
    await userEvent.click(button);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("discloses that nothing is saved without approval and audio is never stored", () => {
    render(<VoiceRecapButton committedSegmentCount={1} busy={false} onTrigger={vi.fn()} />);
    expect(screen.getByText(/Nothing is saved until you approve it/iu)).toBeInTheDocument();
    expect(screen.getByText(/Raw audio is never stored/iu)).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <VoiceRecapButton committedSegmentCount={2} busy={false} onTrigger={vi.fn()} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

function handlers() {
  return {
    onApprove: vi.fn(),
    onEdit: vi.fn(),
    onReject: vi.fn(),
    onForget: vi.fn(),
  };
}

describe("VoiceRecapPanel", () => {
  it("announces the loading state while a recap is building", () => {
    render(<VoiceRecapPanel loading candidates={[]} {...handlers()} />);
    expect(screen.getByRole("status")).toHaveTextContent(/Reviewing your voice session/iu);
  });

  it("renders nothing when not loading and there are no candidates", () => {
    const { container } = render(
      <VoiceRecapPanel loading={false} candidates={[]} {...handlers()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("lists candidates and delegates Approve / Reject / Forget to the handlers", async () => {
    const h = handlers();
    render(
      <VoiceRecapPanel loading={false} candidates={[record("m-1", "I prefer dark mode")]} {...h} />,
    );
    expect(screen.getByText("I prefer dark mode")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Approve candidate" }));
    expect(h.onApprove).toHaveBeenCalledWith("m-1");

    await userEvent.click(screen.getByRole("button", { name: "Reject candidate" }));
    expect(h.onReject).toHaveBeenCalledWith("m-1");

    await userEvent.click(screen.getByRole("button", { name: "Forget candidate" }));
    expect(h.onForget).toHaveBeenCalledWith("m-1");
  });

  it("edits a candidate body and delegates the trimmed text to onEdit", async () => {
    const h = handlers();
    render(<VoiceRecapPanel loading={false} candidates={[record("m-2", "old body")]} {...h} />);
    await userEvent.click(screen.getByRole("button", { name: "Edit candidate" }));
    const textarea = screen.getByRole("textbox");
    await userEvent.clear(textarea);
    await userEvent.type(textarea, "  new body  ");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(h.onEdit).toHaveBeenCalledWith("m-2", "new body");
  });

  it("cancels an edit without delegating and restores the candidate view", async () => {
    const h = handlers();
    render(<VoiceRecapPanel loading={false} candidates={[record("m-3", "keep")]} {...h} />);
    await userEvent.click(screen.getByRole("button", { name: "Edit candidate" }));
    await userEvent.clear(screen.getByRole("textbox"));
    await userEvent.type(screen.getByRole("textbox"), "discarded edit");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(h.onEdit).not.toHaveBeenCalled();
    expect(screen.getByText("keep")).toBeInTheDocument();
  });

  it("disables Save when the edited body is empty", async () => {
    const h = handlers();
    render(<VoiceRecapPanel loading={false} candidates={[record("m-4", "body")]} {...h} />);
    await userEvent.click(screen.getByRole("button", { name: "Edit candidate" }));
    await userEvent.clear(screen.getByRole("textbox"));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("has no axe violations with listed candidates", async () => {
    const { container } = render(
      <VoiceRecapPanel loading={false} candidates={[record("m-5", "a fact")]} {...handlers()} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
