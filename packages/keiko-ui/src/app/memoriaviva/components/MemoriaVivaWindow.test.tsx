import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryListResponse } from "@/lib/memory-api";
import { resetConversationMemorySettingsForTests } from "@/app/components/desktop/hooks/memorySettings";
import { MemoriaVivaWindow } from "./MemoriaVivaWindow";

function makeListResponse(): MemoryListResponse {
  return { memories: [], total: 0, limit: 50, offset: 0 };
}

function fetchEmptyMemories() {
  return vi.fn().mockResolvedValue(makeListResponse());
}

beforeEach(() => {
  resetConversationMemorySettingsForTests();
});

describe("MemoriaVivaWindow request settings", () => {
  it("owns the chat memory request switch and context budget controls", async () => {
    const user = userEvent.setup();
    render(<MemoriaVivaWindow fetchMemoriesImpl={fetchEmptyMemories()} />);

    const memorySwitch = screen.getByRole("switch", {
      name: "Use MemoriaViva in chat requests",
    });
    expect(memorySwitch).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Enabled for chat")).toBeInTheDocument();

    await user.click(memorySwitch);

    expect(memorySwitch).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Disabled for chat")).toBeInTheDocument();

    const budgetInput = screen.getByLabelText("MemoriaViva context budget");
    expect(budgetInput).toHaveValue(1200);

    fireEvent.change(budgetInput, { target: { value: "800" } });
    expect(budgetInput).toHaveValue(800);

    await user.click(screen.getByRole("button", { name: "Increase MemoriaViva context budget" }));
    expect(budgetInput).toHaveValue(900);

    await user.click(screen.getByRole("button", { name: "Decrease MemoriaViva context budget" }));
    expect(budgetInput).toHaveValue(800);
  });
});
