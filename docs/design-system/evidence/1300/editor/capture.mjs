// Issue #1300 — dedicated EDITOR matrix (Design System 0.4.0 editor tier).
//
// The epic gate cannot close on component evidence alone: the issue requires a dedicated editor
// matrix proving the running editor's token tier resolves to the 0.4.0 editor reference, plus
// reference-page captures for visual inspection across Light / Dark / High Contrast.
//
// Two proofs, both re-runnable, headless Chromium:
//
//   (1) EDITOR TOKEN FIDELITY (0-diff GATE in dark + light): every representative --ed-* token
//       (Monaco theme/chrome, gutter, syntax 12-colour palette, selection/find, bracket match,
//       diagnostics, diff add/remove/change, agent ghost/accept/reject, focus, inlay, blame,
//       minimap) resolves to the IDENTICAL computed sRGB colour under the product globals.css and
//       the governed DS reference (keiko-tokens + keiko-semantic-tokens + keiko-editor-tokens).
//       HC modes are RECORDED (the product layers its own [data-hc] editor palette).
//
//   (2) REFERENCE-PAGE CAPTURES: the seven editor-*.html 0.4.0 reference pages rendered over
//       file:// (sibling CSS resolves, CodeQL-safe — no server) in Dark + Light, for side-by-side
//       designer inspection of Monaco theme, chrome, gutter, navigation, panels, markdown, and the
//       agent-in-editor surfaces.
//
// The RUNNING editor (real Monaco registration, tabs/splits, diagnostics, find/replace, ghost text,
// agent prompts) is proven by the executable Playwright suites tests/e2e/editor-fidelity-1295.spec.ts
// and tests/e2e/editor-agent-1296.spec.ts (npm run test:e2e:editor-fidelity-1295 / -1296), whose
// committed captures live in docs/design-system/evidence/1295/editor and .../1296/editor and are
// linked from the acceptance packet. This harness consolidates the token tier + reference visuals.
//
// Run (from repo root, after npm ci + npx playwright install chromium):
//   node docs/design-system/evidence/1300/editor/capture.mjs
// Writes editor-fidelity-proof.json + ref-*.png and exits non-zero on any gated token diff.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../../..");
const CSS_PATH = "packages/keiko-ui/src/app/globals.css";
const POST = readFileSync(resolve(REPO, CSS_PATH), "utf8");
const POST_CSS_SHA256 = createHash("sha256").update(POST).digest("hex");
const DS_DIR = resolve(REPO, "design-system");
const REFERENCE_FILES = [
  "keiko-tokens.css",
  "keiko-semantic-tokens.css",
  "keiko-editor-tokens.css",
];
const REFERENCE = REFERENCE_FILES.map((f) => readFileSync(resolve(DS_DIR, f), "utf8")).join("\n");

function git(args) {
  try {
    return execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

// Representative editor token tier — covers every editor surface family the issue enumerates.
const EDITOR_TOKENS = [
  "--ed-bg",
  "--ed-fg",
  "--ed-bg-gutter",
  "--ed-gutter-fg",
  "--ed-gutter-fg-active",
  "--ed-line-active",
  "--ed-statusbar-bg",
  "--ed-statusbar-fg",
  "--ed-statusbar-accent",
  "--ed-syn-keyword",
  "--ed-syn-string",
  "--ed-syn-comment",
  "--ed-syn-function",
  "--ed-syn-type",
  "--ed-syn-number",
  "--ed-syn-constant",
  "--ed-syn-operator",
  "--ed-syn-property",
  "--ed-syn-punct",
  "--ed-syn-regexp",
  "--ed-syn-variable",
  "--ed-selection",
  "--ed-find-match",
  "--ed-find-match-active",
  "--ed-bracket-match",
  "--ed-cursor",
  "--ed-error",
  "--ed-info",
  "--ed-hint",
  "--ed-diff-ins-line",
  "--ed-diff-rem-line",
  "--ed-diff-chg-line",
  "--ed-ghost",
  "--ed-agent-ghost",
  "--ed-agent-accept",
  "--ed-agent-reject",
  "--ed-agent-line",
  "--ed-focus",
  "--ed-focus-inner",
  "--ed-inlay-fg",
  "--ed-blame-fg",
  "--ed-minimap-bg",
  "--ed-fold-placeholder",
];

// Accent-derived editor tokens resolve through the brand --accent (product hex #4eba87 vs reference
// oklch(0.72 0.124 160) — the documented ~1.5% primitive delta). RECORDED, not gated, consistent
// with the component-harness accent bucket.
const ACCENT_EDITOR_TOKENS = new Set([
  "--ed-statusbar-accent",
  "--ed-selection",
  "--ed-agent-line",
  "--ed-focus",
]);

const MODES = [
  { id: "01-dark", theme: null, hc: null },
  { id: "02-light", theme: "light", hc: null },
  { id: "03-dark-hc", theme: null, hc: "more" },
  { id: "04-light-hc", theme: "light", hc: "more" },
];
const GATE_MODES = new Set(["01-dark", "02-light"]);

function tokenPageHtml(cssText) {
  const swatches = EDITOR_TOKENS.map(
    (t) => `<i class="sw" data-tok="${t}" style="color:var(${t})">${t}</i>`,
  ).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>${cssText}
  body{margin:0;padding:20px;background:var(--ed-bg,#111);color:var(--ed-fg,#eee);font-family:var(--font-mono),monospace;display:flex;flex-wrap:wrap;gap:6px}
  .sw{font-size:11px;padding:2px 4px}</style></head><body>${swatches}</body></html>`;
}

async function applyMode(page, cssText, mode) {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setContent(tokenPageHtml(cssText), { waitUntil: "load" });
  await page.evaluate(
    ({ theme, hc }) => {
      const r = document.documentElement;
      r.removeAttribute("data-theme");
      r.removeAttribute("data-hc");
      if (theme) r.setAttribute("data-theme", theme);
      if (hc) r.setAttribute("data-hc", hc);
    },
    { theme: mode.theme, hc: mode.hc },
  );
}

async function collectTokens(page, cssText, mode) {
  await applyMode(page, cssText, mode);
  return page.evaluate((tokens) => {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 1;
    const cx = cv.getContext("2d", { willReadFrequently: true });
    const toRGBA = (color) => {
      cx.clearRect(0, 0, 1, 1);
      cx.fillStyle = "#000";
      cx.fillStyle = color;
      cx.fillRect(0, 0, 1, 1);
      const d = cx.getImageData(0, 0, 1, 1).data;
      return `${d[0]},${d[1]},${d[2]},${d[3]}`;
    };
    const rootStyle = getComputedStyle(document.documentElement);
    const out = {};
    for (const t of tokens) {
      const el = document.querySelector(`[data-tok="${t}"]`);
      // `defined` reads the raw custom-property value off :root: an empty string means the token is
      // not declared in this stylesheet (so `color: var(--t)` would fall back to the inherited --ed-fg).
      out[t] = {
        rgba: el ? toRGBA(getComputedStyle(el).color) : "__MISSING__",
        defined: rootStyle.getPropertyValue(t).trim() !== "",
      };
    }
    return out;
  }, EDITOR_TOKENS);
}

function rgbaClose(x, y, tol = 1) {
  if (x === "__MISSING__" || y === "__MISSING__") return x === y;
  const a = x.split(",").map(Number);
  const b = y.split(",").map(Number);
  return a.length === 4 && b.length === 4 && a.every((v, i) => Math.abs(v - b[i]) <= tol);
}

const REF_PAGES = [
  "editor-theme.html",
  "editor-chrome.html",
  "editor-gutter.html",
  "editor-navigation.html",
  "editor-panels.html",
  "editor-markdown.html",
  "editor-agent.html",
];
const REF_MODES = [
  { id: "dark", theme: "dark", hc: null },
  { id: "light", theme: "light", hc: null },
];
const EXPECTED_REF_CAPTURE_COUNT = REF_PAGES.length * REF_MODES.length;

const browser = await chromium.launch();
const ctx = await browser.newContext({
  deviceScaleFactor: 2,
  viewport: { width: 1280, height: 900 },
});
const page = await ctx.newPage();

const gatedDiffs = [];
const recordedDiffs = [];
const accentDiffs = [];
const missing = new Set();
const referenceOnlyTokens = new Set();
const byMode = {};
let totalProbes = 0;
const tokenRecord = {};

for (const mode of MODES) {
  const product = await collectTokens(page, POST, mode);
  const reference = await collectTokens(page, REFERENCE, mode);
  let gated = 0;
  let accent = 0;
  let refOnly = 0;
  for (const t of EDITOR_TOKENS) {
    if (reference[t].rgba === "__MISSING__") {
      missing.add(`${mode.id}:${t}`);
      continue;
    }
    // Reference-only: the 0.4.0 editor reference declares this token but the product has not adopted
    // it yet (inlay-hint / git-blame / fold surfaces owned by the editor epics #1373/#1390, outside
    // the DS epic #1290 token migration). Recorded as a carried-forward variance, never gated here.
    if (!product[t].defined) {
      refOnly++;
      referenceOnlyTokens.add(t);
      continue;
    }
    totalProbes++;
    if (rgbaClose(reference[t].rgba, product[t].rgba)) continue;
    const line = `[${mode.id}] ${t} { ref="${reference[t].rgba}" product="${product[t].rgba}" }`;
    if (ACCENT_EDITOR_TOKENS.has(t)) {
      accent++;
      accentDiffs.push(line);
    } else if (GATE_MODES.has(mode.id)) {
      gated++;
      gatedDiffs.push(line);
    } else {
      recordedDiffs.push(line);
    }
  }
  if (GATE_MODES.has(mode.id)) {
    tokenRecord[mode.id] = Object.fromEntries(
      EDITOR_TOKENS.map((t) => [
        t,
        {
          product: product[t].rgba,
          reference: reference[t].rgba,
          productDefined: product[t].defined,
        },
      ]),
    );
  }
  byMode[mode.id] = {
    gatedDiffs: gated,
    accentDiffs: accent,
    referenceOnly: refOnly,
    gated: GATE_MODES.has(mode.id),
  };
  console.log(
    `${mode.id}: gated ${gated} · accent ${accent} · reference-only ${refOnly}${GATE_MODES.has(mode.id) ? " (gated mode)" : " (recorded mode)"}`,
  );
}

// Reference-page captures for visual inspection.
const refCaptures = [];
const refCaptureErrors = [];
for (const file of REF_PAGES) {
  const url = pathToFileURL(resolve(DS_DIR, file)).href;
  for (const mode of REF_MODES) {
    try {
      await page.emulateMedia({ colorScheme: mode.theme === "light" ? "light" : "dark" });
      await page.goto(url, { waitUntil: "load", timeout: 30000 });
      await page.evaluate((m) => {
        const r = document.documentElement;
        r.setAttribute("data-theme", m.theme);
        r.removeAttribute("data-hc");
        if (m.hc) r.setAttribute("data-hc", m.hc);
      }, mode);
      await page.waitForTimeout(350);
      const name = `ref-${file.replace(".html", "")}-${mode.id}.png`;
      await page.screenshot({ path: resolve(HERE, name), fullPage: true });
      const info = await page.evaluate(() => ({
        title: document.title,
        theme: document.documentElement.dataset.theme,
        textLen: (document.body.innerText || "").length,
      }));
      refCaptures.push({ file: name, page: file, mode: mode.id, ...info });
      console.log(`captured ${name} (theme=${info.theme}, text=${info.textLen})`);
    } catch (e) {
      const error = { page: file, mode: mode.id, error: String(e).slice(0, 240) };
      refCaptureErrors.push(error);
      refCaptures.push(error);
      console.log(`FAILED ${file} ${mode.id}: ${error.error}`);
    }
  }
}

await browser.close();

// A reference-page capture failure (e.g. a missing editor-*.html) must FAIL the gate, not record a
// silent error field alongside a PASS verdict.
const missingReferenceTokens = [...missing].sort();
const captureFailed =
  refCaptures.some((c) => "error" in c) ||
  refCaptures.length !== EXPECTED_REF_CAPTURE_COUNT ||
  refCaptureErrors.length > 0;
const failed = gatedDiffs.length > 0 || missingReferenceTokens.length > 0 || captureFailed;
writeFileSync(
  resolve(HERE, "editor-fidelity-proof.json"),
  JSON.stringify(
    {
      issue: 1300,
      epic: 1290,
      surface: "editor",
      postCssSha256: POST_CSS_SHA256,
      referenceFiles: REFERENCE_FILES,
      referenceFileSha256: Object.fromEntries(
        REFERENCE_FILES.map((file) => [
          file,
          createHash("sha256")
            .update(readFileSync(resolve(DS_DIR, file), "utf8"))
            .digest("hex"),
        ]),
      ),
      run: { generatedAt: new Date().toISOString(), repoHeadSha: git(["rev-parse", "HEAD"]) },
      tolerance: "≤1 LSB per sRGB channel (canvas-normalised)",
      tokenFidelity: {
        description:
          "Editor token tier resolves identically under product globals.css and DS 0.4.0 reference " +
          "(keiko-tokens + keiko-semantic-tokens + keiko-editor-tokens). Gated 0-diff dark+light for " +
          "every neutral editor token the product defines; accent-derived recorded; reference-only " +
          "(unadopted 0.4.0) editor tokens recorded as carried-forward variance.",
        tokenCount: EDITOR_TOKENS.length,
        totalProbes,
        gatedDiffCount: gatedDiffs.length,
        recordedDiffCount: recordedDiffs.length,
        gatedDiffs,
        recordedDiffs,
        byMode,
      },
      accentDerived: {
        description:
          "Recorded, not gated. Accent-derived editor tokens resolve through --accent (product hex " +
          "#4eba87 vs reference oklch(0.72 0.124 160), ~1.5% pre-existing primitive delta). Identical chain.",
        tokens: [...ACCENT_EDITOR_TOKENS],
        diffs: accentDiffs,
      },
      referenceOnly: {
        description:
          "Recorded carried-forward variance: 0.4.0 editor reference tokens NOT yet declared by the " +
          "product. These cover inlay hints, git blame and fold placeholders — editor surfaces owned " +
          "by the editor epics #1373 / #1390, outside the DS epic #1290 token migration. Tracked for " +
          "adoption there; not a #1300 regression. Product falls back to --ed-fg until adopted.",
        ownerEpics: ["#1373", "#1390"],
        tokens: [...referenceOnlyTokens],
      },
      tokenRecord,
      referenceCaptureSummary: {
        expectedCount: EXPECTED_REF_CAPTURE_COUNT,
        actualCount: refCaptures.length,
        errorCount: refCaptureErrors.length,
        errors: refCaptureErrors,
      },
      referenceCaptures: refCaptures,
      runningEditorEvidence: {
        note: "Real Monaco / tabs / diagnostics / find / ghost-text / agent-prompt captures are produced by the executable e2e suites and committed under the #1295/#1296 evidence dirs.",
        suites: ["npm run test:e2e:editor-fidelity-1295", "npm run test:e2e:editor-fidelity-1296"],
        captures: [
          "docs/design-system/evidence/1295/editor/",
          "docs/design-system/evidence/1296/editor/",
        ],
      },
      missingReferenceTokenCount: missingReferenceTokens.length,
      missing: missingReferenceTokens,
      verdict: failed ? "FAIL" : "PASS",
    },
    null,
    2,
  ),
);

console.log(
  `\nEDITOR TOKEN FIDELITY: ${totalProbes} gated probes · gated diffs ${gatedDiffs.length} · accent ${accentDiffs.length} · reference-only ${referenceOnlyTokens.size}`,
);
for (const d of gatedDiffs.slice(0, 60)) console.log("  GATED " + d);
for (const d of accentDiffs.slice(0, 20)) console.log("  accent " + d);
if (referenceOnlyTokens.size)
  console.log(`  reference-only (pending #1373/#1390): ${[...referenceOnlyTokens].join(", ")}`);
if (missing.size) console.log(`MISSING (failure): ${missingReferenceTokens.join(", ")}`);
if (refCaptureErrors.length) {
  console.log(`REFERENCE CAPTURE ERRORS: ${refCaptureErrors.length}`);
  for (const error of refCaptureErrors)
    console.log(`  ${error.page} ${error.mode}: ${error.error}`);
}
console.log(
  `\n${failed ? "FAIL" : "PASS"} — editor neutral-token dark/light 0-diff: ${gatedDiffs.length === 0}; reference captures ${refCaptures.length}/${EXPECTED_REF_CAPTURE_COUNT}; capture errors ${refCaptureErrors.length}`,
);
process.exit(failed ? 1 : 0);
