// Issue #1559 — browser + accessibility evidence for the chat dialog-mode UX.
//
// Headless Chromium renders the dialog-mode surfaces against the REAL product globals.css via
// page.setContent (no file server — CodeQL-safe), in dark and light themes, for the eight session
// states the issue requires evidence for (active/idle, connecting, listening, thinking, speaking,
// muted, error, unavailable). Each rendered state is checked with axe-core (WCAG 2.x rules) and
// captured as a PNG. The markup mirrors the output of VoiceDialogMode.tsx exactly — the same
// classes, roles, aria-live wiring, headline strings, and data-dialog-state attribute that the
// keiko-ui unit tests pin against the real React components — so the screenshots reflect the shipped
// component contract without a React build step.
//
// Self-contained reproduction (from repo root, after `npm ci` + `npx playwright install chromium`):
//   node docs/design-system/evidence/1559/equivalence-harness.mjs
// Writes dialog-mode-proof.json + <state>-<theme>.png for every state, and exits non-zero if any
// serious/critical axe violation is found or a required state failed to render.

import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const CSS_PATH = "packages/keiko-ui/src/app/globals.css";
const AXE_PATH = resolve(REPO, "node_modules/axe-core/axe.min.js");

function git(args) {
  return execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).trim();
}

const cssText = readFileSync(resolve(REPO, CSS_PATH), "utf8");
const cssSha256 = createHash("sha256").update(cssText).digest("hex");
const axeSource = readFileSync(AXE_PATH, "utf8");
const repoHeadSha = git(["rev-parse", "HEAD"]);

// The product persona display labels (mirror VoiceDialogMode.tsx personaLabel).
const PERSONA_LABEL = { male: "Male voice", female: "Female voice", neutral: "Neutral voice" };

// The headline per dialog state (mirror voice-dialog-state.ts DIALOG_STATE_HEADLINE).
const HEADLINE = {
  idle: "Voice dialogue is ready.",
  connecting: "Connecting the voice dialogue…",
  listening: "Listening to you.",
  thinking: "The assistant is thinking.",
  speaking: "The assistant is speaking.",
  muted: "The assistant is speaking. Playback is muted.",
  interrupted: "Voice dialogue interrupted.",
  error: "Voice dialogue could not continue. You can keep chatting in text.",
};
const LIVE = new Set(["listening", "speaking", "muted"]);
const TEXT_FALLBACK =
  "Voice dialogue is optional. You can keep chatting with the assistant in text.";

// The eight evidence states. `available:false` is the unavailable deployment: the switch and all
// dialog controls are absent and only the untouched text composer affordance remains (AC3).
const STATES = [
  {
    id: "01-idle",
    state: "idle",
    active: true,
    muted: false,
    personas: ["male", "female", "neutral"],
    selected: "female",
    available: true,
  },
  {
    id: "02-connecting",
    state: "connecting",
    active: true,
    muted: false,
    personas: ["male", "female", "neutral"],
    selected: "female",
    available: true,
  },
  {
    id: "03-listening",
    state: "listening",
    active: true,
    muted: false,
    personas: ["male", "female", "neutral"],
    selected: "female",
    available: true,
  },
  {
    id: "04-thinking",
    state: "thinking",
    active: true,
    muted: false,
    personas: ["male", "female", "neutral"],
    selected: "male",
    available: true,
  },
  {
    id: "05-speaking",
    state: "speaking",
    active: true,
    muted: false,
    personas: ["male", "female", "neutral"],
    selected: "female",
    available: true,
  },
  {
    id: "06-muted",
    state: "muted",
    active: true,
    muted: true,
    personas: ["male", "female", "neutral"],
    selected: "neutral",
    available: true,
  },
  {
    id: "07-error",
    state: "error",
    active: true,
    muted: false,
    personas: ["male", "female", "neutral"],
    selected: "male",
    available: true,
  },
  {
    id: "08-unavailable",
    state: "idle",
    active: false,
    muted: false,
    personas: [],
    selected: undefined,
    available: false,
  },
];

const THEMES = [
  { id: "dark", attr: null },
  { id: "light", attr: "light" },
];

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// VoiceDialogModeSwitch (role=switch) — present whenever the deployment offers dialogue.
function switchMarkup(active) {
  return `<button type="button" role="switch" aria-checked="${active ? "true" : "false"}" aria-label="Voice dialogue mode" data-tip="Voice dialogue mode" data-active="${active ? "true" : "false"}" class="cmp-icon cmp-voice ui-tip"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M4 5h16v10H9l-4 4V5z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg></button>`;
}

// VoiceProfileSelect — KeikoSelect closed trigger + sr-only active-voice label.
function profileSelectMarkup(personas, selected) {
  if (personas.length === 0) return "";
  return `<div class="cmp-model mono"><span id="cmp-voice-dialog-profile-label" class="sr-only">Voice profile: ${escapeHtml(PERSONA_LABEL[selected])}</span><button class="ksel-trigger mono" aria-controls="ksel-menu" aria-expanded="false" aria-haspopup="listbox" aria-label="Voice profile" aria-labelledby="cmp-voice-dialog-profile-label" role="combobox" type="button"><span class="ksel-trigger-copy"><span class="ksel-trigger-label">${escapeHtml(PERSONA_LABEL[selected])}</span></span><span class="ksel-trigger-caret" aria-hidden="true">▾</span></button></div>`;
}

// VoicePlaybackMuteButton — reused mute control.
function muteMarkup(muted) {
  const label = muted ? "Unmute assistant voice" : "Mute assistant voice";
  return `<button type="button" class="cmp-icon cmp-voice ui-tip" data-muted="${muted ? "true" : "false"}" data-tip="${label}" aria-label="${label}" aria-pressed="${muted ? "true" : "false"}" aria-describedby="cmp-voice-playback-privacy-hint"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg><span id="cmp-voice-playback-privacy-hint" class="sr-only">Assistant speech is optional. The full response is always available as text in the conversation.</span></button>`;
}

// VoiceDialogSessionStatus — aria-live status strip (role=alert on error).
function statusMarkup(state) {
  const isError = state === "error";
  const live = LIVE.has(state);
  const liveAttr = isError ? "" : ' aria-live="polite"';
  const dot = live ? '<span class="cmp-voice-dot" aria-hidden="true"></span>' : "";
  const pClass = isError ? ' class="cmp-voice-error-text"' : "";
  return `<div class="cmp-voice-preview${isError ? " cmp-voice-error" : ""}" role="${isError ? "alert" : "status"}"${liveAttr} aria-atomic="true" data-dialog-state="${state}"><p${pClass}>${dot}${escapeHtml(HEADLINE[state])}</p><span class="sr-only">${escapeHtml(TEXT_FALLBACK)}</span></div>`;
}

// VoiceDialogControls — selector + mute + Stop + Leave cluster.
function controlsMarkup(spec) {
  return `<div class="cmp-voice-actions" data-dialog-state="${spec.state}">${profileSelectMarkup(spec.personas, spec.selected)}${muteMarkup(spec.muted)}<button type="button" class="cmp-voice-btn">Stop</button><button type="button" class="cmp-voice-btn">Leave voice dialogue</button></div>`;
}

// The always-present text composer affordance, so every screenshot shows that text chat is never
// blocked (AC1) — including the unavailable deployment, which shows ONLY this.
function composerMarkup() {
  return `<div class="ev-composer"><label class="sr-only" for="ev-chat">Chat message</label><textarea id="ev-chat" rows="2" placeholder="Message Keiko…"></textarea></div>`;
}

function bodyMarkup(spec) {
  if (!spec.available) {
    return `<section class="ev-card"><h3>Unavailable deployment — no dialogue affordance</h3>${composerMarkup()}</section>`;
  }
  return `<section class="ev-card"><h3>${escapeHtml(spec.state)} — switch ${spec.active ? "on" : "off"}</h3><div class="ev-bar">${switchMarkup(spec.active)}</div>${spec.active ? statusMarkup(spec.state) + controlsMarkup(spec) : ""}${composerMarkup()}</section>`;
}

function pageHtml(spec) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Issue #1559 dialog-mode evidence — ${escapeHtml(spec.id)}</title><style>${cssText}
  body{margin:0;padding:24px;background:var(--background-primary);color:var(--text-primary);font-family:var(--font-ui),system-ui,sans-serif}
  .ev-card{display:flex;flex-direction:column;gap:14px;max-width:560px}
  .ev-card h3{font:600 12px var(--font-mono),monospace;letter-spacing:.04em;text-transform:uppercase;color:var(--text-secondary);margin:0;border-bottom:1px solid var(--border-subtle);padding-bottom:8px}
  .ev-bar{display:flex;gap:10px;align-items:center}
  .ev-composer textarea{width:100%;box-sizing:border-box;background:var(--surface-raised,var(--background-secondary));color:var(--text-primary);border:1px solid var(--border-subtle);border-radius:10px;padding:10px 12px;font:inherit;resize:none}
  </style></head><body><div id="root">${bodyMarkup(spec)}</div></body></html>`;
}

const results = [];
let serious = 0;
let rendered = 0;

const browser = await chromium.launch();
try {
  for (const theme of THEMES) {
    const ctx = await browser.newContext({
      viewport: { width: 600, height: 520 },
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    await page.emulateMedia({ colorScheme: theme.id === "dark" ? "dark" : "light" });
    for (const spec of STATES) {
      await page.setContent(pageHtml(spec), { waitUntil: "load" });
      await page.evaluate((attr) => {
        const r = document.documentElement;
        r.removeAttribute("data-theme");
        if (attr) r.setAttribute("data-theme", attr);
      }, theme.attr);
      const file = `${spec.id}-${theme.id}.png`;
      await page.screenshot({ path: resolve(HERE, file), fullPage: true });
      rendered += 1;
      // axe-core a11y scan of the rendered state.
      await page.evaluate(axeSource);
      const axe = await page.evaluate(async () => {
        // eslint-disable-next-line no-undef
        const run = await axe.run(document, {
          runOnly: {
            type: "tag",
            values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
          },
        });
        return run.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
      });
      const seriousHere = axe.filter((v) => v.impact === "serious" || v.impact === "critical");
      serious += seriousHere.length;
      results.push({
        state: spec.id,
        semanticState: spec.state,
        theme: theme.id,
        file,
        axeViolations: axe,
      });
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}

const verdict = serious === 0 && rendered === STATES.length * THEMES.length ? "PASS" : "FAIL";
writeFileSync(
  resolve(HERE, "dialog-mode-proof.json"),
  `${JSON.stringify(
    {
      issue: 1559,
      verdict,
      cssSha256,
      repoHeadSha,
      statesCaptured: rendered,
      seriousOrCriticalAxeViolations: serious,
      axeTags: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      note: "Markup mirrors VoiceDialogMode.tsx / voice-dialog-state.ts and is contract-pinned by the keiko-ui unit tests. globals.css is unchanged by #1559.",
      results,
    },
    null,
    2,
  )}\n`,
);

console.log(
  `dialog-mode evidence: ${verdict} — ${rendered} screenshots, ${serious} serious/critical axe violations`,
);
process.exit(verdict === "PASS" ? 0 : 1);
