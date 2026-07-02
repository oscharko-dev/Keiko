// Voice Dialogue browser smoke. Drives the REAL app composer in headless Chromium through the documented
// Studio path (Left Rail → Chat History → New). It proves the colleague-like dialogue surface renders
// and starts the Realtime WebRTC transport from the single Voice Dialogue switch:
//   1. No-voice deployment: /api/voice/capability reports unavailable → NO dialogue switch and the
//      composer stays fully text-capable (AC4).
//   2. Full-realtime WITH browser WebRTC media: fake getUserMedia + RTCPeerConnection + WebSocket are
//      injected (no hardware, no provider; privacy contract preserved). The dialogue switch starts the
//      Realtime session directly; provider data-channel transcript events append committed user and
//      assistant turns through /api/desktop/chat/voice-turn, without raw audio or a second chat send.
//   3. Full-realtime WITHOUT browser WebRTC media: no fluid dialogue switch is offered. Dictation and
//      read-aloud remain separate helper surfaces.
//
// Scope note: the provider itself is faked at the WebRTC/control boundary. The executable unit and
// integration suites cover parser, turn-manager, and BFF persistence behavior; this smoke proves the
// user-facing surface is a single Realtime dialogue mode and the composer stays text-capable.

import { expect, test, type Page } from "@playwright/test";

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
  const OFFER = "v=0\\r\\no=- 1 1 IN IP4 127.0.0.1\\r\\ns=-\\r\\nt=0 0\\r\\nm=audio 9 UDP/TLS/RTP/SAVPF 111\\r\\n";
  const ANSWER = "v=0\\r\\no=- 2 2 IN IP4 0.0.0.0\\r\\ns=-\\r\\nt=0 0\\r\\nm=audio 9 UDP/TLS/RTP/SAVPF 111\\r\\n";
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
    channel.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "user-item",
      transcript: "what is the deploy status",
    });
    channel.emit({ type: "response.output_audio.delta", response_id: "resp-1", delta: "stub" });
    channel.emit({
      type: "response.output_audio_transcript.done",
      response_id: "resp-1",
      transcript: "The deploy is green.",
    });
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
    addTrack() {}
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
  instrumentMic = false,
}: {
  readonly emitTranscript?: boolean;
  readonly instrumentMic?: boolean;
} = {}): string {
  return `
    (() => {
      window.__keikoVoiceFakeOptions = {
        emitTranscript: ${JSON.stringify(emitTranscript)},
        instrumentMic: ${JSON.stringify(instrumentMic)},
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

interface CapturedVoiceTurnBody {
  readonly chatId?: string;
  readonly projectPath?: string;
  readonly messages?: readonly { readonly role?: string; readonly content?: string }[];
}

function stubVoiceTurnAppend(page: Page): {
  turns: () => readonly { readonly role: string; readonly content: string }[];
} {
  const captured: { turns: { role: string; content: string }[] } = { turns: [] };
  void page.route("**/api/desktop/chat/voice-turn", (route) => {
    const body = (route.request().postDataJSON() ?? {}) as CapturedVoiceTurnBody;
    const messages =
      body.messages
        ?.filter(
          (message): message is { role: string; content: string } =>
            typeof message.role === "string" &&
            typeof message.content === "string" &&
            message.content.length > 0,
        )
        .map((message) => ({ role: message.role, content: message.content })) ?? [];
    captured.turns.push(...messages);
    const chatId = body.chatId ?? "chat";
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        chat: {
          id: chatId,
          projectPath: body.projectPath ?? "/repo",
          title: "New chat",
          selectedModel: "model",
          status: "open",
          connectedScopes: [],
          localKnowledgeScopes: [],
          createdAt: 1,
          updatedAt: 2,
        },
        messages: messages.map((message, index) => ({
          id: `voice-${String(captured.turns.length)}-${String(index)}`,
          chatId,
          role: message.role,
          content: message.content,
          timestamp: 2,
        })),
      }),
    });
  });
  return { turns: () => captured.turns };
}

// Reads a counter from the browser-side window.__micStats instrument (see fakeRealtimeInit), so
// the lifecycle assertions are on observable call counts rather than on timing.
async function micStat(page: Page, field: "getUserMedia" | "stopped"): Promise<number | undefined> {
  return page.evaluate(
    (key) => (window as unknown as { __micStats?: Record<string, number> }).__micStats?.[key],
    field,
  );
}

async function noVoiceFlow(page: Page): Promise<void> {
  await stubCapability(page, NO_VOICE_CAPABILITY);
  await openComposer(page);
  const composer = page.getByRole("textbox", { name: "Chat message" }).first();
  await composer.fill("plain typed message");
  await expect(composer).toHaveValue("plain typed message");
  await expect(page.getByRole("switch", { name: "Voice dialogue mode" })).toHaveCount(0);
}

async function dialogueTurnFlow(page: Page): Promise<void> {
  await page.addInitScript(fakeRealtimeInit({ emitTranscript: true }));
  await stubCapability(page, FULL_REALTIME_WEBRTC_CAPABILITY);
  const voiceTurns = stubVoiceTurnAppend(page);
  await openComposer(page);

  await expect(page.getByRole("button", { name: "Start realtime voice" })).toHaveCount(0);
  const dialogSwitch = page.getByRole("switch", { name: "Voice dialogue mode" });
  await expect(dialogSwitch).toBeVisible();
  await dialogSwitch.click();
  await expect(dialogSwitch).toHaveAttribute("aria-checked", "true");

  await expect(page.getByText("Voice dialogue is ready.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Mute voice dialogue microphone" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop voice dialogue" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Leave voice dialogue" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Interrupt the assistant" })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: /^Voice profile/u })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start speaking" })).toHaveCount(0);

  await page.screenshot({
    path: "docs/voice/evidence/1560-dialogue-session.png",
    fullPage: true,
  });

  const composer = page.getByRole("textbox", { name: "Chat message" }).first();
  await expect.poll(() => voiceTurns.turns().length).toBeGreaterThanOrEqual(2);
  expect(voiceTurns.turns()).toEqual(
    expect.arrayContaining([
      { role: "user", content: "what is the deploy status" },
      { role: "assistant", content: "The deploy is green." },
    ]),
  );
  await expect(composer).toHaveValue("");
  await expect(dialogSwitch).toHaveAttribute("aria-checked", "true");

  // Leaving is the same Keiko-logo switch: no separate Stop / Leave panel exists.
  await dialogSwitch.click();
  await expect(dialogSwitch).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("button", { name: "Mute voice dialogue microphone" })).toHaveCount(0);
  await expect(composer).toBeVisible();
}

test("voice dialogue @smoke — no-voice deployment offers no dialogue switch (AC4)", async ({
  page,
}) => {
  await noVoiceFlow(page);
});

test("voice dialogue @smoke — Realtime WebRTC appends committed transcript turns (AC1/AC2/AC3)", async ({
  page,
}) => {
  await dialogueTurnFlow(page);
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
  await expect(page.getByText("Voice dialogue is ready.")).toBeVisible();

  await page.screenshot({
    path: "docs/voice/evidence/1562-dialogue-mic-lifecycle.png",
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

  await expect(page.getByText("Voice dialogue is ready.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Mute voice dialogue microphone" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop voice dialogue" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Leave voice dialogue" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Interrupt the assistant" })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: /^Voice profile/u })).toHaveCount(0);

  await page.screenshot({
    path: "docs/voice/evidence/1563-dialogue-evaluation.png",
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

test("voice dialogue @smoke — active composer keeps only switch and mic mute visible (AC1/AC4)", async ({
  page,
}) => {
  await activeComposerControlsFlow(page);
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

  await page.screenshot({
    path: "docs/voice/evidence/1564-persona-storage.png",
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
