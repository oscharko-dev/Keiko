// Issue #1298 — computed-value proof + browser evidence for the input family + navigation
// component layer. Headless Chromium, all 7 theme/contrast/motion modes via page.setContent
// (no file server — CodeQL-safe). Two claims are proved against the REAL product globals.css:
//
//   GROUP R (reference fidelity, 0-diff gate in dark + light): the NEW canonical .c-* input /
//     navigation primitives are rendered with (a) the product POST globals.css and (b) the
//     governed DS 0.4.0 reference CSS (keiko-tokens + keiko-semantic-tokens + keiko-inputs +
//     keiko-nav). Every NEUTRAL/semantic-tier surface (checkbox/radio/stepper/combo/date borders
//     and fills, breadcrumb/pagination/context text, tab/step chrome, popover surfaces) MUST match
//     in the two canonical theme modes, proving the port resolves identically to inputs.html /
//     nav-components.html. HC / forced-colors / reduced-motion are RECORDED (the product layers its
//     own HC handling the bare reference page does not).
//
//   GROUP ACCENT (recorded, not gated): accent-derived surfaces (selected checkbox, tag, slider
//     fill, current page, completed step) resolve through the brand --accent, which the product
//     defines as hex #4eba87 (rgb 78,186,135) while the DS reference uses oklch(0.72 0.124 160)
//     (rgb 82,188,138) — a ~1.5% pre-existing primitive delta outside #1298. The token chain is
//     identical in both. Recorded per mode with explanation.
//
// The one product adopter (the workflow-handoff "Expected checks" list adopting .c-check) is a
// React change proved by WorkflowHandoff.a11y.test.tsx (role/name preserved, glyph aria-hidden,
// toggle behaviour, axe-clean) — not reproducible in this CSS-only harness.
//
// Self-contained reproduction (from repo root, after `npm ci` + `npx playwright install chromium`):
//   BASE_REF=origin/release/0.2.0 node docs/design-system/evidence/1298/equivalence-harness.mjs
// Writes computed-value-proof.json + 01-dark.png … 09-responsive.png and exits non-zero if any
// Group-R (dark/light) computed value differs.
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const CSS_PATH = "packages/keiko-ui/src/app/globals.css";
// BASE_REF is recorded as provenance only (this harness compares the working-tree globals.css against
// the design-system reference files — it shells out to nothing). Constrain it to a git-ref charset so
// the recorded value stays well-formed.
const BASE_REF = process.env.BASE_REF ?? "origin/release/0.2.0";
if (!/^[\w./-]+$/.test(BASE_REF)) {
  throw new Error(`refusing malformed BASE_REF: ${BASE_REF}`);
}

const POST = readFileSync(resolve(REPO, CSS_PATH), "utf8");

// Governed DS 0.4.0 reference: token tiers + the input + nav component layers, concatenated exactly
// as inputs.html / nav-components.html link them (ds.css / components.css carry only layout helpers,
// not the probed .c-* component colours).
const DS_DIR = resolve(REPO, "design-system");
const REFERENCE = [
  "keiko-tokens.css",
  "keiko-semantic-tokens.css",
  "keiko-inputs.css",
  "keiko-nav.css",
]
  .map((f) => readFileSync(resolve(DS_DIR, f), "utf8"))
  .join("\n");

// ─── Representative markup ────────────────────────────────────────────────────
// Mirrors inputs.html (checkbox/radio/slider/stepper/combobox/tag/file/date) and
// nav-components.html (breadcrumbs/back/underline tabs/pagination/context menu/steps). SVGs from the
// reference are simplified to glyphs (colour-irrelevant).
const CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 12.5 L10 17.5 L19 6.5"/></svg>`;
const BODY = `
<section class="ev-sec"><h3>Inputs (.c-* — DS 0.4.0)</h3>
  <div class="ev-row">
    <label class="c-check"><input type="checkbox" checked aria-label="on"/><span class="bx">${CHECK}</span>Run on every push</label>
    <label class="c-check"><input type="checkbox" aria-label="off"/><span class="bx">${CHECK}</span>Notify reviewers</label>
    <label class="c-check is-disabled"><input type="checkbox" disabled aria-label="locked"/><span class="bx">${CHECK}</span>Require 2 approvals</label>
  </div>
  <div class="ev-row">
    <label class="c-radio"><input type="radio" name="vis" checked aria-label="private"/><span class="rb"></span>Private</label>
    <label class="c-radio"><input type="radio" name="vis" aria-label="team"/><span class="rb"></span>Team</label>
  </div>
  <div class="ev-row">
    <div class="c-slider"><input type="range" min="0" max="100" value="60" aria-label="opacity"/><span class="val">60</span></div>
    <div class="c-stepper"><button aria-label="decrease">−</button><input value="3" aria-label="count"/><button aria-label="increase">+</button></div>
  </div>
  <div class="ev-row">
    <div class="c-combo"><div class="c-combo-input"><input placeholder="Search…" aria-label="combo"/><span class="chev">▾</span></div>
      <div class="c-combo-list"><div class="c-combo-opt" aria-selected="true">gpt-oss-120b<span class="ck">✓</span></div><div class="c-combo-opt">claude-sonnet<span class="ck">✓</span></div></div>
    </div>
    <div class="c-tagfield"><span class="c-tag">backend<button aria-label="remove">×</button></span><span class="c-tag">infra<button aria-label="remove">×</button></span><input placeholder="Add…" aria-label="tags"/></div>
  </div>
  <div class="ev-row">
    <div class="c-drop"><div class="ic">⬆</div><div class="tt"><b>Click to upload</b> or drag &amp; drop</div><div class="ts">PNG, PDF up to 10MB</div></div>
    <div class="c-datefield"><span class="seg">2026</span><span class="sep">/</span><span class="seg">06</span><span class="sep">/</span><span class="seg">21</span><button class="cal" aria-label="open calendar">▦</button></div>
  </div>
  <div class="c-fileitem"><span class="fi">PDF</span><div style="flex:1"><div class="nm">spec.pdf</div><div class="mt">240 KB</div><div class="bar"><i style="width:62%"></i></div></div></div>
</section>

<section class="ev-sec"><h3>Navigation (.c-* — DS 0.4.0)</h3>
  <nav class="c-crumbs" aria-label="Breadcrumb"><a href="#">workspace</a><span class="sep">/</span><a href="#">src</a><span class="sep">/</span><span aria-current="page">app.ts</span></nav>
  <button class="c-back" type="button">← Back</button>
  <div class="c-utabs" role="tablist"><button class="c-utab" role="tab" aria-selected="true">Overview</button><button class="c-utab" role="tab" aria-selected="false">Runs<span class="ct">12</span></button><button class="c-utab" role="tab" aria-selected="false">Settings</button></div>
  <div class="c-pager"><button aria-label="previous">‹</button><button aria-current="page">1</button><button>2</button><button>3</button><span class="gap">…</span><button>9</button><button aria-label="next">›</button></div>
  <div class="c-ctx"><button class="c-ctx-item">Rename<span class="k">⌘R</span></button><button class="c-ctx-item active">Duplicate</button><div class="c-ctx-sep"></div><button class="c-ctx-item danger">Delete<span class="k">⌫</span></button></div>
  <div class="c-steps"><div class="c-step done"><span class="dot">✓</span><span class="lb">Connect</span></div><div class="c-step-line"></div><div class="c-step active"><span class="dot">2</span><span class="lb">Configure</span></div><div class="c-step-line"></div><div class="c-step"><span class="dot">3</span><span class="lb">Review</span></div></div>
</section>

<section class="ev-sec"><h3>Form layout (.c-form-grid responsive)</h3>
  <div class="c-form-grid" style="grid-template-columns:1fr 1fr">
    <label class="c-form-row"><span>Name</span><div class="c-combo"><div class="c-combo-input"><input aria-label="name"/></div></div></label>
    <label class="c-form-row"><span>Owner</span><div class="c-combo"><div class="c-combo-input"><input aria-label="owner"/></div></div></label>
  </div>
</section>`;

// ─── Probes ───────────────────────────────────────────────────────────────────
// GROUP R — reference fidelity (NEUTRAL/semantic tier). POST product vs DS reference; MUST match in
// dark + light. Only neutral surfaces whose token chain bottoms out in a non-accent primitive.
const PROBES_R = [
  // target the DEFAULT-state instances: the base surface/border are neutral, whereas the
  // checked/done instances resolve through --accent (recorded in PROBES_ACCENT instead).
  [".c-check input:not(:checked) + .bx", ["borderTopColor", "backgroundColor"]],
  [".c-radio input:not(:checked) + .rb", ["borderTopColor", "backgroundColor"]],
  ['.c-slider input[type="range"]', ["backgroundColor"]],
  [".c-stepper", ["borderTopColor", "backgroundColor"]],
  [".c-stepper button", ["color"]],
  [".c-combo-input", ["borderTopColor", "backgroundColor"]],
  [".c-combo-list", ["backgroundColor", "borderTopColor"]],
  [".c-combo-opt", ["color"]],
  [".c-datefield", ["borderTopColor", "backgroundColor"]],
  [".c-fileitem", ["backgroundColor", "borderTopColor"]],
  [".c-crumbs a", ["color"]],
  [".c-back", ["color"]],
  [".c-utabs", ["borderBottomColor"]],
  [".c-utab", ["color"]],
  [".c-pager button", ["color"]],
  [".c-ctx", ["backgroundColor", "borderTopColor"]],
  [".c-ctx-item", ["color"]],
  [".c-step:not(.done):not(.active) .dot", ["borderTopColor", "backgroundColor", "color"]],
  [".c-step .lb", ["color"]],
];

// GROUP ACCENT — accent-derived surfaces (recorded, not gated). Resolve through the brand --accent,
// which the product defines as hex #4eba87 vs the reference's oklch(0.72 0.124 160): a ~1.5%
// pre-existing primitive delta outside #1298. The token CHAIN is identical in both.
const PROBES_ACCENT = [
  [".c-check input:checked + .bx", ["backgroundColor"]],
  [".c-radio input:checked + .rb", ["borderTopColor"]],
  [".c-step.done .dot", ["backgroundColor"]],
  [".c-tag", ["backgroundColor", "color"]],
  [".c-drop .ic", ["backgroundColor", "color"]],
  ['.c-pager button[aria-current="page"]', ["backgroundColor"]],
];

const MODES = [
  { id: "01-dark", theme: null, hc: null, media: {} },
  { id: "02-light", theme: "light", hc: null, media: {} },
  { id: "03-dark-hc", theme: null, hc: "more", media: {} },
  { id: "04-light-hc", theme: "light", hc: "more", media: {} },
  { id: "05-prefers-contrast", theme: null, hc: null, media: { contrast: "more" } },
  { id: "06-forced-colors", theme: null, hc: null, media: { forcedColors: "active" } },
  { id: "07-reduced-motion", theme: null, hc: null, media: { reducedMotion: "reduce" } },
];
const GATE_R_MODES = new Set(["01-dark", "02-light"]);

function pageHtml(cssText, extra = "") {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${cssText}
  body{margin:0;padding:22px;background:var(--background-primary);color:var(--text-primary);font-family:var(--font-ui),system-ui,sans-serif;display:flex;flex-direction:column;gap:22px}
  .ev-sec{display:flex;flex-direction:column;gap:16px;max-width:760px}
  .ev-sec h3{font:600 12px var(--font-mono);letter-spacing:.04em;text-transform:uppercase;color:var(--text-secondary);margin:0;border-bottom:1px solid var(--border-subtle);padding-bottom:8px}
  .ev-row{display:flex;flex-wrap:wrap;align-items:center;gap:18px}${extra}
  </style></head><body><div id="root">${BODY}</div></body></html>`;
}

async function applyMode(page, cssText, mode, extra = "") {
  await page.emulateMedia({ colorScheme: "dark", ...mode.media });
  await page.setContent(pageHtml(cssText, extra), { waitUntil: "load" });
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

async function collect(page, cssText, mode, probes) {
  await applyMode(page, cssText, mode);
  return page.evaluate((p) => {
    // Canonicalise every colour to actual rendered sRGB pixels (r,g,b,a 0-255) via a canvas, so a
    // hex-authored token and the perceptually-identical oklch() the DS reference uses compare equal.
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
    const out = {};
    for (const [sel, props] of p) {
      const el = document.querySelector(sel);
      if (!el) {
        out[sel] = "__MISSING__";
        continue;
      }
      const cs = getComputedStyle(el);
      out[sel] = Object.fromEntries(props.map((k) => [k, toRGBA(cs[k])]));
    }
    return out;
  }, probes);
}

// Per-channel tolerance: oklch()→sRGB and hex→sRGB rounding can differ by 1 LSB; treat ≤1 as equal.
function rgbaClose(x, y, tol = 1) {
  if (x === "__MISSING__" || y === "__MISSING__") return x === y;
  const a = x.split(",").map(Number);
  const b = y.split(",").map(Number);
  return a.length === 4 && b.length === 4 && a.every((v, i) => Math.abs(v - b[i]) <= tol);
}

function diffSets(a, b, probes, modeId, sink, counters, missing) {
  for (const [sel] of probes) {
    if (a[sel] === "__MISSING__" || b[sel] === "__MISSING__") {
      missing.add(`${modeId}:${sel}`);
      continue;
    }
    for (const p of Object.keys(b[sel])) {
      counters.total++;
      const x = a[sel]?.[p];
      const y = b[sel]?.[p];
      if (!rgbaClose(x, y)) {
        counters.diffs++;
        sink.push(`[R ${modeId}] ${sel} { ${p}: ref="${x}" post="${y}" }`);
      }
    }
  }
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  deviceScaleFactor: 2,
  viewport: { width: 1500, height: 1700 },
});
const page = await ctx.newPage();

const rDiffsGated = [];
const rDiffsRecorded = [];
const missing = new Set();
const rCounters = { total: 0, diffs: 0 };
const byMode = {};
const accentRecord = {};

for (const mode of MODES) {
  const rPost = await collect(page, POST, mode, PROBES_R);
  const rRef = await collect(page, REFERENCE, mode, PROBES_R);
  const sink = GATE_R_MODES.has(mode.id) ? rDiffsGated : rDiffsRecorded;
  const rBefore = rCounters.diffs;
  diffSets(rRef, rPost, PROBES_R, mode.id, sink, rCounters, missing);

  byMode[mode.id] = {
    groupR_diffs: rCounters.diffs - rBefore,
    groupR_gated: GATE_R_MODES.has(mode.id),
  };

  if (GATE_R_MODES.has(mode.id)) {
    const addPost = await collect(page, POST, mode, PROBES_ACCENT);
    const addRef = await collect(page, REFERENCE, mode, PROBES_ACCENT);
    accentRecord[mode.id] = Object.fromEntries(
      PROBES_ACCENT.map(([sel]) => [sel, { product: addPost[sel], reference: addRef[sel] }]),
    );
  }

  await applyMode(page, POST, mode);
  await page.screenshot({ path: resolve(HERE, `${mode.id}.png`), fullPage: true });
  console.log(
    `${mode.id}: R ${byMode[mode.id].groupR_diffs} diff${byMode[mode.id].groupR_gated ? " (gated)" : " (recorded)"}`,
  );
}

// Extra screenshots: compact density + narrow responsive (POST app).
await applyMode(page, POST, MODES[0], "");
await page.evaluate(() => document.documentElement.setAttribute("data-density", "compact"));
await page.screenshot({ path: resolve(HERE, "08-compact-density.png"), fullPage: true });

const narrow = await ctx.newPage();
await narrow.emulateMedia({ colorScheme: "dark" });
await narrow.setViewportSize({ width: 560, height: 1700 });
await narrow.setContent(pageHtml(POST), { waitUntil: "load" });
await narrow.screenshot({ path: resolve(HERE, "09-responsive.png"), fullPage: true });
await narrow.close();

writeFileSync(
  resolve(HERE, "computed-value-proof.json"),
  JSON.stringify(
    {
      issue: 1298,
      baseRef: BASE_REF,
      groupR: {
        description:
          "Reference fidelity: ported .c-* input/navigation primitives resolve identically to the " +
          "DS 0.4.0 reference (keiko-tokens + keiko-semantic-tokens + keiko-inputs + keiko-nav). " +
          "Gated to 0-diff (NEUTRAL/semantic surfaces) in dark + light; HC/forced-colors/reduced-" +
          "motion recorded only.",
        totalProbes: rCounters.total,
        gatedDiffCount: rDiffsGated.length,
        recordedDiffCount: rDiffsRecorded.length,
        gatedDiffs: rDiffsGated,
        recordedDiffs: rDiffsRecorded,
      },
      accentDerived: {
        description:
          "Recorded (not gated), rendered as sRGB (r,g,b,a). Accent-derived surfaces (selected " +
          "checkbox, tag, dropzone icon, current page, completed step) resolve through the brand " +
          "--accent, which the product defines as hex #4eba87 vs the reference's oklch(0.72 0.124 " +
          "160): a ~1.5% pre-existing primitive delta outside #1298. The token chain is identical.",
        byMode: accentRecord,
      },
      productAdopter: {
        description:
          "The workflow-handoff 'Expected checks' list adopts the .c-check primitive (presentation-" +
          "only). Proved by WorkflowHandoff.a11y.test.tsx (checkbox role + accessible name " +
          "preserved, glyph aria-hidden, toggle behaviour, axe-clean) — a React change not " +
          "reproducible in this CSS-only harness.",
      },
      missingSelectors: [...missing],
      byMode,
    },
    null,
    2,
  ),
);

console.log(
  `\nGROUP R (reference fidelity): ${rCounters.total} probes, gated diffs ${rDiffsGated.length}, recorded diffs ${rDiffsRecorded.length}`,
);
for (const d of rDiffsGated.slice(0, 60)) console.log("  GATED " + d);
for (const d of rDiffsRecorded.slice(0, 30)) console.log("  recorded " + d);
if (missing.size) {
  console.log(`MISSING (skipped): ${missing.size}`);
  for (const m of missing) console.log("  " + m);
}

await browser.close();
const failed = rDiffsGated.length > 0;
console.log(
  `\n${failed ? "FAIL" : "PASS"} — Group R dark/light 0-diff: ${rDiffsGated.length === 0}`,
);
process.exit(failed ? 1 : 0);
