// Issue #501, Epic #491 — assistant speech-output browser smoke. Drives the REAL app composer in
// headless Chromium through the documented Studio path (Left Rail → Chat History → New). Three flows:
//   1. No-voice deployment: /api/voice/capability reports unavailable → the composer loads with NO
//      assistant-voice playback control and stays fully text-capable (AC1).
//   2. STT-only deployment: capability advertises speech-to-text only → the dictation affordance is
//      present but NO playback control — dictation does not imply the assistant can speak (AC1).
//   3. Speech-output deployment: capability advertises speech output → the "Mute assistant voice" toggle
//      is present, accessible, and operable, and the composer stays fully text-capable. No new TTS model
//      is deployed; this proves the optional, capability-gated control renders without breaking text.
//
// Tagged @smoke so the Studio browser quality gate exercises it. The required `ci` check does not run
// Playwright; the executable AC coverage that runs in `ci` lives in the keiko-contracts + keiko-ui suites
// (voice-playback contract, voice-playback-state controller, VoicePlayback component, ChatWindow voice
// integration), which prove the lifecycle, the interruption → turn-manager boundary (AC2), and the
// content-free / no-stored-audio invariants (AC3/AC4).

import { expect, test, type Page } from "@playwright/test";

const SPEECH_OUTPUT_CAPABILITY = {
  voice: {
    available: true,
    profile: "speech-output",
    capabilities: { speechToText: false, speechOutput: true, realtimeVoice: false },
    transport: { websocketControl: true, webrtcMedia: false },
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

// A capture-capable browser so the STT-only flow renders the dictation affordance (the playback control
// must be absent independently of capture support).
const CAPTURE_FAKES_SCRIPT = `
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
  });
  window.MediaRecorder = class { static isTypeSupported() { return true; } start() {} stop() {} addEventListener() {} };
`;

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
  await expect(page.getByRole("button", { name: "Mute assistant voice" })).toHaveCount(0);
}

async function sttOnlyFlow(page: Page): Promise<void> {
  await page.addInitScript(CAPTURE_FAKES_SCRIPT);
  await stubCapability(page, STT_CAPABILITY);
  await openComposer(page);
  // Dictation is offered for an STT-only deployment, but NEVER the assistant-voice playback control:
  // dictation does not imply the assistant can speak (AC1).
  await expect(page.getByRole("button", { name: "Dictate a message" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Mute assistant voice" })).toHaveCount(0);
}

async function speechOutputFlow(page: Page): Promise<void> {
  await stubCapability(page, SPEECH_OUTPUT_CAPABILITY);
  await openComposer(page);

  const mute = page.getByRole("button", { name: "Mute assistant voice" });
  await expect(mute).toBeVisible();
  await expect(mute).toHaveAttribute("aria-pressed", "false");
  await page.screenshot({
    path: "docs/voice/evidence/501-speech-output-controls.png",
    fullPage: true,
  });

  // The toggle is operable and the composer stays fully text-capable.
  await mute.click();
  await expect(page.getByRole("button", { name: "Unmute assistant voice" })).toBeVisible();
  const composer = page.getByRole("textbox", { name: "Chat message" }).first();
  await composer.fill("typing with assistant voice muted");
  await expect(composer).toHaveValue("typing with assistant voice muted");
}

test("assistant speech output @smoke — no-voice composer has no playback control (AC1)", async ({
  page,
}) => {
  await noVoiceFlow(page);
});

test("assistant speech output @smoke — STT-only offers dictation but no playback control (AC1)", async ({
  page,
}) => {
  await sttOnlyFlow(page);
});

test("assistant speech output @smoke — speech-output renders an accessible mute toggle (AC1)", async ({
  page,
}) => {
  await speechOutputFlow(page);
});
