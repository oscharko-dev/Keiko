// Issue #504, Epic #491 — voice session recap browser smoke. Drives the REAL app composer in headless
// Chromium through the documented Studio path (Left Rail → Chat History → New). It proves the recap
// surface's capability gating in the real browser (AC1):
//   1. No-voice deployment: /api/voice/capability reports unavailable → NO "Review voice session" control
//      and the composer stays fully text-capable.
//   2. Playback-only (speech-output) deployment: the assistant can speak but NO user transcript is
//      captured → NO recap control (recap derives from the committed user transcript, not playback).
//   3. STT / full-realtime deployment: the recap control is present, accessible, and — because the live
//      composer does not yet feed committed transcript segments to the hook (the #500 transcript-segments
//      store is not yet consumed by the composer; the hook's `segments` prop is the seam) — it is
//      correctly inert (aria-disabled) until there is committed content, so it can never propose a memory
//      candidate from an empty session. The composer stays fully text-capable throughout.
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

async function transcriptCapturingFlow(
  page: Page,
  body: unknown,
  evidencePath: string,
): Promise<void> {
  await stubCapability(page, body);
  await openComposer(page);

  const recap = page.getByRole("button", { name: RECAP_BUTTON });
  await expect(recap).toBeVisible();
  // Inert until committed content exists (no live segment store wired yet); aria-disabled keeps focus
  // operability while preventing any side effect from an empty session (AC1).
  await expect(recap).toHaveAttribute("aria-disabled", "true");
  await page.screenshot({ path: evidencePath, fullPage: true });

  // The composer stays fully text-capable alongside the recap affordance.
  const composer = page.getByRole("textbox", { name: "Chat message" }).first();
  await composer.fill("typing with a voice-capable deployment");
  await expect(composer).toHaveValue("typing with a voice-capable deployment");
}

test("voice recap @smoke — no-voice composer has no recap control (AC1)", async ({ page }) => {
  await noVoiceFlow(page);
});

test("voice recap @smoke — playback-only deployment has no recap control (AC1)", async ({
  page,
}) => {
  await playbackOnlyFlow(page);
});

test("voice recap @smoke — STT deployment renders an accessible, inert-until-committed recap control (AC1)", async ({
  page,
}) => {
  await transcriptCapturingFlow(
    page,
    STT_CAPABILITY,
    "docs/voice/evidence/504-recap-stt-control.png",
  );
});

test("voice recap @smoke — full-realtime deployment renders the recap control (AC1)", async ({
  page,
}) => {
  await transcriptCapturingFlow(
    page,
    REALTIME_CAPABILITY,
    "docs/voice/evidence/504-recap-realtime-control.png",
  );
});
