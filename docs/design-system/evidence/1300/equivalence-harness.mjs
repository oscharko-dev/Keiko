import { designEvidenceSourceHashes } from "../../../../scripts/lib/design-evidence-sources.mjs";
import {
  loadHtmlFixture,
  renderedFixtureColours,
  compareColourProbes,
  fixtureMediaProbe,
  captureResponsiveFixture,
  measureFixtureScroll,
} from "../../../../scripts/lib/css-rendered-evidence.mjs";
import fixtureData from "./component-fixture-data.json" with { type: "json" };

import { readStylesheet } from "../../../../packages/keiko-ui/read-stylesheet.mjs";
// Issue #1300 — consolidated Design System 0.4.0 reference-fidelity visual-regression suite.
//
// This is the epic #1290 historical CAPSTONE evidence script. Children #1296–#1299 each proved ONE ported component
// layer resolved identically to its DS 0.4.0 reference. This harness reproduces the UNION of those
// surfaces in one historical pass, so a manual re-run reports any divergence from that snapshot.
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
import { resolveHostExecutable } from "../../../../scripts/lib/host-executable.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const GIT_PATH = resolveHostExecutable("git", { workspaceRoot: REPO });
const CSS_PATH = "packages/keiko-ui/src/app/globals.css";
const POST = readStylesheet(resolve(REPO, CSS_PATH)).replace(/\r\n?/g, "\n");
const POST_CSS_SHA256 = createHash("sha256").update(POST).digest("hex");
const RUN_STARTED_AT = new Date().toISOString();

function git(args) {
  try {
    return execFileSync(GIT_PATH, ["-C", REPO, ...args], {
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

function fixtureRowStatus(index) {
  if (index % 11 === 0) return "Degraded";
  if (index % 17 === 0) return "Queued";
  return "Active";
}
const PERF_ROW_TEMPLATE = fixtureData.boundedRowTemplate;
const PERF_ROWS = Array.from({ length: 250 }, (_, offset) => {
  const index = offset + 1;
  const row = {
    index,
    status: fixtureRowStatus(index),
    model: ["gpt-oss-120b", "claude-sonnet", "gpt-oss-20b"][index % 3],
    runs: (1000 + index).toLocaleString(),
  };
  return Object.entries(row).reduce(
    (html, [name, value]) => html.replaceAll("{{" + name + "}}", String(value)),
    PERF_ROW_TEMPLATE,
  );
}).join("");

// ─── Union markup ───────────────────────────────────────────────────────────────
// The four migrated component families assembled into one document. Each section reuses the exact
// markup the per-child harness (#1296/#1297/#1298) proved, so the union gate is a strict superset.
const BODY = fixtureData.body
  .join("\n")
  .replaceAll("{{ICON}}", ICON)
  .replaceAll("{{CHECK}}", CHECK)
  .replaceAll("{{PERF_ROWS}}", PERF_ROWS);

// ─── Probes ───────────────────────────────────────────────────────────────────
// GROUP R — reference fidelity (NEUTRAL/semantic tier). PRODUCT vs REFERENCE; MUST match dark+light.
// Only surfaces whose token chain bottoms out in a non-accent primitive.
const PROBES_R = fixtureData.PROBES_R;

// GROUP ACCENT — accent-derived / feedback / color-mix surfaces (RECORDED, not gated). Resolve
// through the brand --accent (product hex #4eba87 vs reference oklch(0.72 0.124 160), ~1.5% delta)
// or through color-mix() over feedback hues. The token CHAIN is identical in both.
const PROBES_ACCENT = fixtureData.PROBES_ACCENT;

const MODES = fixtureData.MODES;
const GATE_R_MODES = new Set(["01-dark", "02-light"]);

async function readMediaProbe(page) {
  return fixtureMediaProbe(page);
}

function mediaMatchesMode(modeId, probe) {
  return (
    probe.reducedMotion === (modeId === "07-reduced-motion") &&
    probe.forcedColors === (modeId === "06-forced-colors") &&
    probe.prefersContrast === (modeId === "05-prefers-contrast")
  );
}

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
  return loadHtmlFixture(page, pageHtml(cssText, extra), mode, {
    colorScheme: "dark",
    contrast: "no-preference",
    forcedColors: "none",
    reducedMotion: "no-preference",
    ...mode.media,
  });
}

async function collect(page, cssText, mode, probes) {
  await applyMode(page, cssText, mode);
  return page.evaluate(renderedFixtureColours, { kind: "probes", probes });
}

// Per-channel tolerance: oklch()→sRGB and hex→sRGB rounding can differ by 1 LSB; treat ≤1 as equal.

function diffSets(a, b, probes, modeId, sink, counters, missing) {
  const result = compareColourProbes(a, b, probes, modeId);
  result.missing.forEach((selector) => missing.add(selector));
  counters.total += result.total;
  counters.diffs += result.differences.length;
  sink.push(
    ...result.differences.map(
      ({ mode, selector, prop, reference, product }) =>
        `[R ${mode}] ${selector} { ${prop}: ref="${reference}" product="${product}" }`,
    ),
  );
}

async function collectAccessibilityProof(page) {
  await applyMode(page, POST, MODES[0]);
  // keyboard / focus: Tab to the first focusable interactive control and assert it receives focus
  // and a visible ring (WCAG 2.4.7 / 2.1.1). The proof is that the Tab loop reached the target on
  // its own — never programmatically focus the element afterwards, because a forced focus() makes
  // the assertion `activeIsBack === true` trivially true and the proof cannot fail. Hoist `reached`
  // out of the loop and gate focusProof on it, so a Tab loop that never reached the target is
  // reported as such instead of being papered over.
  let reached = false;
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab");
    reached = await page.evaluate(() => {
      const a = document.activeElement;
      return !!a && a.closest(".c-back") !== null;
    });
    if (reached) break;
  }
  const focusProof = await page.evaluate(() => {
    const btn = document.querySelector(".c-back");
    const cs = btn ? getComputedStyle(btn) : null;
    return {
      activeIsBack: document.activeElement === btn,
      outlineStyle: cs?.outlineStyle ?? null,
      outlineWidth: cs?.outlineWidth ?? null,
      hasFocusRing:
        !!cs && (cs.outlineStyle !== "none" || (cs.boxShadow !== "none" && cs.boxShadow !== "")),
    };
  });
  focusProof.tabReached = reached;
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
  const smoke = await page.evaluate(measureFixtureScroll, {
    scrollSelector: "#bounded-row-scroll",
    rowSelector: "#bounded-row-smoke tbody tr",
    headerSelector: "#bounded-row-smoke thead th",
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

const { rDiffsGated, rDiffsRecorded, missing, rCounters, byMode, accentRecord } = {
  rDiffsGated: [],
  rDiffsRecorded: [],
  missing: new Set(),
  rCounters: { total: 0, diffs: 0 },
  byMode: {},
  accentRecord: {},
};

async function measurePair(mode, probes) {
  const reference = await collect(page, REFERENCE, mode, probes);
  const product = await collect(page, POST, mode, probes);
  return { reference, product };
}

for (const mode of MODES) {
  // Order matters: collect REFERENCE first, then POST, so the DOM ends in POST state and the
  // screenshot below captures the product surface without a redundant applyMode(POST) call.
  const pair = await measurePair(mode, PROBES_R);
  const sink = GATE_R_MODES.has(mode.id) ? rDiffsGated : rDiffsRecorded;
  const before = rCounters.diffs;
  diffSets(pair.reference, pair.product, PROBES_R, mode.id, sink, rCounters, missing);
  byMode[mode.id] = {
    groupR_diffs: rCounters.diffs - before,
    groupR_gated: GATE_R_MODES.has(mode.id),
  };

  if (GATE_R_MODES.has(mode.id)) {
    // Same ordering: REFERENCE first, then POST last so the DOM stays in POST state.
    const accent = await measurePair(mode, PROBES_ACCENT);
    accentRecord[mode.id] = Object.fromEntries(
      PROBES_ACCENT.map(([sel]) => [
        sel,
        { product: accent.product[sel], reference: accent.reference[sel] },
      ]),
    );
  }

  // The DOM is already in POST state from the collect(POST, mode, ...) call above.
  byMode[mode.id].mediaProbe = await readMediaProbe(page);
  await page.screenshot({ path: resolve(HERE, `${mode.id}.png`), fullPage: true });
  console.log(
    `${mode.id}: R ${byMode[mode.id].groupR_diffs} diff${byMode[mode.id].groupR_gated ? " (gated)" : " (recorded)"}`,
  );
}

// Extra screenshots: compact density + narrow responsive (PRODUCT).
await applyMode(page, POST, MODES[0], "");
await page.evaluate(() => {
  document.documentElement.dataset.density = "compact";
});
await page.screenshot({ path: resolve(HERE, "08-compact-density.png"), fullPage: true });

await captureResponsiveFixture(
  ctx,
  pageHtml(POST),
  { width: 560, height: 2000 },
  resolve(HERE, "09-responsive.png"),
);

const accessibilityProof = await collectAccessibilityProof(page);
const boundedRowSmoke = await runBoundedRowSmoke(page);

await browser.close();

const focusFailed =
  accessibilityProof.focusProof.tabReached !== true ||
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
const mediaFailed = Object.entries(byMode).some(
  ([modeId, mode]) => !mediaMatchesMode(modeId, mode.mediaProbe),
);
const failed =
  rDiffsGated.length > 0 || missingSelectors.length > 0 || focusFailed || perfFailed || mediaFailed;

writeFileSync(
  resolve(HERE, "consolidated-fidelity-proof.json"),
  JSON.stringify(
    {
      issue: 1300,
      epic: 1290,
      sourceFiles: designEvidenceSourceHashes(REPO),
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
// Narrow on ok=true before formatting durationMs / stickyHeaderDeltaPx: runBoundedRowSmoke returns
// `{ ok: false, reason }` when the DOM probe elements are absent, and calling .toFixed() on a
// missing field would throw here — before process.exit is reached — so Chromium would leak.
if (boundedRowSmoke.ok === true) {
  console.log(
    `BOUNDED ROW SMOKE: ${boundedRowSmoke.rowCount} rows, ${boundedRowSmoke.durationMs.toFixed(2)}ms, sticky delta ${boundedRowSmoke.stickyHeaderDeltaPx.toFixed(2)}px`,
  );
} else {
  console.log(`BOUNDED ROW SMOKE: skipped — ${boundedRowSmoke.reason}`);
}
console.log(
  `\n${failed ? "FAIL" : "PASS"} — Group R dark/light 0-diff: ${rDiffsGated.length === 0}; missing selectors: ${missingSelectors.length}; media isolation: ${!mediaFailed}; a11y proof: ${!focusFailed}; bounded-row smoke: ${!perfFailed}`,
);
process.exit(failed ? 1 : 0);
