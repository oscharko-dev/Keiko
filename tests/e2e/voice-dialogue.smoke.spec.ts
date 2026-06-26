// Issue #1560, Epic #1556 — voice dialogue-session browser smoke. Drives the REAL app composer in
// headless Chromium through the documented Studio path (Left Rail → Chat History → New). It proves the
// colleague-like dialogue surface renders and runs its user-side turn loop in the real browser:
//   1. No-voice deployment: /api/voice/capability reports unavailable → NO dialogue switch and the
//      composer stays fully text-capable (AC4).
//   2. Full-realtime WITHOUT browser WebRTC media (the production STT+TTS fallback, ADR-0090 D3): a fake
//      getUserMedia + MediaRecorder + stubbed /api/voice/transcribe + /api/voice/speak are injected (no
//      hardware, no provider; privacy contract preserved). The dialogue switch AND the per-turn controls
//      (Speak + Interrupt) render; activating the mic begins a listening turn and stopping commits the
//      transcript into the composer draft through the dialogue session's chat-send seam (AC1/AC2);
//      leaving removes the controls and runs the master cleanup (AC3). A screenshot of the active
//      dialogue surface is captured as evidence.
//
// Scope note (mirrors the #501 / #504 voice smokes): the assistant answer → spoken playback → barge-in
// half of the loop depends on a live chat + TTS provider that CI does not deploy, and the deep
// transcribe→send and interrupt routing is proven deterministically in the required `ci` check by the
// keiko-ui suites (voice-dialogue-session core, useVoiceDialogueSession hook, the VoiceDialogTurnControls
// component, and the ChatWindow voice integration). This browser smoke proves the gated surface renders,
// the user-side turn loop runs through real component code, and the composer stays text-capable — it
// does not drive a real model/audio round trip.

import { expect, test, type Page } from "@playwright/test";

// Full-realtime WITH personas but WITHOUT browser WebRTC media — the STT+TTS fallback the matrix must
// still offer (ADR-0090 D3). availableVoicePersonas is required to unlock the dialogue switch.
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

// Injected before any app script runs: a fake getUserMedia + MediaRecorder so the real dialogue
// dictation exercises a complete capture cycle in the browser without touching hardware or a provider.
function fakeMediaInit(): string {
  return `
    (() => {
      const fakeTrack = { stop() {} };
      const fakeStream = { getTracks: () => [fakeTrack] };
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: { getUserMedia: async () => fakeStream },
      });
      class FakeMediaRecorder {
        static isTypeSupported() { return true; }
        constructor() { this.state = "inactive"; this.mimeType = "audio/webm"; this._l = {}; }
        addEventListener(type, cb) { (this._l[type] ||= []).push(cb); }
        start() { this.state = "recording"; }
        stop() {
          this.state = "inactive";
          for (const cb of this._l["dataavailable"] || []) {
            cb({ data: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }) });
          }
          for (const cb of this._l["stop"] || []) cb({});
        }
      }
      window.MediaRecorder = FakeMediaRecorder;
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

async function stubVoiceProviders(page: Page): Promise<void> {
  await page.route("**/api/voice/transcribe", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ transcript: "what is the deploy status", confidence: 0.95 }),
    }),
  );
  await page.route("**/api/voice/speak", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ audio: btoa("stub-audio"), mimeType: "audio/mpeg" }),
    }),
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
  await page.addInitScript(fakeMediaInit());
  await stubCapability(page, FULL_REALTIME_NO_WEBRTC_CAPABILITY);
  await stubVoiceProviders(page);
  await openComposer(page);

  // The dialogue switch is offered even though the browser has no WebRTC media (the STT+TTS fallback).
  const dialogSwitch = page.getByRole("switch", { name: "Voice dialogue mode" });
  await expect(dialogSwitch).toBeVisible();
  await dialogSwitch.click();
  await expect(dialogSwitch).toHaveAttribute("aria-checked", "true");

  // The per-turn controls render so the user can take the floor (AC1).
  const speak = page.getByRole("button", { name: "Start speaking" });
  await expect(speak).toBeVisible();
  const interrupt = page.getByRole("button", { name: "Interrupt the assistant" });
  await expect(interrupt).toBeVisible();
  await expect(interrupt).toBeDisabled();

  await page.screenshot({
    path: "docs/voice/evidence/1560-dialogue-session.png",
    fullPage: true,
  });

  // Activate the mic: a listening turn begins and the control flips to stop-and-send (AC1).
  await speak.click();
  const stopAndSend = page.getByRole("button", { name: "Stop speaking and send" });
  await expect(stopAndSend).toBeVisible();
  await expect(stopAndSend).toHaveAttribute("aria-pressed", "true");

  // Ending the turn commits the transcript through the dialogue session's chat-send seam (AC2): the
  // committed text lands in the composer draft via setDraft before the send is dispatched.
  await stopAndSend.click();
  await expect(page.getByRole("textbox", { name: "Chat message" }).first()).toHaveValue(
    /what is the deploy status/u,
  );

  // Leaving removes the per-turn controls and runs the master cleanup (AC3); the composer stays usable.
  await page.getByRole("button", { name: "Leave voice dialogue" }).click();
  await expect(page.getByRole("button", { name: "Start speaking" })).toHaveCount(0);
  await expect(dialogSwitch).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("textbox", { name: "Chat message" }).first()).toBeVisible();
}

test("voice dialogue @smoke — no-voice deployment offers no dialogue switch (AC4)", async ({
  page,
}) => {
  await noVoiceFlow(page);
});

test("voice dialogue @smoke — STT+TTS fallback renders the turn loop and commits a spoken turn (AC1/AC2/AC3)", async ({
  page,
}) => {
  await dialogueTurnFlow(page);
});
