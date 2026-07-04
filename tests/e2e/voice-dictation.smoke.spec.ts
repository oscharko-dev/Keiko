// Issue #495, Epic #491 — composer dictation browser smoke. Drives the REAL app composer in headless
// Chromium through the documented Studio path (Left Rail → Chat History → New). Two flows:
//   1. No-voice deployment: /api/voice/capability reports unavailable → the composer loads with NO
//      microphone affordance and stays fully text-capable (AC1).
//   2. STT-enabled deployment: /api/voice/capability is stubbed to advertise speech-to-text and
//      /api/voice/transcribe returns a deterministic transcript; a fake MediaRecorder is injected so
//      no real microphone/provider is touched (privacy contract: no real audio leaves the host). The
//      user dictates, stops, reviews/edits the transcript preview, and inserts it into the composer
//      (AC2/AC3), then a denied-permission run proves the composer survives the failure (AC4).
//
// Tagged @smoke so the Studio browser quality gate exercises it. The required `ci` check does not run
// Playwright; the executable AC coverage that runs in `ci` lives in the keiko-ui vitest suites.

import { expect, test, type Page } from "@playwright/test";
import { evidenceScreenshotPath } from "./support/evidence.js";

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

// Injected before any app script runs: a fake getUserMedia + MediaRecorder so the real component code
// exercises a complete capture cycle in the browser without touching hardware or a provider.
function fakeMediaInit(mode: "grant" | "deny"): string {
  return `
    (() => {
      const mode = ${JSON.stringify(mode)};
      const fakeTrack = { stop() {} };
      const fakeStream = { getTracks: () => [fakeTrack] };
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

// Each flow is a top-level helper so the test wiring stays well under the max-lines-per-function gate.
async function noVoiceFlow(page: Page): Promise<void> {
  await page.route("**/api/voice/capability", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(NO_VOICE_CAPABILITY) }),
  );
  await openComposer(page);
  const composer = page.getByRole("textbox", { name: "Chat message" }).first();
  await composer.fill("plain typed message");
  await expect(composer).toHaveValue("plain typed message");
  await expect(page.getByRole("button", { name: "Dictate a message" })).toHaveCount(0);
}

async function dictateInsertFlow(page: Page): Promise<void> {
  await page.addInitScript(fakeMediaInit("grant"));
  await page.route("**/api/voice/capability", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(STT_CAPABILITY) }),
  );
  await page.route("**/api/voice/transcribe", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ transcript: "dictated hello from the smoke test", confidence: 0.9 }),
    }),
  );
  await openComposer(page);

  const mic = page.getByRole("button", { name: "Dictate a message" });
  await expect(mic).toBeVisible();
  await mic.click();
  const stop = page.getByRole("button", { name: "Stop dictation" });
  await expect(stop).toBeVisible();
  await stop.click();

  const transcript = page.getByRole("textbox", { name: "Review your dictation" });
  await expect(transcript).toBeVisible();
  await expect(transcript).toHaveValue("dictated hello from the smoke test");
  await transcript.fill("dictated hello, edited");

  await page.getByRole("button", { name: "Insert transcript into the message" }).click();
  await expect(page.getByRole("textbox", { name: "Chat message" }).first()).toHaveValue(
    /dictated hello, edited/u,
  );
  await page.screenshot({
    path: evidenceScreenshotPath("docs/voice/evidence/495-dictation-insert.png"),
    fullPage: true,
  });
}

async function deniedPermissionFlow(page: Page): Promise<void> {
  await page.addInitScript(fakeMediaInit("deny"));
  await page.route("**/api/voice/capability", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(STT_CAPABILITY) }),
  );
  await openComposer(page);

  await page.getByRole("button", { name: "Dictate a message" }).click();
  // Scope to the dictation error text — Next.js also renders an empty role="alert" route announcer.
  await expect(page.getByText(/Microphone access was denied/u)).toBeVisible();
  const composer = page.getByRole("textbox", { name: "Chat message" }).first();
  await composer.fill("still typing fine");
  await expect(composer).toHaveValue("still typing fine");
}

test("composer dictation @smoke — no-voice composer is usable with no mic (AC1)", async ({
  page,
}) => {
  await noVoiceFlow(page);
});

test("composer dictation @smoke — dictate, review, edit, and insert (AC2/AC3)", async ({
  page,
}) => {
  await dictateInsertFlow(page);
});

test("composer dictation @smoke — denied permission does not break the composer (AC4)", async ({
  page,
}) => {
  await deniedPermissionFlow(page);
});
