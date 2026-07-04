// P3 ChatWindow matrix: dictation remains visible under speech-to-text, live dictation is selected
// only for full-realtime + browser WebRTC posture, and the dictation mic remains separate from Voice
// Dialogue's switch/controller.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatWindow } from "./ChatWindow";
import { ChatSessionProvider } from "./context/ChatSessionContext";
import { clearVoiceCapabilityCacheForTests } from "./hooks/useVoiceCapability";
import type { ChatSessionApi } from "./hooks/useChatSession";
import * as api from "@/lib/api";
import type { Chat, ModelCapability, VoiceCapabilityResolution } from "@/lib/types";

const dictationMock = vi.hoisted(() => ({
  options: [] as unknown[],
  start: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
  retry: vi.fn(),
  discard: vi.fn(),
  insert: vi.fn(),
  setTranscript: vi.fn(),
}));

const realtimeVoiceMock = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  retry: vi.fn(),
  interrupt: vi.fn(),
  toggleMute: vi.fn(),
}));

vi.mock("./hooks/useDictation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./hooks/useDictation")>();
  return {
    ...actual,
    useDictation: vi.fn((options: unknown) => {
      dictationMock.options.push(options);
      return {
        phase: "idle",
        mode: "batch",
        transcript: "",
        liveTranscript: "",
        finalizationNote: undefined,
        error: undefined,
        audioLevel: 0,
        heardSpeech: false,
        micReady: false,
        busy: false,
        start: dictationMock.start,
        stop: dictationMock.stop,
        cancel: dictationMock.cancel,
        retry: dictationMock.retry,
        discard: dictationMock.discard,
        insert: dictationMock.insert,
        setTranscript: dictationMock.setTranscript,
      };
    }),
  };
});

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

const FULL_REALTIME: VoiceCapabilityResolution = {
  available: true,
  profile: "full-realtime",
  capabilities: { speechToText: true, speechOutput: true, realtimeVoice: true },
  transport: { websocketControl: true, webrtcMedia: true },
  availableVoicePersonas: ["neutral"],
  providerLocality: "azure-foundry",
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

class StubMediaRecorder {
  static isTypeSupported = (): boolean => true;
  state = "inactive";
  mimeType = "audio/webm";
  addEventListener(): void {}
  start(): void {}
  stop(): void {}
}

class StubRTCPeerConnection {}

function stubCaptureBrowser(): void {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [] }) as unknown as MediaStream) },
  });
  vi.stubGlobal("MediaRecorder", StubMediaRecorder);
}

function stubRealtimeBrowser(): void {
  stubCaptureBrowser();
  vi.stubGlobal("RTCPeerConnection", StubRTCPeerConnection);
}

function renderWindow(session: ChatSessionApi = makeSession()): void {
  render(
    <ChatSessionProvider value={session}>
      <ChatWindow />
    </ChatSessionProvider>,
  );
}

function latestDictationOptions(): { readonly realtime?: { readonly enabled: boolean } } {
  const latest = dictationMock.options.at(-1);
  expect(latest).toBeDefined();
  return latest as { readonly realtime?: { readonly enabled: boolean } };
}

beforeEach(() => {
  clearVoiceCapabilityCacheForTests();
  vi.mocked(api.fetchVoiceCapability).mockReset();
  dictationMock.options.length = 0;
  dictationMock.start.mockReset();
  dictationMock.stop.mockReset();
  dictationMock.cancel.mockReset();
  dictationMock.retry.mockReset();
  dictationMock.discard.mockReset();
  dictationMock.insert.mockReset();
  dictationMock.setTranscript.mockReset();
  realtimeVoiceMock.start.mockReset();
  realtimeVoiceMock.stop.mockReset();
  realtimeVoiceMock.retry.mockReset();
  realtimeVoiceMock.interrupt.mockReset();
  realtimeVoiceMock.toggleMute.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, "mediaDevices");
});

describe("ChatWindow live dictation mode selection", () => {
  it("keeps STT-only dictation on the batch path", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: STT });
    stubCaptureBrowser();
    renderWindow();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Dictate a message" })).toBeInTheDocument(),
    );
    expect(latestDictationOptions().realtime?.enabled).toBe(false);
    expect(screen.queryByRole("switch", { name: "Voice dialogue mode" })).toBeNull();
  });

  it("enables live dictation for full-realtime deployments with browser realtime media APIs", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: FULL_REALTIME });
    stubRealtimeBrowser();
    renderWindow();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Dictate a message" })).toBeInTheDocument(),
    );
    expect(latestDictationOptions().realtime?.enabled).toBe(true);
    expect(screen.getByRole("switch", { name: "Voice dialogue mode" })).toBeInTheDocument();
  });

  it("falls back to batch dictation when full-realtime is advertised but WebRTC APIs are absent", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: FULL_REALTIME });
    stubCaptureBrowser();
    renderWindow();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Dictate a message" })).toBeInTheDocument(),
    );
    expect(latestDictationOptions().realtime?.enabled).toBe(false);
    expect(screen.queryByRole("switch", { name: "Voice dialogue mode" })).toBeNull();
  });

  it("keeps dictation and Voice Dialogue controls separate", async () => {
    vi.mocked(api.fetchVoiceCapability).mockResolvedValue({ voice: FULL_REALTIME });
    stubRealtimeBrowser();
    renderWindow();

    const mic = await screen.findByRole("button", { name: "Dictate a message" });
    await userEvent.click(mic);
    expect(dictationMock.start).toHaveBeenCalledTimes(1);
    expect(realtimeVoiceMock.start).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("switch", { name: "Voice dialogue mode" }));
    expect(realtimeVoiceMock.start).toHaveBeenCalledTimes(1);
    expect(dictationMock.start).toHaveBeenCalledTimes(1);
  });
});
