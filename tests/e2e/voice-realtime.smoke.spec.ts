// Issue #497, Epic #491 — realtime voice transport browser smoke. Drives the REAL app composer in
// headless Chromium through the documented Studio path (Left Rail → Chat History → New). Four flows:
//   1. No-voice deployment: /api/voice/capability reports unavailable → the composer loads with NO
//      realtime voice affordance and stays fully text-capable (AC1/AC3).
//   2. STT-only deployment: capability advertises speech-to-text only → the dictation affordance is
//      present but NO realtime voice affordance (AC4 — STT-only exposes dictation, not full transport).
//   3. Full-realtime deployment: capability advertises full-realtime AND fake getUserMedia +
//      RTCPeerConnection + WebSocket are injected so the proxied-SDP handshake completes in the browser
//      without touching hardware, a provider, or the real WS upgrade. The user enables Voice Dialogue,
//      which opens the realtime session directly (AC1/AC2/AC6 — observable transport state).
//   4. Permission denied: getUserMedia is denied → a non-blocking error appears and the composer stays
//      fully usable (AC4).
//
// Tagged @smoke so the Studio browser quality gate exercises it. The required `ci` check does not run
// Playwright; the executable AC coverage that runs in `ci` lives in the keiko-server + keiko-ui suites
// (the gated WS upgrade integration test boots the real BFF and a real `ws` client).

import { expect, test, type Page } from "@playwright/test";
import { evidenceScreenshotPath } from "./support/evidence.js";

const FULL_REALTIME_CAPABILITY = {
  voice: {
    available: true,
    profile: "full-realtime",
    capabilities: { speechToText: true, speechOutput: true, realtimeVoice: true },
    transport: { websocketControl: true, webrtcMedia: true },
    availableVoicePersonas: ["male", "female", "neutral"],
    providerLocality: "azure-foundry",
  },
};

const STT_CAPABILITY = {
  voice: {
    available: true,
    profile: "speech-to-text",
    capabilities: { speechToText: true, speechOutput: false, realtimeVoice: false },
    transport: { websocketControl: true, webrtcMedia: false },
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

// Injected before any app script runs: fake getUserMedia + RTCPeerConnection + WebSocket so the real
// client code (voice-rtc-transport / voice-realtime-client) exercises a complete proxied-SDP handshake
// in the browser without hardware, a provider, or the real BFF WebSocket upgrade. `mode` controls the
// microphone grant. The fake WebSocket plays the host side of the #496 protocol.
// The fake RTCPeerConnection + WebSocket (the host side of the #496 protocol). The WebSocket
// intercepts only the voice control path; every other socket (e.g. the dev server's own HMR
// WebSocket) is delegated to the real implementation so the app still loads.
const TRANSPORT_FAKES_SCRIPT = `
  const OFFER = "v=0\\r\\no=- 1 1 IN IP4 127.0.0.1\\r\\ns=-\\r\\nt=0 0\\r\\nm=audio 9 UDP/TLS/RTP/SAVPF 111\\r\\n";
  const ANSWER = "v=0\\r\\no=- 2 2 IN IP4 0.0.0.0\\r\\ns=-\\r\\nt=0 0\\r\\nm=audio 9 UDP/TLS/RTP/SAVPF 111\\r\\n";
  class FakeDataChannel {
    constructor() {
      this.readyState = "open";
      this._l = {};
      this.sent = [];
    }
    addEventListener(type, cb) { (this._l[type] ||= []).push(cb); }
    send(data) {
      this.sent.push(data);
      let msg; try { msg = JSON.parse(data); } catch { return; }
      if (msg.type === "session.update") {
        for (const cb of this._l["message"] || []) {
          cb({ data: JSON.stringify({ type: "session.updated", session: msg.session || {} }) });
        }
      }
    }
    close() { this.readyState = "closed"; for (const cb of this._l["close"] || []) cb({}); }
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
    addTrack() {}
    createDataChannel() { this._channel = new FakeDataChannel(); return this._channel; }
    async createOffer() { return { type: "offer", sdp: OFFER }; }
    async setLocalDescription(desc) { this.localDescription = { type: desc.type, sdp: desc.sdp }; }
    async setRemoteDescription() {
      setTimeout(() => {
        this.connectionState = "connected";
        if (this.onconnectionstatechange) this.onconnectionstatechange({});
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

function fakeRealtimeInit(mode: "grant" | "deny"): string {
  return `
    (() => {
      const mode = ${JSON.stringify(mode)};
      const fakeStream = { getTracks: () => [{ stop() {} }] };
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => {
            if (mode === "deny") {
              const error = new Error("denied");
              error.name = "NotAllowedError";
              throw error;
            }
            return fakeStream;
          },
        },
      });
      ${TRANSPORT_FAKES_SCRIPT}
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

async function noVoiceFlow(page: Page): Promise<void> {
  await stubCapability(page, NO_VOICE_CAPABILITY);
  await openComposer(page);
  const composer = page.getByRole("textbox", { name: "Chat message" }).first();
  await composer.fill("plain typed message");
  await expect(composer).toHaveValue("plain typed message");
  await expect(page.getByRole("button", { name: "Start realtime voice" })).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "Voice dialogue mode" })).toHaveCount(0);
}

async function sttOnlyFlow(page: Page): Promise<void> {
  await stubCapability(page, STT_CAPABILITY);
  await openComposer(page);
  // Dictation is offered for an STT-only deployment, but never the full realtime transport (AC4).
  await expect(page.getByRole("button", { name: "Dictate a message" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start realtime voice" })).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "Voice dialogue mode" })).toHaveCount(0);
}

async function realtimeConnectFlow(page: Page): Promise<void> {
  await page.addInitScript(fakeRealtimeInit("grant"));
  await stubCapability(page, FULL_REALTIME_CAPABILITY);
  await openComposer(page);

  await expect(page.getByRole("button", { name: "Start realtime voice" })).toHaveCount(0);
  const dialogSwitch = page.getByRole("switch", { name: "Voice dialogue mode" });
  await expect(dialogSwitch).toBeVisible();
  await dialogSwitch.click();

  // The proxied-SDP handshake completes via the injected fakes and the link comes up.
  await expect(page.getByText("Voice dialogue is ready.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Mute voice dialogue microphone" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop voice dialogue" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Leave voice dialogue" })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: /^Voice profile/u })).toHaveCount(0);
  await page.screenshot({
    path: evidenceScreenshotPath("docs/voice/evidence/497-realtime-connected.png"),
    fullPage: true,
  });

  // The composer remains fully text-capable while a voice session is live.
  const composer = page.getByRole("textbox", { name: "Chat message" }).first();
  await composer.fill("typing while connected");
  await expect(composer).toHaveValue("typing while connected");
}

async function deniedPermissionFlow(page: Page): Promise<void> {
  await page.addInitScript(fakeRealtimeInit("deny"));
  await stubCapability(page, FULL_REALTIME_CAPABILITY);
  await openComposer(page);

  await page.getByRole("switch", { name: "Voice dialogue mode" }).click();
  await expect(page.getByText(/Voice dialogue could not continue/u)).toBeVisible();
  const composer = page.getByRole("textbox", { name: "Chat message" }).first();
  await composer.fill("still typing fine");
  await expect(composer).toHaveValue("still typing fine");
}

test("realtime voice @smoke — no-voice composer has no realtime affordance (AC1/AC3)", async ({
  page,
}) => {
  await noVoiceFlow(page);
});

test("realtime voice @smoke — STT-only offers dictation but not realtime transport (AC4)", async ({
  page,
}) => {
  await sttOnlyFlow(page);
});

test("realtime voice @smoke — full-realtime connects over the proxied-SDP handshake (AC1/AC2/AC6)", async ({
  page,
}) => {
  await realtimeConnectFlow(page);
});

test("realtime voice @smoke — denied microphone does not break the composer (AC4)", async ({
  page,
}) => {
  await deniedPermissionFlow(page);
});
