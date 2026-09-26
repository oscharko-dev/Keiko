import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryListResponse, MemoryRecentCapturesResponse } from "@/lib/memory-api";
import { resetConversationMemorySettingsForTests } from "@/app/components/desktop/hooks/memorySettings";
import { resetAutonomyPersistenceQueueForTests } from "@/app/components/desktop/hooks/useAutonomyModePolicy";
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
    revision: 0,
  });
}

beforeEach(() => {
  resetConversationMemorySettingsForTests();
});

afterEach(() => {
  resetAutonomyPersistenceQueueForTests();
});

describe("MemoriaVivaWindow request settings", () => {
  it("leaves per-chat memory activation to each chat's branded control", async () => {
    render(
      <MemoriaVivaWindow
        fetchMemoriesImpl={fetchEmptyMemories()}
        loadMemoryAutonomyModeImpl={loadDefaultMode()}
      />,
    );

    expect(screen.queryByRole("switch", { name: "Use MemoriaViva in chat requests" })).toBeNull();
    expect(screen.queryByLabelText("Memory context budget")).toBeNull();
    expect(
      await screen.findByRole("radiogroup", { name: "Memory autonomy mode" }),
    ).toBeInTheDocument();
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
