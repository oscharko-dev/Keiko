// Voice recap regression smoke. The composer no longer exposes a separate "Review voice session"
// control. MemoriaViva capture runs through committed chat turns; STT remains only dictation, and
// Realtime Voice persists final transcripts through the normal chat lifecycle.
//
// Tagged @smoke so the Studio browser quality gate exercises it. The required `ci` check does not run
// Playwright; the executable AC coverage that runs in `ci` lives in the keiko-contracts + keiko-server +
// keiko-ui suites (voice-session-recap contract, voice-recap route, the recap hook, the VoiceRecap
// component, and the ChatWindow voice integration) and the keiko-evaluations voice-recap suite, which
// prove governed candidate creation, dormancy, content-free audit, and secret redaction (AC1–AC6).

import { expect, test, type Page } from "@playwright/test";

const REALTIME_CAPABILITY = {
  voice: {
    available: true,
    profile: "full-realtime",
    capabilities: { speechToText: true, speechOutput: true, realtimeVoice: true },
    transport: { websocketControl: true, webrtcMedia: true },
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

const SPEECH_OUTPUT_CAPABILITY = {
  voice: {
    available: true,
    profile: "speech-output",
    capabilities: { speechToText: false, speechOutput: true, realtimeVoice: false },
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

const RECAP_BUTTON = /review voice session/iu;

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
  await expect(page.getByRole("button", { name: RECAP_BUTTON })).toHaveCount(0);
}

async function playbackOnlyFlow(page: Page): Promise<void> {
  await stubCapability(page, SPEECH_OUTPUT_CAPABILITY);
  await openComposer(page);
  // Playback-only deployments capture no user transcript, so the recap control must be absent: a recap
  // derives from the committed user transcript, never from assistant speech output (AC1).
  await expect(page.getByRole("button", { name: RECAP_BUTTON })).toHaveCount(0);
}

async function noRecapControlFlow(page: Page, body: unknown, text: string): Promise<void> {
  await stubCapability(page, body);
  await openComposer(page);

  await expect(page.getByRole("button", { name: RECAP_BUTTON })).toHaveCount(0);
  const composer = page.getByRole("textbox", { name: "Chat message" }).first();
  await composer.fill(text);
  await expect(composer).toHaveValue(text);
}

test("voice recap @smoke — no-voice composer has no recap control (AC1)", async ({ page }) => {
  await noVoiceFlow(page);
});

test("voice recap @smoke — playback-only deployment has no recap control (AC1)", async ({
  page,
}) => {
  await playbackOnlyFlow(page);
});

test("voice recap @smoke — STT deployment keeps recap control absent; dictation remains separate (AC1)", async ({
  page,
}) => {
  await noRecapControlFlow(page, STT_CAPABILITY, "typing with an STT deployment");
  await expect(page.getByRole("button", { name: "Dictate a message" })).toBeVisible();
});

test("voice recap @smoke — full-realtime deployment keeps recap control absent (AC1)", async ({
  page,
}) => {
  await noRecapControlFlow(page, REALTIME_CAPABILITY, "typing with realtime voice available");
});
