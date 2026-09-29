import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import type { ChatContextStatusWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import { ChatContextMeter } from "./ChatContextMeter";

function status(used: number): ChatContextStatusWire {
  return {
    modelId: "fixture",
    contextWindowTokens: 12_000,
    inputBudgetTokens: 10_000,
    reservedOutputTokens: 1_600,
    safetyMarginTokens: 400,
    estimatedInputTokens: used,
    canCompact: true,
    compaction: {
      tokensBefore: 8_000,
      tokensAfter: 1_000,
      tokensSaved: 7_000,
      messagesCompacted: 30,
    },
  };
}

function fixture(
  used: number | undefined,
  busy = false,
): ReturnType<typeof render> & { compact: ReturnType<typeof vi.fn> } {
  const compact = vi.fn();
  return {
    ...render(
      <ChatContextMeter
        status={used === undefined ? undefined : status(used)}
        busy={busy}
        compacting={false}
        error={false}
        onCompact={compact}
        onRetry={vi.fn()}
      />,
    ),
    compact,
  };
}

describe("Chat context meter", () => {
  it("renders the expanded panel outside the clipping chat canvas", () => {
    const { container } = fixture(8_000);
    fireEvent.click(screen.getByRole("button", { name: /Conversation context:/ }));
    const panel = screen.getByRole("region", { name: "Conversation context" });
    expect(container).not.toContainElement(panel);
    expect(document.body).toContainElement(panel);
  });
  it.each([
    [0, "normal"],
    [7_999, "normal"],
    [8_000, "warning"],
    [8_999, "warning"],
    [9_000, "critical"],
    [12_000, "critical"],
  ])("uses the branding, warning and danger states at %s tokens", (tokens, tone) => {
    const { container } = fixture(Number(tokens));
    expect(container.querySelector("[data-tone]")).toHaveAttribute("data-tone", tone);
  });

  it("shows estimates, reserves and savings with a working manual action", () => {
    const { compact } = fixture(8_000);
    fireEvent.click(screen.getByRole("button", { name: /Conversation context:/ }));
    expect(screen.getByText("8,000")).toBeInTheDocument();
    expect(
      screen.getByText("7,000 tokens saved across 30 summarized messages."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Compact context now" }));
    expect(compact).toHaveBeenCalledOnce();
  });

  it("blocks manual maintenance during an answer", () => {
    const { compact } = fixture(9_000, true);
    fireEvent.click(screen.getByRole("button", { name: /Conversation context:/ }));
    const button = screen.getByRole("button", { name: "Compact context now" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(compact).not.toHaveBeenCalled();
  });

  it("uses an unknown state instead of inventing zero usage", () => {
    const { container } = fixture(undefined);
    expect(container.querySelector("[data-tone]")).toHaveAttribute("data-tone", "unknown");
    expect(container.querySelector("button")).toHaveAttribute(
      "aria-label",
      "Context estimate unavailable",
    );
  });

  it("closes on Escape and restores focus to the ring", () => {
    const { container } = fixture(8_000);
    fireEvent.click(screen.getByRole("button", { name: /Conversation context:/ }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Conversation context" })).not.toBeInTheDocument();
    expect(container.querySelector("button")).toHaveFocus();
  });

  it("lets keyboard users reach the portaled action and return to the composer", async () => {
    const user = userEvent.setup();
    fixture(8_000);
    const trigger = screen.getByRole("button", { name: /Conversation context:/ });
    render(<button type="button">Following composer action</button>);
    await user.click(trigger);
    await user.tab();
    expect(screen.getByRole("button", { name: "Compact context now" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(trigger).toHaveFocus();
    await user.tab();
    await user.tab();
    expect(screen.getByRole("button", { name: "Following composer action" })).toHaveFocus();
    expect(screen.queryByRole("region", { name: "Conversation context" })).not.toBeInTheDocument();
  });

  it("is accessible in both collapsed and expanded states", async () => {
    fixture(9_000);
    expect(await axe(document.body)).toHaveNoViolations();
    fireEvent.click(screen.getByRole("button", { name: /Conversation context:/ }));
    expect(await axe(document.body)).toHaveNoViolations();
  });
});
