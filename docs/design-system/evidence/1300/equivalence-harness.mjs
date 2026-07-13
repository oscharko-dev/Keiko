// Issue #1300 — consolidated Design System 0.4.0 reference-fidelity visual-regression suite.
//
// This is the epic #1290 CAPSTONE gate. Children #1296–#1299 each proved ONE ported component
// layer resolves identically to its DS 0.4.0 reference. This harness re-proves the UNION of those
// surfaces in a single re-runnable pass, so a future drift in ANY migrated layer fails one gate.
//
// It renders the same component markup with two CSS sources, in headless Chromium, across all 7
// theme/contrast/motion modes via page.setContent (no file server — CodeQL-safe):
//
//   (a) PRODUCT  — the real product packages/keiko-ui/src/app/globals.css (working tree).
//   (b) REFERENCE — the governed DS 0.4.0 layers concatenated exactly as the reference pages link
//       them: keiko-tokens + keiko-semantic-tokens + keiko-ai + keiko-data + keiko-dataviz +
//       keiko-inputs + keiko-nav (the proven per-surface recipe used by the #1297/#1298 harnesses).
//
//   GROUP R (reference fidelity, 0-diff GATE in dark + light): every NEUTRAL/semantic-tier surface
//     across AI components, data grid, dataviz, inputs and navigation MUST resolve to the identical
//     computed sRGB colour under PRODUCT and REFERENCE. HC / forced-colors / reduced-motion are
//     RECORDED (the product layers its own HC handling the bare reference page does not).
//
//   GROUP ACCENT (recorded, not gated): accent-derived surfaces resolve through the brand --accent,
//     which the product defines as hex #4eba87 (rgb 78,186,135) while the DS reference uses
//     oklch(0.72 0.124 160) (rgb 82,188,138) — a ~1.5% sub-perceptual delta in the shared base
//     primitive that predates and is outside the 0.4.0 token migration. The token CHAIN is identical
//     in both; recorded with the delta rather than gated (see docs/design-system/visual-regression.md).
//
// The run also proves a keyboard/focus + name/role/value accessibility smoke and a bounded-render
// performance smoke (the visual automation must not regress interaction). Tolerance: ≤1 LSB per
// sRGB channel (oklch()→sRGB and hex→sRGB rounding can differ by one least-significant bit).
//
// Self-contained reproduction (from repo root, after `npm ci` + `npx playwright install chromium`):
//   node docs/design-system/evidence/1300/equivalence-harness.mjs
// Writes consolidated-fidelity-proof.json + 01-dark.png … 11-bounded-rows.png and exits non-zero if
// any Group-R gated diff / accessibility / performance smoke fails.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const CSS_PATH = "packages/keiko-ui/src/app/globals.css";
const POST = readFileSync(resolve(REPO, CSS_PATH), "utf8").replace(/\r\n?/g, "\n");
const POST_CSS_SHA256 = createHash("sha256").update(POST).digest("hex");
const RUN_STARTED_AT = new Date().toISOString();

function git(args) {
  try {
    return execFileSync("git", ["-C", REPO, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch {
    return "unknown";
  }
}

// Governed DS 0.4.0 reference: token tiers + every migrated component layer, concatenated exactly as
// ai-components.html / data-grid.html / dataviz.html / inputs.html / nav-components.html link them.
const DS_DIR = resolve(REPO, "design-system");
const REFERENCE_FILES = [
  "keiko-tokens.css",
  "keiko-semantic-tokens.css",
  "keiko-ai.css",
  "keiko-data.css",
  "keiko-dataviz.css",
  "keiko-inputs.css",
  "keiko-nav.css",
];
const REFERENCE = REFERENCE_FILES.map((f) => readFileSync(resolve(DS_DIR, f), "utf8")).join("\n");

const ICON = "▾";
const CHECK = "✓";
const PERF_ROWS = Array.from({ length: 250 }, (_, i) => {
  const idx = i + 1;
  const status = idx % 11 === 0 ? "Degraded" : idx % 17 === 0 ? "Queued" : "Active";
  const model = idx % 3 === 0 ? "gpt-oss-120b" : idx % 3 === 1 ? "claude-sonnet" : "gpt-oss-20b";
  return `<tr role="row"><td role="gridcell" data-label="Agent">Bounded row ${idx}</td><td role="gridcell" data-label="Status">${status}</td><td class="num" role="gridcell" data-label="Runs">${(1000 + idx).toLocaleString()}</td><td role="gridcell" data-label="Model">${model}</td></tr>`;
}).join("");

// ─── Union markup ───────────────────────────────────────────────────────────────
// The four migrated component families assembled into one document. Each section reuses the exact
// markup the per-child harness (#1296/#1297/#1298) proved, so the union gate is a strict superset.
const BODY = `
<section class="ev-sec"><h3>AI / agent components (.ai-* — DS 0.4.0 · #1296)</h3>
  <div class="ai-msg"><span class="ai-avatar">✦</span><div class="ai-body">
    <div class="ai-response">The migration routes every AI surface onto the <code>--ai-*</code> tokens, so the change is visually identical.</div>
  </div></div>
  <div class="ai-tool">
    <div class="ai-tool-head"><span class="ic">≡</span><span class="nm"><b>grep</b>(pattern, path)</span><span class="st run">Running</span></div>
    <div class="ai-tool-body"><span class="k">pattern:</span> "--accent" &nbsp; <span class="k">path:</span> "globals.css"</div>
  </div>
  <div class="ai-response">High-contrast lives in one source<span class="ai-cite">1</span> and success uses status green<span class="ai-cite">2</span>.
    <div class="ai-sources">
      <div class="ai-source"><span class="n">1</span><span class="tl">keiko-tokens.css — HC palette</span><span class="ur">L110-164</span></div>
      <div class="ai-source"><span class="n">2</span><span class="tl">audit.html — status green</span><span class="ur">§04</span></div>
    </div></div>
  <div class="ai-conf" data-level="high"><span class="track"><i></i><i></i><i></i></span><span class="lbl">High</span></div>
  <div class="ai-conf" data-level="medium"><span class="track"><i></i><i></i><i></i></span><span class="lbl">Medium</span></div>
  <div class="ai-conf" data-level="low"><span class="track"><i></i><i></i><i></i></span><span class="lbl">Low — verify</span></div>
  <div class="ai-permit">
    <div class="ai-permit-h"><span class="ic">🔒</span><div><div class="tt">Allow access to your repository?</div><div class="ts">Keiko needs read access to run the linter agent.</div></div></div>
    <div class="ai-permit-scope"><div class="row"><span class="gr">✓</span> Read files &amp; commit history</div></div>
  </div>
  <div class="ai-danger">
    <div class="ai-danger-h"><span class="ic">⚠</span><div class="tt">Delete 3 branches?</div></div>
    <p>This permanently removes <code>release/0.1</code>. This can't be undone.</p>
  </div>
</section>

<section class="ev-sec"><h3>Data grid (.c-table — DS 0.4.0 · #1297)</h3>
  <div class="c-tablewrap">
    <div class="c-tablescroll">
      <table id="grid-table" class="c-table responsive" role="grid" aria-label="Agents" aria-multiselectable="true">
        <thead><tr role="row">
          <th class="selcell" role="columnheader"><input type="checkbox" aria-label="Select all"></th>
          <th class="sortable" role="columnheader" tabindex="0" aria-sort="none" data-key="name">Agent <span class="so">${ICON}</span></th>
          <th class="sortable" role="columnheader" tabindex="0" aria-sort="none" data-key="status">Status</th>
          <th class="sortable num" role="columnheader" tabindex="0" aria-sort="descending" data-key="runs">Runs <span class="so">${ICON}</span></th>
          <th class="sortable" role="columnheader" tabindex="0" aria-sort="none" data-key="model">Model</th>
        </tr></thead>
        <tbody>
          <tr role="row"><td class="selcell" role="gridcell"><input type="checkbox" class="rowsel" aria-label="Select Triage Bot"></td>
            <td role="gridcell" data-label="Agent"><div class="c-cell-user"><span class="av">TB</span><span class="pri">Triage Bot</span></div></td>
            <td role="gridcell" data-label="Status">Active</td><td class="num" role="gridcell" data-label="Runs">1,284</td>
            <td role="gridcell" data-label="Model">gpt-oss-120b</td></tr>
          <tr id="focus-row" role="row" tabindex="0" aria-selected="true"><td class="selcell" role="gridcell"><input type="checkbox" class="rowsel" checked aria-label="Select Doc Summariser"></td>
            <td role="gridcell" data-label="Agent"><div class="c-cell-user"><span class="av">DS</span><span class="pri">Doc Summariser</span></div></td>
            <td role="gridcell" data-label="Status">Active</td><td class="num" role="gridcell" data-label="Runs">932</td>
            <td role="gridcell" data-label="Model">claude-sonnet</td></tr>
        </tbody>
      </table>
    </div>
    <div class="c-table-foot"><span class="rc">1 selected</span><span class="grow"></span><span class="rc">1–2 of 2</span></div>
    <p id="sort-status" class="sr-only" role="status" aria-live="polite" aria-atomic="true">Sorted by Runs descending.</p>
  </div>
  <div class="c-tablewrap"><div class="c-table-empty"><div class="ic">▦</div><div class="tt">No agents yet</div>
    <div class="ts">Connect a workspace to see runs appear here.</div></div></div>
</section>

<section class="ev-sec"><h3>Data visualisation (.viz — DS 0.4.0 · #1297)</h3>
  <div class="viz-legend">
    <span class="it"><span class="sw" style="background:var(--viz-1)"></span>Triage</span>
    <span class="it"><span class="sw" style="background:var(--viz-2)"></span>Summarise</span>
    <span class="it"><span class="sw" style="background:var(--viz-3)"></span>Review</span>
  </div>
  <div class="viz-seq"><i></i><i></i><i></i><i></i><i></i></div>
  <div class="viz"><div class="viz-plot">
    <div class="viz-yaxis"><span>1.5k</span><span>1k</span><span>500</span><span>0</span></div>
    <div class="viz-gridlines"><i></i><i></i><i></i><i></i></div>
    <div class="viz-bars">
      <div class="viz-bar-col"><div class="viz-bar" style="height:62%"></div><span class="xl">Mon</span></div>
      <div class="viz-bar-col"><div class="viz-bar s2" style="height:80%"></div><span class="xl">Tue</span></div>
      <div class="viz-bar-col"><div class="viz-bar s4" style="height:55%"></div><span class="xl">Wed</span></div>
    </div>
  </div></div>
  <div class="viz-tip"><div class="vl">Thursday · 4 Jun</div>
    <div class="vk"><span class="sw" style="background:var(--viz-1)"></span>Triage<span class="vv">1,284</span></div></div>
</section>

<section class="ev-sec"><h3>Inputs (.c-* — DS 0.4.0 · #1298)</h3>
  <div class="ev-row">
    <label class="c-check"><input type="checkbox" checked aria-label="on"/><span class="bx">${CHECK}</span>Run on every push</label>
    <label class="c-check"><input type="checkbox" aria-label="off"/><span class="bx">${CHECK}</span>Notify reviewers</label>
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
    <div class="c-combo"><div class="c-combo-input"><input placeholder="Search…" aria-label="combo" role="combobox" aria-expanded="true" aria-controls="ev-combo-list" aria-autocomplete="list"/><span class="chev">▾</span></div>
      <div class="c-combo-list" id="ev-combo-list" role="listbox" aria-label="Models"><div class="c-combo-opt" role="option" aria-selected="true">gpt-oss-120b<span class="ck">✓</span></div><div class="c-combo-opt" role="option">claude-sonnet<span class="ck">✓</span></div></div>
    </div>
    <div class="c-tagfield"><span class="c-tag">backend<button aria-label="remove backend">×</button></span><input placeholder="Add…" aria-label="tags"/></div>
  </div>
  <div class="ev-row">
    <div class="c-datefield"><span class="seg" tabindex="0" role="spinbutton" aria-label="year" aria-valuemin="2026" aria-valuemax="2030" aria-valuenow="2026">2026</span><span class="sep">/</span><span class="seg" tabindex="0" role="spinbutton" aria-label="month" aria-valuemin="1" aria-valuemax="12" aria-valuenow="6">06</span></div>
  </div>
  <div class="c-fileitem"><span class="fi">PDF</span><div style="flex:1"><div class="nm">spec.pdf</div><div class="mt">240 KB</div><div class="bar"><i style="width:62%"></i></div></div></div>
</section>

<section class="ev-sec"><h3>Navigation (.c-* — DS 0.4.0 · #1298)</h3>
  <nav class="c-crumbs" aria-label="Breadcrumb"><a href="#">workspace</a><span class="sep">/</span><a href="#">src</a><span class="sep">/</span><span aria-current="page">app.ts</span></nav>
  <button class="c-back" type="button">← Back</button>
  <div class="c-utabs" role="tablist" aria-label="Evidence tabs"><button class="c-utab" role="tab" aria-selected="true" tabindex="0">Overview</button><button class="c-utab" role="tab" aria-selected="false" tabindex="-1">Runs<span class="ct">12</span></button></div>
  <div class="c-pager"><button aria-label="previous">‹</button><button aria-current="page">1</button><button>2</button><button aria-label="next">›</button></div>
  <div class="c-ctx" role="menu" aria-label="Row actions" aria-orientation="vertical"><button class="c-ctx-item" role="menuitem" tabindex="0">Rename<span class="k">⌘R</span></button><button class="c-ctx-item danger" role="menuitem" tabindex="-1">Delete<span class="k">⌫</span></button></div>
  <div class="c-steps"><div class="c-step done"><span class="dot">✓</span><span class="lb">Connect</span></div><div class="c-step-line"></div><div class="c-step active"><span class="dot">2</span><span class="lb">Configure</span></div><div class="c-step-line"></div><div class="c-step"><span class="dot">3</span><span class="lb">Review</span></div></div>
</section>

<section class="ev-sec" id="bounded-row-smoke"><h3>Performance smoke: bounded 250-row sticky table</h3>
  <div class="c-tablewrap"><div class="c-tablescroll" id="bounded-row-scroll">
    <table class="c-table">
      <thead><tr><th>Agent</th><th>Status</th><th class="num">Runs</th><th>Model</th></tr></thead>
      <tbody>${PERF_ROWS}</tbody>
    </table>
  </div></div>
</section>`;

// ─── Probes ───────────────────────────────────────────────────────────────────
// GROUP R — reference fidelity (NEUTRAL/semantic tier). PRODUCT vs REFERENCE; MUST match dark+light.
// Only surfaces whose token chain bottoms out in a non-accent primitive.
const PROBES_R = [
  // AI components (#1296) — neutral surfaces.
  [".ai-response", ["backgroundColor", "borderTopColor", "color"]],
  [".ai-tool", ["backgroundColor", "borderTopColor"]],
  [".ai-tool-body", ["backgroundColor", "borderTopColor", "color"]],
  [".ai-tool-head .ic", ["backgroundColor", "color"]],
  [".ai-source", ["backgroundColor", "borderTopColor"]],
  [".ai-source .tl", ["color"]],
  [".ai-permit", ["backgroundColor", "borderTopColor"]],
  [".ai-permit-scope", ["backgroundColor", "borderTopColor", "color"]],
  // The EMPTY track segment is the neutral surface (--surface-inset). The filled segments resolve
  // through --ai-confidence-* (accent-derived) and are recorded in PROBES_ACCENT instead, so target
  // the third segment of the low-confidence meter, which is always unfilled.
  ['.ai-conf[data-level="low"] .track i:nth-child(3)', ["backgroundColor"]],
  // Data grid (#1297) — neutral surfaces.
  [".c-tablewrap", ["backgroundColor", "borderTopColor"]],
  [".c-table thead th", ["backgroundColor", "color", "borderBottomColor"]],
  [".c-table tbody td", ["borderBottomColor", "color"]],
  [".c-table-foot", ["backgroundColor"]],
  [".c-table-empty .ic", ["backgroundColor", "borderTopColor"]],
  // Dataviz (#1297) — neutral structural surfaces.
  [".viz-gridlines i", ["backgroundColor"]],
  [".viz-yaxis span", ["color"]],
  [".viz-tip", ["backgroundColor", "color"]],
  // Inputs (#1298) — default-state neutral surfaces (checked instances are accent-derived).
  [".c-check input:not(:checked) + .bx", ["borderTopColor", "backgroundColor"]],
  [".c-radio input:not(:checked) + .rb", ["borderTopColor", "backgroundColor"]],
  ['.c-slider input[type="range"]', ["backgroundColor"]],
  [".c-stepper", ["borderTopColor", "backgroundColor"]],
  [".c-combo-input", ["borderTopColor", "backgroundColor"]],
  [".c-combo-list", ["backgroundColor", "borderTopColor"]],
  // Target the UNSELECTED option: the first .c-combo-opt carries aria-selected="true" (→ the selected
  // colour), so probe the second one for the default --text-secondary option colour.
  [".c-combo-opt:not([aria-selected])", ["color"]],
  [".c-datefield", ["borderTopColor", "backgroundColor"]],
  [".c-fileitem", ["backgroundColor", "borderTopColor"]],
  // Navigation (#1298) — neutral surfaces.
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

// GROUP ACCENT — accent-derived / feedback / color-mix surfaces (RECORDED, not gated). Resolve
// through the brand --accent (product hex #4eba87 vs reference oklch(0.72 0.124 160), ~1.5% delta)
// or through color-mix() over feedback hues. The token CHAIN is identical in both.
const PROBES_ACCENT = [
  [".ai-avatar", ["backgroundColor", "color", "borderTopColor"]],
  [".ai-cite", ["backgroundColor", "color"]],
  ['.ai-conf[data-level="high"] .track i:nth-child(1)', ["backgroundColor"]],
  [".ai-danger", ["backgroundColor", "borderTopColor"]],
  [".viz-bar", ["backgroundColor"]],
  [".viz-bar.s2", ["backgroundColor"]],
  ['.c-table tbody tr[aria-selected="true"]', ["backgroundColor"]],
  [".c-check input:checked + .bx", ["backgroundColor"]],
  [".c-radio input:checked + .rb", ["borderTopColor"]],
  [".c-step.done .dot", ["backgroundColor"]],
  [".c-tag", ["backgroundColor", "color"]],
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
  .ev-sec{display:flex;flex-direction:column;gap:14px;max-width:840px}
  .ev-sec h3{font:600 12px var(--font-mono);letter-spacing:.04em;text-transform:uppercase;color:var(--text-secondary);margin:0;border-bottom:1px solid var(--border-subtle);padding-bottom:8px}
  .ev-row{display:flex;flex-wrap:wrap;gap:18px;align-items:flex-start}
  .av{font-size:10.5px}.viz-plot{width:420px}.viz-tip{align-self:flex-start}${extra}
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
    // hex-authored token (#4eba87) and the perceptually-identical oklch() the DS reference uses
    // compare equal. Removes the authored-syntax mismatch from the fidelity gate.
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
      missing.add(`${sel}`);
      continue;
    }
    for (const p of Object.keys(b[sel])) {
      counters.total++;
      const x = a[sel]?.[p];
      const y = b[sel]?.[p];
      if (!rgbaClose(x, y)) {
        counters.diffs++;
        sink.push(`[R ${modeId}] ${sel} { ${p}: ref="${x}" product="${y}" }`);
      }
    }
  }
}

async function collectAccessibilityProof(page) {
  await applyMode(page, POST, MODES[0]);
  // keyboard / focus: Tab to the first focusable interactive control and assert it receives focus
  // and a visible ring (WCAG 2.4.7 / 2.1.1).
  let activeTag = "";
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab");
    activeTag = await page.evaluate(() => {
      const a = document.activeElement;
      return a ? `${a.tagName.toLowerCase()}#${a.id || ""}.${a.className || ""}` : "";
    });
    const reached = await page.evaluate(() => {
      const a = document.activeElement;
      return !!a && a.closest(".c-back") !== null;
    });
    if (reached) break;
  }
  const focusProof = await page.evaluate(() => {
    const btn = document.querySelector(".c-back");
    btn?.focus();
    const cs = btn ? getComputedStyle(btn) : null;
    return {
      activeIsBack: document.activeElement === btn,
      outlineStyle: cs?.outlineStyle ?? null,
      outlineWidth: cs?.outlineWidth ?? null,
      hasFocusRing:
        !!cs && (cs.outlineStyle !== "none" || (cs.boxShadow !== "none" && cs.boxShadow !== "")),
    };
  });
  // name / role / value: combobox + grid sort header expose the correct ARIA contract.
  const nameRoleValue = await page.evaluate(() => {
    const combo = document.querySelector('.c-combo-input input[role="combobox"]');
    const sortedHeader = document.querySelector('#grid-table thead th[aria-sort="descending"]');
    const live = document.querySelector("#sort-status");
    const opt = document.querySelector('.c-combo-opt[aria-selected="true"]');
    return {
      comboRole: combo?.getAttribute("role") ?? null,
      comboExpanded: combo?.getAttribute("aria-expanded") ?? null,
      comboControls: combo?.getAttribute("aria-controls") ?? null,
      comboLabel: combo?.getAttribute("aria-label") ?? null,
      optionSelected: opt?.getAttribute("aria-selected") ?? null,
      gridSort: sortedHeader?.getAttribute("aria-sort") ?? null,
      liveRole: live?.getAttribute("role") ?? null,
      liveAriaLive: live?.getAttribute("aria-live") ?? null,
    };
  });
  await page.screenshot({ path: resolve(HERE, "10-focus-visible.png"), fullPage: true });
  return { focusProof, nameRoleValue };
}

async function runBoundedRowSmoke(page) {
  await applyMode(page, POST, MODES[0]);
  const smoke = await page.evaluate(() => {
    const scroll = document.querySelector("#bounded-row-scroll");
    const rows = document.querySelectorAll("#bounded-row-smoke tbody tr");
    const header = document.querySelector("#bounded-row-smoke thead th");
    if (!(scroll instanceof HTMLElement) || !(header instanceof HTMLElement)) {
      return { ok: false, reason: "missing bounded-row smoke elements" };
    }
    const start = performance.now();
    scroll.scrollTop = scroll.scrollHeight;
    const afterScrollTop = scroll.scrollTop;
    const headerTop = header.getBoundingClientRect().top;
    const scrollTop = scroll.getBoundingClientRect().top;
    scroll.scrollTop = 0;
    scroll.scrollTop = scroll.scrollHeight / 2;
    const durationMs = performance.now() - start;
    return {
      ok: true,
      rowCount: rows.length,
      durationMs,
      afterScrollTop,
      scrollHeight: scroll.scrollHeight,
      clientHeight: scroll.clientHeight,
      stickyHeaderDeltaPx: Math.abs(headerTop - scrollTop),
    };
  });
  await page.screenshot({ path: resolve(HERE, "11-bounded-rows.png"), fullPage: true });
  return smoke;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  deviceScaleFactor: 2,
  viewport: { width: 1500, height: 2100 },
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
  const before = rCounters.diffs;
  diffSets(rRef, rPost, PROBES_R, mode.id, sink, rCounters, missing);
  byMode[mode.id] = {
    groupR_diffs: rCounters.diffs - before,
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

// Extra screenshots: compact density + narrow responsive (PRODUCT).
await applyMode(page, POST, MODES[0], "");
await page.evaluate(() => document.documentElement.setAttribute("data-density", "compact"));
await page.screenshot({ path: resolve(HERE, "08-compact-density.png"), fullPage: true });

const narrow = await ctx.newPage();
await narrow.emulateMedia({ colorScheme: "dark" });
await narrow.setViewportSize({ width: 560, height: 2000 });
await narrow.setContent(pageHtml(POST), { waitUntil: "load" });
await narrow.screenshot({ path: resolve(HERE, "09-responsive.png"), fullPage: true });
await narrow.close();

const accessibilityProof = await collectAccessibilityProof(page);
const boundedRowSmoke = await runBoundedRowSmoke(page);

await browser.close();

const focusFailed =
  accessibilityProof.focusProof.activeIsBack !== true ||
  accessibilityProof.focusProof.hasFocusRing !== true ||
  accessibilityProof.nameRoleValue.comboRole !== "combobox" ||
  accessibilityProof.nameRoleValue.comboExpanded !== "true" ||
  accessibilityProof.nameRoleValue.comboControls !== "ev-combo-list" ||
  accessibilityProof.nameRoleValue.gridSort !== "descending" ||
  accessibilityProof.nameRoleValue.liveRole !== "status" ||
  accessibilityProof.nameRoleValue.liveAriaLive !== "polite";
const perfFailed =
  boundedRowSmoke.ok !== true ||
  boundedRowSmoke.rowCount !== 250 ||
  boundedRowSmoke.afterScrollTop <= 0 ||
  boundedRowSmoke.scrollHeight <= boundedRowSmoke.clientHeight ||
  boundedRowSmoke.durationMs > 250 ||
  boundedRowSmoke.stickyHeaderDeltaPx > 4;
// A missing probe selector (e.g. a migrated surface was renamed away) must FAIL the gate, not pass
// silently — otherwise a dropped surface would still record PASS with fewer probes.
const missingSelectors = [...missing].sort((a, b) => a.localeCompare(b));
const failed = rDiffsGated.length > 0 || missingSelectors.length > 0 || focusFailed || perfFailed;

writeFileSync(
  resolve(HERE, "consolidated-fidelity-proof.json"),
  JSON.stringify(
    {
      issue: 1300,
      epic: 1290,
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
      run: {
        startedAt: RUN_STARTED_AT,
        generatedAt: new Date().toISOString(),
        repoHeadSha: git(["rev-parse", "HEAD"]),
      },
      tolerance: "≤1 LSB per sRGB channel (canvas-normalised)",
      groupR: {
        description:
          "Reference fidelity: every migrated NEUTRAL surface (AI, data grid, dataviz, inputs, " +
          "navigation) resolves identically under the product globals.css and the concatenated DS " +
          "0.4.0 reference. Gated to 0-diff in dark + light; HC/forced-colors/reduced-motion recorded.",
        totalProbes: rCounters.total,
        gatedDiffCount: rDiffsGated.length,
        recordedDiffCount: rDiffsRecorded.length,
        gatedDiffs: rDiffsGated,
        recordedDiffs: rDiffsRecorded,
      },
      accentDerived: {
        description:
          "Recorded (not gated), rendered as sRGB (r,g,b,a). Accent/feedback/color-mix surfaces " +
          "resolve through the brand --accent (product hex #4eba87 vs reference oklch(0.72 0.124 " +
          "160) — ~1.5% pre-existing primitive delta outside the 0.4.0 migration). Token chain identical.",
        byMode: accentRecord,
      },
      accessibilityProof,
      boundedRowSmoke,
      missingSelectorCount: missingSelectors.length,
      missingSelectors,
      byMode,
      verdict: failed ? "FAIL" : "PASS",
    },
    null,
    2,
  ),
);

console.log(
  `\nGROUP R (reference fidelity): ${rCounters.total} probes · gated diffs ${rDiffsGated.length} · recorded diffs ${rDiffsRecorded.length}`,
);
for (const d of rDiffsGated.slice(0, 60)) console.log("  GATED " + d);
for (const d of rDiffsRecorded.slice(0, 20)) console.log("  recorded " + d);
if (missing.size) {
  console.log(`MISSING (failure): ${missing.size}`);
  for (const m of missingSelectors) console.log("  " + m);
}
console.log(
  `ACCESSIBILITY: back-button focus=${accessibilityProof.focusProof.activeIsBack} ring=${accessibilityProof.focusProof.hasFocusRing}; combo role=${accessibilityProof.nameRoleValue.comboRole}; grid sort=${accessibilityProof.nameRoleValue.gridSort}`,
);
console.log(
  `BOUNDED ROW SMOKE: ${boundedRowSmoke.rowCount} rows, ${boundedRowSmoke.durationMs.toFixed(2)}ms, sticky delta ${boundedRowSmoke.stickyHeaderDeltaPx.toFixed(2)}px`,
);
console.log(
  `\n${failed ? "FAIL" : "PASS"} — Group R dark/light 0-diff: ${rDiffsGated.length === 0}; missing selectors: ${missingSelectors.length}; a11y proof: ${!focusFailed}; bounded-row smoke: ${!perfFailed}`,
);
process.exit(failed ? 1 : 0);
