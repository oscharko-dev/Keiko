// Issue #144 / Epic #142: SettingsPanel surfaces conversation eligibility.
// These tests pin AC #3 ("The UI can explain why a model is unavailable for a
// capability without showing provider URLs or credentials") by asserting:
//   - the eligible badge renders for chat models;
//   - the reason text renders for embedding / ocr-vision models;
//   - the rendered markup contains no host-name pattern or credential-shape
//     literal (the no-leak invariant).

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import type { ModelCapability } from "@/lib/types";
import { SettingsPanel, formatGatewayReadinessReport } from "./SettingsPanel";
import { consumePendingGatewaySetup, requestGatewaySetup } from "../shared/gatewaySetupBus";

const fetchConfigMock = vi.fn();
const fetchModelsMock = vi.fn();
const runGatewayReadinessMock = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchConfig: (): Promise<unknown> => fetchConfigMock(),
  fetchModels: (): Promise<unknown> => fetchModelsMock(),
  runGatewayReadiness: (...args: readonly unknown[]): Promise<unknown> =>
    runGatewayReadinessMock(...args),
}));

// Issue #144: synthetic capability fixtures. Generic ids only — no customer
// model names. ModelCapability has no URL / api-key field by design; the
// no-leak assertion below pins that nothing in the rendered markup contains a
// host-name pattern or a credential-shape literal.
function chatCapability(id = "test-chat-1"): ModelCapability {
  return {
    id,
    kind: "chat",
    contextWindow: 0,
    maxOutputTokens: 0,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: false,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "test fixture",
    preferredUseCases: ["Chat"],
    knownLimitations: ["test fixture"],
  };
}

function embeddingCapability(id = "test-embed-1"): ModelCapability {
  return {
    id,
    kind: "embedding",
    contextWindow: 0,
    maxOutputTokens: 0,
    toolCalling: false,
    structuredOutput: false,
    streaming: false,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: false,
    costClass: "low",
    latencyClass: "fast",
    throughputHint: "test fixture",
    preferredUseCases: ["Embeddings"],
    knownLimitations: ["test fixture"],
  };
}

function ocrVisionCapability(id = "test-ocr-1"): ModelCapability {
  return {
    id,
    kind: "ocr-vision",
    contextWindow: 0,
    maxOutputTokens: 0,
    toolCalling: false,
    structuredOutput: false,
    streaming: false,
    supportsImageInput: true,
    supportsDocumentInput: true,
    workflowEligible: false,
    costClass: "low",
    latencyClass: "standard",
    throughputHint: "test fixture",
    preferredUseCases: ["OCR"],
    knownLimitations: ["test fixture"],
  };
}

function voiceCapability(
  id = "keiko-tts",
  overrides: Partial<ModelCapability> = {},
): ModelCapability {
  return {
    id,
    kind: "voice",
    contextWindow: 0,
    maxOutputTokens: 0,
    toolCalling: false,
    structuredOutput: false,
    streaming: false,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: false,
    voiceProviderLocality: "azure-foundry",
    costClass: "low",
    latencyClass: "fast",
    throughputHint: "test fixture",
    preferredUseCases: ["Voice"],
    knownLimitations: ["test fixture"],
    ...overrides,
  };
}

function primeFetches(models: readonly ModelCapability[]): void {
  fetchConfigMock.mockResolvedValue({ config: null, configPresent: true });
  fetchModelsMock.mockResolvedValue({ models });
}

function setClipboard(writeText: (text: string) => Promise<void>): PropertyDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  return descriptor;
}

afterEach(() => {
  vi.clearAllMocks();
  // Issue #1399: clear any residual gateway-setup latch so it cannot leak across tests.
  consumePendingGatewaySetup();
  window.localStorage.clear();
  document.documentElement.lang = "en";
  document.documentElement.removeAttribute("data-locale");
  document.documentElement.style.removeProperty("--workspace-bg-brightness");
  document.documentElement.style.removeProperty("--workspace-grid-strength");
  document.documentElement.style.removeProperty("--frame-border-strength");
  document.documentElement.style.removeProperty("--frame-inner-glow-strength");
});

describe("SettingsPanel conversation eligibility badge (Issue #144 AC #3)", () => {
  it("renders the 'Conversation-eligible' badge for a chat capability", async () => {
    primeFetches([chatCapability("test-chat-1")]);
    render(<SettingsPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("conv-elig-ok")).toHaveTextContent(/conversation-eligible/i);
    });
  });

  it("renders the embedding reason for an embedding capability", async () => {
    primeFetches([embeddingCapability("test-embed-1")]);
    render(<SettingsPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("embedding-elig-ok")).toHaveTextContent(/embedding-ready/i);
    });
    expect(screen.getByTestId("embedding-elig-ok")).toHaveAttribute(
      "title",
      expect.stringMatching(/available for embeddings/i),
    );
  });

  it("renders the OCR/vision-only reason for an ocr-vision capability", async () => {
    primeFetches([ocrVisionCapability("test-ocr-1")]);
    render(<SettingsPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("conv-elig-no")).toHaveTextContent(/ocr\/vision-only/i);
    });
  });

  it("marks embedding models as available without making them conversation-eligible", async () => {
    primeFetches([embeddingCapability("test-embed-1")]);
    const { container } = render(<SettingsPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("embedding-elig-ok")).toBeInTheDocument();
    });
    const status = container.querySelector('.ml-status[title="available for embeddings"]');
    expect(status).not.toBeNull();
    expect(status?.className).toContain("connected");
    expect(container.textContent ?? "").toContain("0 chat");
  });

  it("renders a positive 'Voice provider' badge for a configured voice provider (Issue #1557 AC4)", async () => {
    primeFetches([
      voiceCapability("keiko-tts", {
        supportsSpeechOutput: true,
        supportedVoicePersonas: ["male", "female", "neutral"],
      }),
    ]);
    render(<SettingsPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("voice-elig-ok")).toHaveTextContent(/voice provider/i);
    });
    // It is presented as available, NOT as the red chat-ineligibility warning.
    expect(screen.queryByTestId("conv-elig-no")).toBeNull();
    expect(screen.getByTestId("voice-elig-ok")).toHaveAttribute(
      "title",
      expect.stringMatching(/available for speech output; voices: male, female, neutral/i),
    );
  });

  it("describes an STT-only voice provider as available for speech-to-text (Issue #1557 AC4)", async () => {
    primeFetches([voiceCapability("keiko-stt", { supportsSpeechInput: true })]);
    render(<SettingsPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("voice-elig-ok")).toHaveTextContent(/speech-to-text/i);
    });
    expect(screen.queryByTestId("conv-elig-no")).toBeNull();
  });

  it("does NOT show the voice-available badge for a voice kind with no advertised sub-capability (fail-closed)", async () => {
    // The config parser rejects this combination; the UI defends in depth — a degenerate voice
    // capability falls through to the not-selectable badge rather than claiming availability.
    primeFetches([voiceCapability("degenerate-voice", {})]);
    render(<SettingsPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("conv-elig-no")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("voice-elig-ok")).toBeNull();
  });
});

describe("SettingsPanel chat-count uses the eligibility helper (Issue #144 AC #1)", () => {
  it("counts only chat-eligible capabilities, not embedding/ocr-vision", async () => {
    primeFetches([
      chatCapability("test-chat-1"),
      chatCapability("test-chat-2"),
      embeddingCapability("test-embed-1"),
      ocrVisionCapability("test-ocr-1"),
      voiceCapability("test-stt-1", { supportsSpeechInput: true }),
    ]);
    const { container } = render(<SettingsPanel />);
    await waitFor(() => {
      expect(container.textContent ?? "").toContain("2 chat");
    });
    expect(container.textContent ?? "").toContain("5 models");
  });
});

describe("SettingsPanel does not leak provider URLs or credentials (Issue #144 AC #3)", () => {
  it("renders no http(s):// host-name pattern in the model list markup", async () => {
    // A synthetic credential-shape string the test will look for. It is not
    // present on the capability props (ModelCapability has no api-key field
    // by design) — the assertion exists to pin the no-leak invariant.
    const SYNTHETIC_TOKEN_LITERAL = ["sk-", "test-keiko-no-leak-canary"].join("");
    primeFetches([
      chatCapability("test-chat-1"),
      embeddingCapability("test-embed-1"),
      ocrVisionCapability("test-ocr-1"),
    ]);
    const { container } = render(<SettingsPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("conv-elig-ok")).toBeInTheDocument();
    });
    expect(container.innerHTML).not.toMatch(/https?:\/\//u);
    expect(container.innerHTML).not.toContain(SYNTHETIC_TOKEN_LITERAL);
    // Common credential-shape patterns we want to guard against, even though
    // ModelCapability does not expose them today.
    expect(container.innerHTML).not.toMatch(/Bearer\s+/u);
    expect(container.innerHTML).not.toMatch(/api[-_]?key/iu);
  });
});

describe("SettingsPanel gateway summary semantics", () => {
  it("distinguishes a configured gateway with zero models from setup-required state", async () => {
    primeFetches([]);
    render(<SettingsPanel />);
    await waitFor(() => {
      expect(screen.getByText("Gateway configured")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/review the gateway configuration or discovered model set/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("Gateway setup required")).toBeNull();
  });

  // uiux-fix C286: discovered-but-not-chat-capable models must not claim chat works.
  it("does not claim chat capability when no discovered model is conversation-eligible", async () => {
    primeFetches([embeddingCapability("test-embed-1")]);
    render(<SettingsPanel />);
    await waitFor(() => {
      expect(screen.getByText("Gateway connected")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/none of the discovered models can be used for conversation/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/keiko can use the configured gateway models for chat/i)).toBeNull();
  });
});

describe("SettingsPanel gateway readiness checks", () => {
  it("shows readiness actions only for conversation-capable models", async () => {
    primeFetches([chatCapability("test-chat-1"), embeddingCapability("test-embed-1")]);

    render(<SettingsPanel />);

    await waitFor(() => {
      expect(screen.getByTestId("conv-elig-ok")).toBeInTheDocument();
    });
    expect(screen.getAllByRole("button", { name: "Run readiness check" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Deep probes" })).toHaveLength(1);
  });

  it("renders busy and verified states for a successful readiness check", async () => {
    primeFetches([chatCapability("test-chat-1")]);
    runGatewayReadinessMock.mockResolvedValue({
      modelId: "test-chat-1",
      checkedAt: "2026-06-24T09:00:00.000Z",
      overallStatus: "ready",
      probes: [
        { name: "chat", status: "passed", latencyMs: 12, evidence: "Working today" },
        { name: "streaming", status: "passed", latencyMs: 10, evidence: "Streaming works" },
        { name: "tool_calling", status: "passed", latencyMs: 11, evidence: "Tools work" },
        { name: "json_schema", status: "passed", latencyMs: 9, evidence: "JSON works" },
      ],
      verifiedCapabilities: { streaming: true, toolCalling: true, structuredOutput: true },
    });

    render(<SettingsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Run readiness check" }));

    expect(screen.getByText(/checking basic readiness/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("Working today")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Verified capabilities")).toHaveTextContent("Streaming");
    expect(screen.getByLabelText("Verified capabilities")).toHaveTextContent("Tools");
    expect(screen.getByLabelText("Verified capabilities")).toHaveTextContent("JSON");
    expect(runGatewayReadinessMock).toHaveBeenCalledWith("test-chat-1", undefined);
  });

  it("surfaces unsupported probe evidence for partial readiness", async () => {
    primeFetches([chatCapability("test-chat-1")]);
    runGatewayReadinessMock.mockResolvedValue({
      modelId: "test-chat-1",
      checkedAt: "2026-06-24T09:00:00.000Z",
      overallStatus: "partial",
      probes: [
        { name: "chat", status: "passed", latencyMs: 12, evidence: "Working today" },
        { name: "streaming", status: "passed", latencyMs: 10, evidence: "Streaming works" },
        {
          name: "json_schema",
          status: "unsupported",
          latencyMs: 9,
          evidence: "JSON schema response_format was not accepted by the endpoint.",
        },
      ],
      verifiedCapabilities: { streaming: true },
    });

    render(<SettingsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Run readiness check" }));

    await waitFor(() => {
      expect(screen.getByText("Working today")).toBeInTheDocument();
    });
    expect(screen.getByText(/JSON schema response_format was not accepted/i)).toBeInTheDocument();
  });

  it("copies a complete readiness report for customer diagnostics", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    const clipboardDescriptor = setClipboard(writeText);
    primeFetches([chatCapability("test-chat-1")]);
    const report = {
      modelId: "test-chat-1",
      checkedAt: "2026-06-24T09:00:00.000Z",
      overallStatus: "partial" as const,
      probes: [
        {
          name: "chat" as const,
          status: "passed" as const,
          latencyMs: 12,
          evidence: "Working today",
        },
        {
          name: "long_context" as const,
          status: "passed" as const,
          latencyMs: 99,
          evidence: "32000 approximate tokens were accepted and the sentinel was recovered.",
        },
        {
          name: "json_schema" as const,
          status: "unsupported" as const,
          latencyMs: 9,
          evidence: "JSON schema response_format was not accepted by the endpoint.",
        },
      ],
      verifiedCapabilities: { testedContextTokens: 32000 },
    };
    runGatewayReadinessMock.mockResolvedValue(report);

    render(<SettingsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Run readiness check" }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy report" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(formatGatewayReadinessReport(report));
    });
    const copied = writeText.mock.calls[0]?.[0] ?? "";
    expect(copied).toContain("Keiko Gateway Readiness Report");
    expect(copied).toContain("Model: test-chat-1");
    expect(copied).toContain("- json_schema: unsupported");
    expect(copied).toContain("Raw JSON:");
    expect(await screen.findByText("Readiness report copied.")).toBeInTheDocument();

    if (clipboardDescriptor === undefined) {
      Reflect.deleteProperty(navigator, "clipboard");
    } else {
      Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    }
  });

  it("passes deep probe options and surfaces route errors without blocking settings", async () => {
    primeFetches([chatCapability("test-chat-1")]);
    runGatewayReadinessMock.mockRejectedValue(
      new Error("Configure a gateway before running readiness checks."),
    );

    render(<SettingsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Deep probes" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/configure a gateway/i);
    });
    expect(runGatewayReadinessMock).toHaveBeenCalledWith("test-chat-1", {
      includeDeepProbes: true,
    });
    expect(screen.getByRole("button", { name: "Update credentials" })).toBeEnabled();
  });
});

describe("SettingsPanel load-error handling (uiux-fix C287/C285)", () => {
  it("maps raw transport errors to a readable alert and recovers via Retry", async () => {
    fetchConfigMock.mockRejectedValueOnce(new Error("HTTP 500"));
    fetchModelsMock.mockRejectedValueOnce(new Error("HTTP 500"));
    fetchConfigMock.mockResolvedValue({ config: null, configPresent: true });
    fetchModelsMock.mockResolvedValue({ models: [chatCapability("test-chat-1")] });

    render(<SettingsPanel />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not load gateway settings");
    expect(alert.textContent).not.toContain("HTTP 500");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(screen.getByTestId("conv-elig-ok")).toBeInTheDocument();
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("SettingsPanel tabs (uiux-fix C070/C147)", () => {
  it("exposes the active tab via aria-pressed and labels the gateway tab 'Models'", async () => {
    primeFetches([]);
    render(<SettingsPanel />);
    const modelsTab = screen.getByRole("button", { name: "Models" });
    expect(modelsTab).toHaveAttribute("aria-pressed", "true");
    const generalTab = screen.getByRole("button", { name: "General" });
    expect(generalTab).toHaveAttribute("aria-pressed", "false");
    fireEvent.pointerDown(generalTab);
    expect(generalTab).toHaveAttribute("aria-pressed", "true");
    expect(modelsTab).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => {
      expect(fetchModelsMock).toHaveBeenCalled();
    });
  });
});

describe("SettingsPanel workspace wallpaper controls", () => {
  it("persists the selected interface language from General settings", async () => {
    primeFetches([]);
    render(
      <I18nProvider>
        <SettingsPanel />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "General" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Interface language" }));
    fireEvent.click(screen.getByRole("option", { name: "Deutsch" }));

    expect(window.localStorage.getItem("keiko.locale")).toBe("de");
    expect(document.documentElement.lang).toBe("de");
    expect(document.documentElement.dataset.locale).toBe("de");
    expect(screen.getByText("Einstellungen")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allgemein" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("persists the selected assistant voice from General settings", async () => {
    primeFetches([
      voiceCapability("keiko-tts", {
        supportsSpeechOutput: true,
        supportsRealtimeVoice: true,
        supportedVoicePersonas: ["male", "female"],
      }),
    ]);
    render(<SettingsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "General" }));
    const voiceSelect = await screen.findByRole("combobox", { name: "Voice" });
    vi.spyOn(voiceSelect, "getBoundingClientRect").mockReturnValue({
      bottom: 142,
      height: 42,
      left: 64,
      right: 304,
      top: 100,
      width: 240,
      x: 64,
      y: 100,
      toJSON: () => ({}),
    });

    fireEvent.click(voiceSelect);
    fireEvent.click(screen.getByRole("option", { name: "Female voice" }));

    expect(window.localStorage.getItem("keiko.voice.dialog.persona")).toBe("female");
  });

  it("defaults the liquid wallpaper off and enables opacity only after opt-in", async () => {
    primeFetches([]);
    render(<SettingsPanel />);

    const generalTab = screen.getByRole("button", { name: "General" });
    fireEvent.click(generalTab);

    const switchControl = screen.getByRole("switch", { name: "Liquid wallpaper" });
    expect(switchControl).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("slider", { name: "Wallpaper opacity" })).toBeDisabled();

    fireEvent.click(switchControl);

    expect(switchControl).toHaveAttribute("aria-checked", "true");
    expect(window.localStorage.getItem("keiko.wallpaper.enabled")).toBe("true");
    expect(screen.getByRole("slider", { name: "Wallpaper opacity" })).toBeEnabled();
  });

  it("persists workspace background brightness and applies the CSS variable", async () => {
    primeFetches([]);
    render(<SettingsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "General" }));
    fireEvent.change(screen.getByRole("slider", { name: "Workspace background brightness" }), {
      target: { value: "38" },
    });

    expect(window.localStorage.getItem("keiko.workspace.background.brightness")).toBe("38");
    expect(document.documentElement.style.getPropertyValue("--workspace-bg-brightness")).toBe(
      "38%",
    );
  });

  it("persists workspace grid strength and applies the CSS variable", async () => {
    primeFetches([]);
    render(<SettingsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "General" }));
    fireEvent.change(screen.getByRole("slider", { name: "Workspace grid strength" }), {
      target: { value: "64" },
    });

    expect(window.localStorage.getItem("keiko.workspace.grid.strength")).toBe("64");
    expect(document.documentElement.style.getPropertyValue("--workspace-grid-strength")).toBe(
      "64%",
    );
  });

  it("persists workspace camera smoothness and emits the runtime event", async () => {
    const listener = vi.fn();
    window.addEventListener("keiko:workspace-camera-smoothness", listener);
    primeFetches([]);
    render(<SettingsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "General" }));
    fireEvent.change(screen.getByRole("slider", { name: "Workspace camera smoothness" }), {
      target: { value: "72" },
    });

    expect(window.localStorage.getItem("keiko.workspace.camera.smoothness")).toBe("72");
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ detail: 72 }),
    );
    expect(screen.getByRole("slider", { name: "Workspace camera smoothness" })).toHaveValue("72");

    window.removeEventListener("keiko:workspace-camera-smoothness", listener);
  });

  it("persists workspace border strength and applies the CSS variable", async () => {
    primeFetches([]);
    render(<SettingsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "General" }));
    fireEvent.change(screen.getByRole("slider", { name: "Workspace border strength" }), {
      target: { value: "57" },
    });

    expect(window.localStorage.getItem("keiko.frame.border.strength")).toBe("57");
    expect(document.documentElement.style.getPropertyValue("--frame-border-strength")).toBe("57%");
  });

  it("persists workspace inner glow and applies the CSS variable", async () => {
    primeFetches([]);
    render(<SettingsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "General" }));
    fireEvent.change(screen.getByRole("slider", { name: "Workspace inner glow" }), {
      target: { value: "34" },
    });

    expect(window.localStorage.getItem("keiko.frame.inner.glow.strength")).toBe("34");
    expect(document.documentElement.style.getPropertyValue("--frame-inner-glow-strength")).toBe(
      "34%",
    );
  });
});

// Issue #1399: the Figma Snapshot PAT error deep-links here via the gateway-setup bus. The panel
// must open the gateway-setup dialog (Figma access-token section) whether it was already open
// (live event) or just opened by openWindow (latch read on mount).
describe("SettingsPanel Figma token deep-link (Issue #1399)", () => {
  it("opens the gateway-setup dialog on the Figma token section when already open", async () => {
    primeFetches([chatCapability("test-chat-1")]);
    render(<SettingsPanel />);
    // Wait until config has loaded (preserveExisting depends on it).
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Update credentials" })).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText(/figma access token/iu)).not.toBeInTheDocument();

    act(() => {
      requestGatewaySetup();
    });

    await waitFor(() => expect(screen.getByLabelText(/figma access token/iu)).toBeInTheDocument());
    // The dialog's Figma section heading confirms the deep-link target.
    expect(screen.getByRole("heading", { name: "Figma Snapshot" })).toBeInTheDocument();
  });

  it("opens the dialog after mount when the request was latched before Settings existed", async () => {
    primeFetches([chatCapability("test-chat-1")]);
    // Settings was just opened by openWindow: the request is latched before the panel mounts.
    requestGatewaySetup();
    render(<SettingsPanel />);

    await waitFor(() => expect(screen.getByLabelText(/figma access token/iu)).toBeInTheDocument());
  });

  it("does not open the dialog on a normal mount without a pending request", async () => {
    primeFetches([chatCapability("test-chat-1")]);
    render(<SettingsPanel />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Update credentials" })).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText(/figma access token/iu)).not.toBeInTheDocument();
  });

  it("defers opening the dialog when config load fails, then opens after a successful Retry", async () => {
    // First load fails → the latched request must NOT open the dialog in misleading first-run
    // wording; the panel shows its own error + Retry. A successful retry then opens it correctly.
    fetchConfigMock.mockRejectedValueOnce(new Error("HTTP 500"));
    fetchModelsMock.mockRejectedValueOnce(new Error("HTTP 500"));
    fetchConfigMock.mockResolvedValue({ config: null, configPresent: true });
    fetchModelsMock.mockResolvedValue({ models: [chatCapability("test-chat-1")] });

    requestGatewaySetup();
    render(<SettingsPanel />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not load gateway settings");
    // The dialog must stay closed while config is unresolved.
    expect(screen.queryByLabelText(/figma access token/iu)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByLabelText(/figma access token/iu)).toBeInTheDocument());
  });
});
