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
  providerLocality: "azure-foundry",
};

const NONE: VoiceCapabilityResolution = {
  available: false,
  profile: "none",
  capabilities: { speechToText: false, speechOutput: false, realtimeVoice: false },
  transport: { websocketControl: false, webrtcMedia: false },
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
