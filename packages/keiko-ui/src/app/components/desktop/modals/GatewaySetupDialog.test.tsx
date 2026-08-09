import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, setupGateway } from "@/lib/api";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import type { ModelCapability } from "@/lib/types";
import { GatewaySetupDialog } from "./GatewaySetupDialog";
import { GATEWAY_CONFIG_UPDATED_EVENT } from "../widgets/shared/gatewaySetupBus";

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
    delete document.documentElement.dataset.keikoGatewaySetupOpenCount;
    document.documentElement.removeAttribute("data-keiko-gateway-setup-open");
    window.localStorage.removeItem(I18N_STORAGE_KEY);
    window.localStorage.removeItem("keiko.theme");
    document.documentElement.removeAttribute("data-theme");
  });

  it("announces dialog semantics, focuses the first field, traps tab focus, and closes on Escape", async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();

    render(<GatewaySetupDialog onCancel={onCancel} />);

    const dialog = screen.getByRole("dialog", { name: /connect keiko to your internal llms/i });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("open");

    const baseUrl = screen.getByLabelText(/base url/i);
    await waitFor(() => expect(baseUrl).toHaveFocus());

    // The config-upload control sits between the theme toggle and Base URL in the tab order.
    // It loads as its own chunk, so wait for it to mount before walking the trap.
    const uploadInput = await screen.findByLabelText(/load keiko\.config\.json/i);
    await user.tab({ shift: true });
    expect(uploadInput).toHaveFocus();

    await user.tab();
    expect(baseUrl).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("switches the global theme without clearing or submitting credentials", async () => {
    const user = userEvent.setup();
    render(<GatewaySetupDialog />);

    const baseUrl = screen.getByLabelText(/base url/i);
    const apiToken = screen.getByLabelText(/api token/i);
    await user.type(baseUrl, "https://llm-gateway.example.com/v1");
    await user.type(apiToken, "example-token");

    await user.click(screen.getByRole("button", { name: /light mode/i }));

    await waitFor(() => expect(document.documentElement).toHaveAttribute("data-theme", "light"));
    const darkModeButton = screen.getByRole("button", { name: /dark mode/i });
    expect(darkModeButton).not.toHaveAttribute("aria-pressed");
    expect(window.localStorage.getItem("keiko.theme")).toBe("light");

    await user.click(darkModeButton);

    await waitFor(() => expect(document.documentElement).toHaveAttribute("data-theme", "dark"));
    expect(screen.getByRole("button", { name: /light mode/i })).not.toHaveAttribute("aria-pressed");
    expect(window.localStorage.getItem("keiko.theme")).toBe("dark");
    expect(baseUrl).toHaveValue("https://llm-gateway.example.com/v1");
    expect(apiToken).toHaveValue("example-token");
    expect(setupGateway).not.toHaveBeenCalled();
  });

  // GEN-UI-FOCUS-015: the Tab trap must skip fields hidden inside a collapsed
  // <details> ("Replace model gateway settings" / "Update voice dictation
  // credentials"), otherwise the trap's first/last boundary can be an invisible
  // input and Tab appears to lose focus. jsdom supports the <details open>
  // attribute, so the collapsed-section filter is exercised here even though
  // jsdom cannot compute offsetParent/layout. The trap boundaries are driven
  // directly (fireEvent keydown on the dialog) because jsdom's native Tab order
  // ignores visibility and would otherwise reach the hidden fields.
  it("keeps the Tab trap boundaries out of collapsed <details> fields (GEN-UI-FOCUS-015)", async () => {
    render(
      <GatewaySetupDialog
        preserveExisting
        storedApiKeyHeaderName="authorization"
        storedModels={[modelCapability("internal-chat")]}
      />,
    );

    const dialog = screen.getByRole("dialog");

    // The replace/update fields exist in the DOM but sit inside collapsed
    // <details> — they must be excluded from the trap entirely.
    const hiddenBaseUrl = screen.getByPlaceholderText(
      "Only enter a value to replace the stored gateway URL",
    );
    const gatewayDetails = hiddenBaseUrl.closest("details");
    expect(gatewayDetails?.open).toBe(false);

    // The kept focusables begin with the visible theme toggle, followed by the
    // two <summary> toggles and the Figma token input. The boundaries never
    // resolve to a hidden field.
    const themeToggle = screen.getByRole("button", { name: "Light mode" });
    const figmaToken = screen.getByLabelText(/figma access token optional/i);
    await waitFor(() => expect(figmaToken).toHaveFocus());

    // Tab from the last boundary (Figma token) wraps to the visible theme
    // toggle, not a hidden field inside the collapsed <details>.
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(themeToggle).toHaveFocus();
    expect(document.activeElement?.tagName).toBe("BUTTON");
    expect(document.activeElement).not.toBe(hiddenBaseUrl);

    // Shift+Tab from the first boundary wraps to the last (Figma token) — a
    // visible field, never one of the hidden replace/voice inputs.
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(figmaToken).toHaveFocus();
    expect(figmaToken.closest("details")).toBeNull();
  });

  it("requires real deployment names for Microsoft Foundry before testing credentials", async () => {
    render(<GatewaySetupDialog />);

    expect(screen.getByLabelText(/deployment names for microsoft foundry/i)).toHaveAttribute(
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

    expect(screen.getByText(/microsoft foundry requires deployment names/i)).toBeInTheDocument();
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

  it("marks gateway setup as active while the credential dialog is open", () => {
    const { unmount } = render(<GatewaySetupDialog preserveExisting />);

    expect(document.documentElement).toHaveAttribute("data-keiko-gateway-setup-open", "true");
    expect(document.documentElement.dataset.keikoGatewaySetupOpenCount).toBe("1");

    unmount();

    expect(document.documentElement).not.toHaveAttribute("data-keiko-gateway-setup-open");
    expect(document.documentElement.dataset.keikoGatewaySetupOpenCount).toBeUndefined();
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

  it("prevents native cancellation while a gateway request is in flight", async () => {
    vi.mocked(setupGateway).mockImplementation(() => new Promise(() => undefined));
    const onCancel = vi.fn();
    render(<GatewaySetupDialog onCancel={onCancel} />);
    await userEvent.type(screen.getByLabelText(/base url/i), "https://llm-gateway.example.com/v1");
    await userEvent.type(screen.getByLabelText(/api token/i), "example-token");
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));
    const dialog = screen.getByRole("dialog");
    const cancelEvent = new Event("cancel", { bubbles: false, cancelable: true });

    fireEvent(dialog, cancelEvent);

    expect(cancelEvent.defaultPrevented).toBe(true);
    expect(onCancel).not.toHaveBeenCalled();
    expect(dialog).toHaveAttribute("open");
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

  it("removes whitespace from pasted first-run gateway credentials only", async (): Promise<void> => {
    const { unmount } = render(<GatewaySetupDialog />);
    const baseUrl = screen.getByLabelText(/base url/i);
    const apiToken = screen.getByLabelText(/api token/i);
    const clipboardData = (text: string): Pick<DataTransfer, "getData"> => ({
      getData: vi.fn((format: string): string => (format === "text" ? text : "")),
    });
    const baseUrlClipboardData = clipboardData(" https://llm-gateway.example.com /\n v1 ");
    const apiTokenClipboardData = clipboardData(" example \t token \n");

    expect(
      fireEvent.paste(baseUrl, {
        clipboardData: baseUrlClipboardData,
      }),
    ).toBe(false);
    expect(baseUrlClipboardData.getData).toHaveBeenCalledWith("text");
    expect(baseUrl).toHaveValue("https://llm-gateway.example.com/v1");

    expect(
      fireEvent.paste(baseUrl, {
        clipboardData: clipboardData("https://gateway.example.com/v1"),
      }),
    ).toBe(true);

    expect(
      fireEvent.paste(apiToken, {
        clipboardData: apiTokenClipboardData,
      }),
    ).toBe(false);
    expect(apiTokenClipboardData.getData).toHaveBeenCalledWith("text");
    expect(apiToken).toHaveValue("exampletoken");

    unmount();
    render(
      <GatewaySetupDialog
        preserveExisting
        storedApiKeyHeaderName="authorization"
        storedModels={[modelCapability("internal-chat")]}
      />,
    );
    await userEvent.click(screen.getByText("Replace model gateway settings"));

    expect(
      fireEvent.paste(screen.getByLabelText(/base url/i), {
        clipboardData: clipboardData(" https://llm-gateway.example.com/v1 "),
      }),
    ).toBe(true);
    expect(
      fireEvent.paste(screen.getByLabelText(/api token/i), {
        clipboardData: clipboardData(" example token "),
      }),
    ).toBe(true);
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

  // F-02 (review of #2847): the panels that remember observations about the gateway cannot see a
  // credential replacement — the safe config projection they read is credential-free, so nothing
  // about it changes when a key is rotated. The write is therefore announced, and it must be
  // announced BEFORE the page reload the dialog schedules, because for that second the Settings
  // panel is still mounted and still holding readiness verdicts about the replaced gateway.
  it("announces the configuration update as soon as the write succeeded", async () => {
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
    const onConfigUpdated = vi.fn();
    window.addEventListener(GATEWAY_CONFIG_UPDATED_EVENT, onConfigUpdated);
    try {
      render(<GatewaySetupDialog />);
      await userEvent.type(
        screen.getByLabelText(/base url/i),
        "https://llm-gateway.example.com/v1",
      );
      await userEvent.type(screen.getByLabelText(/api token/i), "example-token");
      await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

      expect(await screen.findByRole("status")).toHaveTextContent(
        /verified 1 workflow chat model/i,
      );
      expect(onConfigUpdated).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(GATEWAY_CONFIG_UPDATED_EVENT, onConfigUpdated);
    }
  });

  it("submits an optional gateway request timeout", async () => {
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
    await userEvent.type(screen.getByLabelText(/request timeout.*optional/i), "120000");
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    expect(setupGateway).toHaveBeenCalledWith({
      baseUrl: "https://llm-gateway.example.com/v1",
      apiKey: "example-token",
      apiKeyHeaderName: undefined,
      timeoutMs: 120_000,
      deploymentNames: [],
      preserveExisting: false,
    });
  });

  it("rejects a non-integer gateway request timeout before submit", async () => {
    render(<GatewaySetupDialog />);

    await userEvent.type(screen.getByLabelText(/base url/i), "https://llm-gateway.example.com/v1");
    await userEvent.type(screen.getByLabelText(/api token/i), "example-token");
    await userEvent.type(screen.getByLabelText(/request timeout.*optional/i), "12.5");
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    expect(setupGateway).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /request timeout must be a positive integer/i,
    );
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
      screen.getByLabelText(/deployment names for microsoft foundry/i),
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

  it("submits explicit coding-safe workflow model approval", async () => {
    vi.mocked(setupGateway).mockResolvedValueOnce({
      ok: true,
      testedModelId: "coding-chat",
      testedModelIds: ["coding-chat"],
      providerCount: 1,
      models: [],
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      },
    });
    render(<GatewaySetupDialog />);

    await userEvent.type(screen.getByLabelText(/base url/i), "https://llm.example.com/v1");
    await userEvent.type(screen.getByLabelText(/api token/i), "example-token");
    await userEvent.type(
      screen.getByLabelText(/coding-safe workflow models optional/i),
      "coding-chat",
    );
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    expect(setupGateway).toHaveBeenCalledWith({
      baseUrl: "https://llm.example.com/v1",
      apiKey: "example-token",
      apiKeyHeaderName: undefined,
      deploymentNames: [],
      preserveExisting: false,
      workflowEligibleModelIds: ["coding-chat"],
    });
  });

  it("submits an explicit empty workflow list when the operator clears stored approval", async () => {
    vi.mocked(setupGateway).mockResolvedValueOnce({
      ok: true,
      testedModelId: "coding-chat",
      testedModelIds: ["coding-chat"],
      providerCount: 1,
      models: [],
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      },
    });
    render(<GatewaySetupDialog preserveExisting storedModels={[modelCapability("coding-chat")]} />);

    await userEvent.click(screen.getByText("Replace model gateway settings"));
    const workflowModels = screen.getByLabelText(/coding-safe workflow models optional/i);
    expect(workflowModels).toHaveValue("coding-chat");
    await userEvent.clear(workflowModels);
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    expect(setupGateway).toHaveBeenCalledWith({
      baseUrl: undefined,
      apiKey: undefined,
      apiKeyHeaderName: undefined,
      deploymentNames: [],
      preserveExisting: true,
      workflowEligibleModelIds: [],
    });
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(/updated model gateway settings/i);
    expect(status).not.toHaveTextContent(/verified/i);
  });

  it("preserves the stored workflow approval list without requiring an edit", async () => {
    vi.mocked(setupGateway).mockResolvedValueOnce({
      ok: true,
      testedModelId: "coding-chat",
      testedModelIds: ["coding-chat"],
      providerCount: 1,
      models: [],
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      },
    });
    render(<GatewaySetupDialog preserveExisting storedModels={[modelCapability("coding-chat")]} />);

    await userEvent.click(screen.getByText("Replace model gateway settings"));
    await userEvent.type(screen.getByLabelText(/^api token/i), "rotated-token");
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    const submitted = vi.mocked(setupGateway).mock.lastCall?.[0];
    expect(submitted).toEqual(
      expect.objectContaining({ preserveExisting: true, apiKey: "rotated-token" }),
    );
    expect(submitted).not.toHaveProperty("workflowEligibleModelIds");
  });

  it("submits optional voice dictation credentials from update mode", async () => {
    vi.mocked(setupGateway).mockResolvedValueOnce({
      ok: true,
      testedModelId: "internal-chat",
      testedModelIds: ["internal-chat", "keiko-stt"],
      providerCount: 2,
      models: [],
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      },
    });
    render(
      <GatewaySetupDialog
        preserveExisting
        storedApiKeyHeaderName="authorization"
        storedModels={[modelCapability("internal-chat")]}
      />,
    );

    await userEvent.click(screen.getByText("Update audio and Digital Voice settings"));
    await userEvent.type(
      screen.getByLabelText(/audio endpoint url/i),
      "https://voice-gateway.example.com/openai/v1",
    );
    await userEvent.type(screen.getByLabelText(/^audio credential/i), "voice-token");
    await userEvent.type(screen.getByLabelText(/dictate.*speech-to-text deployment/i), "keiko-stt");
    await userEvent.type(screen.getByLabelText(/audio auth header advanced/i), "api-key");
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    expect(setupGateway).toHaveBeenCalledWith({
      baseUrl: undefined,
      apiKey: undefined,
      apiKeyHeaderName: undefined,
      deploymentNames: [],
      preserveExisting: true,
      voiceBaseUrl: "https://voice-gateway.example.com/openai/v1",
      voiceApiKey: "voice-token",
      voiceApiKeyHeaderName: "api-key",
      voiceSpeechToTextModelId: "keiko-stt",
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      /updated audio and digital voice settings/i,
    );
  });

  it("rejects new audio credentials without an explicit voice deployment", async () => {
    render(<GatewaySetupDialog />);

    await userEvent.type(screen.getByLabelText(/base url/i), "https://models.example.com/v1");
    await userEvent.type(screen.getByLabelText(/api token/i), "model-token");
    await userEvent.type(
      screen.getByLabelText(/audio endpoint url/i),
      "https://audio.example.com/v1",
    );
    await userEvent.type(screen.getByLabelText(/audio credential/i), "audio-token");
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    expect(setupGateway).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /enter at least one explicit voice deployment/i,
    );
  });

  it("renders German preserve hints for the complete stored audio connection", async () => {
    await loadLocaleMessages("de");
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    render(
      <I18nProvider>
        <GatewaySetupDialog preserveExisting storedModels={[modelCapability("internal-chat")]} />
      </I18nProvider>,
    );

    await userEvent.click(screen.getByText("Audio- und Digital-Voice-Einstellungen aktualisieren"));

    expect(screen.getByLabelText(/Audio-Endpunkt-URL.*leer lassen/i)).toHaveAttribute(
      "placeholder",
      "Mit Zugangsdaten, Lokalität und ausdrücklichen Zielrollen ersetzen",
    );
    expect(
      screen.getByText(/um einen audio-endpunkt zu ersetzen.*neue zugangsdaten/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Audio-Zugangsdaten.*leer lassen/i)).toHaveAttribute(
      "placeholder",
      "Nur ausfüllen, um die gespeicherten Audio-Zugangsdaten zu ersetzen",
    );
    expect(screen.getByLabelText(/Audio-Authentifizierungs-Header/i)).toHaveAttribute(
      "placeholder",
      "Leer lassen, um den gespeicherten Header beizubehalten",
    );
    expect(screen.getByLabelText(/Audio-Zeitlimit/i)).toHaveAttribute(
      "placeholder",
      "Leer lassen, um das gespeicherte Zeitlimit beizubehalten",
    );
  });

  it("summarizes stored voice roles and live replacement input in preserve mode", async () => {
    render(
      <GatewaySetupDialog
        preserveExisting
        storedModels={[modelCapability("internal-chat"), speechInputCapability("stored-stt")]}
      />,
    );
    await userEvent.click(screen.getByText("Update audio and Digital Voice settings"));

    expect(
      screen.getByText(/Selected capabilities: Dictate on.*Digital Voice off.*Read aloud off/iu),
    ).toBeInTheDocument();

    const realtimeDeployment = screen.getByLabelText(/Digital Voice.*Realtime deployment/i);
    await userEvent.type(realtimeDeployment, "replacement-realtime");
    expect(
      screen.getByText(/Selected capabilities: Dictate on.*Digital Voice on.*Read aloud off/iu),
    ).toBeInTheDocument();

    await userEvent.clear(realtimeDeployment);
    expect(
      screen.getByText(/Selected capabilities: Dictate on.*Digital Voice off.*Read aloud off/iu),
    ).toBeInTheDocument();
  });

  it("explains and submits separate Dictate, Digital Voice, and read-aloud deployments", async () => {
    vi.mocked(setupGateway).mockResolvedValueOnce({
      ok: true,
      testedModelId: "internal-chat",
      testedModelIds: ["internal-chat"],
      providerCount: 4,
      models: [],
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      },
    });
    render(<GatewaySetupDialog />);

    expect(screen.getByText(/dictate requires a speech-to-text deployment/i)).toBeInTheDocument();
    expect(
      screen.getByText(
        /digital voice requires a realtime media deployment and its compatible live-transcription deployment/i,
      ),
    ).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/base url/i), "https://models.example.com/v1");
    await userEvent.type(screen.getByLabelText(/api token/i), "model-token");
    await userEvent.type(
      screen.getByLabelText(/audio endpoint url/i),
      "https://audio.example.com/v1",
    );
    await userEvent.type(screen.getByLabelText(/audio credential/i), "audio-token");
    await userEvent.type(
      screen.getByLabelText(/dictate.*speech-to-text deployment/i),
      "transcribe",
    );
    await userEvent.type(screen.getByLabelText(/digital voice.*realtime deployment/i), "realtime");
    await userEvent.type(
      screen.getByLabelText(/digital voice.*live transcription deployment/i),
      "realtime-transcribe",
    );
    const semanticTurnDetection = screen.getByRole("checkbox", {
      name: /semantic turn detection/i,
    });
    expect(semanticTurnDetection).not.toBeChecked();
    await userEvent.click(semanticTurnDetection);
    await userEvent.type(screen.getByLabelText(/read aloud.*speech-output deployment/i), "tts");
    await userEvent.type(screen.getByLabelText(/output voice/i), "provider-neutral");
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    expect(setupGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        voiceBaseUrl: "https://audio.example.com/v1",
        voiceApiKey: "audio-token",
        voiceSpeechToTextModelId: "transcribe",
        voiceRealtimeModelId: "realtime",
        voiceRealtimeTranscriptionModelId: "realtime-transcribe",
        voiceSupportsSemanticTurnDetection: true,
        voiceSpeechOutputModelId: "tts",
        voiceOutputVoiceId: "provider-neutral",
      }),
    );
  });

  it("does not inherit stored Semantic VAD when configuring a new gateway", () => {
    render(<GatewaySetupDialog storedModels={[semanticRealtimeCapability("stored-realtime")]} />);

    expect(screen.getByRole("checkbox", { name: /semantic turn detection/i })).not.toBeChecked();
  });

  it.each([
    {
      label: "enabled",
      storedRealtime: realtimeCapability("stored-realtime"),
      initiallyChecked: false,
    },
    {
      label: "disabled",
      storedRealtime: semanticRealtimeCapability("stored-realtime"),
      initiallyChecked: true,
    },
  ])(
    "invalidates explicitly $label Semantic VAD when the Realtime deployment changes",
    async ({ storedRealtime, initiallyChecked }) => {
      vi.mocked(setupGateway).mockRejectedValueOnce(
        new ApiError("EXPECTED_TEST_STOP", "Stop after capturing the request.", 400),
      );
      render(
        <GatewaySetupDialog
          preserveExisting
          storedModels={[modelCapability("internal-chat"), storedRealtime]}
        />,
      );
      await userEvent.click(screen.getByText("Update audio and Digital Voice settings"));
      const semanticTurnDetection = screen.getByRole("checkbox", {
        name: /semantic turn detection/i,
      });
      expect(semanticTurnDetection).toHaveProperty("checked", initiallyChecked);

      await userEvent.click(semanticTurnDetection);
      await userEvent.type(
        screen.getByLabelText(/digital voice.*realtime deployment/i),
        "replacement-realtime",
      );
      expect(semanticTurnDetection).not.toBeChecked();
      await userEvent.type(
        screen.getByLabelText(/digital voice.*live transcription deployment/i),
        "replacement-transcription",
      );
      await userEvent.click(screen.getByRole("button", { name: /test & save/i }));
      await screen.findByRole("alert");

      const submitted = vi.mocked(setupGateway).mock.calls[0]?.[0];
      expect(submitted).not.toHaveProperty("voiceSupportsSemanticTurnDetection");
    },
  );

  it("invalidates a live-transcription alias when the Realtime deployment changes", async () => {
    render(<GatewaySetupDialog />);
    const realtimeDeployment = screen.getByLabelText(/digital voice.*realtime deployment/i);
    const transcriptionDeployment = screen.getByLabelText(
      /digital voice.*live transcription deployment/i,
    );

    await userEvent.type(realtimeDeployment, "realtime-a");
    await userEvent.type(transcriptionDeployment, "transcription-a");
    await userEvent.clear(realtimeDeployment);
    await userEvent.type(realtimeDeployment, "realtime-b");

    expect(transcriptionDeployment).toHaveValue("");
  });

  it("invalidates an output voice when the speech-output deployment changes", async () => {
    render(<GatewaySetupDialog />);
    const speechOutputDeployment = screen.getByLabelText(/read aloud.*speech-output deployment/i);
    const outputVoice = screen.getByLabelText(/output voice/i);

    await userEvent.type(speechOutputDeployment, "tts-a");
    await userEvent.type(outputVoice, "provider-a-neutral");
    await userEvent.clear(speechOutputDeployment);
    await userEvent.type(speechOutputDeployment, "tts-b");

    expect(outputVoice).toHaveValue("");
  });

  it("invalidates every provider-bound voice role when a stored audio endpoint changes", async () => {
    render(
      <GatewaySetupDialog
        preserveExisting
        storedModels={[
          modelCapability("internal-chat"),
          semanticRealtimeCapability("stored-realtime"),
        ]}
      />,
    );
    await userEvent.click(screen.getByText("Update audio and Digital Voice settings"));
    const semanticTurnDetection = screen.getByRole("checkbox", {
      name: /semantic turn detection/i,
    });
    await userEvent.type(
      screen.getByLabelText(/dictate.*speech-to-text deployment/i),
      "replacement-stt",
    );
    await userEvent.type(
      screen.getByLabelText(/digital voice.*realtime deployment/i),
      "replacement-realtime",
    );
    await userEvent.type(
      screen.getByLabelText(/digital voice.*live transcription deployment/i),
      "replacement-transcription",
    );
    await userEvent.click(semanticTurnDetection);
    await userEvent.type(
      screen.getByLabelText(/read aloud.*speech-output deployment/i),
      "replacement-tts",
    );
    await userEvent.type(screen.getByLabelText(/output voice/i), "replacement-neutral");

    await userEvent.type(
      screen.getByLabelText(/audio endpoint url/i),
      "https://replacement-audio.example.com/v1",
    );
    await userEvent.tab();

    expect(screen.getByLabelText(/dictate.*speech-to-text deployment/i)).toHaveValue("");
    expect(screen.getByLabelText(/digital voice.*realtime deployment/i)).toHaveValue("");
    expect(screen.getByLabelText(/digital voice.*live transcription deployment/i)).toHaveValue("");
    expect(semanticTurnDetection).not.toBeChecked();
    expect(screen.getByLabelText(/read aloud.*speech-output deployment/i)).toHaveValue("");
    expect(screen.getByLabelText(/output voice/i)).toHaveValue("");
  });

  it("preserves dependent values while their previously absent provider is first configured", async () => {
    render(<GatewaySetupDialog />);
    const semanticTurnDetection = screen.getByRole("checkbox", {
      name: /semantic turn detection/i,
    });
    const transcriptionDeployment = screen.getByLabelText(
      /digital voice.*live transcription deployment/i,
    );
    const outputVoice = screen.getByLabelText(/output voice/i);
    await userEvent.type(transcriptionDeployment, "first-transcription");
    await userEvent.click(semanticTurnDetection);
    await userEvent.type(outputVoice, "first-provider-neutral");

    await userEvent.type(
      screen.getByLabelText(/digital voice.*realtime deployment/i),
      "first-realtime",
    );
    await userEvent.type(
      screen.getByLabelText(/read aloud.*speech-output deployment/i),
      "first-tts",
    );
    await userEvent.type(
      screen.getByLabelText(/audio endpoint url/i),
      "https://first-audio.example.com/v1",
    );

    expect(transcriptionDeployment).toHaveValue("first-transcription");
    expect(semanticTurnDetection).toBeChecked();
    expect(outputVoice).toHaveValue("first-provider-neutral");
  });

  it("requires an explicit provider voice before configuring speech output", async () => {
    render(<GatewaySetupDialog />);
    await userEvent.type(screen.getByLabelText(/base url/i), "https://models.example.com/v1");
    await userEvent.type(screen.getByLabelText(/api token/i), "model-token");
    await userEvent.type(
      screen.getByLabelText(/audio endpoint url/i),
      "https://audio.example.com/v1",
    );
    await userEvent.type(screen.getByLabelText(/audio credential/i), "audio-token");
    await userEvent.type(screen.getByLabelText(/read aloud.*speech-output deployment/i), "tts");

    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    expect(setupGateway).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(/explicit provider voice id/i);
  });

  it("does not carry stored semantic VAD support to an untouched replacement", async () => {
    vi.mocked(setupGateway).mockResolvedValueOnce({
      ok: true,
      testedModelId: "internal-chat",
      testedModelIds: ["internal-chat", "replacement-realtime"],
      providerCount: 2,
      models: [],
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      },
    });
    render(
      <GatewaySetupDialog
        preserveExisting
        storedModels={[
          modelCapability("internal-chat"),
          semanticRealtimeCapability("stored-realtime"),
        ]}
      />,
    );

    await userEvent.click(screen.getByText("Update audio and Digital Voice settings"));
    expect(screen.getByRole("checkbox", { name: /semantic turn detection/i })).toBeChecked();
    const realtimeDeployment = screen.getByLabelText(/digital voice.*realtime deployment/i);
    await userEvent.type(realtimeDeployment, "replacement-realtime");
    expect(screen.getByRole("checkbox", { name: /semantic turn detection/i })).not.toBeChecked();
    await userEvent.clear(realtimeDeployment);
    expect(screen.getByRole("checkbox", { name: /semantic turn detection/i })).toBeChecked();
    await userEvent.type(realtimeDeployment, "replacement-realtime");
    expect(screen.getByRole("checkbox", { name: /semantic turn detection/i })).not.toBeChecked();
    await userEvent.type(
      screen.getByLabelText(/digital voice.*live transcription deployment/i),
      "replacement-transcription",
    );
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    const submitted = vi.mocked(setupGateway).mock.calls[0]?.[0];
    expect(submitted).toMatchObject({
      preserveExisting: true,
      voiceRealtimeModelId: "replacement-realtime",
      voiceRealtimeTranscriptionModelId: "replacement-transcription",
    });
    expect(submitted).not.toHaveProperty("voiceSupportsSemanticTurnDetection");
  });

  it("does not require the unchanged transcription alias for a scoped credential rotation", async () => {
    vi.mocked(setupGateway).mockRejectedValueOnce(
      new ApiError("EXPECTED_TEST_STOP", "Stop after capturing the request.", 400),
    );
    render(
      <GatewaySetupDialog
        preserveExisting
        storedModels={[modelCapability("internal-chat"), realtimeCapability("stored-realtime")]}
      />,
    );
    await userEvent.click(screen.getByText("Update audio and Digital Voice settings"));
    await userEvent.type(screen.getByLabelText(/^audio credential/i), "rotated-token");
    await userEvent.type(
      screen.getByLabelText(/digital voice.*realtime deployment/i),
      "stored-realtime",
    );

    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));
    await screen.findByRole("alert");

    const submitted = vi.mocked(setupGateway).mock.calls[0]?.[0];
    expect(submitted).toMatchObject({
      preserveExisting: true,
      voiceApiKey: "rotated-token",
      voiceRealtimeModelId: "stored-realtime",
    });
    expect(submitted).not.toHaveProperty("voiceRealtimeTranscriptionModelId");
  });

  it("binds untouched Semantic VAD state to the elected Realtime provider", async () => {
    vi.mocked(setupGateway).mockRejectedValueOnce(
      new ApiError("EXPECTED_TEST_STOP", "Stop after capturing the request.", 400),
    );
    render(
      <GatewaySetupDialog
        preserveExisting
        storedModels={[
          modelCapability("internal-chat"),
          realtimeCapability("elected-realtime"),
          semanticRealtimeCapability("secondary-realtime"),
        ]}
      />,
    );

    await userEvent.click(screen.getByText("Update audio and Digital Voice settings"));
    const semanticTurnDetection = screen.getByRole("checkbox", {
      name: /semantic turn detection/i,
    });
    expect(semanticTurnDetection).not.toBeChecked();

    await userEvent.type(
      screen.getByLabelText(/digital voice.*realtime deployment/i),
      "secondary-realtime",
    );
    expect(semanticTurnDetection).not.toBeChecked();
    await userEvent.type(
      screen.getByLabelText(/digital voice.*live transcription deployment/i),
      "secondary-transcription",
    );
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));
    await screen.findByRole("alert");

    const submitted = vi.mocked(setupGateway).mock.calls[0]?.[0];
    expect(submitted).toMatchObject({
      preserveExisting: true,
      voiceRealtimeModelId: "secondary-realtime",
      voiceRealtimeTranscriptionModelId: "secondary-transcription",
    });
    expect(submitted).not.toHaveProperty("voiceSupportsSemanticTurnDetection");
  });

  it("shows Semantic VAD for the cheapest runtime-elected Realtime provider", async () => {
    render(
      <GatewaySetupDialog
        preserveExisting
        storedModels={[
          modelCapability("internal-chat"),
          { ...realtimeCapability("realtime-high"), costClass: "high" },
          { ...semanticRealtimeCapability("realtime-low"), costClass: "low" },
        ]}
      />,
    );

    await userEvent.click(screen.getByText("Update audio and Digital Voice settings"));

    expect(screen.getByRole("checkbox", { name: /semantic turn detection/i })).toBeChecked();
  });

  it("resets untouched Semantic VAD when an entered endpoint targets Realtime", async () => {
    vi.mocked(setupGateway).mockRejectedValueOnce(
      new ApiError("EXPECTED_TEST_STOP", "Stop after capturing the request.", 400),
    );
    render(
      <GatewaySetupDialog
        preserveExisting
        storedModels={[
          modelCapability("internal-chat"),
          semanticRealtimeCapability("stored-realtime"),
        ]}
      />,
    );
    await userEvent.click(screen.getByText("Update audio and Digital Voice settings"));
    const semanticTurnDetection = screen.getByRole("checkbox", {
      name: /semantic turn detection/i,
    });
    expect(semanticTurnDetection).toBeChecked();
    await userEvent.type(
      screen.getByLabelText(/audio endpoint url/i),
      " https://audio.example.com/v1/// ",
    );
    await userEvent.type(screen.getByLabelText(/^audio credential/i), "replacement-token");
    await userEvent.type(
      screen.getByLabelText(/digital voice.*realtime deployment/i),
      "stored-realtime",
    );
    await userEvent.type(
      screen.getByLabelText(/digital voice.*live transcription deployment/i),
      "stored-transcription",
    );
    await userEvent.click(screen.getByRole("combobox", { name: /provider locality/i }));
    await userEvent.click(screen.getByRole("option", { name: "Microsoft Foundry" }));
    expect(semanticTurnDetection).not.toBeChecked();

    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));
    await screen.findByRole("alert");

    const submitted = vi.mocked(setupGateway).mock.calls[0]?.[0];
    expect(submitted).toMatchObject({
      preserveExisting: true,
      voiceBaseUrl: "https://audio.example.com/v1///",
      voiceApiKey: "replacement-token",
      voiceProviderLocality: "azure-foundry",
      voiceRealtimeModelId: "stored-realtime",
      voiceRealtimeTranscriptionModelId: "stored-transcription",
    });
    expect(submitted).not.toHaveProperty("voiceSupportsSemanticTurnDetection");
  });

  it("explains the fields required to replace a stored audio endpoint", async () => {
    render(
      <GatewaySetupDialog
        preserveExisting
        storedModels={[
          modelCapability("internal-chat"),
          semanticRealtimeCapability("stored-realtime"),
        ]}
      />,
    );
    await userEvent.click(screen.getByText("Update audio and Digital Voice settings"));
    await userEvent.type(
      screen.getByLabelText(/audio endpoint url/i),
      "https://replacement-audio.example.com/v1",
    );

    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    expect(setupGateway).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /requires a fresh credential.*provider locality.*deployment role/i,
    );
  });

  it("requires a compatible live-transcription deployment before replacing Realtime", async () => {
    render(
      <GatewaySetupDialog
        preserveExisting
        storedModels={[
          modelCapability("internal-chat"),
          semanticRealtimeCapability("stored-realtime"),
        ]}
      />,
    );

    await userEvent.click(screen.getByText("Update audio and Digital Voice settings"));
    await userEvent.type(
      screen.getByLabelText(/digital voice.*realtime deployment/i),
      "replacement-realtime",
    );
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    expect(setupGateway).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /enter the compatible live-transcription deployment for this realtime deployment/i,
    );
  });

  it("rejects a live-transcription deployment without an explicit Realtime deployment", async () => {
    render(
      <GatewaySetupDialog
        preserveExisting
        storedApiKeyHeaderName="authorization"
        storedModels={[modelCapability("internal-chat")]}
      />,
    );

    await userEvent.click(screen.getByText("Update audio and Digital Voice settings"));
    await userEvent.type(
      screen.getByLabelText(/digital voice.*live transcription deployment/i),
      "orphan-transcription",
    );
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    expect(setupGateway).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /live-transcription deployment requires an explicit Realtime deployment/i,
    );
  });

  it("submits an explicit semantic VAD opt-out for a replacement", async () => {
    vi.mocked(setupGateway).mockResolvedValueOnce({
      ok: true,
      testedModelId: "internal-chat",
      testedModelIds: ["internal-chat", "replacement-realtime"],
      providerCount: 2,
      models: [],
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      },
    });
    render(
      <GatewaySetupDialog
        preserveExisting
        storedModels={[
          modelCapability("internal-chat"),
          semanticRealtimeCapability("stored-realtime"),
        ]}
      />,
    );

    await userEvent.click(screen.getByText("Update audio and Digital Voice settings"));
    const semanticTurnDetection = screen.getByRole("checkbox", {
      name: /semantic turn detection/i,
    });
    expect(semanticTurnDetection).toBeChecked();
    await userEvent.type(
      screen.getByLabelText(/digital voice.*realtime deployment/i),
      "replacement-realtime",
    );
    await userEvent.type(
      screen.getByLabelText(/digital voice.*live transcription deployment/i),
      "replacement-transcription",
    );
    expect(semanticTurnDetection).not.toBeChecked();
    await userEvent.click(semanticTurnDetection);
    await userEvent.click(semanticTurnDetection);
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    const submitted = vi.mocked(setupGateway).mock.calls[0]?.[0];
    expect(submitted).toMatchObject({
      preserveExisting: true,
      voiceRealtimeModelId: "replacement-realtime",
      voiceRealtimeTranscriptionModelId: "replacement-transcription",
      voiceSupportsSemanticTurnDetection: false,
    });
    expect(submitted).not.toHaveProperty("voiceOutputVoiceId");
    expect(submitted).not.toHaveProperty("voiceProviderLocality");
  });

  it("uses the Keiko styled select for provider locality and labels Foundry correctly", async () => {
    const user = userEvent.setup();
    render(
      <GatewaySetupDialog
        preserveExisting
        storedApiKeyHeaderName="authorization"
        storedModels={[modelCapability("internal-chat")]}
      />,
    );

    await user.click(screen.getByText("Update audio and Digital Voice settings"));
    const locality = screen.getByRole("combobox", { name: /provider locality/i });

    expect(locality.tagName).toBe("BUTTON");
    expect(locality).toHaveClass("gw-provider-locality-select");
    expect(locality).toHaveClass("ksel-trigger");
    expect(locality).toHaveTextContent("Microsoft Foundry");
    expect(screen.queryByText("Azure Foundry")).not.toBeInTheDocument();

    await user.click(locality);

    const menu = document.querySelector(".gw-provider-locality-menu");
    expect(menu).not.toBeNull();
    expect(menu).toHaveClass("ksel-menu");
    expect(screen.getByRole("listbox", { name: /provider locality/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Microsoft Foundry" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Azure Foundry" })).not.toBeInTheDocument();
  });

  it("submits output voice and provider locality only after the operator changes them", async () => {
    vi.mocked(setupGateway).mockResolvedValueOnce({
      ok: true,
      testedModelId: "internal-chat",
      testedModelIds: ["internal-chat", "stored-realtime"],
      providerCount: 2,
      models: [],
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      },
    });
    render(
      <GatewaySetupDialog
        preserveExisting
        storedModels={[
          modelCapability("internal-chat"),
          semanticRealtimeCapability("stored-realtime"),
        ]}
      />,
    );
    await userEvent.click(screen.getByText("Update audio and Digital Voice settings"));

    const outputVoice = screen.getByLabelText(/output voice/i);
    await userEvent.clear(outputVoice);
    await userEvent.type(outputVoice, "customer-neutral");
    await userEvent.click(screen.getByRole("combobox", { name: /provider locality/i }));
    await userEvent.click(screen.getByRole("option", { name: "Customer-hosted" }));
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    const submitted = vi.mocked(setupGateway).mock.calls[0]?.[0];
    expect(submitted).toMatchObject({
      preserveExisting: true,
      voiceOutputVoiceId: "customer-neutral",
      voiceProviderLocality: "customer-hosted",
    });
    expect(submitted).not.toHaveProperty("voiceSupportsSemanticTurnDetection");
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

  it("fills the form from an uploaded keiko.config.json and reports the applied count", async () => {
    render(<GatewaySetupDialog />);

    // The upload control loads as its own chunk — wait for it to mount instead of relying on
    // an earlier test having warmed the chunk (that ordering is not a contract).
    const upload = await screen.findByLabelText(/load keiko\.config\.json/i);
    await userEvent.upload(
      upload,
      new File(
        [
          JSON.stringify({
            providers: [
              {
                modelId: "gpt-5o",
                baseUrl: "https://llm-gateway.example.com/v1",
                apiKeyHeaderName: "api-key",
                timeoutMs: 30_000,
                capability: {
                  id: "gpt-5o",
                  kind: "chat",
                  supportsImageInput: true,
                  workflowEligible: true,
                },
              },
              {
                modelId: "text-embed",
                baseUrl: "https://llm-gateway.example.com/v1",
                apiKeyHeaderName: "api-key",
                timeoutMs: 30_000,
              },
            ],
          }),
        ],
        "keiko.config.json",
        { type: "application/json" },
      ),
    );

    await waitFor(() =>
      expect(screen.getByLabelText(/base url/i)).toHaveValue("https://llm-gateway.example.com/v1"),
    );
    expect(screen.getByLabelText(/api key header/i)).toHaveValue("api-key");
    expect(screen.getByLabelText(/request timeout/i)).toHaveValue("30000");
    expect(screen.getByLabelText(/deployment names/i)).toHaveValue("gpt-5o\ntext-embed");
    expect(screen.getByText(/configuration loaded — 6 field/i)).toBeInTheDocument();
    // The token was not in the file: manual entry (and the one-time token test) still applies.
    expect(screen.getByLabelText(/api token/i)).toHaveValue("");
  });

  it("replaces the hidden embedding kinds when a corrected file is uploaded", async () => {
    // Hidden imported state is file-scoped: after a corrected re-upload declares model-x as
    // CHAT, the submit must not still assert the FIRST file's embedding kind — the server
    // would classify the corrected deployment as embedding without a chat probe (#3037).
    vi.mocked(setupGateway).mockResolvedValueOnce({
      ok: true,
      testedModelId: "gpt-5o",
      testedModelIds: ["gpt-5o"],
      providerCount: 1,
      models: [],
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      },
    });
    render(<GatewaySetupDialog />);

    const upload = await screen.findByLabelText(/load keiko\.config\.json/i);
    const configFile = (capabilityKind: string): File =>
      new File(
        [
          JSON.stringify({
            providers: [
              {
                modelId: "gpt-5o",
                baseUrl: "https://llm-gateway.example.com/v1",
                capability: { id: "gpt-5o", kind: "chat" },
              },
              {
                modelId: "model-x",
                baseUrl: "https://llm-gateway.example.com/v1",
                capability: { id: "model-x", kind: capabilityKind },
              },
            ],
          }),
        ],
        "keiko.config.json",
        { type: "application/json" },
      );

    await userEvent.upload(upload, configFile("embedding"));
    await waitFor(() =>
      expect(screen.getByLabelText(/base url/i)).toHaveValue("https://llm-gateway.example.com/v1"),
    );
    await userEvent.upload(upload, configFile("chat"));
    await userEvent.type(screen.getByLabelText(/api token/i), "example-token");
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    await waitFor(() => expect(setupGateway).toHaveBeenCalledTimes(1));
    expect(vi.mocked(setupGateway).mock.calls[0]?.[0]).not.toHaveProperty("embeddingModelIds");
  });

  it("resets the invisible configured flags when a corrected file stays silent about them", async () => {
    // File 1 declares an explicit EMPTY image list (a clear request); the corrected file 2 says
    // nothing about the flag lists. A stale invisible configured flag would turn the submit into
    // a stored-flag clear file 2 never asked for (#3037).
    vi.mocked(setupGateway).mockResolvedValueOnce({
      ok: true,
      testedModelId: "gpt-5o",
      testedModelIds: ["gpt-5o"],
      providerCount: 1,
      models: [],
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      },
    });
    render(<GatewaySetupDialog />);

    const upload = await screen.findByLabelText(/load keiko\.config\.json/i);
    const fileOf = (payload: Record<string, unknown>): File =>
      new File([JSON.stringify(payload)], "keiko.config.json", { type: "application/json" });

    await userEvent.upload(
      upload,
      fileOf({
        providers: [
          {
            modelId: "gpt-5o",
            baseUrl: "https://llm-gateway.example.com/v1",
            capability: { id: "gpt-5o", kind: "chat", supportsImageInput: false },
          },
        ],
      }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/base url/i)).toHaveValue("https://llm-gateway.example.com/v1"),
    );
    // The corrected file carries no capability records — it never speaks about the flag lists.
    await userEvent.upload(
      upload,
      fileOf({
        providers: [{ modelId: "gpt-5o", baseUrl: "https://llm-gateway.example.com/v1" }],
      }),
    );
    await userEvent.type(screen.getByLabelText(/api token/i), "example-token");
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    await waitFor(() => expect(setupGateway).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(setupGateway).mock.calls[0]?.[0];
    expect(payload).not.toHaveProperty("imageInputModelIds");
    expect(payload).not.toHaveProperty("workflowEligibleModelIds");
  });

  it("submits imported speech-synthesis instruction support with the voice section", async () => {
    // Review finding on #3037: the flag is behavior-bearing speech-output tuning — an uploaded
    // declaration must ride the submit, or the rebuilt capability silently loses instruction
    // support while the upload reported success.
    vi.mocked(setupGateway).mockResolvedValueOnce({
      ok: true,
      testedModelId: "gpt-5o",
      testedModelIds: ["gpt-5o"],
      providerCount: 1,
      models: [],
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      },
    });
    render(<GatewaySetupDialog />);

    await userEvent.upload(
      await screen.findByLabelText(/load keiko\.config\.json/i),
      new File(
        [
          JSON.stringify({
            providers: [
              {
                modelId: "gpt-5o",
                baseUrl: "https://llm-gateway.example.com/v1",
                capability: { id: "gpt-5o", kind: "chat" },
              },
              {
                modelId: "keiko-tts",
                baseUrl: "https://speech.example.com",
                capability: {
                  id: "keiko-tts",
                  kind: "voice",
                  voiceProviderLocality: "azure-foundry",
                  supportsSpeechOutput: true,
                  supportsSpeechSynthesisInstructions: true,
                },
                voiceProfiles: [{ persona: "neutral", voiceId: "ash" }],
              },
            ],
          }),
        ],
        "keiko.config.json",
        { type: "application/json" },
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/audio endpoint url/i)).toHaveValue(
        "https://speech.example.com",
      ),
    );
    await userEvent.type(screen.getByLabelText(/^audio credential/i), "voice-token");
    await userEvent.type(screen.getByLabelText(/api token/i), "example-token");
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    await waitFor(() => expect(setupGateway).toHaveBeenCalledTimes(1));
    expect(vi.mocked(setupGateway).mock.calls[0]?.[0]).toMatchObject({
      voiceSpeechOutputModelId: "keiko-tts",
      voiceSupportsSpeechSynthesisInstructions: true,
    });
  });

  it("clears synthesis support explicitly when the speech-output identity changes", async () => {
    // Codex finding on #3041: marking the hidden pair unconfigured OMITTED the field, so the
    // server template (the old provider's rawCapability at the same endpoint) re-inherited
    // instruction support onto the replacement model — speech requests would send instructions
    // to a deployment that never declared them. The identity transition now submits an explicit
    // clear.
    vi.mocked(setupGateway).mockResolvedValueOnce({
      ok: true,
      testedModelId: "gpt-5o",
      testedModelIds: ["gpt-5o"],
      providerCount: 1,
      models: [],
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      },
    });
    render(<GatewaySetupDialog />);

    await userEvent.upload(
      await screen.findByLabelText(/load keiko\.config\.json/i),
      new File(
        [
          JSON.stringify({
            providers: [
              {
                modelId: "gpt-5o",
                baseUrl: "https://llm-gateway.example.com/v1",
                capability: { id: "gpt-5o", kind: "chat" },
              },
              {
                modelId: "keiko-tts",
                baseUrl: "https://speech.example.com",
                capability: {
                  id: "keiko-tts",
                  kind: "voice",
                  voiceProviderLocality: "azure-foundry",
                  supportsSpeechOutput: true,
                  supportsSpeechSynthesisInstructions: true,
                },
                voiceProfiles: [{ persona: "neutral", voiceId: "ash" }],
              },
            ],
          }),
        ],
        "keiko.config.json",
        { type: "application/json" },
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/read aloud.*speech-output deployment/i)).toHaveValue(
        "keiko-tts",
      ),
    );
    // The user replaces the speech-output model — the imported flag belongs to the OLD model.
    await userEvent.clear(screen.getByLabelText(/read aloud.*speech-output deployment/i));
    await userEvent.type(
      screen.getByLabelText(/read aloud.*speech-output deployment/i),
      "other-tts",
    );
    await userEvent.type(screen.getByLabelText(/output voice/i), "coral");
    await userEvent.type(screen.getByLabelText(/^audio credential/i), "voice-token");
    await userEvent.type(screen.getByLabelText(/api token/i), "example-token");
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    await waitFor(() => expect(setupGateway).toHaveBeenCalledTimes(1));
    expect(vi.mocked(setupGateway).mock.calls[0]?.[0]).toMatchObject({
      voiceSpeechOutputModelId: "other-tts",
      voiceSupportsSpeechSynthesisInstructions: false,
    });
  });

  it("drops stale synthesis support when a corrected upload omits the TTS role", async () => {
    // Codex finding on #3041: in a fresh dialog the speech-output identity ref starts undefined,
    // so an STT-only re-upload after a TTS upload never triggered the dependency reset — the
    // stale configured true was submitted without a speech-output role and the corrected file
    // became unsavable against the server's relationship validation.
    vi.mocked(setupGateway).mockResolvedValueOnce({
      ok: true,
      testedModelId: "gpt-5o",
      testedModelIds: ["gpt-5o"],
      providerCount: 1,
      models: [],
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      },
    });
    render(<GatewaySetupDialog />);
    const upload = async (providers: readonly Record<string, unknown>[]): Promise<void> => {
      await userEvent.upload(
        await screen.findByLabelText(/load keiko\.config\.json/i),
        new File([JSON.stringify({ providers })], "keiko.config.json", {
          type: "application/json",
        }),
      );
    };

    await upload([
      {
        modelId: "gpt-5o",
        baseUrl: "https://llm-gateway.example.com/v1",
        capability: { id: "gpt-5o", kind: "chat" },
      },
      {
        modelId: "keiko-tts",
        baseUrl: "https://speech.example.com",
        capability: {
          id: "keiko-tts",
          kind: "voice",
          voiceProviderLocality: "azure-foundry",
          supportsSpeechOutput: true,
          supportsSpeechSynthesisInstructions: true,
        },
        voiceProfiles: [{ persona: "neutral", voiceId: "ash" }],
      },
    ]);
    await waitFor(() =>
      expect(screen.getByLabelText(/read aloud.*speech-output deployment/i)).toHaveValue(
        "keiko-tts",
      ),
    );
    // The corrected file keeps the voice section but drops the TTS role entirely.
    await upload([
      {
        modelId: "gpt-5o",
        baseUrl: "https://llm-gateway.example.com/v1",
        capability: { id: "gpt-5o", kind: "chat" },
      },
      {
        modelId: "keiko-stt",
        baseUrl: "https://speech.example.com",
        capability: {
          id: "keiko-stt",
          kind: "voice",
          voiceProviderLocality: "azure-foundry",
          supportsSpeechInput: true,
        },
      },
    ]);
    await waitFor(() =>
      expect(screen.getByLabelText(/read aloud.*speech-output deployment/i)).toHaveValue(""),
    );
    await userEvent.type(screen.getByLabelText(/^audio credential/i), "voice-token");
    await userEvent.type(screen.getByLabelText(/api token/i), "example-token");
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    await waitFor(() => expect(setupGateway).toHaveBeenCalledTimes(1));
    expect(vi.mocked(setupGateway).mock.calls[0]?.[0]).not.toHaveProperty(
      "voiceSupportsSpeechSynthesisInstructions",
    );
  });

  it("submits an operator-stated audio endpoint style after a manual endpoint move", async () => {
    // Review finding on #3042: moving an Azure voice endpoint by hand had no way to state the
    // protocol for the new host, so the save either dropped it silently (before the server
    // guard) or is refused (after it). The visible fields make the statement possible, and it
    // rides the submit even though the URL no longer matches any uploaded endpoint.
    vi.mocked(setupGateway).mockResolvedValueOnce({
      ok: true,
      testedModelId: "gpt-5o",
      testedModelIds: ["gpt-5o"],
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
    await userEvent.type(
      screen.getByLabelText(/audio endpoint url/i),
      "https://new-voice.example.com",
    );
    await userEvent.type(screen.getByLabelText(/^audio credential/i), "voice-token");
    await userEvent.type(
      screen.getByLabelText(/read aloud.*speech-output deployment/i),
      "azure-tts",
    );
    await userEvent.type(screen.getByLabelText(/output voice/i), "ash");
    // The selector is the feature under test: without this the assertion passed with the whole
    // style control removed, and an api-version-without-style pair is what the server rejects
    // (review findings on #3048).
    await userEvent.click(screen.getByRole("combobox", { name: /audio endpoint style/i }));
    await userEvent.click(screen.getByRole("option", { name: "Azure deployment path" }));
    await userEvent.type(screen.getByLabelText(/audio api version/i), "2025-04-01-preview");
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    await waitFor(() => expect(setupGateway).toHaveBeenCalledTimes(1));
    expect(vi.mocked(setupGateway).mock.calls[0]?.[0]).toMatchObject({
      voiceBaseUrl: "https://new-voice.example.com",
      voiceEndpointStyle: "azure-openai-deployment",
      voiceApiVersion: "2025-04-01-preview",
    });
  });

  it("submits a protocol correction made against the stored audio endpoint", async () => {
    // Review finding on #3048: a blank audio URL in preserve mode means "keep the stored
    // endpoint", but the payload returned early on it and dropped the correction — the save
    // reported success while the protocol stayed as it was.
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
        storedModels={[modelCapability("internal-chat"), semanticRealtimeCapability("stored-rt")]}
      />,
    );
    await userEvent.click(screen.getByText("Update audio and Digital Voice settings"));
    await userEvent.click(screen.getByRole("combobox", { name: /audio endpoint style/i }));
    await userEvent.click(screen.getByRole("option", { name: "Azure deployment path" }));
    await userEvent.type(screen.getByLabelText(/audio api version/i), "2025-04-01-preview");
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    await waitFor(() => expect(setupGateway).toHaveBeenCalledTimes(1));
    expect(vi.mocked(setupGateway).mock.calls[0]?.[0]).toMatchObject({
      voiceEndpointStyle: "azure-openai-deployment",
      voiceApiVersion: "2025-04-01-preview",
    });
  });

  it("drops an orphaned api version when a fresh setup states no protocol", async () => {
    // Review finding on #3048: "Not stated" was left alone so the stored template could still
    // supply the Azure style — but a FRESH setup has no template. The submit then carried an api
    // version with no style, the one pair the gateway parser refuses, and the operator had to
    // find and clear the field by hand.
    vi.mocked(setupGateway).mockResolvedValueOnce({
      ok: true,
      testedModelId: "gpt-5o",
      testedModelIds: ["gpt-5o"],
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
    await userEvent.type(screen.getByLabelText(/audio endpoint url/i), "https://voice.example.com");
    await userEvent.type(screen.getByLabelText(/^audio credential/i), "voice-token");
    await userEvent.type(
      screen.getByLabelText(/read aloud.*speech-output deployment/i),
      "azure-tts",
    );
    await userEvent.type(screen.getByLabelText(/output voice/i), "ash");
    await userEvent.click(screen.getByRole("combobox", { name: /audio endpoint style/i }));
    await userEvent.click(screen.getByRole("option", { name: "Azure deployment path" }));
    await userEvent.type(screen.getByLabelText(/audio api version/i), "2025-04-01-preview");
    await userEvent.click(screen.getByRole("combobox", { name: /audio endpoint style/i }));
    await userEvent.click(screen.getByRole("option", { name: "Not stated" }));

    await waitFor(() => expect(screen.getByLabelText(/audio api version/i)).toHaveValue(""));
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    await waitFor(() => expect(setupGateway).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(setupGateway).mock.calls[0]?.[0] ?? {};
    expect(payload).not.toHaveProperty("voiceApiVersion");
    expect(payload).not.toHaveProperty("voiceEndpointStyle");
  });

  it("lets the operator state the realtime auth mode the server now demands", async () => {
    // Review finding on #3048: the server refuses an audio endpoint move that leaves a declared
    // realtime auth mode unstated, but the dialog exposed no control for it — the mode could
    // only come from a config upload, so a manual move of an ephemeral-session provider was
    // impossible. A guard the UI cannot satisfy is a dead end, not a guard.
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
        storedModels={[modelCapability("internal-chat"), semanticRealtimeCapability("stored-rt")]}
      />,
    );
    await userEvent.click(screen.getByText("Update audio and Digital Voice settings"));
    await userEvent.click(screen.getByRole("combobox", { name: /realtime authentication/i }));
    await userEvent.click(screen.getByRole("option", { name: "Ephemeral session token" }));
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    await waitFor(() => expect(setupGateway).toHaveBeenCalledTimes(1));
    expect(vi.mocked(setupGateway).mock.calls[0]?.[0]).toMatchObject({
      voiceRealtimeAuthMode: "ephemeral-session",
    });
  });

  it("clears a typed api version when the style returns to Not stated", async () => {
    // Review finding on #3048: "Not stated" kept a typed version in preserve mode on the theory
    // that the stored template might be Azure. If the stored style is openai-compatible the
    // server pairs the submitted version against it and refuses the save — and when the template
    // IS Azure it supplies the version along with the style, so keeping it buys nothing.
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
        storedModels={[modelCapability("internal-chat"), semanticRealtimeCapability("stored-rt")]}
      />,
    );
    await userEvent.click(screen.getByText("Update audio and Digital Voice settings"));
    await userEvent.click(screen.getByRole("combobox", { name: /audio endpoint style/i }));
    await userEvent.click(screen.getByRole("option", { name: "Azure deployment path" }));
    await userEvent.type(screen.getByLabelText(/audio api version/i), "2025-04-01-preview");
    await userEvent.click(screen.getByRole("combobox", { name: /audio endpoint style/i }));
    await userEvent.click(screen.getByRole("option", { name: "Not stated" }));

    await waitFor(() => expect(screen.getByLabelText(/audio api version/i)).toHaveValue(""));
    await userEvent.click(screen.getByRole("combobox", { name: /realtime authentication/i }));
    await userEvent.click(screen.getByRole("option", { name: "API key" }));
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    await waitFor(() => expect(setupGateway).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(setupGateway).mock.calls[0]?.[0] ?? {};
    expect(payload).not.toHaveProperty("voiceApiVersion");
    expect(payload).not.toHaveProperty("voiceEndpointStyle");
  });

  it("drops the api version when the operator leaves the Azure deployment path", async () => {
    // Review finding on #3048: an api version paired with openai-compatible is exactly what the
    // gateway parser refuses, so leaving it behind turned a protocol correction into a 400 the
    // operator had to decode and clear by hand.
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
        storedModels={[modelCapability("internal-chat"), semanticRealtimeCapability("stored-rt")]}
      />,
    );
    await userEvent.click(screen.getByText("Update audio and Digital Voice settings"));
    await userEvent.click(screen.getByRole("combobox", { name: /audio endpoint style/i }));
    await userEvent.click(screen.getByRole("option", { name: "Azure deployment path" }));
    await userEvent.type(screen.getByLabelText(/audio api version/i), "2025-04-01-preview");
    await userEvent.click(screen.getByRole("combobox", { name: /audio endpoint style/i }));
    await userEvent.click(screen.getByRole("option", { name: "OpenAI-compatible" }));

    await waitFor(() => expect(screen.getByLabelText(/audio api version/i)).toHaveValue(""));
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    await waitFor(() => expect(setupGateway).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(setupGateway).mock.calls[0]?.[0] ?? {};
    expect(payload).toMatchObject({ voiceEndpointStyle: "openai-compatible" });
    expect(payload).not.toHaveProperty("voiceApiVersion");
  });

  it("keeps the imported audio protocol across an identity-equivalent URL edit", async () => {
    // Review finding on #3048: the binding was compared as a raw string, so a trailing slash or
    // a differently-cased hostname read as an endpoint move. The server treats those spellings
    // as the same endpoint, and a fresh setup has no stored template to recover the protocol
    // from, so the save succeeded with the wrong URL shape.
    vi.mocked(setupGateway).mockResolvedValueOnce({
      ok: true,
      testedModelId: "gpt-5o",
      testedModelIds: ["gpt-5o"],
      providerCount: 1,
      models: [],
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      },
    });
    render(<GatewaySetupDialog />);
    await userEvent.upload(
      await screen.findByLabelText(/load keiko\.config\.json/i),
      new File(
        [
          JSON.stringify({
            providers: [
              {
                modelId: "gpt-5o",
                baseUrl: "https://llm-gateway.example.com/v1",
                capability: { id: "gpt-5o", kind: "chat" },
              },
              {
                modelId: "azure-tts",
                baseUrl: "https://voice.example.com/chat/completions",
                endpointStyle: "azure-openai-deployment",
                apiVersion: "2025-04-01-preview",
                capability: {
                  id: "azure-tts",
                  kind: "voice",
                  voiceProviderLocality: "azure-foundry",
                  supportsSpeechOutput: true,
                },
              },
            ],
          }),
        ],
        "keiko.config.json",
        { type: "application/json" },
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/audio endpoint url/i)).toHaveValue(
        "https://voice.example.com/chat/completions",
      ),
    );

    // Same endpoint, different spelling: the operator selects the field and pastes the URL
    // without the /chat/completions suffix the server's normalizeBaseUrl strips before comparing
    // (review findings on #3048). Pasting is one replacement, which is what an equivalent edit
    // looks like — typed character by character it passes through genuinely different endpoints
    // on the way, and resetting there is correct.
    await userEvent.tripleClick(screen.getByLabelText(/audio endpoint url/i));
    await userEvent.paste("https://voice.example.com/");
    await userEvent.type(screen.getByLabelText(/api token/i), "example-token");
    await userEvent.type(screen.getByLabelText(/^audio credential/i), "voice-token");
    await userEvent.type(screen.getByLabelText(/output voice/i), "ash");
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    await waitFor(() => expect(setupGateway).toHaveBeenCalledTimes(1));
    expect(vi.mocked(setupGateway).mock.calls[0]?.[0]).toMatchObject({
      voiceEndpointStyle: "azure-openai-deployment",
      voiceApiVersion: "2025-04-01-preview",
    });
  });

  it("enables the save when a stored audio endpoint's protocol is the only correction", async () => {
    // Review finding on #3048: hasVoiceCredentialInput never looked at the two protocol fields
    // this PR exposes, so "Test & save" stayed disabled for the one edit they exist to allow —
    // correcting the style or api version of an endpoint that is otherwise unchanged. The
    // operator had to touch an unrelated field to unlock the save.
    render(
      <GatewaySetupDialog
        preserveExisting
        storedModels={[modelCapability("internal-chat"), semanticRealtimeCapability("stored-rt")]}
      />,
    );
    await userEvent.click(screen.getByText("Update audio and Digital Voice settings"));
    expect(screen.getByRole("button", { name: /test & save/i })).toBeDisabled();

    await userEvent.click(screen.getByRole("combobox", { name: /audio endpoint style/i }));
    await userEvent.click(screen.getByRole("option", { name: "Azure deployment path" }));

    await waitFor(() => expect(screen.getByRole("button", { name: /test & save/i })).toBeEnabled());
  });

  it("restores the imported protocol when the endpoint edit is typed back", async () => {
    // Review finding on #3048: typing back to the uploaded URL never leaves the committed
    // identity, so no transition fires and the restore inside the reset was never reached — the
    // protocol stayed cleared by the first divergent keystroke.
    vi.mocked(setupGateway).mockResolvedValueOnce({
      ok: true,
      testedModelId: "gpt-5o",
      testedModelIds: ["gpt-5o"],
      providerCount: 1,
      models: [],
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      },
    });
    render(<GatewaySetupDialog />);
    await userEvent.upload(
      await screen.findByLabelText(/load keiko\.config\.json/i),
      new File(
        [
          JSON.stringify({
            providers: [
              {
                modelId: "gpt-5o",
                baseUrl: "https://llm-gateway.example.com/v1",
                capability: { id: "gpt-5o", kind: "chat" },
              },
              {
                modelId: "azure-tts",
                baseUrl: "https://voice.example.com",
                endpointStyle: "azure-openai-deployment",
                apiVersion: "2025-04-01-preview",
                capability: {
                  id: "azure-tts",
                  kind: "voice",
                  voiceProviderLocality: "azure-foundry",
                  supportsSpeechOutput: true,
                },
              },
            ],
          }),
        ],
        "keiko.config.json",
        { type: "application/json" },
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/audio endpoint url/i)).toHaveValue("https://voice.example.com"),
    );

    // Edit away and type the original back, character by character.
    await userEvent.clear(screen.getByLabelText(/audio endpoint url/i));
    await userEvent.type(screen.getByLabelText(/audio endpoint url/i), "https://voice.example.com");

    await waitFor(() =>
      expect(screen.getByLabelText(/audio api version/i)).toHaveValue("2025-04-01-preview"),
    );
    await userEvent.type(screen.getByLabelText(/api token/i), "example-token");
    await userEvent.type(screen.getByLabelText(/^audio credential/i), "voice-token");
    // The deployments were reset by the divergent keystrokes on the way, so they are restated —
    // the protocol is what the return to the uploaded endpoint brings back.
    await userEvent.type(
      screen.getByLabelText(/read aloud.*speech-output deployment/i),
      "azure-tts",
    );
    await userEvent.type(screen.getByLabelText(/output voice/i), "ash");
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    await waitFor(() => expect(setupGateway).toHaveBeenCalledTimes(1));
    expect(vi.mocked(setupGateway).mock.calls[0]?.[0]).toMatchObject({
      voiceEndpointStyle: "azure-openai-deployment",
      voiceApiVersion: "2025-04-01-preview",
    });
  });

  it("restates the Azure style against a retained endpoint without retyping the version", async () => {
    // Review finding on #3048: the client pairing check was unconditional, so restating the
    // stored endpoint's own Azure style — with the audio URL left blank, which keeps that
    // endpoint — was refused for a version the server inherits.
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
        storedModels={[modelCapability("internal-chat"), semanticRealtimeCapability("stored-rt")]}
      />,
    );
    await userEvent.click(screen.getByText("Update audio and Digital Voice settings"));
    await userEvent.click(screen.getByRole("combobox", { name: /audio endpoint style/i }));
    await userEvent.click(screen.getByRole("option", { name: "Azure deployment path" }));
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    await waitFor(() => expect(setupGateway).toHaveBeenCalledTimes(1));
    expect(vi.mocked(setupGateway).mock.calls[0]?.[0]).toMatchObject({
      voiceEndpointStyle: "azure-openai-deployment",
    });
  });

  it("drops a hand-edited imported protocol when the audio endpoint then moves", async () => {
    // Review finding on #3048: stating the protocol by hand released the uploaded URL binding
    // outright, and in a FRESH dialog the endpoint identity ref is still undefined after an
    // upload (the upload sets the URL programmatically), so the later URL change fired no
    // reset. The old host's protocol then rode the submit to the new host — exactly the silent
    // inheritance the binding exists to prevent. A manual statement now binds to the URL in the
    // form at the moment it is made.
    vi.mocked(setupGateway).mockResolvedValueOnce({
      ok: true,
      testedModelId: "gpt-5o",
      testedModelIds: ["gpt-5o"],
      providerCount: 1,
      models: [],
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      },
    });
    render(<GatewaySetupDialog />);

    await userEvent.upload(
      await screen.findByLabelText(/load keiko\.config\.json/i),
      new File(
        [
          JSON.stringify({
            providers: [
              {
                modelId: "gpt-5o",
                baseUrl: "https://llm-gateway.example.com/v1",
                capability: { id: "gpt-5o", kind: "chat" },
              },
              {
                modelId: "azure-tts",
                baseUrl: "https://old-voice.example.com",
                endpointStyle: "azure-openai-deployment",
                apiVersion: "2025-01-01-preview",
                capability: {
                  id: "azure-tts",
                  kind: "voice",
                  voiceProviderLocality: "azure-foundry",
                  supportsSpeechOutput: true,
                  outputVoiceId: "ash",
                },
              },
            ],
          }),
        ],
        "keiko.config.json",
        { type: "application/json" },
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/audio endpoint url/i)).toHaveValue(
        "https://old-voice.example.com",
      ),
    );

    // A hand correction of the imported version, then the endpoint moves to a different host.
    await userEvent.clear(screen.getByLabelText(/audio api version/i));
    await userEvent.type(screen.getByLabelText(/audio api version/i), "2025-04-01-preview");
    await userEvent.clear(screen.getByLabelText(/audio endpoint url/i));
    await userEvent.type(
      screen.getByLabelText(/audio endpoint url/i),
      "https://new-voice.example.com",
    );
    await userEvent.type(screen.getByLabelText(/api token/i), "example-token");
    await userEvent.type(screen.getByLabelText(/^audio credential/i), "voice-token");
    // The move now resets the endpoint's dependencies, so the deployment and its voice are
    // restated for the new host exactly as an operator would have to — and the protocol fields
    // are visibly empty rather than silently ignored.
    expect(screen.getByLabelText(/audio api version/i)).toHaveValue("");
    expect(screen.getByRole("combobox", { name: /audio endpoint style/i })).toHaveTextContent(
      "Not stated",
    );
    await userEvent.type(
      screen.getByLabelText(/read aloud.*speech-output deployment/i),
      "azure-tts",
    );
    await userEvent.type(screen.getByLabelText(/output voice/i), "ash");
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    // The protocol cannot travel to the new host. With no STORED voice provider there is no
    // stored protocol to lose — the file declared one for a host the operator moved away from —
    // so the payload simply omits it, and the visible fields are there to state a new one.
    await waitFor(() => expect(setupGateway).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(setupGateway).mock.calls[0]?.[0] ?? {};
    expect(payload).toMatchObject({ voiceBaseUrl: "https://new-voice.example.com" });
    expect(payload).not.toHaveProperty("voiceEndpointStyle");
    expect(payload).not.toHaveProperty("voiceApiVersion");
  });

  it("submits the imported endpoint protocol while the form still points at the uploaded endpoint", async () => {
    // The positive branch of the URL binding: without a manual retype, the imported protocol
    // rides the submit verbatim (#3037).
    vi.mocked(setupGateway).mockResolvedValueOnce({
      ok: true,
      testedModelId: "gpt-5o",
      testedModelIds: ["gpt-5o"],
      providerCount: 1,
      models: [],
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      },
    });
    render(<GatewaySetupDialog />);

    await userEvent.upload(
      await screen.findByLabelText(/load keiko\.config\.json/i),
      new File(
        [
          JSON.stringify({
            providers: [
              {
                modelId: "gpt-5o",
                baseUrl: "https://llm-gateway.example.com/v1",
                capability: { id: "gpt-5o", kind: "chat" },
              },
              {
                modelId: "keiko-stt",
                baseUrl: "https://speech.example.com",
                endpointStyle: "azure-openai-deployment",
                apiVersion: "2025-03-01-preview",
                capability: {
                  id: "keiko-stt",
                  kind: "voice",
                  voiceProviderLocality: "azure-foundry",
                  supportsSpeechInput: true,
                },
              },
            ],
          }),
        ],
        "keiko.config.json",
        { type: "application/json" },
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/audio endpoint url/i)).toHaveValue(
        "https://speech.example.com",
      ),
    );
    await userEvent.type(screen.getByLabelText(/^audio credential/i), "voice-token");
    await userEvent.type(screen.getByLabelText(/api token/i), "example-token");
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    await waitFor(() => expect(setupGateway).toHaveBeenCalledTimes(1));
    expect(vi.mocked(setupGateway).mock.calls[0]?.[0]).toMatchObject({
      voiceEndpointStyle: "azure-openai-deployment",
      voiceApiVersion: "2025-03-01-preview",
    });
  });

  it("removes a voice role the corrected upload no longer declares", async () => {
    // Review finding on #3037: a corrected file on the SAME voice endpoint that dropped the TTS
    // role must not leave the previous deployment visible — Test & Save would silently re-add
    // the removed role. A file with a voice section REPLACES the role set.
    vi.mocked(setupGateway).mockResolvedValueOnce({
      ok: true,
      testedModelId: "gpt-5o",
      testedModelIds: ["gpt-5o"],
      providerCount: 1,
      models: [],
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      },
    });
    render(<GatewaySetupDialog />);

    const upload = await screen.findByLabelText(/load keiko\.config\.json/i);
    const voiceFile = (withTts: boolean): File =>
      new File(
        [
          JSON.stringify({
            providers: [
              {
                modelId: "gpt-5o",
                baseUrl: "https://llm-gateway.example.com/v1",
                capability: { id: "gpt-5o", kind: "chat" },
              },
              {
                modelId: "keiko-stt",
                baseUrl: "https://voice.example.com",
                capability: {
                  id: "keiko-stt",
                  kind: "voice",
                  voiceProviderLocality: "azure-foundry",
                  supportsSpeechInput: true,
                },
              },
              ...(withTts
                ? [
                    {
                      modelId: "keiko-tts",
                      baseUrl: "https://voice.example.com",
                      capability: {
                        id: "keiko-tts",
                        kind: "voice",
                        voiceProviderLocality: "azure-foundry",
                        supportsSpeechOutput: true,
                      },
                    },
                  ]
                : []),
            ],
          }),
        ],
        "keiko.config.json",
        { type: "application/json" },
      );

    await userEvent.upload(upload, voiceFile(true));
    await waitFor(() =>
      expect(screen.getByLabelText(/audio endpoint url/i)).toHaveValue("https://voice.example.com"),
    );
    await userEvent.upload(upload, voiceFile(false));
    await userEvent.type(screen.getByLabelText(/^audio credential/i), "voice-token");
    await userEvent.type(screen.getByLabelText(/api token/i), "example-token");
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    await waitFor(() => expect(setupGateway).toHaveBeenCalledTimes(1));
    expect(vi.mocked(setupGateway).mock.calls[0]?.[0]).not.toHaveProperty(
      "voiceSpeechOutputModelId",
    );
  });

  it("clears a removed voice profile on a corrected upload", async () => {
    // Review finding on #3037: the corrected file keeps the TTS role but drops voiceProfiles —
    // the previous output voice (and its configured flag) must not survive invisibly.
    vi.mocked(setupGateway).mockResolvedValueOnce({
      ok: true,
      testedModelId: "gpt-5o",
      testedModelIds: ["gpt-5o"],
      providerCount: 1,
      models: [],
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      },
    });
    render(<GatewaySetupDialog />);

    const upload = await screen.findByLabelText(/load keiko\.config\.json/i);
    const voiceFile = (withProfile: boolean): File =>
      new File(
        [
          JSON.stringify({
            providers: [
              {
                modelId: "gpt-5o",
                baseUrl: "https://llm-gateway.example.com/v1",
                capability: { id: "gpt-5o", kind: "chat" },
              },
              {
                modelId: "keiko-tts",
                baseUrl: "https://voice.example.com",
                ...(withProfile
                  ? { voiceProfiles: [{ persona: "neutral", voiceId: "nova" }] }
                  : {}),
                capability: {
                  id: "keiko-tts",
                  kind: "voice",
                  voiceProviderLocality: "azure-foundry",
                  supportsSpeechOutput: true,
                },
              },
            ],
          }),
        ],
        "keiko.config.json",
        { type: "application/json" },
      );

    await userEvent.upload(upload, voiceFile(true));
    await waitFor(() =>
      expect(screen.getByLabelText(/audio endpoint url/i)).toHaveValue("https://voice.example.com"),
    );
    await userEvent.upload(upload, voiceFile(false));
    await userEvent.type(screen.getByLabelText(/^audio credential/i), "voice-token");
    await userEvent.type(screen.getByLabelText(/api token/i), "example-token");
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    // The stale profile is GONE (the field cleared with its configured flag), so the form now
    // demands a voice for the kept TTS role VISIBLY instead of silently persisting the removed
    // profile — the honest outcome of the correction.
    expect(setupGateway).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(/provider voice id is required/i);
    expect(screen.getByLabelText(/output voice/i)).toHaveValue("");
  });

  it("clears the imported endpoint protocol when the user retypes the voice endpoint", async () => {
    // The protocol belongs to the imported connection: after the user manually replaces the
    // uploaded Azure speech endpoint with an OpenAI-compatible one, the submit must not carry
    // the stale deployment-path declaration onto the new endpoint (#3037).
    vi.mocked(setupGateway).mockResolvedValueOnce({
      ok: true,
      testedModelId: "gpt-5o",
      testedModelIds: ["gpt-5o"],
      providerCount: 1,
      models: [],
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      },
    });
    render(<GatewaySetupDialog />);

    await userEvent.upload(
      await screen.findByLabelText(/load keiko\.config\.json/i),
      new File(
        [
          JSON.stringify({
            providers: [
              {
                modelId: "gpt-5o",
                baseUrl: "https://llm-gateway.example.com/v1",
                capability: { id: "gpt-5o", kind: "chat" },
              },
              {
                modelId: "keiko-stt",
                baseUrl: "https://speech.example.com",
                endpointStyle: "azure-openai-deployment",
                apiVersion: "2025-03-01-preview",
                capability: {
                  id: "keiko-stt",
                  kind: "voice",
                  voiceProviderLocality: "azure-foundry",
                  supportsSpeechInput: true,
                },
              },
            ],
          }),
        ],
        "keiko.config.json",
        { type: "application/json" },
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/audio endpoint url/i)).toHaveValue(
        "https://speech.example.com",
      ),
    );

    const endpointField = screen.getByLabelText(/audio endpoint url/i);
    await userEvent.clear(endpointField);
    await userEvent.type(endpointField, "https://openai-voice.example.com/v1");
    // The identity transition reset the role fields — resupply role and credential manually.
    await userEvent.type(screen.getByLabelText(/^audio credential/i), "voice-token");
    await userEvent.type(screen.getByLabelText(/dictate.*speech-to-text deployment/i), "stt-x");
    await userEvent.type(screen.getByLabelText(/api token/i), "example-token");
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    await waitFor(() => expect(setupGateway).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(setupGateway).mock.calls[0]?.[0];
    expect(payload).not.toHaveProperty("voiceEndpointStyle");
    expect(payload).not.toHaveProperty("voiceApiVersion");
  });

  it("fills the voice section from an uploaded configuration and states a skipped realtime", async () => {
    // The owner's persisted keiko.config.json: STT/TTS on a dedicated speech endpoint, realtime
    // sharing the gateway endpoint — the speech pair imports, the realtime skip is stated.
    render(<GatewaySetupDialog />);

    await userEvent.upload(
      await screen.findByLabelText(/load keiko\.config\.json/i),
      new File(
        [
          JSON.stringify({
            providers: [
              {
                modelId: "gpt-5o",
                baseUrl: "https://llm-gateway.example.com/v1",
                apiKeyHeaderName: "api-key",
                timeoutMs: 120_000,
                capability: { id: "gpt-5o", kind: "chat" },
              },
              {
                modelId: "keiko-stt",
                baseUrl: "https://voice.example.com",
                apiKeyHeaderName: "api-key",
                timeoutMs: 120_000,
                capability: {
                  id: "keiko-stt",
                  kind: "voice",
                  voiceProviderLocality: "azure-foundry",
                  supportsSpeechInput: true,
                },
              },
              {
                modelId: "keiko-tts",
                baseUrl: "https://voice.example.com",
                apiKeyHeaderName: "api-key",
                timeoutMs: 120_000,
                capability: {
                  id: "keiko-tts",
                  kind: "voice",
                  voiceProviderLocality: "azure-foundry",
                  supportsSpeechOutput: true,
                },
              },
              {
                modelId: "keiko-realtime",
                baseUrl: "https://llm-gateway.example.com/v1",
                apiKeyHeaderName: "api-key",
                timeoutMs: 120_000,
                capability: {
                  id: "keiko-realtime",
                  kind: "voice",
                  voiceProviderLocality: "azure-foundry",
                  supportsRealtimeVoice: true,
                  realtimeTranscriptionModel: "keiko-realtime-stt",
                },
              },
            ],
          }),
        ],
        "keiko.config.json",
        { type: "application/json" },
      ),
    );

    await waitFor(() =>
      expect(screen.getByLabelText(/audio endpoint url/i)).toHaveValue("https://voice.example.com"),
    );
    expect(screen.getByLabelText(/speech-to-text deployment/i)).toHaveValue("keiko-stt");
    expect(screen.getByLabelText(/speech-output deployment/i)).toHaveValue("keiko-tts");
    // The realtime provider lives on a different connection — skipped and SAID, never silent.
    expect(screen.getByLabelText(/digital voice · realtime deployment/i)).toHaveValue("");
    expect(screen.getByText(/realtime voice model uses its own endpoint/i)).toBeInTheDocument();
  });

  it("submits the imported generic endpoint protocol while the form points at the uploaded endpoint", async () => {
    // #3042 follow-up: an explicit endpoint style in the file must ride the submit, or a
    // server-side KEIKO_DEFAULT_ENDPOINT_STYLE resolves over the file's statement after save.
    vi.mocked(setupGateway).mockResolvedValueOnce({
      ok: true,
      testedModelId: "azure-chat",
      testedModelIds: ["azure-chat"],
      providerCount: 1,
      models: [],
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      },
    });
    render(<GatewaySetupDialog />);

    await userEvent.upload(
      await screen.findByLabelText(/load keiko\.config\.json/i),
      new File(
        [
          JSON.stringify({
            providers: [
              {
                modelId: "azure-chat",
                baseUrl: "https://resource.example.com",
                endpointStyle: "azure-openai-deployment",
                apiVersion: "2025-04-01-preview",
                capability: { id: "azure-chat", kind: "chat" },
              },
            ],
          }),
        ],
        "keiko.config.json",
        { type: "application/json" },
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/base url/i)).toHaveValue("https://resource.example.com"),
    );
    await userEvent.type(screen.getByLabelText(/api token/i), "example-token");
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    await waitFor(() => expect(setupGateway).toHaveBeenCalledTimes(1));
    expect(vi.mocked(setupGateway).mock.calls[0]?.[0]).toMatchObject({
      endpointStyle: "azure-openai-deployment",
      apiVersion: "2025-04-01-preview",
    });
  });
  it("omits the imported generic protocol when the gateway URL is left empty", async () => {
    // The other branch of the URL binding (review finding on #3046): a preserve-mode submit
    // that states no gateway URL inherits the stored connection, so the uploaded protocol has
    // no endpoint to apply to and must not ride along.
    vi.mocked(setupGateway).mockResolvedValueOnce({
      ok: true,
      testedModelId: "azure-chat",
      testedModelIds: ["azure-chat"],
      providerCount: 1,
      models: [],
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      },
    });
    render(<GatewaySetupDialog preserveExisting storedModels={[modelCapability("azure-chat")]} />);

    await userEvent.upload(
      await screen.findByLabelText(/load keiko\.config\.json/i),
      new File(
        [
          JSON.stringify({
            providers: [
              {
                modelId: "azure-chat",
                baseUrl: "https://resource.example.com",
                endpointStyle: "azure-openai-deployment",
                apiVersion: "2025-04-01-preview",
                capability: { id: "azure-chat", kind: "chat" },
              },
            ],
          }),
        ],
        "keiko.config.json",
        { type: "application/json" },
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/base url/i)).toHaveValue("https://resource.example.com"),
    );
    await userEvent.clear(screen.getByLabelText(/base url/i));
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    await waitFor(() => expect(setupGateway).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(setupGateway).mock.calls[0]?.[0] ?? {};
    expect(payload).not.toHaveProperty("endpointStyle");
    expect(payload).not.toHaveProperty("apiVersion");
  });

  it("keeps a declared generic protocol when the uploaded file states no gateway URL", async () => {
    // Review finding on #3046: a file may declare the protocol and leave the URL to the operator
    // — a shape this parser accepts. Clearing the protocol because the URL is absent discarded
    // an explicit declaration, and the save then probed and persisted the OpenAI-compatible
    // shape (or whatever KEIKO_DEFAULT_ENDPOINT_STYLE says) against an Azure endpoint.
    vi.mocked(setupGateway).mockResolvedValueOnce({
      ok: true,
      testedModelId: "azure-chat",
      testedModelIds: ["azure-chat"],
      providerCount: 1,
      models: [],
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      },
    });
    render(<GatewaySetupDialog />);
    await userEvent.upload(
      await screen.findByLabelText(/load keiko\.config\.json/i),
      new File(
        [
          JSON.stringify({
            providers: [
              {
                modelId: "azure-chat",
                endpointStyle: "azure-openai-deployment",
                apiVersion: "2025-04-01-preview",
                capability: { id: "azure-chat", kind: "chat" },
              },
            ],
          }),
        ],
        "keiko.config.json",
        { type: "application/json" },
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/deployment names/i)).toHaveValue("azure-chat"),
    );

    await userEvent.type(screen.getByLabelText(/base url/i), "https://resource.example.com");
    await userEvent.type(screen.getByLabelText(/api token/i), "example-token");
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    await waitFor(() => expect(setupGateway).toHaveBeenCalledTimes(1));
    expect(vi.mocked(setupGateway).mock.calls[0]?.[0]).toMatchObject({
      endpointStyle: "azure-openai-deployment",
      apiVersion: "2025-04-01-preview",
    });
  });

  it("keeps the imported protocol when the URL is edited to the server-equivalent form", async () => {
    // Review finding on #3046: the server's canonical identity also drops a terminal
    // /chat/completions, so trimming an imported URL down to the endpoint the server would
    // derive is not an endpoint change — but the narrower client copy read it as one and
    // dropped the protocol.
    vi.mocked(setupGateway).mockResolvedValueOnce({
      ok: true,
      testedModelId: "azure-chat",
      testedModelIds: ["azure-chat"],
      providerCount: 1,
      models: [],
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      },
    });
    render(<GatewaySetupDialog />);
    await userEvent.upload(
      await screen.findByLabelText(/load keiko\.config\.json/i),
      new File(
        [
          JSON.stringify({
            providers: [
              {
                modelId: "azure-chat",
                baseUrl: "https://gateway.example.com/v1/chat/completions",
                endpointStyle: "azure-openai-deployment",
                apiVersion: "2025-04-01-preview",
                capability: { id: "azure-chat", kind: "chat" },
              },
            ],
          }),
        ],
        "keiko.config.json",
        { type: "application/json" },
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/base url/i)).toHaveValue(
        "https://gateway.example.com/v1/chat/completions",
      ),
    );

    await userEvent.clear(screen.getByLabelText(/base url/i));
    await userEvent.type(screen.getByLabelText(/base url/i), "https://gateway.example.com/v1");
    await userEvent.type(screen.getByLabelText(/api token/i), "example-token");
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    await waitFor(() => expect(setupGateway).toHaveBeenCalledTimes(1));
    expect(vi.mocked(setupGateway).mock.calls[0]?.[0]).toMatchObject({
      endpointStyle: "azure-openai-deployment",
      apiVersion: "2025-04-01-preview",
    });
  });

  it("drops a previous file's generic protocol when the next upload declares none", async () => {
    // Review finding on #3046: applyUploadedGenericEndpoint returned early for a file that
    // states no gateway URL, leaving the PREVIOUS file's protocol and its URL binding in state.
    // The visible URL field still held the old URL, so the binding matched and the stale
    // protocol rode the submit of a file that never mentioned one. A file with no URL states
    // no protocol either.
    vi.mocked(setupGateway).mockResolvedValueOnce({
      ok: true,
      testedModelId: "azure-chat",
      testedModelIds: ["azure-chat"],
      providerCount: 1,
      models: [],
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      },
    });
    render(<GatewaySetupDialog />);
    const upload = async (providers: readonly Record<string, unknown>[]): Promise<void> => {
      await userEvent.upload(
        await screen.findByLabelText(/load keiko\.config\.json/i),
        new File([JSON.stringify({ providers })], "keiko.config.json", {
          type: "application/json",
        }),
      );
    };

    await upload([
      {
        modelId: "azure-chat",
        baseUrl: "https://resource.example.com",
        endpointStyle: "azure-openai-deployment",
        apiVersion: "2025-04-01-preview",
        capability: { id: "azure-chat", kind: "chat" },
      },
    ]);
    await waitFor(() =>
      expect(screen.getByLabelText(/base url/i)).toHaveValue("https://resource.example.com"),
    );

    // The corrected file lists the deployment but states no connection at all — the URL is
    // supplied by the operator, and with it the protocol that belongs to it.
    await upload([{ modelId: "plain-chat", capability: { id: "plain-chat", kind: "chat" } }]);
    await waitFor(() =>
      expect(screen.getByLabelText(/deployment names/i)).toHaveValue("plain-chat"),
    );
    expect(screen.getByLabelText(/base url/i)).toHaveValue("https://resource.example.com");

    await userEvent.type(screen.getByLabelText(/api token/i), "example-token");
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    await waitFor(() => expect(setupGateway).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(setupGateway).mock.calls[0]?.[0] ?? {};
    expect(payload).not.toHaveProperty("endpointStyle");
    expect(payload).not.toHaveProperty("apiVersion");
  });

  it("keeps the imported generic protocol across a semantics-preserving URL edit", async () => {
    // Review finding on #3046: the binding compared raw strings, so adding or removing a
    // trailing slash — the same endpoint by the gateway's own sameBaseUrlIdentity rule — threw
    // the uploaded protocol away and produced a save without it.
    vi.mocked(setupGateway).mockResolvedValueOnce({
      ok: true,
      testedModelId: "azure-chat",
      testedModelIds: ["azure-chat"],
      providerCount: 1,
      models: [],
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      },
    });
    render(<GatewaySetupDialog />);

    await userEvent.upload(
      await screen.findByLabelText(/load keiko\.config\.json/i),
      new File(
        [
          JSON.stringify({
            providers: [
              {
                modelId: "azure-chat",
                baseUrl: "https://resource.example.com/openai",
                endpointStyle: "azure-openai-deployment",
                apiVersion: "2025-04-01-preview",
                capability: { id: "azure-chat", kind: "chat" },
              },
            ],
          }),
        ],
        "keiko.config.json",
        { type: "application/json" },
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/base url/i)).toHaveValue("https://resource.example.com/openai"),
    );
    await userEvent.type(screen.getByLabelText(/base url/i), "/");
    await userEvent.type(screen.getByLabelText(/api token/i), "example-token");
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    await waitFor(() => expect(setupGateway).toHaveBeenCalledTimes(1));
    expect(vi.mocked(setupGateway).mock.calls[0]?.[0]).toMatchObject({
      endpointStyle: "azure-openai-deployment",
      apiVersion: "2025-04-01-preview",
    });
  });

  it("drops the imported generic protocol when the user retypes the gateway URL", async () => {
    vi.mocked(setupGateway).mockResolvedValueOnce({
      ok: true,
      testedModelId: "azure-chat",
      testedModelIds: ["azure-chat"],
      providerCount: 1,
      models: [],
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      },
    });
    render(<GatewaySetupDialog />);

    await userEvent.upload(
      await screen.findByLabelText(/load keiko\.config\.json/i),
      new File(
        [
          JSON.stringify({
            providers: [
              {
                modelId: "azure-chat",
                baseUrl: "https://resource.example.com",
                endpointStyle: "azure-openai-deployment",
                apiVersion: "2025-04-01-preview",
                capability: { id: "azure-chat", kind: "chat" },
              },
            ],
          }),
        ],
        "keiko.config.json",
        { type: "application/json" },
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/base url/i)).toHaveValue("https://resource.example.com"),
    );
    await userEvent.clear(screen.getByLabelText(/base url/i));
    await userEvent.type(screen.getByLabelText(/base url/i), "https://other.example.com/v1");
    await userEvent.type(screen.getByLabelText(/api token/i), "example-token");
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    await waitFor(() => expect(setupGateway).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(setupGateway).mock.calls[0]?.[0] ?? {};
    expect(payload).not.toHaveProperty("endpointStyle");
    expect(payload).not.toHaveProperty("apiVersion");
  });

  it("rejects an unreadable configuration upload with a visible alert and no field changes", async () => {
    render(<GatewaySetupDialog />);

    await userEvent.upload(
      await screen.findByLabelText(/load keiko\.config\.json/i),
      new File(["{ not json"], "keiko.config.json", { type: "application/json" }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/not a readable keiko configuration/i);
    expect(screen.getByLabelText(/base url/i)).toHaveValue("");
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

function semanticRealtimeCapability(id: string): ModelCapability {
  return realtimeCapability(id, true);
}

function realtimeCapability(id: string, supportsSemanticTurnDetection = false): ModelCapability {
  return {
    ...modelCapability(id, "voice"),
    supportsRealtimeVoice: true,
    realtimeTranscriptionModel: `${id}-transcription`,
    ...(supportsSemanticTurnDetection ? { supportsSemanticTurnDetection: true } : {}),
  };
}

function speechInputCapability(id: string): ModelCapability {
  return {
    ...modelCapability(id, "voice"),
    supportsSpeechInput: true,
  };
}
