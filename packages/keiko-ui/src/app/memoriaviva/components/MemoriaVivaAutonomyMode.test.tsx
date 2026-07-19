import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchMode, MemoryAutonomyPolicyWire } from "@oscharko-dev/keiko-contracts";
import { resetConversationMemorySettingsForTests } from "@/app/components/desktop/hooks/memorySettings";
import type { MemoryListResponse } from "@/lib/memory-api";
import { MemoriaVivaWindow } from "./MemoriaVivaWindow";

function policy(mode: CodingWorkbenchMode): MemoryAutonomyPolicyWire {
  return { requestedMode: mode, effectiveMode: mode, deploymentCeiling: "autonomous-delivery" };
}

function fetchEmptyMemories(): Promise<MemoryListResponse> {
  return Promise.resolve({ memories: [], total: 0, limit: 50, offset: 0 });
}

beforeEach(() => {
  resetConversationMemorySettingsForTests();
});

describe("MemoriaViva memory autonomy mode", () => {
  it("hydrates, persists, restores, and exposes one accessible three-mode control", async () => {
    const user = userEvent.setup();
    const loadMode = vi.fn().mockResolvedValue(policy("autonomous-delivery"));
    const persistMode = vi
      .fn<(mode: CodingWorkbenchMode) => Promise<MemoryAutonomyPolicyWire>>()
      .mockImplementation((mode) => Promise.resolve(policy(mode)));
    const first = render(
      <MemoriaVivaWindow
        fetchMemoriesImpl={fetchEmptyMemories}
        loadMemoryAutonomyModeImpl={loadMode}
        persistMemoryAutonomyModeImpl={persistMode}
      />,
    );

    const group = await screen.findByRole("radiogroup", { name: "Memory autonomy mode" });
    expect(within(group).getAllByRole("radio")).toHaveLength(3);
    expect(within(group).getByRole("radio", { name: /Ask for approval/ })).toBeInTheDocument();
    expect(within(group).getByRole("radio", { name: /Supervised workspace/ })).toBeInTheDocument();
    const fullAccess = within(group).getByRole("radio", { name: /Full access/ });
    await waitFor(() => expect(fullAccess).toBeChecked());
    expect(screen.queryByRole("switch", { name: "Enable MemoriaViva policy" })).toBeNull();

    const supervised = within(group).getByRole("radio", { name: /Supervised workspace/ });
    await user.click(supervised);
    await waitFor(() => expect(supervised).toBeChecked());
    expect(persistMode).toHaveBeenCalledWith("supervised-coding");
    expect(await axe(first.container)).toHaveNoViolations();

    first.unmount();
    render(
      <MemoriaVivaWindow
        fetchMemoriesImpl={fetchEmptyMemories}
        loadMemoryAutonomyModeImpl={vi.fn().mockResolvedValue(policy("autonomous-delivery"))}
        persistMemoryAutonomyModeImpl={persistMode}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole("radio", { name: /Full access/ })).toBeChecked();
    });
  });

  it("fails closed on hydrate errors and keeps the prior mode on persist rejection", async () => {
    const user = userEvent.setup();
    const failedHydration = render(
      <MemoriaVivaWindow
        fetchMemoriesImpl={fetchEmptyMemories}
        loadMemoryAutonomyModeImpl={vi.fn().mockRejectedValue(new Error("private detail"))}
        persistMemoryAutonomyModeImpl={vi.fn()}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The memory autonomy mode could not be loaded. Ask for approval remains active.",
    );
    expect(screen.getByRole("radio", { name: /Ask for approval/ })).toBeChecked();
    failedHydration.unmount();

    const persistMode = vi.fn().mockRejectedValue(new Error("private detail"));
    render(
      <MemoriaVivaWindow
        fetchMemoriesImpl={fetchEmptyMemories}
        loadMemoryAutonomyModeImpl={vi.fn().mockResolvedValue(policy("supervised-coding"))}
        persistMemoryAutonomyModeImpl={persistMode}
      />,
    );
    const fullAccess = await screen.findByRole("radio", { name: /Full access/ });
    await waitFor(() => {
      expect(screen.getByRole("radio", { name: /Supervised workspace/ })).toBeChecked();
    });
    await user.click(fullAccess);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The memory autonomy mode could not be saved. The previous mode remains active.",
    );
    expect(screen.getByRole("radio", { name: /Supervised workspace/ })).toBeChecked();
  });

  it("selects every mode with keyboard-only radio operation", async () => {
    const user = userEvent.setup();
    const persistMode = vi
      .fn<(mode: CodingWorkbenchMode) => Promise<MemoryAutonomyPolicyWire>>()
      .mockImplementation((mode) => Promise.resolve(policy(mode)));
    render(
      <MemoriaVivaWindow
        fetchMemoriesImpl={fetchEmptyMemories}
        loadMemoryAutonomyModeImpl={vi.fn().mockResolvedValue(policy("governed-assist"))}
        persistMemoryAutonomyModeImpl={persistMode}
      />,
    );
    const ask = await screen.findByRole("radio", { name: /Ask for approval/ });
    await waitFor(() => expect(ask).toBeChecked());
    ask.focus();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => {
      expect(screen.getByRole("radio", { name: /Supervised workspace/ })).toBeChecked();
    });
    await user.keyboard("{ArrowRight}");
    await waitFor(() => {
      expect(screen.getByRole("radio", { name: /Full access/ })).toBeChecked();
    });
    expect(persistMode.mock.calls.map(([mode]) => mode)).toEqual([
      "supervised-coding",
      "autonomous-delivery",
    ]);
  });
});
