// Issue #495 — ChatWindow dictation integration. Drives the REAL composer with the real
// useVoiceCapability / useDictation hooks (only the BFF clients and the browser media globals are
// stubbed), proving the capability gate (AC1), the STT-enabled affordance (AC2), browser-support
// gating, and that a denied permission surfaces a non-blocking error while the composer stays usable
// (AC4). The deep capture/transcribe flow is covered at the hook level (useDictation.test.ts).

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatWindow } from "./ChatWindow";
import { ChatSessionProvider } from "./context/ChatSessionContext";
import { clearVoiceCapabilityCacheForTests } from "./hooks/useVoiceCapability";
import type { ChatSessionApi } from "./hooks/useChatSession";
import * as api from "@/lib/api";
import type { Chat, ModelCapability, VoiceCapabilityResolution } from "@/lib/types";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchVoiceCapability: vi.fn(),
    transcribeDictation: vi.fn(),
    // Issue #1559 — spied in the dialog-mode suite so we can assert persona routing.
    synthesizeAssistantSpeech: vi.fn(),
  };
});

vi.mock("@/lib/local-knowledge-api", () => ({
  fetchCapsules: vi.fn(async () => ({ capsules: [] })),
  fetchCapsuleSets: vi.fn(async () => ({ capsuleSets: [] })),
}));

const STT: VoiceCapabilityResolution = {
  available: true,
  profile: "speech-to-text",
  capabilities: { speechToText: true, speechOutput: false, realtimeVoice: false },
  transport: { websocketControl: true, webrtcMedia: false },
  availableVoicePersonas: [],
  providerLocality: "azure-foundry",
};

const NONE: VoiceCapabilityResolution = {
  available: false,
  profile: "none",
  capabilities: { speechToText: false, speechOutput: false, realtimeVoice: false },
  transport: { websocketControl: false, webrtcMedia: false },
  availableVoicePersonas: [],
  reason: "no-voice-provider",
};

function chatModel(id: string): ModelCapability {
  return {
    id,
    kind: "chat",
    contextWindow: 8192,
    maxOutputTokens: 1024,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: false,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "fixture",
    preferredUseCases: ["Chat"],
    knownLimitations: [],
  };
}

function makeChat(): Chat {
  return {
    id: "chat-1",
    projectPath: "/proj",
    title: "t",
    selectedModel: "example-chat-model",
    branchLabel: undefined,
    status: undefined,
    connectedScope: undefined,
    localKnowledgeScope: undefined,
    createdAt: 1,
    updatedAt: 2,
  };
}

function makeSession(overrides: Partial<ChatSessionApi> = {}): ChatSessionApi {
  return {
    projects: [],
    chats: [],
    messages: [],
    models: [chatModel("example-chat-model")],
    activeProject: undefined,
    activeChat: makeChat(),
    selectedModel: "example-chat-model",
    noEligibleModels: false,
    draft: "",
    loading: false,
    sending: false,
    sendStatus: "idle",
    error: undefined,
    setDraft: vi.fn(),
    setSelectedModel: vi.fn(),
    openNewChat: vi.fn(),
    openProject: vi.fn(),
    openChat: vi.fn(),
    addProject: vi.fn(),
    sendMessage: vi.fn(),
    cancelSend: vi.fn(),
    replaceChat: vi.fn(),
    latestGrounded: undefined,
    cancelGrounded: vi.fn(),
    pendingAttachments: [],
    addPendingAttachment: vi.fn().mockResolvedValue({ ok: true }),
    removePendingAttachment: vi.fn(),
    clearPendingAttachments: vi.fn(),
    budget: undefined,
    memoryEnabled: true,
    setMemoryEnabled: vi.fn(),
    memoryBudgetTokens: 1200,
    setMemoryBudgetTokens: vi.fn(),
    latestMemory: undefined,
    clearLatestMemory: vi.fn(),
    acceptMemoryCandidate: vi.fn(),
    rejectMemoryCandidate: vi.fn(),
    forgetMemoryAction: vi.fn(),
    clearHistory: vi.fn(),
    lastSentDocuments: [],
    ...overrides,
  };
}

function renderWindow(session: ChatSessionApi): void {
  render(
    <ChatSessionProvider value={session}>
      <ChatWindow />
    </ChatSessionProvider>,
  );
}

// Minimal MediaRecorder stub so dictationCaptureSupported() reports a capture-capable browser. The
// actual capture cycle is not exercised here (it is in the hook/recorder suites).
class StubMediaRecorder {
  static isTypeSupported = (): boolean => true;
  state = "inactive";
  mimeType = "audio/webm";
  addEventListener(): void {}
  start(): void {}
  stop(): void {}
}

function stubCaptureBrowser(getUserMedia: () => Promise<MediaStream>): void {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(getUserMedia) },
  });
  vi.stubGlobal("MediaRecorder", StubMediaRecorder);
}

beforeEach(() => {
  clearVoiceCapabilityCacheForTests();
  vi.mocked(api.fetchVoiceCapability).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, "mediaDevices");
});

describe("ChatWindow dictation integration", () => {
  it("shows NO microphone and stays fully usable in a no-voice deployment (AC1)", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: NONE });
    stubCaptureBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession());

    await waitFor(() => expect(api.fetchVoiceCapability).toHaveBeenCalled());
    // Composer is present and editable; no dictation affordance is rendered.
    expect(screen.getByRole("textbox", { name: "Chat message" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dictate a message" })).toBeNull();
  });

  it("renders the microphone affordance when STT is advertised and the browser can capture (AC2)", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: STT });
    stubCaptureBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession());

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Dictate a message" })).toBeInTheDocument(),
    );
    expect(screen.getByRole("textbox", { name: "Chat message" })).toBeInTheDocument();
  });

  it("hides the microphone when STT is advertised but the browser cannot capture", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: STT });
    // No MediaRecorder / mediaDevices stub -> dictationCaptureSupported() is false.
    renderWindow(makeSession());
    await waitFor(() => expect(api.fetchVoiceCapability).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Dictate a message" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Chat message" })).toBeInTheDocument();
  });

  it("surfaces a denied permission without breaking the composer (AC4)", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: STT });
    const denied = new Error("denied");
    denied.name = "NotAllowedError";
    stubCaptureBrowser(() => Promise.reject(denied));
    renderWindow(makeSession());

    const mic = await screen.findByRole("button", { name: "Dictate a message" });
    await userEvent.click(mic);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Microphone access was denied/u);
    // The composer is still fully usable after a denied permission.
    expect(screen.getByRole("textbox", { name: "Chat message" })).toBeInTheDocument();
  });
});

const FULL_REALTIME: VoiceCapabilityResolution = {
  available: true,
  profile: "full-realtime",
  capabilities: { speechToText: true, speechOutput: true, realtimeVoice: true },
  transport: { websocketControl: true, webrtcMedia: true },
  availableVoicePersonas: [],
  providerLocality: "azure-foundry",
};

// Minimal RTCPeerConnection stub so realtimeVoiceTransportSupported() reports a WebRTC-capable
// browser. The actual WebRTC/WS cycle is not exercised here (it is in the hook/transport suites).
class StubRTCPeerConnection {}

function stubRealtimeBrowser(getUserMedia: () => Promise<MediaStream>): void {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(getUserMedia) },
  });
  vi.stubGlobal("MediaRecorder", StubMediaRecorder);
  vi.stubGlobal("RTCPeerConnection", StubRTCPeerConnection);
}

describe("ChatWindow realtime voice integration (Issue #497)", () => {
  it("shows NO realtime button in a no-voice deployment (AC1)", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: NONE });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession());

    await waitFor(() => expect(api.fetchVoiceCapability).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Start realtime voice" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Chat message" })).toBeInTheDocument();
  });

  it("shows NO realtime button for an STT-only deployment (AC3)", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: STT });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession());

    await waitFor(() => expect(api.fetchVoiceCapability).toHaveBeenCalled());
    // Dictation button appears for STT, but NOT the realtime button.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Dictate a message" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "Start realtime voice" })).toBeNull();
  });

  it("renders the realtime button when full-realtime is advertised and RTCPeerConnection is available", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: FULL_REALTIME });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession());

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start realtime voice" })).toBeInTheDocument(),
    );
    expect(screen.getByRole("textbox", { name: "Chat message" })).toBeInTheDocument();
  });

  it("hides the realtime button when full-realtime is advertised but RTCPeerConnection is absent", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: FULL_REALTIME });
    // Stub MediaRecorder but NOT RTCPeerConnection -> realtimeVoiceTransportSupported() false.
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({}) as MediaStream) },
    });
    vi.stubGlobal("MediaRecorder", StubMediaRecorder);
    // No RTCPeerConnection stub.
    renderWindow(makeSession());

    await waitFor(() => expect(api.fetchVoiceCapability).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Start realtime voice" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Chat message" })).toBeInTheDocument();
  });
});

const SPEECH_OUTPUT: VoiceCapabilityResolution = {
  available: true,
  profile: "speech-output",
  capabilities: { speechToText: false, speechOutput: true, realtimeVoice: false },
  transport: { websocketControl: true, webrtcMedia: false },
  availableVoicePersonas: [],
  providerLocality: "azure-foundry",
};

describe("ChatWindow assistant speech-output integration (Issue #501)", () => {
  it("shows NO playback control and stays fully text-capable in a no-voice deployment (AC1)", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: NONE });
    renderWindow(makeSession());

    await waitFor(() => expect(api.fetchVoiceCapability).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /assistant voice/iu })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Chat message" })).toBeInTheDocument();
  });

  it("shows NO playback control for an STT-only deployment — dictation does not imply speech (AC1)", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: STT });
    stubCaptureBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession());

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Dictate a message" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: /assistant voice/iu })).toBeNull();
  });

  it("renders the mute toggle when speech output is advertised and it stays text-capable", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: SPEECH_OUTPUT });
    renderWindow(makeSession());

    const mute = await screen.findByRole("button", { name: "Mute assistant voice" });
    expect(mute).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("textbox", { name: "Chat message" })).toBeInTheDocument();

    await userEvent.click(mute);
    expect(
      await screen.findByRole("button", { name: "Unmute assistant voice" }),
    ).toBeInTheDocument();
  });

  it("renders the mute toggle for a full-realtime deployment (which also speaks)", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: FULL_REALTIME });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession());

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Mute assistant voice" })).toBeInTheDocument(),
    );
  });
});

// ─── Issue #1559 — Chat dialog-mode switch and persona routing ─────────────────────────────────────

// A full-realtime capability WITH at least one persona — the only combination that unlocks the switch.
const FULL_REALTIME_WITH_PERSONAS: VoiceCapabilityResolution = {
  available: true,
  profile: "full-realtime",
  capabilities: { speechToText: true, speechOutput: true, realtimeVoice: true },
  transport: { websocketControl: true, webrtcMedia: true },
  availableVoicePersonas: ["male", "female", "neutral"],
  providerLocality: "azure-foundry",
};

// Stub an assistant message that has settled so the playback engine attempts synthesis (enables
// persona-routing assertions without a server round-trip).
function makeSessionWithAssistantMessage(
  overrides: Partial<Parameters<typeof makeSession>[0]> = {},
): ReturnType<typeof makeSession> {
  return makeSession({
    messages: [
      {
        id: "msg-1",
        chatId: "chat-1",
        role: "assistant",
        content: "Hello, how can I help you today?",
        timestamp: Date.now(),
        runId: undefined,
        workflowId: undefined,
        workflowStatus: undefined,
        shortResult: undefined,
        taskType: undefined,
      },
    ],
    ...overrides,
  });
}

describe("ChatWindow voice dialog-mode switch (Issue #1559)", () => {
  beforeEach(() => {
    clearVoiceCapabilityCacheForTests();
    vi.mocked(api.fetchVoiceCapability).mockReset();
    vi.mocked(api.synthesizeAssistantSpeech).mockReset();
    // Default: synthesis resolves immediately so the playback engine can proceed.
    vi.mocked(api.synthesizeAssistantSpeech).mockResolvedValue({
      audio: btoa("stub-audio"),
      mimeType: "audio/mpeg",
    });
  });

  it("hides the dialogue switch in a no-voice deployment (AC3)", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: NONE });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession());

    await waitFor(() => expect(api.fetchVoiceCapability).toHaveBeenCalled());
    expect(screen.queryByRole("switch", { name: "Voice dialogue mode" })).toBeNull();
    // Text composer stays fully usable (AC1).
    expect(screen.getByRole("textbox", { name: "Chat message" })).toBeInTheDocument();
  });

  it("hides the dialogue switch for an STT-only deployment (AC3)", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: STT });
    stubCaptureBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession());

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Dictate a message" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("switch", { name: "Voice dialogue mode" })).toBeNull();
  });

  it("hides the dialogue switch for a speech-output deployment that has no realtime (AC3)", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: SPEECH_OUTPUT });
    renderWindow(makeSession());

    await waitFor(() => expect(api.fetchVoiceCapability).toHaveBeenCalled());
    expect(screen.queryByRole("switch", { name: "Voice dialogue mode" })).toBeNull();
  });

  it("hides the dialogue switch when full-realtime has zero advertised personas (AC3)", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: FULL_REALTIME });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession());

    await waitFor(() => expect(api.fetchVoiceCapability).toHaveBeenCalled());
    // FULL_REALTIME has availableVoicePersonas:[] so the switch should not appear.
    expect(screen.queryByRole("switch", { name: "Voice dialogue mode" })).toBeNull();
  });

  it("shows the dialogue switch when full-realtime has at least one persona (AC2)", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: FULL_REALTIME_WITH_PERSONAS });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession());

    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Voice dialogue mode" })).toBeInTheDocument(),
    );
    // aria-checked=false before entering.
    expect(screen.getByRole("switch", { name: "Voice dialogue mode" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("entering dialogue mode does not disturb the text composer (AC1)", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: FULL_REALTIME_WITH_PERSONAS });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession());

    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Voice dialogue mode" })).toBeInTheDocument(),
    );

    // Click the switch to enter dialogue mode.
    await userEvent.click(screen.getByRole("switch", { name: "Voice dialogue mode" }));

    // The text composer must remain fully operable after entering voice dialogue (AC1).
    expect(screen.getByRole("textbox", { name: "Chat message" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Chat message" })).not.toBeDisabled();
  });

  it("entering dialogue mode sets aria-checked=true on the switch and shows the active persona", async () => {
    // Integration-level proof that entering dialogue is reflected in the switch state and that the
    // default persona ("male", the first in VOICE_PERSONAS order) is surfaced in the profile selector.
    //
    // End-to-end persona routing through synthesizeAssistantSpeech is proven deterministically at
    // the hook level in hooks/useAssistantSpeech.test.ts ("Issue #1559 persona routing" suite) —
    // the full-ChatWindow jsdom audio path is too fragile to assert async BFF call receipt reliably.
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: FULL_REALTIME_WITH_PERSONAS });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession());

    const dialogSwitch = await screen.findByRole("switch", { name: "Voice dialogue mode" });
    expect(dialogSwitch).toHaveAttribute("aria-checked", "false");

    // Enter dialogue mode.
    await userEvent.click(dialogSwitch);

    // The switch must now report active.
    expect(screen.getByRole("switch", { name: "Voice dialogue mode" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    // The persona selector's sr-only label contains the active voice so screen readers announce it.
    const profileLabel = document.getElementById("cmp-voice-dialog-profile-label");
    expect(profileLabel?.textContent).toMatch(/Male voice/u);

    // Text composer is still fully operable (AC1 — dialogue never takes over chat).
    expect(screen.getByRole("textbox", { name: "Chat message" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Chat message" })).not.toBeDisabled();
  });
});

// ─── Issue #1560 — live dialogue-session controller wiring ───────────────────────────────────────────

// Full-realtime WITH personas but WITHOUT browser WebRTC media — the production STT+TTS fallback the
// matrix must still offer (ADR-0090 D3). Identical caps to FULL_REALTIME_WITH_PERSONAS except transport.
const FULL_REALTIME_NO_WEBRTC_WITH_PERSONAS: VoiceCapabilityResolution = {
  ...FULL_REALTIME_WITH_PERSONAS,
  transport: { websocketControl: true, webrtcMedia: false },
};

describe("ChatWindow voice dialogue-session controller (Issue #1560)", () => {
  beforeEach(() => {
    clearVoiceCapabilityCacheForTests();
    vi.mocked(api.fetchVoiceCapability).mockReset();
    vi.mocked(api.synthesizeAssistantSpeech).mockReset();
    vi.mocked(api.synthesizeAssistantSpeech).mockResolvedValue({
      audio: btoa("stub-audio"),
      mimeType: "audio/mpeg",
    });
  });

  async function enterDialogue(): Promise<void> {
    const dialogSwitch = await screen.findByRole("switch", { name: "Voice dialogue mode" });
    await userEvent.click(dialogSwitch);
  }

  it("offers the dialogue switch for full-realtime WITH browser WebRTC (AC4)", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: FULL_REALTIME_WITH_PERSONAS });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession());

    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Voice dialogue mode" })).toBeInTheDocument(),
    );
  });

  it("STILL offers the dialogue switch for full-realtime WITHOUT browser WebRTC (STT+TTS fallback, D3)", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({
      voice: FULL_REALTIME_NO_WEBRTC_WITH_PERSONAS,
    });
    // Capture-capable browser (MediaRecorder + mediaDevices) but NO RTCPeerConnection: the matrix gates
    // on dictation capture, not WebRTC media, so dialogue must be offered here — the production fix.
    stubCaptureBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession());

    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Voice dialogue mode" })).toBeInTheDocument(),
    );
  });

  it("entering dialogue renders the per-turn controls (Speak + Interrupt) without disturbing the composer (AC1)", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({
      voice: FULL_REALTIME_NO_WEBRTC_WITH_PERSONAS,
    });
    stubCaptureBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession());

    await enterDialogue();

    // The turn controls are present so the user can actually take the floor (AC1).
    expect(screen.getByRole("button", { name: "Start speaking" })).toBeInTheDocument();
    // Interrupt is present but disabled until the assistant holds the floor.
    expect(screen.getByRole("button", { name: "Interrupt the assistant" })).toBeDisabled();
    // The text composer is untouched and fully usable throughout (AC1/AC2).
    expect(screen.getByRole("textbox", { name: "Chat message" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Chat message" })).not.toBeDisabled();
  });

  it("activating the mic begins a listening turn (AC1)", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({
      voice: FULL_REALTIME_NO_WEBRTC_WITH_PERSONAS,
    });
    stubCaptureBrowser(async () => ({ getTracks: () => [] }) as unknown as MediaStream);
    renderWindow(makeSession());

    await enterDialogue();
    const mic = screen.getByRole("button", { name: "Start speaking" });
    await userEvent.click(mic);

    // Once capturing, the mic flips to the stop-and-send affordance (aria-pressed=true), proving the
    // dialogue session took the floor. The deep transcribe→send path is proven deterministically in
    // hooks/useVoiceDialogueSession.test.ts (the full jsdom MediaRecorder capture cycle is too fragile
    // to drive end-to-end here, mirroring the #1559 persona-routing decision above).
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Stop speaking and send" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
  });

  it("leaving dialogue removes the turn controls and runs cleanup (AC3)", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({
      voice: FULL_REALTIME_NO_WEBRTC_WITH_PERSONAS,
    });
    stubCaptureBrowser(async () => ({ getTracks: () => [] }) as unknown as MediaStream);
    renderWindow(makeSession());

    await enterDialogue();
    expect(screen.getByRole("button", { name: "Start speaking" })).toBeInTheDocument();

    // Leave via the session cluster's Leave control (runs the master cleanup, D9).
    await userEvent.click(screen.getByRole("button", { name: "Leave voice dialogue" }));

    expect(screen.queryByRole("button", { name: "Start speaking" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Interrupt the assistant" })).toBeNull();
    // The switch is back to off and the composer remains usable.
    expect(screen.getByRole("switch", { name: "Voice dialogue mode" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("textbox", { name: "Chat message" })).toBeInTheDocument();
  });
});
