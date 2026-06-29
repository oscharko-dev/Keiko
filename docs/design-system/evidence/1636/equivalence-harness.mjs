import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const CSS_PATH = "packages/keiko-ui/src/app/globals.css";
const AXE_PATH = resolve(REPO, "node_modules/axe-core/axe.min.js");

const cssText = readFileSync(resolve(REPO, CSS_PATH), "utf8");
const cssSha256 = createHash("sha256").update(cssText).digest("hex");
const axeSource = readFileSync(AXE_PATH, "utf8");

mkdirSync(HERE, { recursive: true });

const CAPTURES = [
  { file: "01-context-dark.png", theme: null, hc: null, forcedColors: "none", state: "context" },
  { file: "02-context-light.png", theme: "light", hc: null, forcedColors: "none", state: "context" },
  { file: "03-sibling-active.png", theme: "light", hc: null, forcedColors: "none", state: "siblings" },
  { file: "04-back-disabled.png", theme: "light", hc: null, forcedColors: "none", state: "disabled" },
  { file: "05-chat-highlight.png", theme: "light", hc: null, forcedColors: "none", state: "highlight" },
  { file: "06-responsive.png", theme: "light", hc: null, forcedColors: "none", state: "context", viewport: { width: 430, height: 900 } },
  { file: "07-forced-colors.png", theme: null, hc: null, forcedColors: "active", state: "context" },
];

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function toolbar() {
  return `<div class="pdfv-toolbar" role="group" aria-label="PDF preview controls">
    <div class="pdfv-group">
      <button type="button" class="pdfv-btn tm-action">Previous</button>
      <label class="pdfv-page-field">
        <span class="sr-only">Current page</span>
        <input class="pdfv-page-input" value="8" aria-label="Current page">
      </label>
      <span class="pdfv-page-count mono">/ 12</span>
      <button type="button" class="pdfv-btn tm-action">Next</button>
    </div>
    <div class="pdfv-group">
      <button type="button" class="pdfv-btn tm-action" data-selected="true">Fit width</button>
      <button type="button" class="pdfv-btn tm-action">Fit page</button>
      <button type="button" class="pdfv-btn tm-action">Rotate right</button>
    </div>
  </div>`;
}

function contextPanel({ activeMarker = "[2]", disabledBack = false } = {}) {
  const disabledText = disabledBack
    ? `<span id="back-disabled-reason" class="pdfv-back-to-chat-hint">The originating answer is no longer available.</span>`
    : "";
  const ariaDisabled = disabledBack ? ` aria-disabled="true" aria-describedby="back-disabled-reason"` : "";
  const tip = disabledBack
    ? "The originating answer is no longer available."
    : "Restore the originating chat and highlight this citation";
  return `<section class="pdfv-context" aria-label="Citation context">
    <div class="pdfv-context-head">
      <div class="pdfv-context-copy">
        <p class="pdfv-context-eyebrow">Answer-local citation context</p>
        <h3 class="pdfv-context-title">${escapeHtml(activeMarker)} Product Manual / Policy wording.pdf</h3>
        <p class="pdfv-context-message">Keiko opened the verified source page near the cited passage. Exact PDF highlights are not part of this viewer.</p>
      </div>
      <div class="pdfv-context-actions">
        <button type="button" class="tm-action pdfv-back-to-chat" data-tip="${escapeHtml(tip)}"${ariaDisabled}>
          <span aria-hidden="true">Back</span>
          <span>Back to chat</span>
        </button>
        ${disabledText}
      </div>
    </div>
    <div class="pdfv-context-rail">
      <span class="grounded-citations-label">Same answer citations</span>
      <ul class="grounded-citations pdfv-context-list" aria-label="Same answer citations">
        ${["[1]", "[2]", "[3]"]
          .map((marker, index) => {
            const active = marker === activeMarker;
            const page = index === 0 ? "Page 3" : index === 1 ? "Active" : "Page 11";
            return `<li class="grounded-citations-item">
              <button type="button" class="grounded-citation grounded-citation-action pdfv-context-citation" aria-pressed="${String(active)}" data-active="${String(active)}">
                <span class="grounded-citation-range">${escapeHtml(marker)} Product Manual / Policy wording.pdf</span>
                <span class="grounded-citation-action-label">${escapeHtml(page)}</span>
              </button>
            </li>`;
          })
          .join("")}
      </ul>
    </div>
  </section>`;
}

function viewerMarkup(state) {
  const disabledBack = state === "disabled";
  const activeMarker = state === "siblings" ? "[3]" : "[2]";
  return `<div class="pdfv-shell">
    <div class="pdfv-header">
      <div class="pdfv-heading">
        <p class="pdfv-eyebrow">Verified preview</p>
        <h2 class="pdfv-title">Policy wording.pdf</h2>
        <p class="pdfv-meta">Product Manual / Policy wording.pdf - Page 8</p>
      </div>
      <span class="pdfv-chip">Near cited passage</span>
    </div>
    ${contextPanel({ activeMarker, disabledBack })}
    ${toolbar()}
    <div class="pdfv-scroll" role="region" aria-label="Policy wording.pdf PDF preview">
      <section class="pdfv-page" style="min-height: 360px">
        <div class="pdfv-page-frame">
          <div class="pdfv-page-meta mono">Page 8</div>
          <canvas class="pdfv-page-canvas ev-pdf-page" aria-label="Page 8"></canvas>
        </div>
      </section>
    </div>
  </div>`;
}

function chatHighlightMarkup() {
  return `<div class="chatw-log">
    <article class="chat-msg" data-role="assistant" data-layout="turn" tabindex="-1">
      <div class="chat-msg-bubble">
        <div class="chat-msg-content">
          <p class="sm-p">The policy allows citation inspection <button type="button" class="citation-inline-marker citation-inline-marker--available" data-back-to-chat-highlighted="true">[2]</button>.</p>
        </div>
        <div class="chatw-grounded chatw-grounded-inline">
          <details class="grounded-evidence-disclosure" open>
            <summary class="grounded-evidence-summary">
              <span class="grounded-evidence-summary-title">Evidence</span>
              <span class="grounded-evidence-summary-meta">3 knowledge citations</span>
            </summary>
            <div class="grounded-evidence-body">
              <ul class="grounded-citations" aria-label="Knowledge citations">
                <li class="grounded-citations-item">
                  <button type="button" class="grounded-citation grounded-citation-action" data-back-to-chat-highlighted="true" aria-label="[2] Product Manual / Policy wording.pdf - Open PDF">
                    <span class="grounded-citation-range">[2] Product Manual / Policy wording.pdf</span>
                    <span class="grounded-citation-action-label">Open PDF</span>
                  </button>
                </li>
              </ul>
            </div>
          </details>
        </div>
      </div>
    </article>
  </div>`;
}

function surfaceMarkup(state) {
  return state === "highlight" ? chatHighlightMarkup() : viewerMarkup(state);
}

function pageHtml(capture) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Issue #1636 citation context evidence - ${escapeHtml(capture.file)}</title>
    <style>${cssText}
      body {
        margin: 0;
        padding: var(--space-8);
        background: var(--background-primary);
        color: var(--text-primary);
        font-family: var(--font-ui), system-ui, sans-serif;
      }
      .ev-root {
        max-width: 980px;
        margin: 0 auto;
      }
      .ev-card {
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-floating);
        overflow: hidden;
        background: var(--surface-primary);
        box-shadow: var(--shadow-pop);
      }
      .ev-caption {
        margin: 0 0 var(--space-5);
        color: var(--text-secondary);
        font: var(--weight-semibold) var(--text-label) var(--font-mono), monospace;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .ev-pdf-page {
        width: min(100%, 680px);
        height: 440px;
        border: 1px solid var(--border-subtle);
        background:
          linear-gradient(180deg, color-mix(in oklch, var(--surface-primary) 96%, var(--surface-elevated)), var(--surface-primary));
      }
      .chatw-log {
        padding: var(--space-8);
      }
    </style>
  </head>
  <body>
    <main class="ev-root">
      <p class="ev-caption">Issue #1636 - ${escapeHtml(capture.state)} - ${escapeHtml(capture.file)}</p>
      <section class="ev-card">
        ${surfaceMarkup(capture.state)}
      </section>
    </main>
  </body>
</html>`;
}

const browser = await chromium.launch();
const fidelityResults = [];
const a11yResults = [];
let seriousViolations = 0;

try {
  for (const capture of CAPTURES) {
    const context = await browser.newContext({
      viewport: capture.viewport ?? { width: 1280, height: 980 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.emulateMedia({
      colorScheme: capture.theme === "light" ? "light" : "dark",
      forcedColors: capture.forcedColors,
      reducedMotion: "reduce",
    });
    await page.setContent(pageHtml(capture), { waitUntil: "load" });
    await page.evaluate(
      ({ hc, theme }) => {
        const root = document.documentElement;
        root.removeAttribute("data-theme");
        root.removeAttribute("data-hc");
        root.setAttribute("data-input-modality", "keyboard");
        if (theme) root.setAttribute("data-theme", theme);
        if (hc) root.setAttribute("data-hc", hc);
      },
      { hc: capture.hc, theme: capture.theme },
    );
    await page.locator(".ev-root").screenshot({
      animations: "disabled",
      path: resolve(HERE, capture.file),
    });
    await page.evaluate(axeSource);
    const axeViolations = await page.evaluate(async () => {
      // eslint-disable-next-line no-undef
      const run = await axe.run(document, {
        runOnly: {
          type: "tag",
          values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
        },
      });
      return run.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        nodes: violation.nodes.map((node) => ({
          target: node.target,
          summary: node.failureSummary,
        })),
      }));
    });
    const serious = axeViolations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical",
    );
    seriousViolations += serious.length;
    fidelityResults.push({
      file: capture.file,
      theme: capture.theme ?? "dark",
      hc: capture.hc ?? false,
      forcedColors: capture.forcedColors,
      state: capture.state,
      viewport: capture.viewport ?? { width: 1280, height: 980 },
    });
    a11yResults.push({
      file: capture.file,
      violations: axeViolations,
    });
    await context.close();
  }
} finally {
  await browser.close();
}

const verdict = seriousViolations === 0 ? "PASS" : "FAIL";

writeFileSync(
  resolve(HERE, "citation-context-back-to-chat-fidelity-proof.json"),
  `${JSON.stringify(
    {
      issue: 1636,
      verdict,
      cssSha256,
      captures: fidelityResults,
      summary:
        "Browser-rendered visual evidence for answer-local PDF citation context, sibling citation navigation, Back to chat disabled state, transient chat highlight, responsive layout, and forced-colors coverage.",
    },
    null,
    2,
  )}\n`,
);

writeFileSync(
  resolve(HERE, "a11y-proof.json"),
  `${JSON.stringify(
    {
      issue: 1636,
      verdict,
      cssSha256,
      captures: a11yResults,
      gate: "zero serious/critical axe violations across captured citation-context and Back to chat states",
    },
    null,
    2,
  )}\n`,
);

if (verdict !== "PASS") {
  process.exitCode = 1;
}
