import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

    renderPanel();

    expect(screen.queryByRole("button", { name: "MemoriaViva" })).not.toBeInTheDocument();
    expect(setItem.mock.calls.map(([key]) => key)).not.toContain("keiko.twin.memory");
  });

  it("cycles policy decisions and reports policy drift in the evaluation run", async () => {
    const user = userEvent.setup();
    renderPanel();

    const prPolicy = screen.getByText("Open pull request").closest(".pol-row");
    expect(prPolicy).toBeInstanceOf(HTMLElement);

    await user.click(within(prPolicy as HTMLElement).getByRole("button", { name: "Allow" }));
    expect(
      within(prPolicy as HTMLElement).getByRole("button", { name: "Ask" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "EVAL" }));
    expect(screen.queryByText("5/6 passed")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Run evaluation" }));
    expect(screen.getByText("5/6 passed")).toBeInTheDocument();

    const prScenario = screen.getByText("Open pull request #142").closest(".evl-row");
    expect(prScenario).toBeInstanceOf(HTMLElement);
    expect(prScenario).toHaveAttribute("data-state", "fail");
    expect(within(prScenario as HTMLElement).getByText("Ask")).toBeInTheDocument();
  });

  it("persists connector toggles and persona changes in the twin surface", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("tab", { name: "Connections" }));

    const mailBridge = screen.getByRole("button", { name: "Mail" });
    expect(mailBridge).toHaveAttribute("aria-pressed", "false");
    await user.click(mailBridge);
    expect(mailBridge).toHaveAttribute("aria-pressed", "true");

    await waitFor(() => {
      expect(window.localStorage.getItem("keiko.twin.bridges")).toContain('"mail":true');
    });

    await user.click(screen.getByRole("tab", { name: "Persona" }));
    const designerPersona = screen.getByRole("button", { name: /Designer/ });
    expect(designerPersona).toHaveAttribute("aria-pressed", "false");

    await user.click(designerPersona);
    expect(designerPersona).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("mirroring · Designer")).toBeInTheDocument();

    await waitFor(() => {
      expect(window.localStorage.getItem("keiko.twin.persona")).toBe("Designer");
    });
  });

  // GEN-UI-A11Y-002: the tab strip must expose the ARIA tabs pattern so the active
  // tab is discoverable by assistive tech, not only via CSS.
  it("exposes the tab strip as an accessible tablist with a labelled tabpanel", async () => {
    const user = userEvent.setup();
    renderPanel();

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(4);

    const policyTab = screen.getByRole("tab", { name: "Policy" });
    expect(policyTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "EVAL" })).toHaveAttribute("aria-selected", "false");

    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("aria-labelledby", policyTab.id);
    expect(policyTab).toHaveAttribute("aria-controls", panel.id);

    await user.click(screen.getByRole("tab", { name: "EVAL" }));
    const evalTab = screen.getByRole("tab", { name: "EVAL" });
    expect(evalTab).toHaveAttribute("aria-selected", "true");
    expect(policyTab).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", evalTab.id);
  });
});
