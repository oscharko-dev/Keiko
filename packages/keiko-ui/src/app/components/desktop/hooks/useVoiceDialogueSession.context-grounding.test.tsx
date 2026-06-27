// Issue #1561, Epic #1556 — integration proof that a committed SPOKEN turn is grounded in the SAME
// context as a typed turn. It drives the REAL `useVoiceDialogueSession` wired to the REAL
// `useChatSession`; only the network (`@/lib/api`) and the media surfaces (recorder / transcribe /
// audio) are faked. This is the deliverable the issue asks for — "integration tests for spoken turns
// with file attachments and local knowledge", "evidence assertions proving voice-origin metadata is
// safe and raw audio is absent", and "regression coverage that typed and spoken versions of the same
// question use equivalent context".
//
// The spoken turn reuses the existing chat pipeline end to end: the committed transcript is handed to
// `sendMessage({ text })`, which assembles documentContext (attachments), the grounding route
// (repository / local-knowledge scope), and the memory request exactly as a typed send would. No
// voice-specific field is added to the chat wire, so a spoken turn is byte-identical to a typed one —
// which is the strongest possible "context equivalence" guarantee and keeps raw audio out of the send.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Chat,
  ModelCapability,
  ProjectWithAvailability,
  VoiceCapabilityResolution,
} from "@/lib/types";
import {
  askGrounded,
  fetchChatMessages,
  fetchChats,
  fetchModels,
  fetchProjects,
  sendDesktopChat,
} from "@/lib/api";
import { acceptMemoryProposal } from "@/lib/memory-api";
import { useChatSession } from "./useChatSession";
import { useVoiceDialogueSession, type DialogueChatSession } from "./useVoiceDialogueSession";
import type { DictationRecorder, DictationSession } from "./dictation-recorder";
import type { AssistantSpeechAudioElement } from "./useAssistantSpeech";

// `@/lib/api` is replaced wholesale; the dialogue injects its own transcribe/synthesize seams, but the
// named imports must still exist so module load does not throw. `transcribeDictation` /
// `synthesizeAssistantSpeech` are referenced by useDictation / useAssistantSpeech at import time.
vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly status: number,
    ) {
      super(message);
    }
  },
  askGrounded: vi.fn(),
  createDesktopChat: vi.fn(),
  createProject: vi.fn(),
  fetchChatMessages: vi.fn(),
  fetchChats: vi.fn(),
  fetchModels: vi.fn(),
  fetchProjects: vi.fn(),
  sendDesktopChat: vi.fn(),
  sendDesktopChatStream: vi.fn(),
  transcribeDictation: vi.fn(),
  synthesizeAssistantSpeech: vi.fn(),
  updateChat: vi.fn(),
}));

vi.mock("@/lib/memory-api", () => ({
  acceptMemoryProposal: vi.fn(),
  forgetMemory: vi.fn(),
  rejectMemoryProposal: vi.fn(),
}));

// ─── Capability + media fixtures ──────────────────────────────────────────────────
const PERSONAS = ["male", "female", "neutral"] as const;

// The only resolution for which dialogue is offered (ADR-0096 D2): STT + speech output + personas.
const FULL_REALTIME: VoiceCapabilityResolution = {
  available: true,
  profile: "full-realtime",
  capabilities: { speechToText: true, speechOutput: true, realtimeVoice: true },
  transport: { websocketControl: true, webrtcMedia: false },
  availableVoicePersonas: PERSONAS,
};

class FakeAudio implements AssistantSpeechAudioElement {
  src = "";
  muted = false;
  onplaying: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play(): Promise<void> {
    return Promise.resolve();
  }
  pause(): void {}
}

// A fake recorder whose clip carries an obvious audio payload, so a test can prove that payload never
// reaches the chat send (raw-audio absence). `audioBase64: "RAWAUDIO"` is the canary.
function makeRecorder(): DictationRecorder {
  const session: DictationSession = {
    stop: vi.fn(async () => ({
      audioBase64: "RAWAUDIO",
      mimeType: "audio/webm",
      durationMs: 700,
    })),
    cancel: vi.fn(),
  };
  return { start: vi.fn(async () => session) };
}

function model(patch: Partial<ModelCapability> = {}): ModelCapability {
  return {
    id: "chat-doc",
    kind: "chat",
    contextWindow: 16_000,
    maxOutputTokens: 2_000,
    toolCalling: false,
    structuredOutput: false,
    // Non-streaming so the ungrounded path uses the buffered sendDesktopChat (simpler to assert than SSE).
    streaming: false,
    supportsImageInput: false,
    supportsDocumentInput: true,
    workflowEligible: false,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "test",
    preferredUseCases: [],
    knownLimitations: [],
    ...patch,
  };
}

function project(path = "/repo"): ProjectWithAvailability {
  return {
    path,
    name: "repo",
    favorite: false,
    createdAt: 1,
    lastOpenedAt: 2,
    available: true,
  };
}

function chat(patch: Partial<Chat> = {}): Chat {
  return {
    id: "chat-1",
    projectPath: "/repo",
    title: "Release chat",
    selectedModel: "chat-doc",
    createdAt: 1,
    updatedAt: 1,
    connectedScopes: [],
    localKnowledgeScopes: [],
    ...patch,
  } as Chat;
}

// ─── Integration hook: REAL chat session + REAL dialogue session ──────────────────
interface IntegrationProps {
  readonly transcript: string;
  readonly recorder: DictationRecorder;
  readonly onLeave: () => void;
  readonly synthesize: (
    text: string,
    signal: AbortSignal,
  ) => Promise<{ audio: string; mimeType: string }>;
  readonly createAudio: () => AssistantSpeechAudioElement;
  readonly answerText?: string | undefined;
  readonly answerId?: string | undefined;
}

function useIntegration(props: IntegrationProps): {
  session: ReturnType<typeof useChatSession>;
  dialogue: ReturnType<typeof useVoiceDialogueSession>;
} {
  const session = useChatSession({ autoCreate: false });
  const dialogue = useVoiceDialogueSession({
    capability: FULL_REALTIME,
    active: true,
    persona: "neutral",
    // The full chat API is a structural superset of the dialogue seam.
    session: session as DialogueChatSession,
    answerText: props.answerText,
    answerId: props.answerId,
    onLeave: props.onLeave,
    createRecorder: () => props.recorder,
    transcribe: vi.fn(async () => ({ transcript: props.transcript })),
    synthesize: props.synthesize,
    createAudio: props.createAudio,
    createObjectUrl: () => "blob:dialogue",
    revokeObjectUrl: () => undefined,
  });
  return { session, dialogue };
}

function bootstrapMocks(activeChat: Chat): void {
  vi.mocked(fetchModels).mockResolvedValue({ models: [model()] });
  vi.mocked(fetchProjects).mockResolvedValue({ projects: [project()] });
  vi.mocked(fetchChats).mockResolvedValue({ chats: [activeChat] });
  vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [] });
}

function stableProps(
  transcript: string,
  overrides: Partial<IntegrationProps> = {},
): IntegrationProps {
  return {
    transcript,
    recorder: makeRecorder(),
    onLeave: vi.fn(),
    synthesize: vi.fn(async () => ({ audio: btoa("AUDIO"), mimeType: "audio/mpeg" })),
    createAudio: () => new FakeAudio(),
    ...overrides,
  };
}

type Rendered = ReturnType<typeof renderHook<ReturnType<typeof useIntegration>, IntegrationProps>>;

async function renderIntegration(props: IntegrationProps): Promise<Rendered> {
  const rendered = renderHook((p: IntegrationProps) => useIntegration(p), { initialProps: props });
  await waitFor(() => expect(rendered.result.current.session.loading).toBe(false));
  return rendered;
}

// Drives one full spoken turn: activate mic (start → recording), activate again (stop → transcribe →
// preview → user-end-of-turn → committed transcript handed to the chat send).
async function speakOneTurn(rendered: Rendered): Promise<void> {
  await act(async () => {
    rendered.result.current.dialogue.onListen();
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    rendered.result.current.dialogue.onListen();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.stubGlobal(
    "Blob",
    class {
      constructor(
        public readonly parts: unknown[],
        public readonly options?: { type?: string },
      ) {}
    },
  );
  // dictationCaptureSupported() gates the matrix on a capture-capable browser; jsdom lacks both.
  vi.stubGlobal("MediaRecorder", class {});
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn() },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("voice dialogue context grounding (Issue #1561)", () => {
  it("AC1 — a spoken question about an attached file is sent with the file's documentContext", async () => {
    bootstrapMocks(chat());
    vi.mocked(sendDesktopChat).mockResolvedValue({
      chat: chat(),
      messages: [],
      memory: undefined,
    } as never);

    const rendered = await renderIntegration(stableProps("what does the deploy log say?"));

    // Attach a text document the model can read.
    await act(async () => {
      const outcome = await rendered.result.current.session.addPendingAttachment(
        new File(["deploy step 7 failed: timeout"], "deploy.log.txt", { type: "text/plain" }),
      );
      expect(outcome).toEqual({ ok: true });
    });

    await speakOneTurn(rendered);

    await waitFor(() => expect(sendDesktopChat).toHaveBeenCalledTimes(1));
    const body = vi.mocked(sendDesktopChat).mock.calls[0]?.[0];
    expect(body?.content).toBe("what does the deploy log say?");
    expect(body?.documentContext).toBeDefined();
    expect(body?.documentContext?.[0]?.displayName).toBe("deploy.log.txt");
    expect(body?.documentContext?.[0]?.text).toContain("deploy step 7 failed");
  });

  it("AC2 — a spoken repository question routes through the same grounded path as text chat", async () => {
    const groundedChat = chat({
      connectedScopes: [{ kind: "files", relativePaths: ["README.md"], connectedAtMs: 1 }],
    } as Partial<Chat>);
    bootstrapMocks(groundedChat);
    vi.mocked(askGrounded).mockResolvedValue({
      groundingKind: "connected-context",
      answer: "The repo builds with npm.",
      contextPack: { usage: { excerptBytes: 0 } },
    } as never);

    const rendered = await renderIntegration(stableProps("how does this repository build?"));
    await speakOneTurn(rendered);

    await waitFor(() => expect(askGrounded).toHaveBeenCalledTimes(1));
    expect(askGrounded).toHaveBeenCalledWith(
      { chatId: "chat-1", content: "how does this repository build?", modelId: "chat-doc" },
      expect.anything(),
    );
    // The non-grounded buffered path must NOT be used for a grounded chat.
    expect(sendDesktopChat).not.toHaveBeenCalled();
  });

  it("AC2 — a spoken local-knowledge question routes through the same grounded path", async () => {
    const lkChat = chat({
      localKnowledgeScopes: [{ kind: "capsule", capsuleId: "kb-1" as never, connectedAtMs: 1 }],
    });
    bootstrapMocks(lkChat);
    vi.mocked(askGrounded).mockResolvedValue({
      groundingKind: "local-knowledge",
      answer: "Onboarding lives in the handbook.",
      contextPack: { referenceBudget: 0 },
    } as never);

    const rendered = await renderIntegration(stableProps("where is onboarding documented?"));
    await speakOneTurn(rendered);

    await waitFor(() => expect(askGrounded).toHaveBeenCalledTimes(1));
    expect(askGrounded).toHaveBeenCalledWith(
      { chatId: "chat-1", content: "where is onboarding documented?", modelId: "chat-doc" },
      expect.anything(),
    );
  });

  it("regression — the spoken turn reaches chat even with an empty composer draft", async () => {
    // The previous seam (setDraft(text) + sendMessage()) dropped the turn here: sendMessage read the
    // stale empty draft from its closure and early-returned. Handing the text directly fixes it.
    bootstrapMocks(chat());
    vi.mocked(sendDesktopChat).mockResolvedValue({
      chat: chat(),
      messages: [],
      memory: undefined,
    } as never);

    const rendered = await renderIntegration(stableProps("summarise the open incidents"));
    expect(rendered.result.current.session.draft).toBe("");

    await speakOneTurn(rendered);

    await waitFor(() => expect(sendDesktopChat).toHaveBeenCalledTimes(1));
    expect(vi.mocked(sendDesktopChat).mock.calls[0]?.[0]?.content).toBe(
      "summarise the open incidents",
    );
  });

  it("evidence — the spoken send body carries only the committed text, never raw audio", async () => {
    bootstrapMocks(chat());
    vi.mocked(sendDesktopChat).mockResolvedValue({
      chat: chat(),
      messages: [],
      memory: undefined,
    } as never);

    const rendered = await renderIntegration(stableProps("read me the failing test"));
    await act(async () => {
      await rendered.result.current.session.addPendingAttachment(
        new File(["expect(x).toBe(1)"], "spec.txt", { type: "text/plain" }),
      );
    });
    await speakOneTurn(rendered);

    await waitFor(() => expect(sendDesktopChat).toHaveBeenCalledTimes(1));
    const body = vi.mocked(sendDesktopChat).mock.calls[0]?.[0];
    // The recorder clip's canary payload must NOT appear anywhere in the wire request.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("RAWAUDIO");
    expect(serialized).not.toContain("audio/webm");
    expect(serialized).not.toContain("audioBase64");
    // The only content-bearing fields are the committed text and the attached document text.
    expect(Object.keys(body ?? {}).sort()).toEqual(
      ["chatId", "content", "documentContext", "memory", "modelId", "projectPath"].sort(),
    );
  });

  it("regression — typed and spoken versions of the same question produce an equivalent request body", async () => {
    const question = "which files changed in the last release?";

    // Spoken send.
    bootstrapMocks(chat());
    vi.mocked(sendDesktopChat).mockResolvedValue({
      chat: chat(),
      messages: [],
      memory: undefined,
    } as never);
    const spoken = await renderIntegration(stableProps(question));
    await act(async () => {
      await spoken.result.current.session.addPendingAttachment(
        new File(["v1.2.0: editor, voice"], "CHANGELOG.txt", { type: "text/plain" }),
      );
    });
    await speakOneTurn(spoken);
    await waitFor(() => expect(sendDesktopChat).toHaveBeenCalledTimes(1));
    const spokenBody = vi.mocked(sendDesktopChat).mock.calls[0]?.[0];

    vi.clearAllMocks();

    // Typed send of the identical question + identical attachment.
    bootstrapMocks(chat());
    vi.mocked(sendDesktopChat).mockResolvedValue({
      chat: chat(),
      messages: [],
      memory: undefined,
    } as never);
    const typed = await renderIntegration(stableProps("unused-typed-path"));
    await act(async () => {
      await typed.result.current.session.addPendingAttachment(
        new File(["v1.2.0: editor, voice"], "CHANGELOG.txt", { type: "text/plain" }),
      );
    });
    await act(async () => {
      typed.result.current.session.setDraft(question);
    });
    await act(async () => {
      await typed.result.current.session.sendMessage();
    });
    await waitFor(() => expect(sendDesktopChat).toHaveBeenCalledTimes(1));
    const typedBody = vi.mocked(sendDesktopChat).mock.calls[0]?.[0];

    // documentContext entry ids are random UUIDs; normalise them out before comparing.
    const normalise = (b: typeof spokenBody): unknown => ({
      ...b,
      documentContext: b?.documentContext?.map((e) => ({ ...e, id: "<id>" })),
    });
    expect(normalise(spokenBody)).toEqual(normalise(typedBody));
  });

  it("AC3 — the assistant audio is synthesized from the exact settled answer text", async () => {
    bootstrapMocks(chat());
    const synthesize = vi.fn(async () => ({ audio: btoa("AUDIO"), mimeType: "audio/mpeg" }));
    const rendered = await renderIntegration(
      stableProps("anything", {
        synthesize,
        answerText: "The deploy failed at step 7 due to a timeout.",
        answerId: "assistant-7",
      }),
    );

    await waitFor(() => expect(synthesize).toHaveBeenCalledTimes(1));
    // The spoken answer is exactly the visible assistant message text — no voice-only rephrasing.
    expect(synthesize).toHaveBeenCalledWith(
      "The deploy failed at step 7 due to a timeout.",
      expect.anything(),
    );
  });

  it("AC4 — a spoken question never auto-accepts a memory candidate", async () => {
    bootstrapMocks(chat());
    vi.mocked(sendDesktopChat).mockResolvedValue({
      chat: chat(),
      messages: [],
      // The server may return a memory candidate; it must flow to the review queue, never auto-accept.
      memory: {
        context: { enabled: false, text: "" },
        proposals: [{ id: "mem-1", text: "uses npm" }],
      },
    } as never);

    const rendered = await renderIntegration(stableProps("remember I use npm"));
    await speakOneTurn(rendered);

    await waitFor(() => expect(sendDesktopChat).toHaveBeenCalledTimes(1));
    // Governance: the spoken path commits no memory on its own.
    expect(acceptMemoryProposal).not.toHaveBeenCalled();
  });
});
