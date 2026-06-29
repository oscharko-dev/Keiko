// Issue #495 — ChatWindow dictation integration. Drives the REAL composer with the real
// useVoiceCapability / useDictation hooks (only the BFF clients and the browser media globals are
// stubbed), proving the capability gate (AC1), the STT-enabled affordance (AC2), browser-support
// gating, and that a denied permission surfaces a non-blocking error while the composer stays usable
// (AC4). The deep capture/transcribe flow is covered at the hook level (useDictation.test.ts).

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatWindow } from "./ChatWindow";
import { ChatSessionProvider } from "./context/ChatSessionContext";
import { useRealtimeVoice } from "./hooks/useRealtimeVoice";
import { clearVoiceCapabilityCacheForTests } from "./hooks/useVoiceCapability";
import type { ChatSessionApi } from "./hooks/useChatSession";
import * as api from "@/lib/api";
import type { Chat, ModelCapability, VoiceCapabilityResolution } from "@/lib/types";

const realtimeVoiceMock = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  retry: vi.fn(),
  interrupt: vi.fn(),
  toggleMute: vi.fn(),
}));

vi.mock("./hooks/useRealtimeVoice", () => ({
  useRealtimeVoice: vi.fn(() => ({
    phase: "idle",
    busy: false,
    turnSnapshot: {
      profile: "full-realtime",
      active: false,
      state: "idle",
      floorHolder: "none",
      turnIndex: 0,
      interruptions: 0,
      backchannels: 0,
      pendingCommit: false,
      recovering: false,
      lastEndOfTurnAtMs: undefined,
      lastInterruptAtMs: undefined,
    },
    listening: false,
    speaking: false,
    canInterrupt: false,
    muted: false,
    error: undefined,
    start: realtimeVoiceMock.start,
    stop: realtimeVoiceMock.stop,
    retry: realtimeVoiceMock.retry,
    interrupt: realtimeVoiceMock.interrupt,
    toggleMute: realtimeVoiceMock.toggleMute,
  })),
}));

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

function makeGroundedKnowledgeChat(): Chat {
  return {
    ...makeChat(),
    localKnowledgeScope: {
      kind: "capsule",
      capsuleId: "capsule-1",
      connectedAtMs: 1,
    } as Chat["localKnowledgeScope"],
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
    memoryEnabled: true,
    setMemoryEnabled: vi.fn(),
    memoryBudgetTokens: 1200,
    setMemoryBudgetTokens: vi.fn(),
    latestMemory: undefined,
    clearLatestMemory: vi.fn(),
    acceptMemoryCandidate: vi.fn(),
    rejectMemoryCandidate: vi.fn(),
    forgetMemoryAction: vi.fn(),
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

function getComposerBox(): HTMLElement {
  const box = screen.getByRole("textbox", { name: "Chat message" }).closest(".cmp-box");
  expect(box).toBeInstanceOf(HTMLElement);
  return box as HTMLElement;
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
  realtimeVoiceMock.start.mockReset();
  realtimeVoiceMock.stop.mockReset();
  realtimeVoiceMock.retry.mockReset();
  realtimeVoiceMock.interrupt.mockReset();
  realtimeVoiceMock.toggleMute.mockReset();
  vi.mocked(useRealtimeVoice).mockClear();
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

// Minimal RTCPeerConnection stub for browser-shape coverage. Voice Dialogue is offered only when the
// browser can open native WebRTC media.
class StubRTCPeerConnection {}

function stubRealtimeBrowser(getUserMedia: () => Promise<MediaStream>): void {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => {
        const stream = await getUserMedia();
        return typeof stream.getTracks === "function"
          ? stream
          : ({ getTracks: () => [] } as unknown as MediaStream);
      }),
    },
  });
  vi.stubGlobal("MediaRecorder", StubMediaRecorder);
  vi.stubGlobal("RTCPeerConnection", StubRTCPeerConnection);
}

describe("ChatWindow voice dialogue availability", () => {
  it("shows NO dialogue switch in a no-voice deployment (AC1)", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: NONE });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession());

    await waitFor(() => expect(api.fetchVoiceCapability).toHaveBeenCalled());
    expect(screen.queryByRole("switch", { name: "Voice dialogue mode" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Chat message" })).toBeInTheDocument();
  });

  it("shows NO dialogue switch for an STT-only deployment (AC3)", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: STT });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession());

    await waitFor(() => expect(api.fetchVoiceCapability).toHaveBeenCalled());
    // Dictation button appears for STT, but NOT the full dialogue switch.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Dictate a message" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("switch", { name: "Voice dialogue mode" })).toBeNull();
  });

  it("renders the dialogue switch when full-realtime, personas, and browser capture are available", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({
      voice: { ...FULL_REALTIME, availableVoicePersonas: ["male"] },
    });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession());

    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Voice dialogue mode" })).toBeInTheDocument(),
    );
    expect(screen.getByRole("textbox", { name: "Chat message" })).toBeInTheDocument();
  });

  it("hides the dialogue switch when full-realtime is advertised but RTCPeerConnection is absent", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({
      voice: { ...FULL_REALTIME, availableVoicePersonas: ["male"] },
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({}) as MediaStream) },
    });
    vi.stubGlobal("MediaRecorder", StubMediaRecorder);
    // No RTCPeerConnection stub.
    renderWindow(makeSession());

    await waitFor(() => expect(api.fetchVoiceCapability).toHaveBeenCalled());
    expect(screen.queryByRole("switch", { name: "Voice dialogue mode" })).toBeNull();
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

  it("renders the mute toggle for a full-realtime deployment without enabling dialogue mode", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: FULL_REALTIME });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession());

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Mute assistant voice" })).toBeInTheDocument(),
    );
  });

  it("does not replay an already-settled assistant response on mount and renders no playback status panel", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: SPEECH_OUTPUT });
    vi.mocked(api.synthesizeAssistantSpeech).mockReset();
    vi.mocked(api.synthesizeAssistantSpeech).mockResolvedValue({
      audio: btoa("stub-audio"),
      mimeType: "audio/mpeg",
    });

    renderWindow(makeSessionWithAssistantMessage());

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Mute assistant voice" })).toBeInTheDocument(),
    );
    expect(api.synthesizeAssistantSpeech).not.toHaveBeenCalled();
    expect(screen.queryByText("Preparing the spoken response…")).toBeNull();
    expect(screen.queryByText("The assistant is speaking.")).toBeNull();
    expect(screen.queryByText("Spoken response finished.")).toBeNull();
  });

  it("does not speak a new text-chat assistant response while voice dialogue mode is off", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: SPEECH_OUTPUT });
    vi.mocked(api.synthesizeAssistantSpeech).mockReset();
    vi.mocked(api.synthesizeAssistantSpeech).mockResolvedValue({
      audio: btoa("stub-audio"),
      mimeType: "audio/mpeg",
    });

    const { rerender } = render(
      <ChatSessionProvider value={makeSession({ sending: true, sendStatus: "streaming" })}>
        <ChatWindow />
      </ChatSessionProvider>,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Mute assistant voice" })).toBeInTheDocument(),
    );

    rerender(
      <ChatSessionProvider
        value={makeSessionWithAssistantMessage({ sending: false, sendStatus: "completed" })}
      >
        <ChatWindow />
      </ChatSessionProvider>,
    );

    await waitFor(() =>
      expect(screen.getByText("Hello, how can I help you today?")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("switch", { name: "Voice dialogue mode" })).toBeNull();
    expect(api.synthesizeAssistantSpeech).not.toHaveBeenCalled();
    expect(screen.queryByText("Spoken response finished.")).toBeNull();
  });
});

// ─── Issue #1559 — Chat dialog-mode switch and persona routing ─────────────────────────────────────

// A full-realtime capability WITH at least one persona — speech capture + speech output + persona unlock
// the switch.
const FULL_REALTIME_WITH_PERSONAS: VoiceCapabilityResolution = {
  available: true,
  profile: "full-realtime",
  capabilities: { speechToText: true, speechOutput: true, realtimeVoice: true },
  transport: { websocketControl: true, webrtcMedia: true },
  availableVoicePersonas: ["male", "female", "neutral"],
  providerLocality: "azure-foundry",
};

const FULL_REALTIME_WITH_TOOL_CALLING: VoiceCapabilityResolution = {
  ...FULL_REALTIME_WITH_PERSONAS,
  capabilities: {
    speechToText: true,
    speechOutput: true,
    realtimeVoice: true,
    realtimeToolCalling: true,
  },
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

  it("hides the dialogue switch for a speech-output deployment that cannot capture user speech (AC3)", async () => {
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

  it("shows Voice Dialogue in a grounded chat even when the optional tool-calling hint is absent", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: FULL_REALTIME_WITH_PERSONAS });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession({ activeChat: makeGroundedKnowledgeChat() }));

    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Voice dialogue mode" })).toBeInTheDocument(),
    );
    expect(screen.getByRole("textbox", { name: "Chat message" })).toBeInTheDocument();
    expect(
      vi.mocked(useRealtimeVoice).mock.calls.some(([args]) => {
        return (
          args.groundingActive === true &&
          args.chatContext?.chatId === "chat-1" &&
          args.chatContext.grounding?.enabled === true &&
          args.chatContext.grounding.kind === "knowledge" &&
          args.chatContext.grounding.sourceCount === 1
        );
      }),
    ).toBe(true);
  });

  it("shows Voice Dialogue in a grounded chat when realtime tool calling is available", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({
      voice: FULL_REALTIME_WITH_TOOL_CALLING,
    });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession({ activeChat: makeGroundedKnowledgeChat() }));

    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Voice dialogue mode" })).toBeInTheDocument(),
    );
    expect(screen.getByRole("textbox", { name: "Chat message" })).toBeInTheDocument();
  });

  it("does not mark the composer with a voice aura before dialogue mode is active", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: FULL_REALTIME_WITH_PERSONAS });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession());

    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Voice dialogue mode" })).toBeInTheDocument(),
    );

    const box = getComposerBox();
    expect(box).not.toHaveAttribute("data-voice-aura");
    expect(box).not.toHaveAttribute("data-voice-aura-state");
    expect(box).not.toHaveAttribute("data-voice-aura-intensity");
    expect(box.querySelector('[role="status"][aria-atomic="true"]')).toBeNull();
  });

  it("entering dialogue mode reduces the composer to voice stop and microphone mute controls", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: FULL_REALTIME_WITH_PERSONAS });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession());

    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Voice dialogue mode" })).toBeInTheDocument(),
    );

    // Click the switch to enter dialogue mode.
    await userEvent.click(screen.getByRole("switch", { name: "Voice dialogue mode" }));

    const box = getComposerBox();
    expect(box).toHaveAttribute("data-voice-aura", "on");
    expect(box).toHaveClass("cmp-box-voice-dialog");
    expect(within(box).getByRole("switch", { name: "Voice dialogue mode" })).toBeInTheDocument();
    expect(
      within(box).getByRole("button", { name: "Mute voice dialogue microphone" }),
    ).toBeInTheDocument();
    expect(within(box).queryByRole("button", { name: "Dictate a message" })).toBeNull();
    expect(within(box).queryByRole("button", { name: "Mute assistant voice" })).toBeNull();
    expect(within(box).queryByRole("button", { name: "Send message" })).toBeNull();
    expect(within(box).queryByRole("button", { name: "Clear history" })).toBeNull();
    expect(within(box).queryByText(/Approximate context/iu)).toBeNull();
  });

  it("entering dialogue mode sets aria-checked=true on the switch without opening a control panel", async () => {
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

    expect(screen.queryByRole("button", { name: "Stop voice dialogue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Leave voice dialogue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start speaking" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Interrupt the assistant" })).toBeNull();

    const box = getComposerBox();
    expect(box).toHaveAttribute("data-voice-aura", "on");
    expect(within(box).getByRole("switch", { name: "Voice dialogue mode" })).toBeInTheDocument();
    expect(
      within(box).getByRole("button", { name: "Mute voice dialogue microphone" }),
    ).toBeInTheDocument();
    expect(within(box).queryByRole("button", { name: "Mute assistant voice" })).toBeNull();
    expect(box).toHaveAttribute("data-voice-aura-state", "ready");
    expect(box).toHaveAttribute("data-voice-aura-intensity", "low");
    expect(box.querySelector('.sr-only[role="status"][aria-live="polite"]')).not.toBeNull();
  });

  it("returns keyboard focus to the dialogue switch across enter and leave (WCAG 2.4.3)", async () => {
    // Toggling the mode swaps the composer footer, remounting the switch under a new parent. Without
    // focus restoration the click would drop a keyboard user onto <body>; the switch must keep focus.
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: FULL_REALTIME_WITH_PERSONAS });
    stubRealtimeBrowser(async () => ({ getTracks: () => [] }) as unknown as MediaStream);
    renderWindow(makeSession());

    const enterSwitch = await screen.findByRole("switch", { name: "Voice dialogue mode" });
    await userEvent.click(enterSwitch);
    // The remounted (active) switch holds focus, not the document body.
    expect(document.activeElement).toBe(
      screen.getByRole("switch", { name: "Voice dialogue mode" }),
    );

    await userEvent.click(screen.getByRole("switch", { name: "Voice dialogue mode" }));
    // And again after returning to the normal composer layout.
    expect(document.activeElement).toBe(
      screen.getByRole("switch", { name: "Voice dialogue mode" }),
    );
  });
});

// ─── Issue #1560 — live dialogue-session controller wiring ───────────────────────────────────────────

// Full-realtime WITH personas but WITHOUT browser WebRTC media. This must not offer dialogue because
// there is no STT + normal chat + TTS fallback for Voice Dialogue.
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

  it("offers the dialogue switch for full-realtime WITH browser audio capture (AC4)", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: FULL_REALTIME_WITH_PERSONAS });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession());

    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Voice dialogue mode" })).toBeInTheDocument(),
    );
  });

  it("hides the dialogue switch for full-realtime WITHOUT browser WebRTC", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({
      voice: FULL_REALTIME_NO_WEBRTC_WITH_PERSONAS,
    });
    stubCaptureBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession());

    await waitFor(() => expect(api.fetchVoiceCapability).toHaveBeenCalled());
    expect(screen.queryByRole("switch", { name: "Voice dialogue mode" })).toBeNull();
  });

  it("entering dialogue starts the realtime controller without rendering extra controls (AC1)", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({
      voice: FULL_REALTIME_WITH_PERSONAS,
    });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession());

    await enterDialogue();

    expect(realtimeVoiceMock.start).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Stop voice dialogue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Leave voice dialogue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start speaking" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Interrupt the assistant" })).toBeNull();
    const box = getComposerBox();
    expect(box).toHaveAttribute("data-voice-aura", "on");
    expect(within(box).getByRole("switch", { name: "Voice dialogue mode" })).toBeInTheDocument();
    expect(
      within(box).getByRole("button", { name: "Mute voice dialogue microphone" }),
    ).toBeInTheDocument();
    expect(within(box).queryByRole("button", { name: "Send message" })).toBeNull();
  });

  it("uses the same dialogue switch to leave dialogue mode and run cleanup", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({
      voice: FULL_REALTIME_WITH_PERSONAS,
    });
    stubRealtimeBrowser(async () => ({ getTracks: () => [] }) as unknown as MediaStream);
    renderWindow(makeSession());

    await enterDialogue();

    await userEvent.click(screen.getByRole("switch", { name: "Voice dialogue mode" }));

    expect(realtimeVoiceMock.stop).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Leave voice dialogue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Interrupt the assistant" })).toBeNull();
    // The switch is back to off and the composer remains usable.
    expect(screen.getByRole("switch", { name: "Voice dialogue mode" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("textbox", { name: "Chat message" })).toBeInTheDocument();
    expect(getComposerBox()).not.toHaveAttribute("data-voice-aura");
    expect(screen.getByRole("button", { name: "Dictate a message" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mute assistant voice" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();
  });
});

// ─── Issue #1560 — dialogue survives the empty→populated chat transition ─────────────────────────────
//
// Lifecycle regression: committing the FIRST turn in a fresh chat flips it from empty to populated. The
// composer was previously rendered in two separate conditional slots (one for the empty state, one for
// the populated state), so React remounted ComposerCore on that transition and reset its local
// voice-dialogue state — silently kicking the user out of an active spoken dialogue right after their
// first committed turn. These tests drive the transition (via a provider rerender, exactly what the real
// chat session does when the first message lands) and assert the dialogue session stays live. They fail
// against the two-slot layout (the remount drops the switch and exits dialogue mode).

describe("ChatWindow voice dialogue survives the first committed turn (Issue #1560)", () => {
  beforeEach(() => {
    clearVoiceCapabilityCacheForTests();
    vi.mocked(api.fetchVoiceCapability).mockReset();
    vi.mocked(api.synthesizeAssistantSpeech).mockReset();
    vi.mocked(api.synthesizeAssistantSpeech).mockResolvedValue({
      audio: btoa("stub-audio"),
      mimeType: "audio/mpeg",
    });
  });

  // The first committed user turn — the message that flips the chat from empty to populated. Its origin
  // (spoken via the dialogue send seam, or typed) is irrelevant: both land a user message and drive the
  // SAME empty→populated re-render, so this one fixture covers the spoken and the typed path alike.
  function makeSessionWithUserMessage(): ReturnType<typeof makeSession> {
    return makeSession({
      messages: [
        {
          id: "user-1",
          chatId: "chat-1",
          role: "user",
          content: "what is the deploy status",
          timestamp: Date.now(),
          runId: undefined,
          workflowId: undefined,
          workflowStatus: undefined,
          shortResult: undefined,
          taskType: undefined,
        },
      ],
    });
  }

  it("keeps dialogue mode active when the first message populates an empty chat (spoken or typed)", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({
      voice: FULL_REALTIME_WITH_PERSONAS,
    });
    stubRealtimeBrowser(async () => ({ getTracks: () => [] }) as unknown as MediaStream);

    // Start in a fresh, empty chat (messages: [] -> the empty composer slot).
    const { rerender } = render(
      <ChatSessionProvider value={makeSession()}>
        <ChatWindow />
      </ChatSessionProvider>,
    );

    // Enter spoken dialogue while the chat is still empty.
    const dialogSwitch = await screen.findByRole("switch", { name: "Voice dialogue mode" });
    await userEvent.click(dialogSwitch);
    expect(screen.getByRole("switch", { name: "Voice dialogue mode" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.queryByRole("button", { name: "Leave voice dialogue" })).toBeNull();

    // The first turn lands and the chat flips empty → populated (what useChatSession does on the first
    // send). The dialogue session must survive: the switch stays on and the composer stays clean.
    rerender(
      <ChatSessionProvider value={makeSessionWithUserMessage()}>
        <ChatWindow />
      </ChatSessionProvider>,
    );

    expect(screen.getByRole("switch", { name: "Voice dialogue mode" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.queryByRole("button", { name: "Leave voice dialogue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Interrupt the assistant" })).toBeNull();
    // The conversation is now shown and the composer stays in the clean voice-control layout.
    const box = getComposerBox();
    expect(box).toHaveAttribute("data-voice-aura", "on");
    expect(within(box).getByRole("switch", { name: "Voice dialogue mode" })).toBeInTheDocument();
    expect(
      within(box).getByRole("button", { name: "Mute voice dialogue microphone" }),
    ).toBeInTheDocument();
    expect(within(box).queryByRole("button", { name: "Send message" })).toBeNull();
  });

  it("keeps dialogue mode active after the first message populated the chat", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({
      voice: FULL_REALTIME_WITH_PERSONAS,
    });
    stubRealtimeBrowser(async () => ({ getTracks: () => [] }) as unknown as MediaStream);

    const { rerender } = render(
      <ChatSessionProvider value={makeSession()}>
        <ChatWindow />
      </ChatSessionProvider>,
    );

    const dialogSwitch = await screen.findByRole("switch", { name: "Voice dialogue mode" });
    await userEvent.click(dialogSwitch);
    expect(screen.queryByRole("button", { name: "Leave voice dialogue" })).toBeNull();

    // First turn populates the chat (empty → populated transition).
    rerender(
      <ChatSessionProvider value={makeSessionWithUserMessage()}>
        <ChatWindow />
      </ChatSessionProvider>,
    );

    expect(screen.getByRole("switch", { name: "Voice dialogue mode" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.queryByRole("button", { name: "Leave voice dialogue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start speaking" })).toBeNull();
    expect(getComposerBox()).toHaveAttribute("data-voice-aura", "on");
  });
});
