// Issue #1297 — computed-value proof + browser evidence for the table/data-grid + dataviz
// foundation. Headless Chromium, all 7 theme/contrast/motion modes via page.setContent
// (no file server — CodeQL-safe). Three claims are proved against the REAL product globals.css:
//
//   GROUP A (value-preserving migration, 0-diff gate): the markdown table (.sm-table*) was
//     routed onto the --table-* component tokens, each of which aliases the exact primitive the
//     surface already used → identical computed value PRE (origin/release/0.2.0) vs POST
//     (working tree) in EVERY mode. Any difference fails the run.
//
//   GROUP R (reference fidelity, 0-diff gate in dark + light): the NEW canonical .c-table* /
//     .viz* primitives are rendered with (a) the product POST globals.css and (b) the governed
//     DS 0.4.0 reference CSS (keiko-tokens + keiko-semantic-tokens + keiko-data + keiko-dataviz).
//     The component computed values MUST match in the two canonical theme modes, proving the port
//     resolves identically to data-grid.html / dataviz.html. HC / forced-colors / reduced-motion
//     are RECORDED (the product layers its own HC handling the bare reference page does not).
//
//   GROUP D (deliberate adoption, recorded not gated): the prompt-enhancer scorecards
//     (.pe-scorecards) were UA-default-unstyled PRE and adopt the .c-table component POST, so the
//     computed value is EXPECTED to differ. Recorded per mode.
//
// Self-contained reproduction (from repo root, after `npm ci` + `npx playwright install chromium`):
//   BASE_REF=origin/release/0.2.0 node docs/design-system/evidence/1297/equivalence-harness.mjs
// Writes computed-value-proof.json + 01-dark.png … 09-responsive.png and exits non-zero if any
// Group-A or Group-R (dark/light) computed value differs.
import { chromium } from "playwright";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const CSS_PATH = "packages/keiko-ui/src/app/globals.css";
const BASE_REF = process.env.BASE_REF ?? "origin/release/0.2.0";
// Defensive: BASE_REF is interpolated into a git command — confine it to a git-ref charset.
if (!/^[\w./-]+$/.test(BASE_REF)) {
  throw new Error(`refusing unsafe BASE_REF: ${BASE_REF}`);
}

const PRE = execSync(`git -C "${REPO}" show ${BASE_REF}:${CSS_PATH}`, {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const POST = readFileSync(resolve(REPO, CSS_PATH), "utf8");

// Governed DS 0.4.0 reference: token tiers + the data + dataviz component layers, concatenated
// exactly as data-grid.html / dataviz.html link them.
const DS_DIR = resolve(REPO, "design-system");
const REFERENCE = [
  "keiko-tokens.css",
  "keiko-semantic-tokens.css",
  "keiko-data.css",
  "keiko-dataviz.css",
]
  .map((f) => readFileSync(resolve(DS_DIR, f), "utf8"))
  .join("\n");

// ─── Representative markup ────────────────────────────────────────────────────
// Mirrors data-grid.html (full grid + loading + empty + footer) and dataviz.html (palette, bars,
// line, legend, tooltip, uncertainty, sequential ramp), plus the migrated .sm-table and the
// adopted .pe-scorecards. SVGs from the reference are simplified to glyphs (colour-irrelevant).
const ICON = "▾";
const BODY = `
<section class="ev-sec"><h3>Data grid (.c-table — DS 0.4.0)</h3>
  <div class="c-tablewrap">
    <div class="c-tablescroll">
      <table class="c-table responsive" role="grid" aria-label="Agents" aria-multiselectable="true">
        <thead><tr role="row">
          <th class="selcell" role="columnheader"><input type="checkbox" aria-label="Select all"></th>
          <th class="sortable" role="columnheader" tabindex="0" aria-sort="none" data-key="name">Agent <span class="so">${ICON}</span></th>
          <th class="sortable" role="columnheader" tabindex="0" aria-sort="none" data-key="status">Status</th>
          <th class="sortable num" role="columnheader" tabindex="0" aria-sort="descending" data-key="runs">Runs <span class="so">${ICON}</span></th>
          <th class="sortable num" role="columnheader" tabindex="0" aria-sort="none" data-key="success">Success</th>
          <th class="sortable" role="columnheader" tabindex="0" aria-sort="none" data-key="model">Model</th>
        </tr></thead>
        <tbody>
          <tr role="row"><td class="selcell" role="gridcell"><input type="checkbox" class="rowsel" aria-label="Select Triage Bot"></td>
            <td role="gridcell" data-label="Agent"><div class="c-cell-user"><span class="av">TB</span><span class="pri">Triage Bot</span></div></td>
            <td role="gridcell" data-label="Status">Active</td><td class="num" role="gridcell" data-label="Runs">1,284</td>
            <td class="num" role="gridcell" data-label="Success">98%</td><td role="gridcell" data-label="Model">gpt-oss-120b</td></tr>
          <tr role="row" aria-selected="true"><td class="selcell" role="gridcell"><input type="checkbox" class="rowsel" checked aria-label="Select Doc Summariser"></td>
            <td role="gridcell" data-label="Agent"><div class="c-cell-user"><span class="av">DS</span><span class="pri">Doc Summariser</span></div></td>
            <td role="gridcell" data-label="Status">Active</td><td class="num" role="gridcell" data-label="Runs">932</td>
            <td class="num" role="gridcell" data-label="Success">95%</td><td role="gridcell" data-label="Model">claude-sonnet</td></tr>
          <tr role="row"><td class="selcell" role="gridcell"><input type="checkbox" class="rowsel" aria-label="Select PR Reviewer"></td>
            <td role="gridcell" data-label="Agent"><div class="c-cell-user"><span class="av">PR</span><span class="pri">PR Reviewer</span></div></td>
            <td role="gridcell" data-label="Status">Degraded</td><td class="num" role="gridcell" data-label="Runs">651</td>
            <td class="num" role="gridcell" data-label="Success">81%</td><td role="gridcell" data-label="Model">gpt-oss-120b</td></tr>
        </tbody>
      </table>
    </div>
    <div class="c-table-foot"><span class="rc">1 selected</span><span class="grow"></span><span class="rc">1–3 of 3</span></div>
  </div>
</section>

<section class="ev-sec"><h3>Loading &amp; empty</h3>
  <div class="c-tablewrap"><div class="c-tablescroll"><table class="c-table is-loading">
    <thead><tr><th>Agent</th><th>Status</th><th class="num">Runs</th></tr></thead>
    <tbody><tr><td>x</td><td>x</td><td class="num">0</td></tr><tr><td>x</td><td>x</td><td class="num">0</td></tr></tbody>
  </table></div></div>
  <div class="c-tablewrap"><div class="c-table-empty"><div class="ic">▦</div><div class="tt">No agents yet</div>
    <div class="ts">Connect a workspace or create your first agent to see runs appear here.</div></div></div>
</section>

<section class="ev-sec"><h3>Data visualisation (.viz — DS 0.4.0)</h3>
  <div class="viz-legend">
    <span class="it"><span class="sw" style="background:var(--viz-1)"></span>Triage</span>
    <span class="it"><span class="sw" style="background:var(--viz-2)"></span>Summarise</span>
    <span class="it"><span class="sw" style="background:var(--viz-3)"></span>Review</span>
    <span class="it"><span class="sw" style="background:var(--viz-4)"></span>Draft</span>
    <span class="it"><span class="sw" style="background:var(--viz-5)"></span>Lint</span>
    <span class="it"><span class="sw" style="background:var(--viz-6)"></span>Other</span>
  </div>
  <div class="viz-seq"><i></i><i></i><i></i><i></i><i></i></div>
  <div class="viz"><div class="viz-plot">
    <div class="viz-yaxis"><span>1.5k</span><span>1k</span><span>500</span><span>0</span></div>
    <div class="viz-gridlines"><i></i><i></i><i></i><i></i></div>
    <div class="viz-bars">
      <div class="viz-bar-col"><div class="viz-bar" style="height:62%"></div><span class="xl">Mon</span></div>
      <div class="viz-bar-col"><div class="viz-bar s2" style="height:80%"></div><span class="xl">Tue</span></div>
      <div class="viz-bar-col"><div class="viz-bar s4" style="height:55%"></div><span class="xl">Wed</span></div>
      <div class="viz-bar-col"><div class="viz-bar uncertain" style="height:38%"></div><span class="xl">Sat</span></div>
    </div>
  </div></div>
  <div class="viz-tip"><div class="vl">Thursday · 4 Jun</div>
    <div class="vk"><span class="sw" style="background:var(--viz-1)"></span>Triage<span class="vv">1,284</span></div></div>
  <div class="viz-uncert-note"><span class="pat"></span>Estimated / low-confidence data</div>
</section>

<section class="ev-sec"><h3>Migrated: markdown table (.sm-table — value-preserving)</h3>
  <div class="sm-table-wrapper"><table class="sm-table">
    <thead><tr><th>Key</th><th>Value</th></tr></thead>
    <tbody><tr><td>alpha</td><td>1</td></tr><tr><td>beta</td><td>2</td></tr><tr><td>gamma</td><td>3</td></tr></tbody>
  </table></div>
</section>

<section class="ev-sec"><h3>Adopted: prompt-enhancer scorecards (.pe-scorecards → .c-table)</h3>
  <div class="c-tablewrap"><div class="c-tablescroll"><table class="c-table pe-scorecards">
    <thead><tr><th scope="col">Profile</th><th scope="col" class="num">Score</th><th scope="col" class="num">Tokens</th><th scope="col">Winner</th></tr></thead>
    <tbody>
      <tr class="pe-winner"><th scope="row">precise</th><td class="num">0.912</td><td class="num">740</td><td>★</td></tr>
      <tr><th scope="row">balanced</th><td class="num">0.864</td><td class="num">812</td><td></td></tr>
    </tbody>
  </table></div></div>
</section>`;

// ─── Probes ───────────────────────────────────────────────────────────────────
// GROUP A — value-preserving migration. Computed value MUST be identical PRE vs POST (all modes).
const PROBES_A = [
  [".sm-table-wrapper", ["borderTopColor"]],
  [".sm-table th", ["backgroundColor", "color", "borderBottomColor"]],
  [".sm-table tbody td", ["color", "borderBottomColor"]],
  [".sm-table tbody tr:nth-child(even) td", ["backgroundColor"]],
];

// GROUP R — reference fidelity. POST product vs governed DS reference; MUST match in dark + light.
// Only selectors that exist in BOTH the product and the bare reference CSS (the .s4..s6 series and
// the .viz-seq i ramp are product-additive helpers — recorded separately in PROBES_R_ADDITIVE).
const PROBES_R = [
  [".c-tablewrap", ["backgroundColor", "borderTopColor"]],
  [".c-table thead th", ["backgroundColor", "color", "borderBottomColor"]],
  [".c-table tbody td", ["borderBottomColor", "color"]],
  [".c-table tbody td.num", ["color"]],
  [".c-table-foot", ["backgroundColor"]],
  [".c-table-empty .ic", ["backgroundColor", "borderTopColor"]],
  [".viz-bar.s2", ["backgroundColor"]],
  [".viz-gridlines i", ["backgroundColor"]],
  [".viz-yaxis span", ["color"]],
  [".viz-tip", ["backgroundColor", "color"]],
];

// Accent-derived surfaces resolve through the brand primitive --accent, which the product defines
// as the hex #4eba87 (rgb 78,186,135) while the DS reference uses oklch(0.72 0.124 160)
// (rgb 82,188,138) — a sub-perceptual ~1.5% delta in the shared base primitive, predating and
// outside #1297. The token CHAIN is identical in both (--viz-1 / --table-row-surface-selected →
// --accent[-dim]); recorded with the delta rather than gated.
const PROBES_R_ACCENT = [
  [".viz-bar", ["backgroundColor"]],
  ['.c-table tbody tr[aria-selected="true"]', ["backgroundColor"]],
];

// Product-additive helpers: the reference applies these palette tokens via inline style per series,
// so the bare reference page leaves the selector at its fallback. Recorded (not gated) to evidence
// the extended categorical hues + sequential ramp render their governed token in the product.
const PROBES_R_ADDITIVE = [
  [".viz-bar.s4", ["backgroundColor"]],
  [".viz-seq i:nth-child(3)", ["backgroundColor"]],
];

// GROUP D — deliberate adoption (recorded). PRE unstyled vs POST DS-styled.
const PROBES_D = [
  {
    sel: ".pe-scorecards tbody tr.pe-winner",
    prop: "backgroundColor",
    label: "scorecards winner row: UA default (PRE) → --table-row-surface-selected (POST)",
  },
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
  .ev-sec{display:flex;flex-direction:column;gap:14px;max-width:820px}
  .ev-sec h3{font:600 12px var(--font-mono);letter-spacing:.04em;text-transform:uppercase;color:var(--text-secondary);margin:0;border-bottom:1px solid var(--border-subtle);padding-bottom:8px}
  .av{font-size:10.5px}.viz-plot{width:480px}.viz-tip{align-self:flex-start}${extra}
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

async function collectD(page, cssText, mode) {
  await applyMode(page, cssText, mode);
  return page.evaluate((probes) => {
    const out = {};
    for (const { sel, prop } of probes) {
      const el = document.querySelector(sel);
      out[`${sel}::${prop}`] = el ? getComputedStyle(el)[prop] : "__MISSING__";
    }
    return out;
  }, PROBES_D);
}

// Per-channel tolerance: oklch()→sRGB and hex→sRGB rounding can differ by 1 LSB; treat ≤1 as equal.
function rgbaClose(x, y, tol = 1) {
  if (x === "__MISSING__" || y === "__MISSING__") return x === y;
  const a = x.split(",").map(Number);
  const b = y.split(",").map(Number);
  return a.length === 4 && b.length === 4 && a.every((v, i) => Math.abs(v - b[i]) <= tol);
}

function diffSets(a, b, probes, modeId, group, sink, counters, missing) {
  for (const [sel] of probes) {
    if (a[sel] === "__MISSING__" || b[sel] === "__MISSING__") {
      missing.add(`${group}:${sel}`);
      continue;
    }
    for (const p of Object.keys(b[sel])) {
      counters.total++;
      const x = a[sel]?.[p];
      const y = b[sel]?.[p];
      if (!rgbaClose(x, y)) {
        counters.diffs++;
        sink.push(`[${group} ${modeId}] ${sel} { ${p}: A="${x}" B="${y}" }`);
      }
    }
  }
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  deviceScaleFactor: 2,
  viewport: { width: 1500, height: 1900 },
});
const page = await ctx.newPage();

const aDiffs = [];
const rDiffsGated = [];
const rDiffsRecorded = [];
const missing = new Set();
const aCounters = { total: 0, diffs: 0 };
const rCounters = { total: 0, diffs: 0 };
const byMode = {};
const dRaw = { pre: {}, post: {} };
const additiveRecord = {};

for (const mode of MODES) {
  // GROUP A — value-preserving migration, PRE vs POST app, 0-diff gate.
  const aPre = await collect(page, PRE, mode, PROBES_A);
  const aPost = await collect(page, POST, mode, PROBES_A);
  const aBefore = aCounters.diffs;
  diffSets(aPre, aPost, PROBES_A, mode.id, "A", aDiffs, aCounters, missing);

  // GROUP R — reference fidelity, POST app vs DS reference.
  const rPost = await collect(page, POST, mode, PROBES_R);
  const rRef = await collect(page, REFERENCE, mode, PROBES_R);
  const sink = GATE_R_MODES.has(mode.id) ? rDiffsGated : rDiffsRecorded;
  const rBefore = rCounters.diffs;
  diffSets(rRef, rPost, PROBES_R, mode.id, "R", sink, rCounters, missing);

  byMode[mode.id] = {
    groupA_diffs: aCounters.diffs - aBefore,
    groupR_diffs: rCounters.diffs - rBefore,
    groupR_gated: GATE_R_MODES.has(mode.id),
  };

  if (GATE_R_MODES.has(mode.id)) {
    const extraProbes = [...PROBES_R_ADDITIVE, ...PROBES_R_ACCENT];
    const addPost = await collect(page, POST, mode, extraProbes);
    const addRef = await collect(page, REFERENCE, mode, extraProbes);
    additiveRecord[mode.id] = Object.fromEntries(
      extraProbes.map(([sel]) => [sel, { product: addPost[sel], reference: addRef[sel] }]),
    );
  }

  dRaw.pre[mode.id] = await collectD(page, PRE, mode);
  dRaw.post[mode.id] = await collectD(page, POST, mode);

  await applyMode(page, POST, mode);
  await page.screenshot({ path: resolve(HERE, `${mode.id}.png`), fullPage: true });
  console.log(
    `${mode.id}: A ${byMode[mode.id].groupA_diffs} diff · R ${byMode[mode.id].groupR_diffs} diff${byMode[mode.id].groupR_gated ? " (gated)" : " (recorded)"}`,
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

// GROUP D — record deliberate adoption (dark + light).
const dResults = {};
for (const { sel, prop, label } of PROBES_D) {
  const key = `${sel}::${prop}`;
  dResults[key] = {
    label,
    darkPre: dRaw.pre["01-dark"][key],
    darkPost: dRaw.post["01-dark"][key],
    lightPre: dRaw.pre["02-light"][key],
    lightPost: dRaw.post["02-light"][key],
  };
}

writeFileSync(
  resolve(HERE, "computed-value-proof.json"),
  JSON.stringify(
    {
      issue: 1297,
      baseRef: BASE_REF,
      groupA: {
        description:
          "Value-preserving migration: .sm-table routed onto --table-* tokens. Computed value " +
          "identical PRE vs POST in every mode (0-diff gate).",
        totalProbes: aCounters.total,
        diffCount: aDiffs.length,
        diffs: aDiffs,
      },
      groupR: {
        description:
          "Reference fidelity: ported .c-table*/.viz* primitives resolve identically to the DS " +
          "0.4.0 reference (keiko-tokens + keiko-semantic-tokens + keiko-data + keiko-dataviz). " +
          "Gated to 0-diff in dark + light; HC/forced-colors/reduced-motion recorded only.",
        totalProbes: rCounters.total,
        gatedDiffCount: rDiffsGated.length,
        recordedDiffCount: rDiffsRecorded.length,
        gatedDiffs: rDiffsGated,
        recordedDiffs: rDiffsRecorded,
      },
      groupD: {
        description:
          "Deliberate adoption (recorded, not gated): .pe-scorecards was UA-default-unstyled PRE " +
          "and adopts the .c-table component POST → computed value EXPECTED to differ.",
        probes: dResults,
      },
      additiveAndAccentDerived: {
        description:
          "Recorded (not gated), rendered as sRGB (r,g,b,a). (1) Product-additive .s4/.s5/.s6 + " +
          ".viz-seq i:nth-child() helpers — not in the bare reference, which applies these tokens " +
          "via inline style per series. (2) Accent-derived .viz-bar (--viz-1) + selected row " +
          "(--table-row-surface-selected) — resolve through the brand --accent, which the product " +
          "defines as hex #4eba87 vs the reference's oklch(0.72 0.124 160): a ~1.5% pre-existing " +
          "primitive delta outside #1297; the token chain is identical in both.",
        byMode: additiveRecord,
      },
      missingSelectors: [...missing],
      byMode,
    },
    null,
    2,
  ),
);

console.log(`\nGROUP A (value-preservation): ${aCounters.total} probes, ${aDiffs.length} diffs`);
for (const d of aDiffs.slice(0, 60)) console.log("  " + d);
console.log(
  `GROUP R (reference fidelity): ${rCounters.total} probes, gated diffs ${rDiffsGated.length}, recorded diffs ${rDiffsRecorded.length}`,
);
for (const d of rDiffsGated.slice(0, 60)) console.log("  GATED " + d);
for (const d of rDiffsRecorded.slice(0, 30)) console.log("  recorded " + d);
console.log(`GROUP D (deliberate adoption):`);
for (const [k, r] of Object.entries(dResults)) {
  console.log(
    `  ${k}: dark PRE="${r.darkPre}" POST="${r.darkPost}" · light PRE="${r.lightPre}" POST="${r.lightPost}"`,
  );
}
if (missing.size) {
  console.log(`MISSING (skipped): ${missing.size}`);
  for (const m of missing) console.log("  " + m);
}

await browser.close();
const failed = aDiffs.length > 0 || rDiffsGated.length > 0;
console.log(
  `\n${failed ? "FAIL" : "PASS"} — Group A 0-diff: ${aDiffs.length === 0}; Group R dark/light 0-diff: ${rDiffsGated.length === 0}`,
);
process.exit(failed ? 1 : 0);
