// Issue #1300 — accessibility proof for the Design System 0.4.0 component matrix.
//
// Runs axe-core (WCAG 2.1 A + AA + best-practice rules) against the migrated component union in
// headless Chromium across the theme/contrast/motion matrix, so the epic gate has an executable,
// re-runnable accessibility record covering contrast, name/role/value, keyboard semantics, reduced
// motion and forced-colors. Gate: zero SERIOUS or CRITICAL violations in every mode. The full
// violation list (all impacts) is recorded per mode in a11y-proof.json.
//
// axe-core is injected from the workspace dependency (node_modules/axe-core/axe.min.js) — no network,
// no file server (CodeQL-safe). Markup mirrors the equivalence-harness union (AI, data grid, dataviz,
// inputs, navigation) so the same surfaces proven for pixel fidelity are proven for accessibility.
//
// Run (from repo root): node docs/design-system/evidence/1300/a11y/axe-proof.mjs
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../../..");
const CSS_PATH = "packages/keiko-ui/src/app/globals.css";
const POST = readFileSync(resolve(REPO, CSS_PATH), "utf8");
const AXE_SRC = readFileSync(resolve(REPO, "node_modules/axe-core/axe.min.js"), "utf8");

function git(args) {
  try {
    return execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

// Accessible component union. Every interactive control has an accessible name; decorative glyphs are
// aria-hidden; live regions and ARIA contracts match the DS 0.4.0 reference components.
const BODY = `
<main>
<h1 class="sr-only">Design System 0.4.0 accessibility proof</h1>
<section aria-label="AI components">
  <div class="ai-tool"><div class="ai-tool-head"><span class="ic" aria-hidden="true">≡</span><span class="nm"><b>grep</b></span><span class="st run">Running</span></div>
    <div class="ai-tool-body">pattern: "--accent"</div></div>
  <div class="ai-response">High-contrast lives in one source.
    <div class="ai-sources"><div class="ai-source"><span class="n" aria-hidden="true">1</span><span class="tl">keiko-tokens.css</span><span class="ur">L110</span></div></div></div>
  <div class="ai-conf" data-level="high"><span class="track" aria-hidden="true"><i></i><i></i><i></i></span><span class="lbl">Confidence: High</span></div>
</section>
<section aria-label="Data grid">
  <div class="c-tablewrap"><div class="c-tablescroll">
    <table class="c-table" role="grid" aria-label="Agents">
      <thead><tr role="row"><th role="columnheader" scope="col">Agent</th><th role="columnheader" scope="col">Status</th><th role="columnheader" scope="col" class="num" aria-sort="descending">Runs</th></tr></thead>
      <tbody><tr role="row"><td role="gridcell">Triage Bot</td><td role="gridcell">Active</td><td role="gridcell" class="num">1,284</td></tr>
        <tr role="row" aria-selected="true"><td role="gridcell">Doc Summariser</td><td role="gridcell">Active</td><td role="gridcell" class="num">932</td></tr></tbody>
    </table></div>
    <p id="sort-status" class="sr-only" role="status" aria-live="polite" aria-atomic="true">Sorted by Runs descending.</p>
  </div>
</section>
<section aria-label="Inputs">
  <label class="c-check"><input type="checkbox" checked/><span class="bx" aria-hidden="true">✓</span>Run on every push</label>
  <label class="c-radio"><input type="radio" name="vis" checked/><span class="rb" aria-hidden="true"></span>Private</label>
  <label class="c-form-row"><span>Opacity</span><div class="c-slider"><input type="range" min="0" max="100" value="60" aria-label="Opacity"/></div></label>
  <div class="c-combo"><div class="c-combo-input"><input placeholder="Search" aria-label="Model" role="combobox" aria-expanded="true" aria-controls="ev-list" aria-autocomplete="list"/><span class="chev" aria-hidden="true">▾</span></div>
    <div class="c-combo-list" id="ev-list" role="listbox" aria-label="Models"><div class="c-combo-opt" role="option" aria-selected="true">gpt-oss-120b</div><div class="c-combo-opt" role="option">claude-sonnet</div></div></div>
  <div class="c-tagfield"><span class="c-tag">backend<button aria-label="Remove backend">×</button></span><input placeholder="Add" aria-label="Tags"/></div>
</section>
<section aria-label="Navigation">
  <nav class="c-crumbs" aria-label="Breadcrumb"><a href="#a">workspace</a><span class="sep" aria-hidden="true">/</span><a href="#b">src</a><span class="sep" aria-hidden="true">/</span><span aria-current="page">app.ts</span></nav>
  <div class="c-utabs" role="tablist" aria-label="Evidence tabs"><button class="c-utab" role="tab" aria-selected="true">Overview</button><button class="c-utab" role="tab" aria-selected="false" tabindex="-1">Runs</button></div>
  <nav class="c-pager" aria-label="Pagination"><button aria-label="Previous page">‹</button><button aria-current="page" aria-label="Page 1">1</button><button aria-label="Page 2">2</button><button aria-label="Next page">›</button></nav>
  <div class="c-steps"><div class="c-step done"><span class="dot" aria-hidden="true">✓</span><span class="lb">Connect (done)</span></div><div class="c-step active"><span class="dot" aria-hidden="true">2</span><span class="lb">Configure (current)</span></div></div>
</section>
</main>`;

function pageHtml(cssText) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A11y proof</title><style>${cssText}
  body{margin:0;padding:22px;background:var(--background-primary);color:var(--text-primary);font-family:var(--font-ui),system-ui,sans-serif}
  section{margin-bottom:26px;display:flex;flex-direction:column;gap:14px;max-width:840px}</style></head><body>${BODY}</body></html>`;
}

const MODES = [
  { id: "01-dark", theme: null, hc: null, media: {} },
  { id: "02-light", theme: "light", hc: null, media: {} },
  { id: "03-dark-hc", theme: null, hc: "more", media: {} },
  { id: "04-light-hc", theme: "light", hc: "more", media: {} },
  { id: "05-prefers-contrast", theme: null, hc: null, media: { contrast: "more" } },
  { id: "06-forced-colors", theme: null, hc: null, media: { forcedColors: "active" } },
  { id: "07-reduced-motion", theme: null, hc: null, media: { reducedMotion: "reduce" } },
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
const page = await ctx.newPage();

const byMode = {};
const allSeriousCritical = [];

for (const mode of MODES) {
  await page.emulateMedia({ colorScheme: "dark", ...mode.media });
  await page.setContent(pageHtml(POST), { waitUntil: "load" });
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
  await page.addScriptTag({ content: AXE_SRC });
  const results = await page.evaluate(async () => {
    // WCAG 2.1 A + AA + best-practice. Returns violations with impact + nodes.
    const r = await window.axe.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"],
      },
    });
    return {
      violations: r.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.length,
        targets: v.nodes.slice(0, 4).map((n) => n.target.join(" ")),
      })),
      passCount: r.passes.length,
      incompleteCount: r.incomplete.length,
    };
  });
  const seriousCritical = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  for (const v of seriousCritical) allSeriousCritical.push({ mode: mode.id, ...v });
  byMode[mode.id] = {
    seriousCriticalCount: seriousCritical.length,
    violationCount: results.violations.length,
    passCount: results.passCount,
    incompleteCount: results.incompleteCount,
    violations: results.violations,
  };
  console.log(
    `${mode.id}: ${results.violations.length} violations (${seriousCritical.length} serious/critical), ${results.passCount} passes`,
  );
}

await browser.close();

const failed = allSeriousCritical.length > 0;
writeFileSync(
  resolve(HERE, "a11y-proof.json"),
  JSON.stringify(
    {
      issue: 1300,
      epic: 1290,
      tool: `axe-core ${JSON.parse(readFileSync(resolve(REPO, "node_modules/axe-core/package.json"), "utf8")).version}`,
      run: { generatedAt: new Date().toISOString(), repoHeadSha: git(["rev-parse", "HEAD"]) },
      gate: "zero serious/critical violations in every theme/contrast/motion mode",
      coverage:
        "contrast (color-contrast), name/role/value (aria-*, label, button-name, link-name), " +
        "keyboard semantics (tablist/grid/listbox roles), reduced-motion, forced-colors, prefers-contrast",
      seriousCriticalTotal: allSeriousCritical.length,
      seriousCritical: allSeriousCritical,
      byMode,
      verdict: failed ? "FAIL" : "PASS",
    },
    null,
    2,
  ),
);

console.log(
  `\n${failed ? "FAIL" : "PASS"} — serious/critical violations: ${allSeriousCritical.length}`,
);
for (const v of allSeriousCritical.slice(0, 40))
  console.log(`  [${v.mode}] ${v.id} (${v.impact}) ${v.help} — ${v.targets.join(", ")}`);
process.exit(failed ? 1 : 0);
