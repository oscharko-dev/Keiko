import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, setupGateway } from "@/lib/api";
import type { ModelCapability } from "@/lib/types";
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
    delete document.documentElement.dataset.keikoModalOpenCount;
    document.documentElement.removeAttribute("data-keiko-modal-open");
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
  // its React ancestors include `.ws-scene`, which applies CSS `zoom` and a
  // translated scene layer. Those can establish a containing block for
  // `position: fixed` descendants in Chromium, so without a portal the
  // backdrop is sized to the zero-sized scene instead of the viewport,
  // collapsing the dialog into a tiny visual artifact inside the workspace.
  // The dialog must therefore escape any zoomed/transformed ancestor by
  // portalling to `document.body`.
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

  it("marks the app as modal-locked while open and clears the lock on unmount", () => {
    const { unmount } = render(<GatewaySetupDialog />);

    expect(document.documentElement).toHaveAttribute("data-keiko-modal-open", "true");
    expect(document.documentElement.dataset.keikoModalOpenCount).toBe("1");

    unmount();

    expect(document.documentElement).not.toHaveAttribute("data-keiko-modal-open");
    expect(document.documentElement.dataset.keikoModalOpenCount).toBeUndefined();
  });

  // FE-05 (WCAG 4.1.2): submit button must expose aria-busy reflecting the
  // pending/saving state so AT users know a request is in flight.
  // FE-03 (WCAG 3.3.4): submit button must always have aria-describedby
  // pointing to the requirement description so AT users know what is blocking.
  it("submit button has aria-busy=false initially and aria-describedby pointing to the requirements description (FE-05/FE-03)", () => {
    render(<GatewaySetupDialog />);
    const btn = screen.getByRole("button", { name: /test & save/i });
    // Not submitting — aria-busy must be false, not absent.
    expect(btn).toHaveAttribute("aria-busy", "false");
    // aria-describedby must always point at the requirements span.
    expect(btn).toHaveAttribute("aria-describedby", "gw-submit-requirements");
    const desc = document.getElementById("gw-submit-requirements");
    expect(desc).not.toBeNull();
    expect(desc?.textContent?.trim()).toMatch(/base url.*api token/i);
  });

  it("submit button has aria-busy=true while the gateway test is in flight (FE-05)", async () => {
    // Never resolves — keeps the dialog in the busy state for the assertion.
    vi.mocked(setupGateway).mockImplementation(() => new Promise(() => undefined));
    render(<GatewaySetupDialog />);

    await userEvent.type(screen.getByLabelText(/base url/i), "https://llm-gateway.example.com/v1");
    await userEvent.type(screen.getByLabelText(/api token/i), "example-token");
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    // After clicking, the submit is in flight — aria-busy must flip to true.
    expect(screen.getByRole("button", { name: /testing credentials/i })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByRole("status")).toHaveTextContent(/testing credentials/i);
  });

  it("restores focus to the triggering element when the dialog closes", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open gateway setup";
    document.body.appendChild(trigger);
    trigger.focus();

    try {
      const { unmount } = render(<GatewaySetupDialog />);
      unmount();
      expect(trigger).toHaveFocus();
    } finally {
      trigger.remove();
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
      preserveExisting: false,
    });

    // C084: the async test result must be announced — success is a status live region.
    expect(await screen.findByRole("status")).toHaveTextContent(/verified 1 workflow chat model/i);
  });

  it("announces deployments that could not be verified during setup", async () => {
    vi.mocked(setupGateway).mockResolvedValueOnce({
      ok: true,
      testedModelId: "gpt-5.4",
      testedModelIds: ["gpt-5.4"],
      skippedModelIds: ["Mistral-Large-3"],
      providerCount: 2,
      models: [],
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      },
    });
    render(<GatewaySetupDialog />);

    await userEvent.type(screen.getByLabelText(/base url/i), "https://llm-gateway.example.com/v1");
    await userEvent.type(screen.getByLabelText(/api token/i), "example-token");
    await userEvent.type(
      screen.getByLabelText(/deployment names for azure/i),
      "Mistral-Large-3\ngpt-5.4",
    );
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      /could not verify deployment: Mistral-Large-3/i,
    );
  });

  it("exposes an optional Figma access token field in gateway setup", () => {
    render(<GatewaySetupDialog />);

    expect(screen.getByLabelText(/figma access token optional/i)).toHaveAttribute(
      "placeholder",
      "Paste a read-only Figma PAT when needed",
    );
  });

  it("submits optional image-input model ids from the setup dialog", async () => {
    vi.mocked(setupGateway).mockResolvedValueOnce({
      ok: true,
      testedModelId: "internal-chat",
      testedModelIds: ["internal-chat", "vision-chat"],
      providerCount: 2,
      models: [],
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      },
    });
    render(<GatewaySetupDialog />);

    await userEvent.type(screen.getByLabelText(/base url/i), "https://llm-gateway.example.com/v1");
    await userEvent.type(screen.getByLabelText(/api token/i), "example-token");
    await userEvent.type(screen.getByLabelText(/image-input models optional/i), " vision-chat ");
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    expect(setupGateway).toHaveBeenCalledWith({
      baseUrl: "https://llm-gateway.example.com/v1",
      apiKey: "example-token",
      apiKeyHeaderName: undefined,
      deploymentNames: [],
      imageInputModelIds: ["vision-chat"],
      preserveExisting: false,
    });
  });

  it("submits a Figma access token without requiring other fields in update mode", async () => {
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
    render(
      <GatewaySetupDialog
        preserveExisting
        storedApiKeyHeaderName="x-litellm-key"
        storedModels={[
          modelCapability("gpt-oss-120b"),
          modelCapability("mistral-large-3"),
          modelCapability("llama-4-maverick-vision"),
          modelCapability("text-embedding-3-large", "embedding"),
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: /test & save/i })).toBeDisabled();
    expect(screen.getByLabelText(/figma access token optional/i)).toHaveFocus();
    expect(screen.getByText("Gateway URL")).toBeInTheDocument();
    expect(screen.getAllByText("API token").length).toBeGreaterThan(0);
    expect(screen.getByText("••••••••••••")).toBeInTheDocument();
    expect(screen.getByText("x-litellm-key")).toBeInTheDocument();
    expect(screen.getByText("gpt-oss-120b")).toBeInTheDocument();
    expect(screen.getByText("text-embedding-3-large")).toBeInTheDocument();
    expect(screen.getByText("Replace model gateway settings")).toBeInTheDocument();
    await userEvent.type(
      screen.getByLabelText(/figma access token optional/i),
      "figd_update-token",
    );
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    expect(setupGateway).toHaveBeenCalledWith({
      baseUrl: undefined,
      apiKey: undefined,
      apiKeyHeaderName: undefined,
      deploymentNames: [],
      figmaAccessToken: "figd_update-token",
      preserveExisting: true,
    });
    expect(await screen.findByRole("status")).toHaveTextContent(/verified figma access token/i);
  });

  it("announces a failed test via role=alert, keeps the code as a secondary line, and refocuses Base URL (C084/C186/C191)", async () => {
    vi.mocked(setupGateway).mockRejectedValueOnce(
      new ApiError("GATEWAY_PROBE_FAILED", "The gateway did not respond.", 502),
    );
    render(<GatewaySetupDialog />);

    await userEvent.type(screen.getByLabelText(/base url/i), "https://llm-gateway.example.com/v1");
    await userEvent.type(screen.getByLabelText(/api token/i), "example-token");
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    const alert = await screen.findByRole("alert");
    // Human message first — never a raw "CODE: message" prefix (C191) …
    expect(alert.textContent?.startsWith("GATEWAY_PROBE_FAILED")).toBe(false);
    expect(alert).toHaveTextContent("The gateway did not respond.");
    // … but the machine code stays available for support as a secondary line.
    expect(alert).toHaveTextContent("GATEWAY_PROBE_FAILED");

    // C186: after the failure the controls re-enable and focus returns to Base URL.
    await waitFor(() => expect(screen.getByLabelText(/base url/i)).toHaveFocus());
  });
});

function modelCapability(id: string, kind: ModelCapability["kind"] = "chat"): ModelCapability {
  return {
    id,
    kind,
    contextWindow: kind === "embedding" ? 8_191 : 32_000,
    maxOutputTokens: kind === "embedding" ? 0 : 4_096,
    toolCalling: kind === "chat",
    structuredOutput: kind === "chat",
    streaming: kind === "chat",
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: kind === "chat",
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "test",
    preferredUseCases: ["Tests"],
    knownLimitations: [],
  };
}
