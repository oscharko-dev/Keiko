// Issue #495 — ChatWindow dictation integration. Drives the REAL composer with the real
// useVoiceCapability / useDictation hooks (only the BFF clients and the browser media globals are
// stubbed), proving the capability gate (AC1), the STT-enabled affordance (AC2), browser-support
// gating, and that a denied permission surfaces a non-blocking error while the composer stays usable
// (AC4). The deep capture/transcribe flow is covered at the hook level (useDictation.test.ts).

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatWindow } from "./ChatWindow";
import { ChatSessionProvider } from "./context/ChatSessionContext";
import { useRealtimeVoice } from "./hooks/useRealtimeVoice";
import { clearVoiceCapabilityCacheForTests } from "./hooks/useVoiceCapability";
import type { ChatSessionApi, SendMessageOutcome } from "./hooks/useChatSession";
import * as api from "@/lib/api";
import type { Chat, ModelCapability, VoiceCapabilityResolution } from "@/lib/types";

const realtimeVoiceMock = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  retry: vi.fn(),
  interrupt: vi.fn(),
  toggleMute: vi.fn(),
  phase: "idle" as "idle" | "requesting" | "negotiating" | "connected" | "error",
  error: undefined as
    { readonly reason: "connection-failed"; readonly message: string } | undefined,
  partialUserTranscript: undefined as string | undefined,
}));

vi.mock("./hooks/useRealtimeVoice", () => ({
  useRealtimeVoice: vi.fn(() => ({
    phase: realtimeVoiceMock.phase,
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
    partialUserTranscript: realtimeVoiceMock.partialUserTranscript,
    error: realtimeVoiceMock.error,
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

vi.mock("@/lib/local-knowledge-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/local-knowledge-api")>();
  return {
    ...actual,
    fetchCapsules: vi.fn(async () => ({ capsules: [] })),
    fetchCapsuleSets: vi.fn(async () => ({ capsuleSets: [] })),
  };
});

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
    regeneratingMessageId: undefined,
    error: undefined,
    setDraft: vi.fn(),
    setSelectedModel: vi.fn(),
    openNewChat: vi.fn(),
    openProject: vi.fn(),
    openChat: vi.fn(),
    addProject: vi.fn(),
    sendMessage: vi.fn(),
    regenerateMessage: vi.fn(),
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

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function getComposerBox(): HTMLElement {
  const box = document.querySelector(".cmp-box");
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
  realtimeVoiceMock.phase = "idle";
  realtimeVoiceMock.error = undefined;
  realtimeVoiceMock.partialUserTranscript = undefined;
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

    expect(await screen.findByRole("button", { name: "Dictate a message" })).toBeInTheDocument();
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

describe("ChatWindow canonical spoken-turn recovery", () => {
  it("renders a visible retry action and blocks a later typed send until recovery", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: NONE });
    const retryPendingCanonicalVoiceTurn = vi.fn();
    renderWindow(
      makeSession({
        draft: "typed later",
        canonicalVoiceTurnRequiresRetry: true,
        retryPendingCanonicalVoiceTurn,
      }),
    );
    await waitFor(() => expect(api.fetchVoiceCapability).toHaveBeenCalled());

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/spoken turn is still waiting for a confirmed answer/iu);
    const retry = within(alert).getByRole("button", { name: "Retry spoken turn" });
    expect(retry).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send message" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    await userEvent.click(retry);
    expect(retryPendingCanonicalVoiceTurn).toHaveBeenCalledOnce();
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
class StubRTCPeerConnection {
  addTransceiver(): void {}
}

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
    expect(await screen.findByRole("button", { name: "Dictate a message" })).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Voice dialogue mode" })).toBeNull();
  });

  it("renders the dialogue switch when full-realtime, personas, and browser capture are available", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({
      voice: { ...FULL_REALTIME, availableVoicePersonas: ["male"] },
    });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession());

    expect(await screen.findByRole("switch", { name: "Voice dialogue mode" })).toBeInTheDocument();
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

    expect(await screen.findByRole("button", { name: "Dictate a message" })).toBeInTheDocument();
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

    expect(await screen.findByRole("button", { name: "Mute assistant voice" })).toBeInTheDocument();
  });

  it("does not replay an already-settled assistant response on mount and renders no playback status panel", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: SPEECH_OUTPUT });
    vi.mocked(api.synthesizeAssistantSpeech).mockReset();
    vi.mocked(api.synthesizeAssistantSpeech).mockResolvedValue({
      audio: btoa("stub-audio"),
      mimeType: "audio/mpeg",
    });

    renderWindow(makeSessionWithAssistantMessage());

    expect(await screen.findByRole("button", { name: "Mute assistant voice" })).toBeInTheDocument();
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

    expect(await screen.findByRole("button", { name: "Mute assistant voice" })).toBeInTheDocument();

    rerender(
      <ChatSessionProvider
        value={makeSessionWithAssistantMessage({ sending: false, sendStatus: "completed" })}
      >
        <ChatWindow />
      </ChatSessionProvider>,
    );

    expect(await screen.findByText("Hello, how can I help you today?")).toBeInTheDocument();
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

    expect(await screen.findByRole("button", { name: "Dictate a message" })).toBeInTheDocument();
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

    expect(await screen.findByRole("switch", { name: "Voice dialogue mode" })).toBeInTheDocument();
    // aria-checked=false before entering.
    expect(screen.getByRole("switch", { name: "Voice dialogue mode" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("keeps grounded chat context out of the transcription-only Realtime session", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: FULL_REALTIME_WITH_PERSONAS });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession({ activeChat: makeGroundedKnowledgeChat() }));

    expect(await screen.findByRole("switch", { name: "Voice dialogue mode" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Chat message" })).toBeInTheDocument();
    expect(
      vi.mocked(useRealtimeVoice).mock.calls.some(([args]) => {
        return (
          args.chatContext?.chatId === "chat-1" &&
          Object.keys(args.chatContext).length === 1 &&
          args.onCanonicalUserTurn !== undefined
        );
      }),
    ).toBe(true);
  });

  it("does not activate a second Realtime tool path when the provider supports tools", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({
      voice: FULL_REALTIME_WITH_TOOL_CALLING,
    });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession({ activeChat: makeGroundedKnowledgeChat() }));

    expect(await screen.findByRole("switch", { name: "Voice dialogue mode" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Chat message" })).toBeInTheDocument();
    expect(
      vi.mocked(useRealtimeVoice).mock.calls.some(([args]) => {
        const optionNames = Object.keys(args);
        return (
          args.chatContext?.chatId === "chat-1" &&
          !optionNames.includes("groundingToolActive") &&
          !optionNames.includes("memoryToolActive") &&
          !optionNames.includes("onGroundedToolCall") &&
          !optionNames.includes("onMemoryToolCall")
        );
      }),
    ).toBe(true);
  });

  it("does not mark the composer with a voice aura before dialogue mode is active", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: FULL_REALTIME_WITH_PERSONAS });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession());

    expect(await screen.findByRole("switch", { name: "Voice dialogue mode" })).toBeInTheDocument();

    const box = getComposerBox();
    expect(box).not.toHaveAttribute("data-voice-aura");
    expect(box).not.toHaveAttribute("data-voice-aura-state");
    expect(box).not.toHaveAttribute("data-voice-aura-intensity");
    expect(box.querySelector('[role="status"][aria-atomic="true"]')).toBeNull();
  });

  it("entering dialogue mode exposes only the centred dialogue controls", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: FULL_REALTIME_WITH_PERSONAS });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession());

    expect(await screen.findByRole("switch", { name: "Voice dialogue mode" })).toBeInTheDocument();

    // Click the switch to enter dialogue mode.
    await userEvent.click(screen.getByRole("switch", { name: "Voice dialogue mode" }));

    const box = getComposerBox();
    expect(box).toHaveAttribute("data-voice-aura", "on");
    expect(within(box).queryByRole("textbox", { name: "Chat message" })).toBeNull();
    expect(within(box).queryByRole("button", { name: "Attach file" })).toBeNull();
    expect(within(box).queryByRole("combobox")).toBeNull();
    expect(within(box).getByRole("switch", { name: "Voice dialogue mode" })).toBeInTheDocument();
    expect(
      within(box).getByRole("button", { name: "Mute voice dialogue microphone" }),
    ).toBeInTheDocument();
    expect(within(box).getAllByRole("button")).toHaveLength(1);
    expect(within(box).getAllByRole("switch")).toHaveLength(1);
    expect(within(box).queryByRole("button", { name: "Dictate a message" })).toBeNull();
    expect(within(box).queryByRole("button", { name: "Mute assistant voice" })).toBeNull();
    expect(within(box).queryByRole("button", { name: "Send message" })).toBeNull();
    expect(within(box).queryByRole("button", { name: "Interrupt the assistant" })).toBeNull();
    expect(within(box).queryByRole("button", { name: "Clear history" })).toBeNull();
    expect(within(box).queryByText(/Approximate context/iu)).toBeNull();

    const normalLayer = box.querySelector('[data-composer-layer="normal"]');
    const voiceLayer = box.querySelector('[data-composer-layer="voice"]');
    expect(normalLayer).toHaveAttribute("aria-hidden", "true");
    expect(normalLayer).toHaveAttribute("inert");
    expect(voiceLayer).not.toHaveAttribute("aria-hidden");
    expect(voiceLayer).not.toHaveAttribute("inert");
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
    // Toggling the mode makes the current layer inert. Without focus restoration the click would
    // drop a keyboard user onto <body>; the switch in the newly active layer must receive focus.
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: FULL_REALTIME_WITH_PERSONAS });
    stubRealtimeBrowser(async () => ({ getTracks: () => [] }) as unknown as MediaStream);
    renderWindow(makeSession());

    const enterSwitch = await screen.findByRole("switch", { name: "Voice dialogue mode" });
    await userEvent.click(enterSwitch);
    // The active-layer switch holds focus, not the document body.
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
    // Wait for the ENTERED state, not just for the click to return. Entering swaps the composer's
    // normal layer for the dialogue layer, and `userEvent.click` only flushes what React scheduled
    // during the event itself — a later render is not covered. Every test here that says "after
    // entering" was reading whatever the DOM happened to hold at that moment, and a second click
    // landing mid-swap toggles from an unsettled state. This is an ADDED assertion: it now also
    // proves entering succeeded, which no caller checked before.
    await waitFor((): void => {
      expect(screen.getByRole("switch", { name: "Voice dialogue mode" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    });
  }

  it("offers the dialogue switch for full-realtime WITH browser audio capture (AC4)", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: FULL_REALTIME_WITH_PERSONAS });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession());

    expect(await screen.findByRole("switch", { name: "Voice dialogue mode" })).toBeInTheDocument();
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

  it("surfaces a retained hard-admission final with a focused realtime retry action", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({
      voice: FULL_REALTIME_WITH_PERSONAS,
    });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    realtimeVoiceMock.phase = "error";
    realtimeVoiceMock.error = {
      reason: "connection-failed",
      message: "The final spoken turn could not enter the canonical chat outbox.",
    };
    realtimeVoiceMock.partialUserTranscript = "retained final transcript";
    renderWindow(makeSession());

    await enterDialogue();

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/final spoken turn could not enter/iu);
    expect(screen.getByText("retained final transcript")).toBeInTheDocument();
    const retry = within(alert).getByRole("button", { name: "Try again" });
    await waitFor(() => expect(retry).toHaveFocus());

    await userEvent.click(retry);
    expect(realtimeVoiceMock.retry).toHaveBeenCalledOnce();
  });

  it("shows the ephemeral spoken transcript while the utterance is still in progress", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({
      voice: FULL_REALTIME_WITH_PERSONAS,
    });
    realtimeVoiceMock.partialUserTranscript = "Search the connected repository";
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    renderWindow(makeSession());

    await enterDialogue();

    expect(screen.getByText("Search the connected repository")).toBeInTheDocument();
  });

  it("routes a final spoken transcript through the canonical chat send", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({
      voice: FULL_REALTIME_WITH_PERSONAS,
    });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    const sendMessage = vi.fn().mockResolvedValue({
      status: "completed",
      assistantMessageId: "assistant-canonical",
    });
    renderWindow(makeSession({ sendMessage }));

    await waitFor(() => expect(useRealtimeVoice).toHaveBeenCalled());
    const options = vi.mocked(useRealtimeVoice).mock.calls.at(-1)?.[0];
    expect(options?.onCanonicalUserTurn).toBeDefined();

    await act(async () => {
      await options?.onCanonicalUserTurn?.({
        turnId: "voice-user-1",
        text: "Search the connected repository.",
      });
    });

    expect(sendMessage).toHaveBeenCalledWith({
      text: "Search the connected repository.",
      clientTurnId: "voice-user-1",
      reportOutcome: true,
    });
  });

  it("admits the same canonical voice turn id only once", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({
      voice: FULL_REALTIME_WITH_PERSONAS,
    });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    const sendMessage = vi.fn().mockResolvedValue({
      status: "completed",
      assistantMessageId: "assistant-replayed",
    });
    renderWindow(makeSession({ sendMessage }));

    await waitFor(() => expect(useRealtimeVoice).toHaveBeenCalled());
    const options = vi.mocked(useRealtimeVoice).mock.calls.at(-1)?.[0];
    const turn = { turnId: "voice-user-replayed", text: "Persist me exactly once." };

    await act(async () => {
      await options?.onCanonicalUserTurn?.(turn);
      await options?.onCanonicalUserTurn?.(turn);
    });

    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("hands a response-lost final to the Chat queue once and returns synchronously", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({
      voice: FULL_REALTIME_WITH_PERSONAS,
    });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    const enqueueCanonicalVoiceTurn = vi.fn().mockResolvedValue({ status: "in-progress" });
    const sendMessage = vi.fn();
    renderWindow(makeSession({ enqueueCanonicalVoiceTurn, sendMessage }));

    await waitFor(() => expect(useRealtimeVoice).toHaveBeenCalled());
    const options = vi.mocked(useRealtimeVoice).mock.calls.at(-1)?.[0];
    let firstOutcome: unknown;
    let replayOutcome: unknown;
    await act(async () => {
      firstOutcome = await options?.onCanonicalUserTurn?.({
        turnId: "provider-item-opaque",
        text: "Recover this response-lost turn.",
      });
      replayOutcome = await options?.onCanonicalUserTurn?.({
        turnId: "provider-item-opaque",
        text: "Recover this response-lost turn.",
      });
    });

    expect(firstOutcome).toBe(true);
    expect(replayOutcome).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(enqueueCanonicalVoiceTurn).toHaveBeenCalledOnce();
    expect(enqueueCanonicalVoiceTurn).toHaveBeenCalledWith({
      text: "Recover this response-lost turn.",
      clientTurnId: "provider-item-opaque",
      allowReservedCapacity: true,
      target: {
        chat: expect.objectContaining({ id: "chat-1", projectPath: "/proj" }),
        modelId: "example-chat-model",
      },
    });
  });

  it("prevents Realtime capture from starting while the canonical queue is at its boundary", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({
      voice: FULL_REALTIME_WITH_PERSONAS,
    });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    let captureMustPause = true;
    renderWindow(
      makeSession({
        canonicalVoiceCaptureMustPause: () => captureMustPause,
      }),
    );

    await waitFor(() => expect(useRealtimeVoice).toHaveBeenCalled());
    const options = vi.mocked(useRealtimeVoice).mock.calls.at(-1)?.[0];
    expect(options?.canStartCapture?.()).toBe(false);

    captureMustPause = false;
    expect(options?.canStartCapture?.()).toBe(true);
  });

  it("rejects Realtime ownership when the canonical queue cannot retain the final", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({
      voice: FULL_REALTIME_WITH_PERSONAS,
    });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    const enqueueCanonicalVoiceTurn = vi.fn(() => undefined);
    const sendMessage = vi.fn();
    renderWindow(makeSession({ enqueueCanonicalVoiceTurn, sendMessage }));

    await waitFor(() => expect(useRealtimeVoice).toHaveBeenCalled());
    const options = vi.mocked(useRealtimeVoice).mock.calls.at(-1)?.[0];
    const accepted = options?.onCanonicalUserTurn?.({
      turnId: "queue-backpressure",
      text: "Retain this final in Realtime until capacity is available.",
    });

    expect(accepted).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(enqueueCanonicalVoiceTurn).toHaveBeenCalledOnce();
  });

  it("never restarts an explicitly cancelled canonical turn whose user row persisted", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({
      voice: FULL_REALTIME_WITH_PERSONAS,
    });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    const sendMessage = vi.fn().mockResolvedValue({
      status: "cancelled",
      userPersisted: true,
    });
    renderWindow(makeSession({ sendMessage }));

    await waitFor(() => expect(useRealtimeVoice).toHaveBeenCalled());
    const options = vi.mocked(useRealtimeVoice).mock.calls.at(-1)?.[0];
    let outcome: unknown;
    await act(async () => {
      outcome = await options?.onCanonicalUserTurn?.({
        turnId: "cancelled-provider-item",
        text: "Keep the transcript but cancel its answer.",
      });
    });

    expect(outcome).toBe(true);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith({
      text: "Keep the transcript but cancel its answer.",
      clientTurnId: "cancelled-provider-item",
      reportOutcome: true,
    });
  });

  it("cancels canonical generation when the user barges in", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({
      voice: FULL_REALTIME_WITH_PERSONAS,
    });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    const cancelSend = vi.fn();
    renderWindow(makeSession({ cancelSend }));

    await waitFor(() => expect(useRealtimeVoice).toHaveBeenCalled());
    const options = vi.mocked(useRealtimeVoice).mock.calls.at(-1)?.[0];
    expect(options?.onUserSpeechStart).toBeDefined();

    act(() => options?.onUserSpeechStart?.());

    expect(cancelSend).toHaveBeenCalledOnce();
  });

  it("speaks the settled canonical answer without replaying older chat history", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({
      voice: FULL_REALTIME_WITH_PERSONAS,
    });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    const sendMessage = vi.fn().mockResolvedValue({
      status: "completed",
      assistantMessageId: "msg-2",
    });
    const { rerender } = render(
      <ChatSessionProvider value={makeSessionWithAssistantMessage({ sendMessage })}>
        <ChatWindow />
      </ChatSessionProvider>,
    );

    await enterDialogue();
    expect(api.synthesizeAssistantSpeech).not.toHaveBeenCalled();

    const options = vi.mocked(useRealtimeVoice).mock.calls.at(-1)?.[0];
    await act(async () => {
      await options?.onCanonicalUserTurn?.({
        turnId: "voice-user-2",
        text: "What is the release status?",
      });
    });
    rerender(
      <ChatSessionProvider
        value={makeSession({
          sendMessage,
          messages: [
            ...makeSessionWithAssistantMessage().messages,
            {
              id: "msg-2",
              chatId: "chat-1",
              role: "assistant",
              content: "The release is green.",
              timestamp: Date.now(),
              runId: undefined,
              workflowId: undefined,
              workflowStatus: undefined,
              shortResult: undefined,
              taskType: undefined,
            },
          ],
          sending: false,
          sendStatus: "completed",
        })}
      >
        <ChatWindow />
      </ChatSessionProvider>,
    );

    await waitFor(() =>
      expect(api.synthesizeAssistantSpeech).toHaveBeenCalledWith(
        { persona: "male", text: "The release is green." },
        expect.any(AbortSignal),
      ),
    );

    rerender(
      <ChatSessionProvider
        value={makeSession({
          sendMessage,
          messages: [
            ...makeSessionWithAssistantMessage().messages,
            {
              id: "msg-2",
              chatId: "chat-1",
              role: "assistant",
              content: "The release is green.",
              timestamp: Date.now(),
              runId: undefined,
              workflowId: undefined,
              workflowStatus: undefined,
              shortResult: undefined,
              taskType: undefined,
            },
            {
              id: "msg-3",
              chatId: "chat-1",
              role: "assistant",
              content: "This later text-only update must stay silent.",
              timestamp: Date.now() + 1,
              runId: undefined,
              workflowId: undefined,
              workflowStatus: undefined,
              shortResult: undefined,
              taskType: undefined,
            },
          ],
          sending: false,
          sendStatus: "completed",
        })}
      >
        <ChatWindow />
      </ChatSessionProvider>,
    );

    expect(api.synthesizeAssistantSpeech).toHaveBeenCalledTimes(1);
    expect(api.synthesizeAssistantSpeech).not.toHaveBeenCalledWith(
      { persona: "male", text: "This later text-only update must stay silent." },
      expect.any(AbortSignal),
    );
  });

  it("speaks only the assistant message identified by the canonical send outcome", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({
      voice: FULL_REALTIME_WITH_PERSONAS,
    });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    const sendMessage = vi.fn().mockResolvedValue({
      status: "completed",
      assistantMessageId: "voice-answer",
    });
    const { rerender } = render(
      <ChatSessionProvider value={makeSession({ sendMessage })}>
        <ChatWindow />
      </ChatSessionProvider>,
    );

    await enterDialogue();
    const options = vi.mocked(useRealtimeVoice).mock.calls.at(-1)?.[0];
    await act(async () => {
      await options?.onCanonicalUserTurn?.({
        turnId: "voice-user-correlated",
        text: "Give me the correlated answer.",
      });
    });
    rerender(
      <ChatSessionProvider
        value={makeSession({
          sendMessage,
          messages: [
            {
              id: "voice-answer",
              chatId: "chat-1",
              role: "assistant",
              content: "This answer belongs to the spoken turn.",
              timestamp: 100,
              runId: undefined,
              workflowId: undefined,
              workflowStatus: undefined,
              shortResult: undefined,
              taskType: undefined,
            },
            {
              id: "unrelated-newer-answer",
              chatId: "chat-1",
              role: "assistant",
              content: "This newer answer belongs to another send.",
              timestamp: 101,
              runId: undefined,
              workflowId: undefined,
              workflowStatus: undefined,
              shortResult: undefined,
              taskType: undefined,
            },
          ],
          sendStatus: "completed",
        })}
      >
        <ChatWindow />
      </ChatSessionProvider>,
    );

    await waitFor(() =>
      expect(api.synthesizeAssistantSpeech).toHaveBeenCalledWith(
        { persona: "male", text: "This answer belongs to the spoken turn." },
        expect.any(AbortSignal),
      ),
    );
    expect(api.synthesizeAssistantSpeech).not.toHaveBeenCalledWith(
      { persona: "male", text: "This newer answer belongs to another send." },
      expect.any(AbortSignal),
    );
  });

  it("does not arm speech for a blocked canonical send or a later unrelated answer", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({
      voice: FULL_REALTIME_WITH_PERSONAS,
    });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    const sendMessage = vi.fn().mockResolvedValue({ status: "not-sent" });
    const initial = makeSessionWithAssistantMessage({ sendMessage });
    const { rerender } = render(
      <ChatSessionProvider value={initial}>
        <ChatWindow />
      </ChatSessionProvider>,
    );

    await enterDialogue();
    const options = vi.mocked(useRealtimeVoice).mock.calls.at(-1)?.[0];
    let handoffAccepted: unknown;
    await act(async () => {
      handoffAccepted = options?.onCanonicalUserTurn?.({
        turnId: "voice-user-blocked",
        text: "This send is blocked.",
      });
      await Promise.resolve();
    });
    expect(handoffAccepted).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith({
      text: "This send is blocked.",
      clientTurnId: "voice-user-blocked",
      reportOutcome: true,
    });

    rerender(
      <ChatSessionProvider
        value={makeSession({
          sendMessage,
          messages: [
            ...initial.messages,
            {
              id: "unrelated-assistant",
              chatId: "chat-1",
              role: "assistant",
              content: "This unrelated answer must stay silent.",
              timestamp: Date.now(),
              runId: undefined,
              workflowId: undefined,
              workflowStatus: undefined,
              shortResult: undefined,
              taskType: undefined,
            },
          ],
        })}
      >
        <ChatWindow />
      </ChatSessionProvider>,
    );

    expect(api.synthesizeAssistantSpeech).not.toHaveBeenCalledWith(
      { persona: "male", text: "This unrelated answer must stay silent." },
      expect.any(AbortSignal),
    );
  });

  it("never speaks a late pre-leave answer after re-entry and speaks the new exact answer", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: FULL_REALTIME_WITH_PERSONAS });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    const first = deferred<SendMessageOutcome>();
    const enqueueCanonicalVoiceTurn = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ status: "completed", assistantMessageId: "answer-b" });
    const session = makeSession({ enqueueCanonicalVoiceTurn });
    const rendered = render(
      <ChatSessionProvider value={session}>
        <ChatWindow />
      </ChatSessionProvider>,
    );
    await enterDialogue();
    const firstOptions = vi.mocked(useRealtimeVoice).mock.calls.at(-1)?.[0];
    act(() => {
      firstOptions?.onCanonicalUserTurn?.({ turnId: "turn-a", text: "Question A" });
    });
    await userEvent.click(screen.getByRole("switch", { name: "Voice dialogue mode" }));
    await userEvent.click(screen.getByRole("switch", { name: "Voice dialogue mode" }));
    const secondOptions = vi.mocked(useRealtimeVoice).mock.calls.at(-1)?.[0];
    await act(async () => {
      secondOptions?.onCanonicalUserTurn?.({ turnId: "turn-b", text: "Question B" });
      await Promise.resolve();
    });
    const answerB = {
      id: "answer-b",
      chatId: "chat-1",
      role: "assistant" as const,
      content: "Answer B",
      timestamp: 200,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    };
    rendered.rerender(
      <ChatSessionProvider value={makeSession({ enqueueCanonicalVoiceTurn, messages: [answerB] })}>
        <ChatWindow />
      </ChatSessionProvider>,
    );
    await waitFor(() =>
      expect(api.synthesizeAssistantSpeech).toHaveBeenCalledWith(
        { persona: "male", text: "Answer B" },
        expect.any(AbortSignal),
      ),
    );

    await act(async () => {
      first.resolve({ status: "completed", assistantMessageId: "answer-a" });
      await first.promise;
    });
    rendered.rerender(
      <ChatSessionProvider
        value={makeSession({
          enqueueCanonicalVoiceTurn,
          messages: [
            answerB,
            { ...answerB, id: "answer-a", content: "Late answer A", timestamp: 201 },
          ],
        })}
      >
        <ChatWindow />
      </ChatSessionProvider>,
    );

    expect(api.synthesizeAssistantSpeech).not.toHaveBeenCalledWith(
      { persona: "male", text: "Late answer A" },
      expect.any(AbortSignal),
    );
    expect(realtimeVoiceMock.stop).toHaveBeenCalledOnce();
  });

  it("leaves once on chat switch and never routes the old chat answer into the new chat", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: FULL_REALTIME_WITH_PERSONAS });
    stubRealtimeBrowser(async () => ({}) as MediaStream);
    const delivery = deferred<SendMessageOutcome>();
    const enqueueCanonicalVoiceTurn = vi.fn().mockReturnValue(delivery.promise);
    const chatA = makeChat();
    const chatB = { ...makeChat(), id: "chat-b", title: "Chat B" };
    const rendered = render(
      <ChatSessionProvider value={makeSession({ activeChat: chatA, enqueueCanonicalVoiceTurn })}>
        <ChatWindow />
      </ChatSessionProvider>,
    );
    await enterDialogue();
    const options = vi.mocked(useRealtimeVoice).mock.calls.at(-1)?.[0];
    act(() => {
      options?.onCanonicalUserTurn?.({ turnId: "turn-chat-a", text: "Question for A" });
    });

    rendered.rerender(
      <ChatSessionProvider
        value={makeSession({ activeChat: chatB, enqueueCanonicalVoiceTurn, messages: [] })}
      >
        <ChatWindow />
      </ChatSessionProvider>,
    );
    await waitFor(() => expect(realtimeVoiceMock.stop).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: "Leave voice dialogue" })).toBeNull();
    await act(async () => {
      delivery.resolve({ status: "completed", assistantMessageId: "answer-a" });
      await delivery.promise;
    });
    rendered.rerender(
      <ChatSessionProvider
        value={makeSession({
          activeChat: chatB,
          enqueueCanonicalVoiceTurn,
          messages: [
            {
              id: "answer-a",
              chatId: "chat-b",
              role: "assistant",
              content: "Must not speak in B",
              timestamp: 300,
              runId: undefined,
              workflowId: undefined,
              workflowStatus: undefined,
              shortResult: undefined,
              taskType: undefined,
            },
          ],
        })}
      >
        <ChatWindow />
      </ChatSessionProvider>,
    );

    expect(api.synthesizeAssistantSpeech).not.toHaveBeenCalledWith(
      { persona: "male", text: "Must not speak in B" },
      expect.any(AbortSignal),
    );
  });

  it("uses the same dialogue switch to leave dialogue mode and run cleanup", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({
      voice: FULL_REALTIME_WITH_PERSONAS,
    });
    stubRealtimeBrowser(async () => ({ getTracks: () => [] }) as unknown as MediaStream);
    renderWindow(makeSession());

    await enterDialogue();

    await userEvent.click(screen.getByRole("switch", { name: "Voice dialogue mode" }));

    expect(realtimeVoiceMock.stop).toHaveBeenCalledOnce();
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
