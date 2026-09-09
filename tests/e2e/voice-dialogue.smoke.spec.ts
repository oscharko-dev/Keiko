// Voice Dialogue browser smoke. Drives the REAL app composer in headless Chromium through the documented
// Studio path (Left Rail → Chat History → New). It proves the colleague-like dialogue surface renders
// and starts the Realtime WebRTC transport from the single Voice Dialogue switch:
//   1. No-voice deployment: /api/voice/capability reports unavailable → NO dialogue switch and the
//      composer stays fully text-capable (AC4).
//   2. Full-realtime WITH browser WebRTC media: fake getUserMedia + RTCPeerConnection + WebSocket are
//      injected (no hardware, no provider; privacy contract preserved). The dialogue switch starts the
//      Realtime session directly; the committed user transcript enters the canonical desktop-chat
//      route, so persistence, retrieval, memory, and the visible assistant answer match typed chat.
//   3. Full-realtime WITHOUT browser WebRTC media: no fluid dialogue switch is offered. Dictation and
//      read-aloud remain separate helper surfaces.
//
// Scope note: the provider itself is faked at the WebRTC/control boundary. The executable unit and
// integration suites cover parser, turn-manager, and BFF persistence behavior; this smoke proves the
// user-facing surface is a single Realtime dialogue mode and the composer stays text-capable.

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chat, ChatMessage, GroundedAnswer } from "@oscharko-dev/keiko-contracts/bff-wire";
import { evidenceScreenshotPath } from "./support/evidence.js";

const MEMORY_CAPTURE_TRANSCRIPT =
  "KEIKO_E2E_JOURNAL_CAPTURE: remember the deterministic release window.";
const GROUNDING_PARITY_TRANSCRIPT = "Where is repositoryParityStatus defined?";
const GROUNDING_PARITY_CLAIM = "repositoryParityStatus is defined in the repository fixture";
const GROUNDING_PARITY_ANSWER = `${GROUNDING_PARITY_CLAIM} [src/repository-parity.ts:2].`;
const CHAT_MODEL_ID = "e2e-chat-model";
const PROVIDER_CANONICAL_TURN_ID_PATTERN = /^client-turn-[0-9a-f]{32}-[0-9a-f]{64}$/u;
const MUTATION_HEADERS = { "X-Keiko-CSRF": "1" };
const tempProjects: string[] = [];

async function verifyChatModel(request: APIRequestContext): Promise<void> {
  const response = await request.post("/api/gateway/readiness", {
    headers: MUTATION_HEADERS,
    data: { modelId: CHAT_MODEL_ID, options: { probes: ["chat"] } },
  });
  expect(response.ok(), await response.text().catch(() => "")).toBe(true);
}

declare global {
  interface Window {
    readonly __micStats?: Readonly<Record<string, number>>;
    readonly __providerNativeOutputEvents?: number;
    readonly __canonicalTtsPlays?: number;
    readonly __releaseCanonicalTts?: () => void;
  }
}

const FULL_REALTIME_WEBRTC_CAPABILITY = {
  voice: {
    available: true,
    profile: "full-realtime",
    capabilities: { speechToText: true, speechOutput: true, realtimeVoice: true },
    transport: { websocketControl: true, webrtcMedia: true },
    availableVoicePersonas: ["male", "female", "neutral"],
    providerLocality: "azure-foundry",
  },
};

const FULL_REALTIME_NO_WEBRTC_CAPABILITY = {
  voice: {
    available: true,
    profile: "full-realtime",
    capabilities: { speechToText: true, speechOutput: true, realtimeVoice: true },
    transport: { websocketControl: true, webrtcMedia: false },
    availableVoicePersonas: ["male", "female", "neutral"],
    providerLocality: "azure-foundry",
  },
};

const REALTIME_WITHOUT_TTS_CAPABILITY = {
  voice: {
    available: true,
    profile: "full-realtime",
    capabilities: { speechToText: true, speechOutput: false, realtimeVoice: true },
    transport: { websocketControl: true, webrtcMedia: true },
    availableVoicePersonas: ["neutral"],
    providerLocality: "azure-foundry",
  },
};

const NO_VOICE_CAPABILITY = {
  voice: {
    available: false,
    profile: "none",
    capabilities: { speechToText: false, speechOutput: false, realtimeVoice: false },
    transport: { websocketControl: false, webrtcMedia: false },
    reason: "no-voice-provider",
  },
};

// Issue #1563 — the two partial deployments that must NOT offer spoken dialogue (no full STT+TTS
// conjunction): speech-to-text only (dictation, no spoken answer) and speech-output only (spoken
// answer, no capture). Both carry personas, so the gate's persona check is not what hides the switch —
// the missing capability is. These exercise the evaluation's AC1 "all configured profiles" coverage at
// the real browser layer (the keiko-ui suites prove the gate itself).
const STT_ONLY_CAPABILITY = {
  voice: {
    available: true,
    profile: "speech-to-text",
    capabilities: { speechToText: true, speechOutput: false, realtimeVoice: false },
    transport: { websocketControl: true, webrtcMedia: false },
    availableVoicePersonas: ["male", "female", "neutral"],
    providerLocality: "azure-foundry",
  },
};

const SPEECH_OUTPUT_ONLY_CAPABILITY = {
  voice: {
    available: true,
    profile: "speech-output",
    capabilities: { speechToText: false, speechOutput: true, realtimeVoice: false },
    transport: { websocketControl: true, webrtcMedia: false },
    availableVoicePersonas: ["male", "female", "neutral"],
    providerLocality: "azure-foundry",
  },
};

const REALTIME_BROWSER_FAKE_SCRIPT = `
  const options = window.__keikoVoiceFakeOptions || {};
  const emitTranscript = options.emitTranscript === true;
  const instrumentMic = options.instrumentMic === true;
  const transcript = typeof options.transcript === "string"
    ? options.transcript
    : "what is the deploy status";
  window.__providerNativeOutputEvents = 0;
  window.__canonicalTtsPlays = 0;
  window.__releaseCanonicalTts = undefined;
  Object.defineProperty(window, "AudioWorkletNode", { configurable: true, value: undefined });
  window.Audio = class {
    constructor() {
      this.src = "";
      this.muted = false;
      this.onplaying = null;
      this.onended = null;
      this.onerror = null;
    }
    play() {
      window.__canonicalTtsPlays++;
      if (this.onplaying) this.onplaying();
      const finish = () => { if (this.onended) this.onended(); };
      if (options.holdSpeech === true) {
        window.__releaseCanonicalTts = finish;
      } else {
        setTimeout(finish, 0);
      }
      return Promise.resolve();
    }
    pause() {}
  };
  const OFFER = "v=0\\r\\no=- 1 1 IN IP4 127.0.0.1\\r\\ns=-\\r\\nt=0 0\\r\\nm=audio 9 UDP/TLS/RTP/SAVPF 111\\r\\na=sendonly\\r\\n";
  const ANSWER = "v=0\\r\\no=- 2 2 IN IP4 0.0.0.0\\r\\ns=-\\r\\nt=0 0\\r\\nm=audio 9 UDP/TLS/RTP/SAVPF 111\\r\\na=recvonly\\r\\n";
  if (instrumentMic) window.__micStats = { getUserMedia: 0, stopped: 0 };
  const fakeTrack = {
    stop() {
      if (instrumentMic) window.__micStats.stopped++;
    },
  };
  const fakeStream = { getTracks: () => [fakeTrack] };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => {
        if (instrumentMic) window.__micStats.getUserMedia++;
        return fakeStream;
      },
    },
  });
  class FakeDataChannel {
    constructor() {
      this.readyState = "open";
      this._l = {};
      this.sent = [];
    }
    addEventListener(type, cb) { (this._l[type] ||= []).push(cb); }
    emit(obj) {
      for (const cb of this._l["message"] || []) cb({ data: JSON.stringify(obj) });
    }
    send(data) {
      this.sent.push(data);
      let msg; try { msg = JSON.parse(data); } catch { return; }
      if (msg.type === "session.update") {
        this.emit({ type: "session.updated", session: msg.session || {} });
      }
    }
    close() {
      this.readyState = "closed";
      for (const cb of this._l["close"] || []) cb({});
    }
  }
  function emitRealtimeTranscript(channel) {
    channel.emit({ type: "input_audio_buffer.speech_started", item_id: "user-item" });
    channel.emit({ type: "input_audio_buffer.speech_stopped", item_id: "user-item" });
    const finalTranscript = {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "user-item",
      transcript,
    };
    channel.emit(finalTranscript);
    // Providers may replay a final event during settlement or reconnect. The canonical FIFO must
    // admit this provider item exactly once even when the media boundary delivers it twice.
    channel.emit(finalTranscript);
    window.__providerNativeOutputEvents++;
    channel.emit({ type: "response.output_audio.delta", response_id: "resp-1", delta: "stub" });
    window.__providerNativeOutputEvents++;
    channel.emit({
      type: "response.output_audio_transcript.done",
      response_id: "resp-1",
      transcript: "The deploy is green.",
    });
    window.__providerNativeOutputEvents++;
    channel.emit({ type: "response.done", response: { id: "resp-1", status: "completed" } });
  }
  class FakeRTCPeerConnection {
    constructor() {
      this.iceGatheringState = "complete";
      this.localDescription = null;
      this.connectionState = "new";
      this.ontrack = null;
      this.onconnectionstatechange = null;
      this._channel = null;
    }
    addEventListener() {}
    removeEventListener() {}
    addTransceiver(_track, options) {
      if (options?.direction !== "sendonly") throw new Error("expected send-only audio");
      return { direction: "sendonly" };
    }
    createDataChannel() {
      this._channel = new FakeDataChannel();
      return this._channel;
    }
    async createOffer() { return { type: "offer", sdp: OFFER }; }
    async setLocalDescription(desc) { this.localDescription = { type: desc.type, sdp: desc.sdp }; }
    async setRemoteDescription() {
      setTimeout(() => {
        this.connectionState = "connected";
        if (this.onconnectionstatechange) this.onconnectionstatechange({});
        if (emitTranscript && this._channel) {
          setTimeout(() => emitRealtimeTranscript(this._channel), 0);
        }
      }, 0);
    }
    close() {}
  }
  window.RTCPeerConnection = FakeRTCPeerConnection;
  const RealWebSocket = window.WebSocket;
  class FakeWebSocket {
    constructor(url, protocols) {
      if (!String(url).includes("/api/voice/control")) {
        return new RealWebSocket(url, protocols);
      }
      this.url = url; this.readyState = 0; this._l = {};
      setTimeout(() => { this.readyState = 1; this._emit("open", {}); }, 0);
    }
    addEventListener(type, cb) { (this._l[type] ||= []).push(cb); }
    removeEventListener() {}
    _emit(type, ev) { for (const cb of this._l[type] || []) cb(ev); }
    send(data) {
      let msg; try { msg = JSON.parse(data); } catch { return; }
      const reply = (obj) => this._emit("message", { data: JSON.stringify(obj) });
      const base = (seq, kind) => ({ protocolVersion: "1", sessionId: msg.sessionId, seq, direction: "host-to-client", kind });
      if (msg.kind === "session.create") {
        reply({ ...base(0, "session.created"), profile: "full-realtime", controlTransport: "loopback-websocket", mediaTransport: "webrtc", negotiationMode: "proxied-sdp" });
        reply({ ...base(1, "capability.offer"), profile: "full-realtime", capabilities: { speechToText: true, speechOutput: true, realtimeVoice: true } });
      } else if (msg.kind === "signal.sdp.offer") {
        reply({ ...base(2, "media.track.state"), track: "audio-in", state: "negotiating" });
        reply({ ...base(3, "signal.sdp.answer"), sdp: ANSWER });
      }
    }
    close() { this.readyState = 3; this._emit("close", {}); }
  }
  window.WebSocket = FakeWebSocket;
`;

function fakeRealtimeInit({
  emitTranscript = false,
  holdSpeech = false,
  instrumentMic = false,
  transcript,
}: {
  readonly emitTranscript?: boolean;
  readonly holdSpeech?: boolean;
  readonly instrumentMic?: boolean;
  readonly transcript?: string;
} = {}): string {
  return `
    (() => {
      window.__keikoVoiceFakeOptions = {
        emitTranscript: ${JSON.stringify(emitTranscript)},
        holdSpeech: ${JSON.stringify(holdSpeech)},
        instrumentMic: ${JSON.stringify(instrumentMic)},
        transcript: ${JSON.stringify(transcript)},
      };
      ${REALTIME_BROWSER_FAKE_SCRIPT}
    })();
  `;
}

async function openComposer(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Chat History", exact: true }).click();
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Chat message" }).first()).toBeVisible();
}

async function stubCapability(page: Page, body: unknown): Promise<void> {
  await page.route("**/api/voice/capability", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(body) }),
  );
}

type GroundingParityChat = Pick<Chat, "id" | "projectPath" | "title">;

interface ChatResponse {
  readonly chat: Chat;
}

function createGroundingParityFixture(): string {
  const projectPath = mkdtempSync(join(tmpdir(), "keiko-e2e-grounding-parity-"));
  tempProjects.push(projectPath);
  mkdirSync(join(projectPath, "src"), { recursive: true });
  writeFileSync(
    join(projectPath, "src", "repository-parity.ts"),
    [
      "// Deterministic Composer/Voice grounding parity fixture.",
      'export const repositoryParityStatus = "KEIKO_E2E_GROUNDING_PARITY";',
      "",
    ].join("\n"),
    "utf8",
  );
  return projectPath;
}

async function ensureGroundingParityProject(
  request: APIRequestContext,
  projectPath: string,
): Promise<void> {
  const response = await request.post("/api/projects", {
    headers: MUTATION_HEADERS,
    data: { path: projectPath, name: "Grounding parity E2E" },
  });
  if (!response.ok()) {
    throw new Error(`Grounding parity project setup failed (${String(response.status())})`);
  }
}

async function createGroundingParityChat(
  request: APIRequestContext,
  projectPath: string,
  title: string,
): Promise<GroundingParityChat> {
  const create = await request.post("/api/chats", {
    headers: MUTATION_HEADERS,
    data: { projectPath, title, selectedModel: CHAT_MODEL_ID },
  });
  expect(create.status()).toBe(201);
  const created = (await create.json()) as ChatResponse;
  const connect = await request.patch(`/api/chats?id=${encodeURIComponent(created.chat.id)}`, {
    headers: MUTATION_HEADERS,
    data: {
      connectedScopes: [{ kind: "workspace-root", relativePaths: [], connectedAtMs: 1 }],
    },
  });
  if (!connect.ok()) {
    throw new Error(`Grounding parity scope setup failed (${String(connect.status())})`);
  }
  const connected = (await connect.json()) as ChatResponse;
  expect(connected.chat.connectedScopes).toHaveLength(1);
  expect(connected.chat.connectedScopes?.[0]).toMatchObject({
    kind: "workspace-root",
    relativePaths: [],
  });
  return connected.chat;
}

async function seedGroundingParityChat(page: Page, chat: GroundingParityChat): Promise<void> {
  await page.addInitScript(
    ({ chatId, title }) => {
      window.localStorage.setItem(
        "keiko.workspace.v4",
        JSON.stringify([
          {
            id: "e2e-grounding-parity-chat-window",
            type: "chat",
            x: 64,
            y: 32,
            w: 920,
            h: 560,
            z: 10,
            cfg: { chatId, title },
            max: false,
          },
        ]),
      );
      window.localStorage.removeItem("keiko.conns.v1");
    },
    { chatId: chat.id, title: chat.title },
  );
}

test.afterEach(() => {
  for (const projectPath of tempProjects.splice(0)) {
    rmSync(projectPath, { recursive: true, force: true });
  }
});

async function expectActiveComposerSettled(page: Page): Promise<void> {
  const composer = page.locator(".cmp-box");
  const normalLayer = composer.locator('[data-composer-layer="normal"]');
  const voiceLayer = composer.locator('[data-composer-layer="voice"]');
  await expect(normalLayer).toHaveCSS("opacity", "0");
  await expect(voiceLayer).toHaveCSS("opacity", "1");
  await expect(normalLayer).toHaveAttribute("aria-hidden", "true");
  await expect(normalLayer).toHaveAttribute("inert", "");

  const centreOffset = await composer.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const cluster = element.querySelector(".cmp-bar-main-voice-dialog")?.getBoundingClientRect();
    if (cluster === undefined) return undefined;
    return {
      x: cluster.x + cluster.width / 2 - (box.x + box.width / 2),
      y: cluster.y + cluster.height / 2 - (box.y + box.height / 2),
    };
  });
  expect(centreOffset).toBeDefined();
  expect(Math.abs(centreOffset?.x ?? Number.POSITIVE_INFINITY)).toBeLessThan(1);
  expect(Math.abs(centreOffset?.y ?? Number.POSITIVE_INFINITY)).toBeLessThan(1);
}

interface VoiceChatSendCapture {
  readonly canonicalContents: () => readonly string[];
  readonly canonicalPaths: () => readonly string[];
  readonly canonicalPayloads: () => readonly Record<string, unknown>[];
  readonly legacyPaths: () => readonly string[];
}

function captureVoiceChatSends(page: Page): VoiceChatSendCapture {
  const contents: string[] = [];
  const paths: string[] = [];
  const payloads: Record<string, unknown>[] = [];
  const legacyPaths: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/desktop/chat/voice-turn") {
      legacyPaths.push(pathname);
      return;
    }
    if (pathname !== "/api/desktop/chat" && pathname !== "/api/desktop/chat/stream") return;
    const payload: unknown = request.postDataJSON();
    if (!isVoiceChatPayload(payload)) return;
    contents.push(payload.content);
    paths.push(pathname);
    payloads.push(payload);
  });
  return {
    canonicalContents: () => contents,
    canonicalPaths: () => paths,
    canonicalPayloads: () => payloads,
    legacyPaths: () => legacyPaths,
  };
}

interface GroundedSendCapture {
  readonly payloads: () => readonly Record<string, unknown>[];
  readonly legacyPaths: () => readonly string[];
}

function captureGroundedSends(page: Page): GroundedSendCapture {
  const payloads: Record<string, unknown>[] = [];
  const legacyPaths: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/desktop/chat/voice-turn") {
      legacyPaths.push(pathname);
      return;
    }
    if (pathname !== "/api/chats/messages/grounded") return;
    const payload: unknown = request.postDataJSON();
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return;
    payloads.push(payload as Record<string, unknown>);
  });
  return { payloads: () => payloads, legacyPaths: () => legacyPaths };
}

type ConnectedGroundedAnswer = Extract<
  GroundedAnswer,
  { readonly groundingKind: "connected-context" }
>;

interface GroundingCitationIdentity {
  readonly lineRange: { readonly startLine: number; readonly endLine: number } | undefined;
  readonly scopePath: string;
  readonly score: number;
  readonly stableId: string;
}

type GroundingCoverageIdentity =
  Omit<NonNullable<ConnectedGroundedAnswer["contextPack"]["coverage"]>, "elapsedMs"> | undefined;

interface GroundingIdentity {
  readonly citations: readonly GroundingCitationIdentity[];
  readonly content: string;
  readonly contextPack: {
    readonly budget: ConnectedGroundedAnswer["contextPack"]["budget"];
    readonly citationCount: number;
    readonly contextSummary: ConnectedGroundedAnswer["contextPack"]["contextSummary"];
    readonly coverage: GroundingCoverageIdentity;
    readonly fileCount: number;
    readonly omittedCount: number;
    readonly omittedCounts: ConnectedGroundedAnswer["contextPack"]["omittedCounts"];
    readonly queryKind: ConnectedGroundedAnswer["contextPack"]["queryKind"];
    readonly rankingSummary: ConnectedGroundedAnswer["contextPack"]["rankingSummary"];
    readonly scopeId: string;
    readonly scopeKind: ConnectedGroundedAnswer["contextPack"]["scopeKind"];
    readonly uncertaintyCount: number;
    readonly usage: Omit<ConnectedGroundedAnswer["contextPack"]["usage"], "elapsedMs">;
  };
  readonly omittedCount: number;
  readonly uncertainty: ConnectedGroundedAnswer["uncertainty"];
}

type RetrievalParityIdentity = Omit<GroundingIdentity, "citations" | "contextPack"> & {
  readonly citations: readonly Omit<GroundingCitationIdentity, "stableId">[];
  readonly contextPack: Omit<GroundingIdentity["contextPack"], "scopeId">;
};

interface PersistedGroundingSnapshot {
  readonly assistantCount: number;
  readonly identity: GroundingIdentity | undefined;
  readonly userCount: number;
}

function groundingCoverageIdentity(
  coverage: ConnectedGroundedAnswer["contextPack"]["coverage"],
): GroundingCoverageIdentity {
  if (coverage === undefined) return undefined;
  const { elapsedMs, ...identity } = coverage;
  if (elapsedMs < 0) throw new Error("Grounding coverage elapsed time must be non-negative");
  return identity;
}

function groundingIdentity(answer: ConnectedGroundedAnswer): GroundingIdentity {
  const { contextPack } = answer;
  return {
    citations: answer.citations.map((citation) => ({
      lineRange: citation.lineRange,
      scopePath: citation.scopePath,
      score: citation.score,
      stableId: citation.stableId,
    })),
    content: answer.content,
    contextPack: {
      budget: contextPack.budget,
      citationCount: contextPack.citationCount,
      contextSummary: contextPack.contextSummary,
      coverage: groundingCoverageIdentity(contextPack.coverage),
      fileCount: contextPack.fileCount,
      omittedCount: contextPack.omittedCount,
      omittedCounts: contextPack.omittedCounts,
      queryKind: contextPack.queryKind,
      rankingSummary: contextPack.rankingSummary,
      scopeId: contextPack.scopeId,
      scopeKind: contextPack.scopeKind,
      uncertaintyCount: contextPack.uncertaintyCount,
      usage: {
        searchCalls: contextPack.usage.searchCalls,
        filesRead: contextPack.usage.filesRead,
        excerptBytes: contextPack.usage.excerptBytes,
        modelInputTokens: contextPack.usage.modelInputTokens,
        modelOutputTokens: contextPack.usage.modelOutputTokens,
        rerankCalls: contextPack.usage.rerankCalls,
      },
    },
    omittedCount: answer.omittedCount,
    uncertainty: answer.uncertainty,
  };
}

function retrievalParityIdentity(identity: GroundingIdentity): RetrievalParityIdentity {
  const { scopeId, ...contextPack } = identity.contextPack;
  if (scopeId.length === 0) throw new Error("Grounding scope identity was empty");
  return {
    citations: identity.citations.map((citation) => ({
      lineRange: citation.lineRange,
      scopePath: citation.scopePath,
      score: citation.score,
    })),
    content: identity.content,
    contextPack,
    omittedCount: identity.omittedCount,
    uncertainty: identity.uncertainty,
  };
}

function connectedGroundedAnswer(message: ChatMessage): ConnectedGroundedAnswer | undefined {
  const answer = message.groundedAnswer;
  return answer?.groundingKind === "connected-context" ? answer : undefined;
}

async function persistedGroundingSnapshot(
  request: APIRequestContext,
  chat: GroundingParityChat,
): Promise<PersistedGroundingSnapshot> {
  const params = new URLSearchParams({ chatId: chat.id, projectPath: chat.projectPath });
  const response = await request.get(`/api/chats/messages?${params.toString()}`);
  if (!response.ok()) {
    throw new Error(`Grounding parity message read failed (${String(response.status())})`);
  }
  const body = (await response.json()) as { readonly messages?: readonly ChatMessage[] };
  const messages = body.messages ?? [];
  const assistants = messages.filter((message) => message.role === "assistant");
  const soleAssistant = assistants[0];
  const answer =
    assistants.length === 1 && soleAssistant !== undefined
      ? connectedGroundedAnswer(soleAssistant)
      : undefined;
  return {
    assistantCount: assistants.length,
    identity: answer === undefined ? undefined : groundingIdentity(answer),
    userCount: messages.filter(
      (message) => message.role === "user" && message.content === GROUNDING_PARITY_TRANSCRIPT,
    ).length,
  };
}

async function requirePersistedGroundingIdentity(
  request: APIRequestContext,
  chat: GroundingParityChat,
): Promise<GroundingIdentity> {
  await expect
    .poll(() => persistedGroundingSnapshot(request, chat), { timeout: 30_000 })
    .toMatchObject({
      assistantCount: 1,
      identity: { content: GROUNDING_PARITY_ANSWER },
      userCount: 1,
    });
  const snapshot = await persistedGroundingSnapshot(request, chat);
  if (snapshot.identity === undefined) throw new Error("Persisted grounded answer was unavailable");
  return snapshot.identity;
}

interface VoiceChatPayload extends Record<string, unknown> {
  readonly content: string;
}

interface VoiceChatScope {
  readonly chatId: string;
  readonly projectPath: string;
}

function isVoiceChatPayload(payload: unknown): payload is VoiceChatPayload {
  return !(
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !("content" in payload) ||
    typeof payload.content !== "string"
  );
}

function voiceChatPayloadContent(payload: unknown): string | undefined {
  return isVoiceChatPayload(payload) ? payload.content : undefined;
}

function expectCanonicalVoiceSend(
  chatSends: VoiceChatSendCapture,
  expectedContent: string,
): VoiceChatScope {
  expect(chatSends.canonicalContents()).toEqual([expectedContent]);
  expect(chatSends.legacyPaths()).toEqual([]);
  // The Chat-owned Voice FIFO deliberately chooses the buffered canonical route: unlike a display
  // stream, its terminal response is reconcilable after media teardown. It still enters the same
  // server-owned validation, memory, retrieval, persistence, and idempotency layer as Composer chat.
  expect(chatSends.canonicalPaths()).toEqual(["/api/desktop/chat"]);
  const payload = chatSends.canonicalPayloads()[0];
  const chatId = payload?.chatId;
  const projectPath = payload?.projectPath;
  if (typeof chatId !== "string" || typeof projectPath !== "string") {
    throw new Error("canonical voice request omitted its chat scope");
  }
  expect(chatId).toEqual(expect.any(String));
  expect(projectPath).toEqual(expect.any(String));
  expect(payload).toMatchObject({
    chatId,
    projectPath,
    content: expectedContent,
    modelId: expect.any(String),
    clientTurnId: expect.stringMatching(PROVIDER_CANONICAL_TURN_ID_PATTERN),
    memory: {
      enabled: expect.any(Boolean),
      budgetTokens: expect.any(Number),
      mode: expect.any(String),
      surface: "voice",
      context: {
        userId: expect.any(String),
        workspaceId: projectPath,
        projectId: projectPath,
        conversationId: chatId,
      },
    },
  });
  return { chatId, projectPath };
}

async function persistedVoiceTurnCounts(
  request: APIRequestContext,
  scope: VoiceChatScope,
): Promise<{ readonly assistant: number; readonly user: number } | string> {
  const params = new URLSearchParams({ chatId: scope.chatId, projectPath: scope.projectPath });
  const response = await request.get(`/api/chats/messages?${params.toString()}`);
  if (!response.ok()) return `HTTP ${String(response.status())}`;
  const body = (await response.json()) as {
    readonly messages?: readonly { readonly content?: unknown; readonly role?: unknown }[];
  };
  const messages = body.messages ?? [];
  return {
    assistant: messages.filter(
      (message) =>
        message.role === "assistant" &&
        typeof message.content === "string" &&
        message.content.includes("KEIKO_E2E_STREAM_OK"),
    ).length,
    user: messages.filter(
      (message) => message.role === "user" && message.content === "what is the deploy status",
    ).length,
  };
}

async function persistedMemoryCaptureCount(
  request: APIRequestContext,
  since: number,
): Promise<number | string> {
  const params = new URLSearchParams({ order: "desc", since: String(since) });
  const response = await request.get(`/api/memory?${params.toString()}`);
  if (!response.ok()) return `HTTP ${String(response.status())}`;
  const body = (await response.json()) as {
    readonly captures?: readonly {
      readonly memoryId?: unknown;
      readonly outcome?: unknown;
    }[];
  };
  const captures = body.captures ?? [];
  return captures.filter(
    (capture) => capture.outcome !== "rejected" && typeof capture.memoryId === "string",
  ).length;
}

// Reads a counter from the browser-side window.__micStats instrument (see fakeRealtimeInit), so
// the lifecycle assertions are on observable call counts rather than on timing.
async function micStat(page: Page, field: "getUserMedia" | "stopped"): Promise<number | undefined> {
  return page.evaluate((key) => window.__micStats?.[key], field);
}

async function providerNativeOutputEvents(page: Page): Promise<number | undefined> {
  return page.evaluate(() => window.__providerNativeOutputEvents);
}

async function canonicalTtsPlays(page: Page): Promise<number | undefined> {
  return page.evaluate(() => window.__canonicalTtsPlays);
}

async function releaseCanonicalTts(page: Page): Promise<void> {
  await page.evaluate(() => window.__releaseCanonicalTts?.());
}

async function noVoiceFlow(page: Page): Promise<void> {
  await stubCapability(page, NO_VOICE_CAPABILITY);
  await openComposer(page);
  const composer = page.getByRole("textbox", { name: "Chat message" }).first();
  await composer.fill("plain typed message");
  await expect(composer).toHaveValue("plain typed message");
  await expect(page.getByRole("switch", { name: "Voice dialogue mode" })).toHaveCount(0);
}

async function expectDialogueOnlyControls(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Mute voice dialogue microphone" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop voice dialogue" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Leave voice dialogue" })).toHaveCount(0);
  // KEIKO-0217/#2894 keeps barge-in reachable while the fake provider's output is active.
  const interrupt = page.getByRole("button", { name: "Interrupt the assistant" });
  await expect(interrupt).toBeVisible();
  await expect(interrupt).toHaveAttribute("aria-disabled", "false");
  await interrupt.click();
  await releaseCanonicalTts(page);
  await expect(interrupt).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("combobox", { name: /^Voice profile/u })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start speaking" })).toHaveCount(0);
}

async function dialogueTurnFlow(page: Page, request: APIRequestContext): Promise<void> {
  // Hold fake playback open so the KEIKO-0217/#2894 reachability assertion observes an explicit
  // provider-output state; releasing the fixture after Interrupt proves the settled state as well.
  await page.addInitScript(fakeRealtimeInit({ emitTranscript: true, holdSpeech: true }));
  await stubCapability(page, FULL_REALTIME_WEBRTC_CAPABILITY);
  const chatSends = captureVoiceChatSends(page);
  const synthesizedTexts = await captureSynthesizedTexts(page);
  await openComposer(page);

  await expect(page.getByRole("button", { name: "Start realtime voice" })).toHaveCount(0);
  const dialogSwitch = page.getByRole("switch", { name: "Voice dialogue mode" });
  await expect(dialogSwitch).toBeVisible();
  await dialogSwitch.click();
  await expect(dialogSwitch).toHaveAttribute("aria-checked", "true");

  await expectActiveComposerSettled(page);
  await expectDialogueOnlyControls(page);

  await page.screenshot({
    path: evidenceScreenshotPath("docs/voice/evidence/1560-dialogue-session.png"),
    fullPage: true,
  });

  const composer = page.locator(".cmp-input");
  await expect(composer).toHaveCount(1);
  await expect(page.getByRole("textbox", { name: "Chat message" })).toHaveCount(0);
  const conversation = page.getByRole("log", { name: "Conversation" });
  await expect(conversation.getByText("what is the deploy status", { exact: true })).toHaveCount(1);
  await expect(conversation.getByText(/KEIKO_E2E_STREAM_OK/u)).toHaveCount(1);
  await expect.poll(() => providerNativeOutputEvents(page)).toBe(3);
  await expect(conversation.getByText("The deploy is green.", { exact: true })).toHaveCount(0);
  await expect.poll(() => synthesizedTexts.length).toBe(1);
  expect(synthesizedTexts[0]).toContain("KEIKO_E2E_STREAM_OK");
  expect(synthesizedTexts[0]).not.toContain("The deploy is green.");
  await expect.poll(() => canonicalTtsPlays(page)).toBe(1);
  await expect(composer).toHaveValue("");
  await expect(dialogSwitch).toHaveAttribute("aria-checked", "true");

  // Leaving is the same Keiko-logo switch: no separate Stop / Leave panel exists.
  await dialogSwitch.click();
  await expect(dialogSwitch).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("button", { name: "Mute voice dialogue microphone" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Chat message" }).first()).toBeVisible();
  const scope = expectCanonicalVoiceSend(chatSends, "what is the deploy status");
  await expect
    .poll(() => persistedVoiceTurnCounts(request, scope))
    .toEqual({
      assistant: 1,
      user: 1,
    });

  // Reload must hydrate the one admitted user turn and its canonical assistant answer from the
  // server store. This rejects UI-only echo success and duplicate persistence after replayed finals.
  await page.reload();
  const restoredConversation = page.getByRole("log", { name: "Conversation" });
  await expect(
    restoredConversation.getByText("what is the deploy status", { exact: true }),
  ).toHaveCount(1);
  await expect(restoredConversation.getByText(/KEIKO_E2E_STREAM_OK/u)).toHaveCount(1);
}

async function voiceMemoryCaptureFlow(page: Page, request: APIRequestContext): Promise<void> {
  const since = Date.now() - 1_000;
  await verifyChatModel(request);
  await page.addInitScript(
    fakeRealtimeInit({ emitTranscript: true, transcript: MEMORY_CAPTURE_TRANSCRIPT }),
  );
  await stubCapability(page, FULL_REALTIME_WEBRTC_CAPABILITY);
  const chatSends = captureVoiceChatSends(page);
  await page.route("**/api/voice/speak", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ audio: "AA==", mimeType: "audio/mpeg" }),
    }),
  );
  await openComposer(page);
  const chatWindow = page.locator('section.window[data-top="true"]');
  const memoryControl = chatWindow.locator(".chat-memory-activation-toggle");
  await expect(memoryControl).toHaveAccessibleName("Enable MemoriaViva for this chat");
  await memoryControl.click();
  await expect(memoryControl).toHaveAttribute("aria-pressed", "true");
  await expect(memoryControl).toHaveAccessibleName("Disable MemoriaViva for this chat");

  const dialogSwitch = page.getByRole("switch", { name: "Voice dialogue mode" });
  await dialogSwitch.click();
  const conversation = page.getByRole("log", { name: "Conversation" });
  await expect(conversation.getByText(MEMORY_CAPTURE_TRANSCRIPT, { exact: true })).toHaveCount(1);
  await expect(conversation.getByText(/KEIKO_E2E_STREAM_OK/u)).toHaveCount(1);
  await expect.poll(() => persistedMemoryCaptureCount(request, since)).toBe(1);
  expectCanonicalVoiceSend(chatSends, MEMORY_CAPTURE_TRANSCRIPT);

  await dialogSwitch.click();
  await expect(dialogSwitch).toHaveAttribute("aria-checked", "false");
}

async function captureSynthesizedTexts(page: Page): Promise<string[]> {
  const texts: string[] = [];
  await page.route("**/api/voice/speak", async (route) => {
    const payload: unknown = route.request().postDataJSON();
    if (
      payload !== null &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      "text" in payload &&
      typeof payload.text === "string"
    ) {
      texts.push(payload.text);
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ audio: "AA==", mimeType: "audio/mpeg" }),
    });
  });
  return texts;
}

async function expectGroundingParityUi(page: Page, chat: GroundingParityChat): Promise<void> {
  const chatWindow = page.getByRole("region", { name: `Chat — ${chat.title}` });
  await expect(chatWindow.getByText(GROUNDING_PARITY_TRANSCRIPT, { exact: true })).toHaveCount(1);
  await expect(chatWindow.getByText(GROUNDING_PARITY_CLAIM, { exact: true })).toHaveCount(1);
  await expect(
    chatWindow.getByRole("button", {
      name: "Open src/repository-parity.ts at line 2 in editor",
    }),
  ).toHaveCount(1);
  await chatWindow.locator("summary").filter({ hasText: "Evidence" }).click();
  await expect(
    chatWindow
      .getByRole("list", { name: "Evidence citations" })
      .getByTitle(/^Evidence citation in src\/repository-parity\.ts at lines 2-2 — relevance /u),
  ).toHaveCount(1);
}

async function sendTypedGroundingTurn(page: Page, chat: GroundingParityChat): Promise<void> {
  await seedGroundingParityChat(page, chat);
  await page.goto("/");
  const chatWindow = page.getByRole("region", { name: `Chat — ${chat.title}` });
  await expect(chatWindow).toBeVisible();
  const composer = chatWindow.getByRole("textbox", { name: "Chat message" });
  await composer.fill(GROUNDING_PARITY_TRANSCRIPT);
  await chatWindow.getByRole("button", { name: "Send message" }).click();
  await expectGroundingParityUi(page, chat);
}

async function sendVoiceGroundingTurn(page: Page, chat: GroundingParityChat): Promise<void> {
  await seedGroundingParityChat(page, chat);
  await page.goto("/");
  const chatWindow = page.getByRole("region", { name: `Chat — ${chat.title}` });
  await expect(chatWindow).toBeVisible();
  const dialogSwitch = chatWindow.getByRole("switch", { name: "Voice dialogue mode" });
  await dialogSwitch.click();
  await expect(dialogSwitch).toHaveAttribute("aria-checked", "true");
  await expectGroundingParityUi(page, chat);
  await expect(chatWindow.getByText("The deploy is green.", { exact: true })).toHaveCount(0);
  await expect.poll(() => providerNativeOutputEvents(page)).toBe(3);
  await dialogSwitch.click();
  await expect(dialogSwitch).toHaveAttribute("aria-checked", "false");
}

function expectGroundedPayloadScope(payload: unknown, chat: GroundingParityChat): void {
  expect(payload).toMatchObject({
    chatId: chat.id,
    content: GROUNDING_PARITY_TRANSCRIPT,
    memory: {
      context: {
        conversationId: chat.id,
        projectId: chat.projectPath,
        workspaceId: chat.projectPath,
      },
    },
    modelId: CHAT_MODEL_ID,
  });
}

function expectGroundedSendParity(
  typedCapture: GroundedSendCapture,
  voiceCapture: GroundedSendCapture,
  typedChat: GroundingParityChat,
  voiceChat: GroundingParityChat,
): void {
  const payloads = [...typedCapture.payloads(), ...voiceCapture.payloads()];
  expect(payloads.map((payload) => payload.content)).toEqual([
    GROUNDING_PARITY_TRANSCRIPT,
    GROUNDING_PARITY_TRANSCRIPT,
  ]);
  expectGroundedPayloadScope(payloads[0], typedChat);
  expectGroundedPayloadScope(payloads[1], voiceChat);
  expect(payloads[1]).toMatchObject({
    clientTurnId: expect.stringMatching(PROVIDER_CANONICAL_TURN_ID_PATTERN),
  });
  expect(typedCapture.legacyPaths()).toEqual([]);
  expect(voiceCapture.legacyPaths()).toEqual([]);
}

function expectGroundingCitationIdentity(identity: GroundingIdentity): void {
  expect(identity.citations).toHaveLength(1);
  expect(identity.citations[0]).toMatchObject({
    lineRange: { startLine: 2, endLine: 2 },
    scopePath: "src/repository-parity.ts",
    score: expect.any(Number),
    stableId: expect.any(String),
  });
  expect(identity.citations[0]?.stableId.length).toBeGreaterThan(0);
  expect(identity.contextPack).toMatchObject({
    citationCount: 1,
    scopeKind: "workspace-root",
  });
}

async function groundingParityFlow(page: Page, request: APIRequestContext): Promise<void> {
  const projectPath = createGroundingParityFixture();
  await ensureGroundingParityProject(request, projectPath);
  const typedChat = await createGroundingParityChat(request, projectPath, "E2E Composer parity");
  const typedSends = captureGroundedSends(page);
  const typedSpeech = await captureSynthesizedTexts(page);
  await sendTypedGroundingTurn(page, typedChat);
  expect(typedSpeech).toEqual([]);
  const typedIdentity = await requirePersistedGroundingIdentity(request, typedChat);

  const voiceChat = await createGroundingParityChat(request, projectPath, "E2E Voice parity");
  const voicePage = await page.context().newPage();
  await voicePage.addInitScript(
    fakeRealtimeInit({ emitTranscript: true, transcript: GROUNDING_PARITY_TRANSCRIPT }),
  );
  await stubCapability(voicePage, FULL_REALTIME_WEBRTC_CAPABILITY);
  const voiceSends = captureGroundedSends(voicePage);
  const voiceSpeech = await captureSynthesizedTexts(voicePage);
  await sendVoiceGroundingTurn(voicePage, voiceChat);
  await expect.poll(() => voiceSpeech).toEqual([GROUNDING_PARITY_ANSWER]);
  await expect.poll(() => canonicalTtsPlays(voicePage)).toBe(1);
  const voiceIdentity = await requirePersistedGroundingIdentity(request, voiceChat);

  expectGroundedSendParity(typedSends, voiceSends, typedChat, voiceChat);
  expectGroundingCitationIdentity(typedIdentity);
  expectGroundingCitationIdentity(voiceIdentity);
  expect(voiceIdentity.contextPack.scopeId).not.toBe(typedIdentity.contextPack.scopeId);
  expect(voiceIdentity.citations[0]?.stableId).not.toBe(typedIdentity.citations[0]?.stableId);
  expect(retrievalParityIdentity(voiceIdentity)).toEqual(retrievalParityIdentity(typedIdentity));
  await voicePage.close();
}

test("voice dialogue @smoke — canonical payload parsing rejects non-object boundaries", () => {
  for (const payload of [null, undefined, "spoken", 7, [], { content: 7 }]) {
    expect(voiceChatPayloadContent(payload)).toBeUndefined();
  }
  expect(voiceChatPayloadContent({ content: "spoken turn" })).toBe("spoken turn");
});

test("voice dialogue @smoke — no-voice deployment offers no dialogue switch (AC4)", async ({
  page,
}) => {
  await noVoiceFlow(page);
});

test("voice dialogue @smoke — Realtime WebRTC uses canonical chat turns (AC1/AC2/AC3)", async ({
  page,
  request,
}) => {
  await dialogueTurnFlow(page, request);
});

test("voice dialogue @smoke — canonical speech reaches Memoria Viva exactly once", async ({
  page,
  request,
}) => {
  await voiceMemoryCaptureFlow(page, request);
});

test("voice dialogue @smoke — Composer and Voice preserve persisted grounding parity", async ({
  page,
  request,
}) => {
  await groundingParityFlow(page, request);
});

async function micLifecycleFlow(page: Page): Promise<void> {
  await page.addInitScript(fakeRealtimeInit({ instrumentMic: true }));
  await stubCapability(page, FULL_REALTIME_WEBRTC_CAPABILITY);
  await openComposer(page);

  const dialogSwitch = page.getByRole("switch", { name: "Voice dialogue mode" });
  await expect(dialogSwitch).toBeVisible();
  await expect.poll(() => micStat(page, "getUserMedia")).toBe(0);
  await dialogSwitch.click();
  await expect(dialogSwitch).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => micStat(page, "getUserMedia")).toBe(1);
  await expectActiveComposerSettled(page);

  await page.screenshot({
    path: evidenceScreenshotPath("docs/voice/evidence/1562-dialogue-mic-lifecycle.png"),
    fullPage: true,
  });

  await dialogSwitch.click();
  await expect.poll(() => micStat(page, "stopped")).toBeGreaterThanOrEqual(1);
  await expect(page.getByRole("button", { name: "Stop voice dialogue" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Mute voice dialogue microphone" })).toHaveCount(0);
  await expect(dialogSwitch).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("textbox", { name: "Chat message" }).first()).toBeVisible();
}

test("voice dialogue @smoke — switch starts WebRTC microphone and leave releases it (AC2/AC3/D3)", async ({
  page,
}) => {
  await micLifecycleFlow(page);
});

// Issue #1563, Epic #1556 — production evaluation browser evidence.
//
// A no-voice deployment is already covered above; this asserts the OTHER two partial profiles the
// evaluation enumerates (speech-to-text only, speech-output only) also keep the dialogue switch absent
// while the composer stays fully text-capable. Together with the no-voice and full-realtime cases, the
// browser smoke now covers every configured capability profile (AC1).
async function unavailableProfileFlow(page: Page, capability: unknown): Promise<void> {
  await stubCapability(page, capability);
  await openComposer(page);
  const composer = page.getByRole("textbox", { name: "Chat message" }).first();
  await composer.fill("plain typed message");
  await expect(composer).toHaveValue("plain typed message");
  // Partial or non-WebRTC deployments do not offer spoken dialogue; text chat is unaffected.
  await expect(page.getByRole("switch", { name: "Voice dialogue mode" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start speaking" })).toHaveCount(0);
}

// Issue #1563 — active-session composer evidence.
//
// Voice selection now lives in Settings > General. The active composer remains a clean dialogue surface:
// the Keiko-logo switch plus the microphone mute control are the only voice-dialogue controls.
async function activeComposerControlsFlow(page: Page): Promise<void> {
  await page.addInitScript(fakeRealtimeInit());
  await stubCapability(page, FULL_REALTIME_WEBRTC_CAPABILITY);
  await openComposer(page);

  const dialogSwitch = page.getByRole("switch", { name: "Voice dialogue mode" });
  await dialogSwitch.click();
  await expect(dialogSwitch).toHaveAttribute("aria-checked", "true");

  await expect(page.getByRole("button", { name: "Mute voice dialogue microphone" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop voice dialogue" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Leave voice dialogue" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Interrupt the assistant" })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: /^Voice profile/u })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Chat message" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Attach file" })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Models" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Dictate a message" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Mute assistant voice" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send message" })).toHaveCount(0);
  await expectActiveComposerSettled(page);

  await page.screenshot({
    path: evidenceScreenshotPath("docs/voice/evidence/1563-dialogue-evaluation.png"),
    fullPage: true,
  });

  // Leave returns to a clean, text-capable composer (master cleanup).
  await dialogSwitch.click();
  await expect(page.getByRole("button", { name: "Stop voice dialogue" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Mute voice dialogue microphone" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Chat message" }).first()).toBeVisible();
}

test("voice dialogue @smoke — speech-to-text-only deployment offers no dialogue switch (AC1)", async ({
  page,
}) => {
  await unavailableProfileFlow(page, STT_ONLY_CAPABILITY);
});

test("voice dialogue @smoke — speech-output-only deployment offers no dialogue switch (AC1)", async ({
  page,
}) => {
  await unavailableProfileFlow(page, SPEECH_OUTPUT_ONLY_CAPABILITY);
});

test("voice dialogue @smoke — full-realtime without WebRTC offers no dialogue switch (AC1)", async ({
  page,
}) => {
  await unavailableProfileFlow(page, FULL_REALTIME_NO_WEBRTC_CAPABILITY);
});

test("voice dialogue @smoke — Realtime without explicit TTS offers no spoken Twin", async ({
  page,
}) => {
  await page.addInitScript(fakeRealtimeInit());
  await unavailableProfileFlow(page, REALTIME_WITHOUT_TTS_CAPABILITY);
});

test("voice dialogue @smoke — active composer keeps only switch and mic mute visible (AC1/AC4)", async ({
  page,
}) => {
  await activeComposerControlsFlow(page);
});

async function reducedMotionComposerFlow(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(fakeRealtimeInit());
  await stubCapability(page, FULL_REALTIME_WEBRTC_CAPABILITY);
  await openComposer(page);

  const composer = page.locator(".cmp-box");
  const normalLayer = composer.locator('[data-composer-layer="normal"]');
  const voiceLayer = composer.locator('[data-composer-layer="voice"]');
  const dialogSwitch = page.getByRole("switch", { name: "Voice dialogue mode" });

  await dialogSwitch.click();
  await expectActiveComposerSettled(page);
  await expect(normalLayer).toHaveCSS("transition-duration", "0s");
  await expect(normalLayer).toHaveCSS("transform", "none");
  await expect(normalLayer).toHaveCSS("filter", "none");
  await expect(voiceLayer).toHaveCSS("transition-duration", "0s");
  await expect(voiceLayer).toHaveCSS("transform", "none");
  await expect(voiceLayer).toHaveCSS("filter", "none");

  await page.screenshot({
    path: evidenceScreenshotPath("docs/voice/evidence/1563-dialogue-reduced-motion.png"),
    fullPage: true,
  });

  await dialogSwitch.click();
  await expect(page.getByRole("textbox", { name: "Chat message" }).first()).toBeVisible();
  await expect(normalLayer).toHaveCSS("opacity", "1");
  await expect(normalLayer).toHaveCSS("transform", "none");
  await expect(voiceLayer).toHaveCSS("opacity", "0");
  await expect(voiceLayer).toHaveCSS("transform", "none");
}

test("voice dialogue @smoke — reduced motion uses a static accessible state change", async ({
  page,
}) => {
  await reducedMotionComposerFlow(page);
});

async function enterDialogue(page: Page): Promise<void> {
  const dialogSwitch = page.getByRole("switch", { name: "Voice dialogue mode" });
  await expect(dialogSwitch).toBeVisible();
  if ((await dialogSwitch.getAttribute("aria-checked")) !== "true") {
    await dialogSwitch.click();
  }
  await expect(dialogSwitch).toHaveAttribute("aria-checked", "true");
}

async function personaStorageFlow(page: Page): Promise<void> {
  await page.addInitScript(fakeRealtimeInit());
  await stubCapability(page, FULL_REALTIME_WEBRTC_CAPABILITY);
  await openComposer(page);
  await page.evaluate(() => {
    window.localStorage.setItem("keiko.voice.dialog.persona", "male");
  });
  expect(await page.evaluate(() => window.localStorage.getItem("keiko.voice.dialog.persona"))).toBe(
    "male",
  );
  await enterDialogue(page);
  await expect(page.getByRole("combobox", { name: /^Voice profile/u })).toHaveCount(0);
  await expectActiveComposerSettled(page);

  await page.screenshot({
    path: evidenceScreenshotPath("docs/voice/evidence/1564-persona-storage.png"),
    fullPage: true,
  });

  const dialogSwitch = page.getByRole("switch", { name: "Voice dialogue mode" });
  await dialogSwitch.click();
  await expect(dialogSwitch).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("textbox", { name: "Chat message" }).first()).toBeVisible();

  await page.reload();
  expect(await page.evaluate(() => window.localStorage.getItem("keiko.voice.dialog.persona"))).toBe(
    "male",
  );
}

test("voice dialogue @smoke — persona preference stays content-free and out of the active composer (AC3)", async ({
  page,
}) => {
  await personaStorageFlow(page);
});
