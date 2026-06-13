import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TwinProvider } from "../../context/TwinContext";
import { KeikoTwinPanel } from "./KeikoTwinPanel";

function renderPanel(): void {
  render(
    <TwinProvider>
      <KeikoTwinPanel />
    </TwinProvider>,
  );
}

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("KeikoTwinPanel", () => {
  it("does not expose a separate localStorage-backed MemoriaViva surface", async () => {
    window.localStorage.setItem("keiko.twin.memory", JSON.stringify(["private local memory"]));
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");

    renderPanel();

    await waitFor(() => {
      expect(setItem).toHaveBeenCalledWith("keiko.twin.mode", "manual");
    });
    expect(screen.queryByRole("button", { name: "MemoriaViva" })).not.toBeInTheDocument();
    expect(removeItem).toHaveBeenCalledWith("keiko.twin.memory");
    expect(window.localStorage.getItem("keiko.twin.memory")).toBeNull();
    expect(setItem.mock.calls.map(([key]) => key)).not.toContain("keiko.twin.memory");
  });
});
