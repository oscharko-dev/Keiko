// Issue #1560, Epic #1556 — voice dialogue-session browser smoke. Drives the REAL app composer in
// headless Chromium through the documented Studio path (Left Rail → Chat History → New). It proves the
// colleague-like dialogue surface renders and runs its user-side turn loop in the real browser:
//   1. No-voice deployment: /api/voice/capability reports unavailable → NO dialogue switch and the
//      composer stays fully text-capable (AC4).
//   2. Full-realtime WITHOUT browser WebRTC media (the production STT+TTS fallback, ADR-0090 D3): a fake
//      getUserMedia + MediaRecorder + stubbed /api/voice/transcribe + /api/voice/speak are injected (no
//      hardware, no provider; privacy contract preserved). The dialogue switch AND the per-turn controls
//      (Speak + Interrupt) render; activating the mic begins a listening turn and stopping commits the
//      transcript through the dialogue session's chat-send seam — Issue #1561: the committed text is sent
//      through the SAME chat send path a typed message uses (carrying the same context), not parked in
//      the composer draft, so the captured send carries the transcript and the composer clears (AC1/AC2).
//      Issue #1560 lifecycle: committing that first turn flips the chat from empty to populated, and the
//      dialogue session SURVIVES it — the switch stays on and the controls remain, so a SECOND spoken
//      turn can be taken (the user is never silently kicked back to the text composer); only leaving
//      removes the controls and runs the master cleanup (AC3). A screenshot of the active dialogue
//      surface is captured as evidence.
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

// Issue #1562, AC2/AC3/D3 — instrumented variant that exposes window.__micStats so the browser smoke
// can assert exact getUserMedia call counts and deterministic track-stop counts without touching real
// hardware. Each getUserMedia call increments __micStats.getUserMedia; each fake track.stop() call
// increments __micStats.stopped. The counters are initialised synchronously before any app script runs
// so assertions on count=0 before the first capture are race-free.
function fakeMediaInitWithStats(): string {
  return `
    (() => {
      window.__micStats = { getUserMedia: 0, stopped: 0 };
      const fakeTrack = {
        stop() { window.__micStats.stopped++; },
      };
      const fakeStream = { getTracks: () => [fakeTrack] };
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => {
            window.__micStats.getUserMedia++;
            return fakeStream;
          },
        },
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

// Issue #1561 — captures the chat send dispatched when a spoken turn is committed, and fulfils it with a
// canned response so the smoke stays deterministic (no model round trip — the deep send routing is proven
// in the required `ci` keiko-ui suites). The streaming route is forced to a non-SSE response so the
// client falls back to the buffered send, which is the one we capture. This is the browser-level proof
// that the committed transcript flows through the SAME chat send path a typed message uses.
interface CapturedSendBody {
  readonly chatId?: string;
  readonly projectPath?: string;
  readonly modelId?: string;
  readonly content?: string;
}

function stubChatSend(page: Page): { sends: () => readonly string[] } {
  // Every committed turn is captured in order, so the test can assert BOTH that the first spoken turn
  // reached the chat send AND that a second turn fired after the chat went from empty to populated.
  const captured: { sends: string[] } = { sends: [] };
  void page.route("**/api/desktop/chat/stream", (route) =>
    route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ code: "STREAMING_UNSUPPORTED", message: "buffered in smoke" }),
    }),
  );
  void page.route("**/api/desktop/chat", (route) => {
    const body = (route.request().postDataJSON() ?? {}) as CapturedSendBody;
    if (typeof body.content === "string" && body.content.length > 0) {
      captured.sends.push(body.content);
    }
    const chatId = body.chatId ?? "chat";
    const turn = captured.sends.length;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        chat: {
          id: chatId,
          projectPath: body.projectPath ?? "/repo",
          title: "New chat",
          selectedModel: body.modelId ?? "model",
          status: "open",
          connectedScopes: [],
          localKnowledgeScopes: [],
          createdAt: 1,
          updatedAt: 2,
        },
        messages: [
          {
            id: `user-${String(turn)}`,
            chatId,
            role: "user",
            content: body.content ?? "",
            timestamp: 2,
          },
        ],
      }),
    });
  });
  return { sends: () => captured.sends };
}

// Reads a counter from the browser-side window.__micStats instrument (see fakeMediaInitWithStats), so
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
  await page.addInitScript(fakeMediaInit());
  await stubCapability(page, FULL_REALTIME_NO_WEBRTC_CAPABILITY);
  await stubVoiceProviders(page);
  const send = stubChatSend(page);
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

  const composer = page.getByRole("textbox", { name: "Chat message" }).first();
  const stopAndSend = page.getByRole("button", { name: "Stop speaking and send" });

  // AC1/AC2 (Issue #1561) — run a spoken turn from the FRESH, empty chat. Activating the mic begins a
  // listening turn (the control flips to stop-and-send); ending it commits the transcript through the
  // chat-send seam. The committed text is sent through the SAME chat send path a typed message uses
  // (carrying the same context), NOT parked in the composer draft: the captured send carries the
  // transcript and the composer clears. The deep send / grounding routing is proven deterministically in
  // the required `ci` keiko-ui suites; this smoke proves the spoken turn reaches the chat send in the
  // real browser.
  await speak.click();
  await expect(stopAndSend).toBeVisible();
  await expect(stopAndSend).toHaveAttribute("aria-pressed", "true");
  await stopAndSend.click();
  await expect.poll(() => send.sends().length).toBeGreaterThanOrEqual(1);
  expect(send.sends()[0]).toMatch(/what is the deploy status/u);
  await expect(composer).toHaveValue("");

  // Issue #1560 lifecycle regression — committing that first turn flips the chat from empty to populated.
  // The dialogue session MUST survive that transition: the switch stays on and the per-turn controls
  // remain, so the user is NOT silently kicked back to the plain text composer mid-conversation. (On the
  // pre-fix two-slot composer layout the ComposerCore remounted here, resetting voiceDialog.active —
  // this is the assertion that fails against that regression.)
  await expect(dialogSwitch).toHaveAttribute("aria-checked", "true");
  await expect(speak).toBeVisible();

  // The continuous colleague-like dialogue: a SECOND spoken turn can be taken on the now-populated chat.
  await speak.click();
  await expect(stopAndSend).toBeVisible();
  await stopAndSend.click();
  await expect.poll(() => send.sends().length).toBeGreaterThanOrEqual(2);

  // AC3 — leaving removes the per-turn controls, flips the switch off, and runs the master cleanup; the
  // composer stays fully usable.
  await page.getByRole("button", { name: "Leave voice dialogue" }).click();
  await expect(speak).toHaveCount(0);
  await expect(dialogSwitch).toHaveAttribute("aria-checked", "false");
  await expect(composer).toBeVisible();
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

// Issue #1562, Epic #1556 — AC2/AC3/D3: microphone permission lifecycle browser evidence.
//
// Drives the real app composer through the documented dialogue path and asserts — at the browser layer —
// that the microphone is acquired only in response to an explicit user gesture (AC2) and is released
// deterministically when the user leaves dialogue mode (AC3). Instrumented via window.__micStats
// (see fakeMediaInitWithStats) so assertions are on observable call counts, not on timing.
//
// What this proves (D3 — manual browser verification as automated checked-in evidence):
//   - Entering dialogue mode does NOT open the microphone (getUserMedia count stays 0).
//   - Clicking "Start speaking" opens the microphone exactly once (getUserMedia count becomes 1)
//     and the visible recording state is reflected (aria-pressed="true" on the stop button).
//   - Clicking "Leave voice dialogue" stops all fake tracks (stopped count >= 1), satisfying the
//     deterministic resource-release requirement even when a capture cycle was in progress.
//   - The per-turn controls are removed after leaving, so the surface is clean (composer still usable).
//
// A screenshot is captured to docs/voice/evidence/1562-dialogue-mic-lifecycle.png as the D3 artifact.
// The coordinator runs the test to generate the PNG.
async function micLifecycleFlow(page: Page): Promise<void> {
  // Instrumented init: window.__micStats is set before any app script; getUserMedia/track.stop()
  // increment the counters so assertions on count=0 before capture are race-free.
  await page.addInitScript(fakeMediaInitWithStats());
  await stubCapability(page, FULL_REALTIME_NO_WEBRTC_CAPABILITY);
  await stubVoiceProviders(page);
  await openComposer(page);

  // Enter dialogue mode by toggling the switch.
  const dialogSwitch = page.getByRole("switch", { name: "Voice dialogue mode" });
  await expect(dialogSwitch).toBeVisible();
  await dialogSwitch.click();
  await expect(dialogSwitch).toHaveAttribute("aria-checked", "true");

  // AC2 — the microphone must NOT be opened merely by entering dialogue mode: the turn controls render
  // but getUserMedia must still be 0.
  const speak = page.getByRole("button", { name: "Start speaking" });
  await expect(speak).toBeVisible();
  await expect.poll(() => micStat(page, "getUserMedia")).toBe(0);

  // AC2 — clicking "Start speaking" is the explicit user gesture that opens the microphone exactly once,
  // and the visible recording state must be reflected immediately (aria-pressed on the stop control).
  await speak.click();
  await expect.poll(() => micStat(page, "getUserMedia")).toBe(1);
  const stopAndSend = page.getByRole("button", { name: "Stop speaking and send" });
  await expect(stopAndSend).toBeVisible();
  await expect(stopAndSend).toHaveAttribute("aria-pressed", "true");

  // Capture the live recording state as the D3 evidence artifact: the mic is open and the visible
  // recording control is shown. Leaving mid-recording (next) is the strongest AC3 release proof.
  await page.screenshot({
    path: "docs/voice/evidence/1562-dialogue-mic-lifecycle.png",
    fullPage: true,
  });

  // AC3 — leaving dialogue mode while the microphone is live must release all acquired tracks
  // deterministically (leaveVoiceDialog → dialogue session master teardown → dictation.cancel →
  // track.stop). Asserted before any turn commits, isolating the lifecycle from the chat-send re-render.
  await page.getByRole("button", { name: "Leave voice dialogue" }).click();
  await expect.poll(() => micStat(page, "stopped")).toBeGreaterThanOrEqual(1);

  // Per-turn controls removed, the switch inactive, and the composer still usable.
  await expect(speak).toHaveCount(0);
  await expect(dialogSwitch).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("textbox", { name: "Chat message" }).first()).toBeVisible();
}

test("voice dialogue @smoke — microphone acquired only on explicit gesture, released on leave (AC2/AC3/D3)", async ({
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
  // The partial deployment does not offer spoken dialogue: no switch, and text chat is unaffected.
  await expect(page.getByRole("switch", { name: "Voice dialogue mode" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start speaking" })).toHaveCount(0);
}

// Issue #1563 — voice selection + live session status browser evidence.
//
// Proves, in the real browser, two surfaces the evaluation's accessibility and lifecycle dimensions
// depend on: the voice/persona selector is operable and its visible active-voice label updates, and the
// live-region status strip announces the listening state when a turn begins. Captures the #1563 evidence
// screenshot of the active evaluation surface.
async function voiceSelectionAndStatusFlow(page: Page): Promise<void> {
  await page.addInitScript(fakeMediaInit());
  await stubCapability(page, FULL_REALTIME_NO_WEBRTC_CAPABILITY);
  await stubVoiceProviders(page);
  stubChatSend(page);
  await openComposer(page);

  const dialogSwitch = page.getByRole("switch", { name: "Voice dialogue mode" });
  await dialogSwitch.click();
  await expect(dialogSwitch).toHaveAttribute("aria-checked", "true");

  // Voice selection: the persona selector is operable, and choosing a voice updates its visible
  // active-voice label (the accessible name is the "Voice profile: <persona>" label).
  const profile = page.getByRole("combobox", { name: /^Voice profile/u });
  await expect(profile).toBeVisible();
  await profile.click();
  await page.getByRole("option", { name: "Neutral voice" }).click();
  await expect(page.getByRole("combobox", { name: "Voice profile: Neutral voice" })).toBeVisible();

  // Live status: beginning a turn announces the listening state through the live region.
  const speak = page.getByRole("button", { name: "Start speaking" });
  await speak.click();
  await expect(page.getByText("Listening to you.")).toBeVisible();

  await page.screenshot({
    path: "docs/voice/evidence/1563-dialogue-evaluation.png",
    fullPage: true,
  });

  // Leave returns to a clean, text-capable composer (master cleanup).
  await page.getByRole("button", { name: "Stop speaking and send" }).click();
  await page.getByRole("button", { name: "Leave voice dialogue" }).click();
  await expect(speak).toHaveCount(0);
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

test("voice dialogue @smoke — voice selection updates the active voice and status announces listening (AC1/AC4)", async ({
  page,
}) => {
  await voiceSelectionAndStatusFlow(page);
});
