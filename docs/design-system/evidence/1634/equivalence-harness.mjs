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
  { file: "01-dark.png", theme: null, hc: null, forcedColors: "none", state: "loaded" },
  { file: "02-light.png", theme: "light", hc: null, forcedColors: "none", state: "loaded" },
  { file: "03-dark-hc.png", theme: null, hc: "more", forcedColors: "none", state: "loaded" },
  { file: "04-light-hc.png", theme: "light", hc: "more", forcedColors: "none", state: "loaded" },
  { file: "05-forced-colors.png", theme: null, hc: null, forcedColors: "active", state: "loaded" },
  { file: "06-responsive.png", theme: "light", hc: null, forcedColors: "none", state: "loaded", viewport: { width: 430, height: 940 } },
  { file: "07-loading.png", theme: "light", hc: null, forcedColors: "none", state: "loading" },
  { file: "08-error.png", theme: "light", hc: null, forcedColors: "none", state: "error" },
  { file: "09-focus-visible.png", theme: "light", hc: null, forcedColors: "none", state: "loaded", focusInput: true },
];

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function toolbar(disabledPrev = false, disabledNext = false) {
  return `<div class="pdfv-toolbar" role="group" aria-label="PDF preview controls">
    <div class="pdfv-group">
      <button type="button" class="pdfv-btn tm-action"${disabledPrev ? " disabled" : ""}>Previous</button>
      <label class="pdfv-page-field">
        <span class="sr-only">Current page</span>
        <input class="pdfv-page-input" value="2" aria-label="Current page">
      </label>
      <span class="pdfv-page-count mono">/ 3</span>
      <button type="button" class="pdfv-btn tm-action"${disabledNext ? " disabled" : ""}>Next</button>
    </div>
    <div class="pdfv-group">
      <button type="button" class="pdfv-btn tm-action">Zoom out</button>
      <button type="button" class="pdfv-btn tm-action">Zoom in</button>
      <button type="button" class="pdfv-btn tm-action" data-selected="true">Fit width</button>
      <button type="button" class="pdfv-btn tm-action">Fit page</button>
      <button type="button" class="pdfv-btn tm-action">Rotate left</button>
      <button type="button" class="pdfv-btn tm-action">Rotate right</button>
      <span class="pdfv-zoom mono">100%</span>
    </div>
  </div>`;
}

function loadedMarkup() {
  return `<div class="pdfv-shell">
    <div class="pdfv-header">
      <div class="pdfv-heading">
        <p class="pdfv-eyebrow">Verified preview</p>
        <h2 class="pdfv-title">Policy wording.pdf</h2>
        <p class="pdfv-meta">Local capsule · Page 2</p>
      </div>
      <span class="pdfv-chip">Approximate anchor</span>
    </div>
    ${toolbar()}
    <div class="pdfv-scroll" role="region" aria-label="Policy wording.pdf PDF preview">
      ${[1, 2, 3]
        .map(
          (page) => `<section class="pdfv-page" style="min-height: 420px">
          <div class="pdfv-page-frame">
            <div class="pdfv-page-meta mono">Page ${String(page)}</div>
            <canvas class="pdfv-page-canvas ev-pdf-page" aria-label="Page ${String(page)}"></canvas>
          </div>
        </section>`,
        )
        .join("")}
    </div>
  </div>`;
}

function loadingMarkup() {
  return `<div class="pdfv-shell">
    <div class="pdfv-header">
      <div class="pdfv-heading">
        <p class="pdfv-eyebrow">Verified preview</p>
        <h2 class="pdfv-title">Policy wording.pdf</h2>
        <p class="pdfv-meta">Local capsule · Page 2</p>
      </div>
      <span class="pdfv-chip">Page anchor</span>
    </div>
    ${toolbar()}
    <div class="lk-loading pdfv-status" role="status" aria-live="polite">Opening verified PDF preview...</div>
  </div>`;
}

function errorMarkup() {
  return `<div class="pdfv-shell">
    <div class="pdfv-header">
      <div class="pdfv-heading">
        <p class="pdfv-eyebrow">Verified preview</p>
        <h2 class="pdfv-title">Policy wording.pdf</h2>
        <p class="pdfv-meta">Local capsule · Page 2</p>
      </div>
      <span class="pdfv-chip">Anchor unavailable</span>
    </div>
    ${toolbar(true, true)}
    <div class="lk-empty pdfv-status" role="alert">
      <div class="lk-empty-icon">i</div>
      <p class="lk-empty-title">Preview unavailable</p>
      <p class="lk-empty-body">Open this viewer from a verified citation preview session.</p>
    </div>
  </div>`;
}

function viewerMarkup(state) {
  switch (state) {
    case "loading":
      return loadingMarkup();
    case "error":
      return errorMarkup();
    default:
      return loadedMarkup();
  }
}

function pageHtml(capture) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Issue #1634 PDF viewer evidence — ${escapeHtml(capture.file)}</title>
    <style>${cssText}
      body {
        margin: 0;
        padding: 24px;
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
        border-radius: 24px;
        overflow: hidden;
        background: var(--surface-primary);
        box-shadow: var(--shadow-pop);
      }
      .ev-caption {
        margin: 0 0 12px;
        color: var(--text-secondary);
        font: 600 12px var(--font-mono), monospace;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .ev-pdf-page {
        width: min(100%, 680px);
        height: 880px;
        border: 1px solid var(--border-subtle);
        background:
          linear-gradient(180deg, color-mix(in oklch, var(--surface-primary) 96%, var(--surface-elevated)), var(--surface-primary));
      }
    </style>
  </head>
  <body>
    <main class="ev-root">
      <p class="ev-caption">Issue #1634 · ${escapeHtml(capture.state)} · ${escapeHtml(capture.file)}</p>
      <section class="ev-card">
        ${viewerMarkup(capture.state)}
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
      viewport: capture.viewport ?? { width: 1280, height: 1160 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.emulateMedia({
      colorScheme: capture.theme === "light" ? "light" : "dark",
      forcedColors: capture.forcedColors,
      reducedMotion: "no-preference",
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
    if (capture.focusInput === true) {
      await page.locator(".pdfv-page-input").focus();
    }
    await page.locator(".ev-root").screenshot({ path: resolve(HERE, capture.file) });
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
        nodes: violation.nodes.length,
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
      viewport: capture.viewport ?? { width: 1280, height: 1160 },
      focusInput: capture.focusInput === true,
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
  resolve(HERE, "pdf-viewer-fidelity-proof.json"),
  `${JSON.stringify(
    {
      issue: 1634,
      verdict,
      cssSha256,
      captures: fidelityResults,
      summary:
        "Component-level browser evidence for the passive PDF viewer window foundation: token-backed chrome, toolbar, page well, responsive mobile width, high-contrast, and forced-colors coverage.",
    },
    null,
    2,
  )}\n`,
);

writeFileSync(
  resolve(HERE, "a11y-proof.json"),
  `${JSON.stringify(
    {
      issue: 1634,
      verdict,
      cssSha256,
      captures: a11yResults,
      gate: "zero serious/critical axe violations across captured viewer states and modes",
    },
    null,
    2,
  )}\n`,
);

if (verdict !== "PASS") {
  process.exitCode = 1;
}
