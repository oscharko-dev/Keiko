import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setupGateway } from "@/lib/api";
import { GatewaySetupDialog } from "./GatewaySetupDialog";

vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
  setupGateway: vi.fn(),
}));

describe("GatewaySetupDialog", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("announces dialog semantics, focuses the first field, traps tab focus, and closes on Escape", async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();

    render(<GatewaySetupDialog onCancel={onCancel} />);

    const dialog = screen.getByRole("dialog", { name: /connect keiko to your internal llms/i });
    expect(dialog).toHaveAttribute("aria-modal", "true");

    const baseUrl = screen.getByLabelText(/base url/i);
    await waitFor(() => expect(baseUrl).toHaveFocus());

    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: /cancel/i })).toHaveFocus();

    await user.tab();
    expect(baseUrl).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("requires real deployment names for Azure AI Foundry before testing credentials", async () => {
    render(<GatewaySetupDialog />);

    expect(screen.getByLabelText(/deployment names for azure/i)).toHaveAttribute(
      "placeholder",
      "Paste deployment names, one per line",
    );
    expect(screen.queryByPlaceholderText("phi-4")).not.toBeInTheDocument();

    await userEvent.type(
      screen.getByLabelText(/base url/i),
      "https://workspace.example.services.ai.azure.com/openai/v1",
    );
    await userEvent.type(screen.getByLabelText(/api token/i), "example-token");
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    expect(screen.getByText(/azure ai foundry requires deployment names/i)).toBeInTheDocument();
    expect(setupGateway).not.toHaveBeenCalled();
  });

  // Issue #422: when this dialog opens from inside the Settings widget panel,
  // its React ancestors include `.ws-scene`, which uses `will-change: transform`
  // and a CSS `zoom`. Both establish a containing block for `position: fixed`
  // descendants in Chromium, so without a portal the backdrop is sized to the
  // zero-sized scene instead of the viewport, collapsing the dialog into a
  // tiny visual artifact inside the workspace. The dialog must therefore
  // escape any zoomed/transformed ancestor by portalling to `document.body`.
  it("renders into document.body so the backdrop is fixed to the viewport, not a zoomed ancestor", () => {
    const zoomedScene = document.createElement("div");
    zoomedScene.style.transform = "translate(0, 0)";
    zoomedScene.style.willChange = "transform";
    zoomedScene.setAttribute("data-testid", "zoomed-scene");
    document.body.appendChild(zoomedScene);

    try {
      render(<GatewaySetupDialog />, { container: zoomedScene });
      const dialog = screen.getByRole("dialog", { name: /connect keiko to your internal llms/i });
      const backdrop = dialog.parentElement;
      expect(backdrop).not.toBeNull();
      expect(backdrop?.classList.contains("gw-setup-backdrop")).toBe(true);
      // The dialog tree must be a direct child of document.body, not of the
      // zoomed scene that React was asked to render into.
      expect(backdrop?.parentElement).toBe(document.body);
      expect(zoomedScene.contains(dialog)).toBe(false);
    } finally {
      zoomedScene.remove();
    }
  });

  it("submits an optional custom API key header for proxy gateways", async () => {
    vi.mocked(setupGateway).mockResolvedValueOnce({
      ok: true,
      testedModelId: "internal-chat",
      testedModelIds: ["internal-chat"],
      providerCount: 1,
      models: [],
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      },
    });
    render(<GatewaySetupDialog />);

    await userEvent.type(screen.getByLabelText(/base url/i), "https://llm-gateway.example.com/v1");
    await userEvent.type(screen.getByLabelText(/api token/i), "example-token");
    await userEvent.type(screen.getByLabelText(/api key header optional/i), "X-Litellm-Key");
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    expect(setupGateway).toHaveBeenCalledWith({
      baseUrl: "https://llm-gateway.example.com/v1",
      apiKey: "example-token",
      apiKeyHeaderName: "X-Litellm-Key",
      deploymentNames: [],
    });
  });
});
