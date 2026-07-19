import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryListResponse, MemoryRecentCapturesResponse } from "@/lib/memory-api";
import { resetConversationMemorySettingsForTests } from "@/app/components/desktop/hooks/memorySettings";
import { MemoriaVivaWindow } from "./MemoriaVivaWindow";

function makeListResponse(): MemoryListResponse {
  return { memories: [], total: 0, limit: 50, offset: 0 };
}

function fetchEmptyMemories() {
  return vi.fn().mockResolvedValue(makeListResponse());
}

function fetchEmptyCaptures() {
  const result: MemoryRecentCapturesResponse = {
    captures: [],
    total: 0,
    limit: 50,
    since: 0,
    order: "desc",
  };
  return vi.fn().mockResolvedValue(result);
}

function loadDefaultMode() {
  return vi.fn().mockResolvedValue({
    requestedMode: "governed-assist",
    effectiveMode: "governed-assist",
    deploymentCeiling: "autonomous-delivery",
  });
}

beforeEach(() => {
  resetConversationMemorySettingsForTests();
});

describe("MemoriaVivaWindow request settings", () => {
  it("owns the chat memory request switch and context budget controls", async () => {
    const user = userEvent.setup();
    render(
      <MemoriaVivaWindow
        fetchMemoriesImpl={fetchEmptyMemories()}
        loadMemoryAutonomyModeImpl={loadDefaultMode()}
      />,
    );

    const memorySwitch = screen.getByRole("switch", {
      name: "Use MemoriaViva in chat requests",
    });
    expect(memorySwitch).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Enabled for chat")).toBeInTheDocument();

    await user.click(memorySwitch);

    expect(memorySwitch).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Disabled for chat")).toBeInTheDocument();

    const budgetInput = screen.getByLabelText("Memory context budget");
    expect(budgetInput).toHaveValue(1200);

    fireEvent.change(budgetInput, { target: { value: "800" } });
    expect(budgetInput).toHaveValue(800);

    await user.click(screen.getByRole("button", { name: "Increase Memory context budget" }));
    expect(budgetInput).toHaveValue(900);

    await user.click(screen.getByRole("button", { name: "Decrease Memory context budget" }));
    expect(budgetInput).toHaveValue(800);
  });

  it("opens the Memory Journal inside the existing window and returns to the list", async () => {
    const user = userEvent.setup();
    render(
      <MemoriaVivaWindow
        fetchMemoriesImpl={fetchEmptyMemories()}
        fetchRecentCapturesImpl={fetchEmptyCaptures()}
        loadMemoryAutonomyModeImpl={loadDefaultMode()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Journal" }));
    expect(screen.getByRole("heading", { name: "Memory Journal" })).toBeInTheDocument();
    expect(await screen.findByTestId("memory-journal-empty")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "MemoriaViva" })).toBeInTheDocument();
  });
});
