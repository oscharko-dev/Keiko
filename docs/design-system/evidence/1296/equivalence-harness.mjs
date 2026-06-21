// Issue #1296 — computed-value proof + browser evidence for the AI/agent component set.
//
// Two claims are proved against the real product globals.css (PRE = origin/release/0.2.0,
// POST = working tree), rendered in a headless Chromium across all 7 theme/contrast/motion
// modes via page.setContent (no file server — CodeQL-safe):
//
//   GROUP A (value-preserving migrations, 0-diff gate): the bespoke product AI surfaces
//     (.grounded-citation, .arun-* tool/result/input/summary cards, .arun-spin / live dot,
//     .arun-perm[data-on], .arun-applied) were routed onto the --ai-* component tokens, each
//     of which aliases the exact primitive the surface already used → identical computed
//     value PRE vs POST in EVERY mode. Any difference fails the run.
//
//   GROUP D (deliberate DS 0.4.0 alignment, recorded not gated to 0): the chat thinking dots
//     adopt --ai-thinking-indicator (= --accent-text) in place of --text-faint. The computed
//     value is EXPECTED to differ PRE vs POST; the run records the before/after per mode.
//
// The canonical .ai-* primitives (response, thinking, streaming cursor, tool-call, citation,
// confidence, stop/regenerate, permission, sensitive-action) are NEW in POST (additive); they
// carry no PRE baseline and are captured only in the screenshots, which mirror ai-components.html.
//
// Self-contained reproduction (from repo root, after `npm ci` + `npx playwright install chromium`):
//   BASE_REF=origin/release/0.2.0 node docs/design-system/evidence/1296/equivalence-harness.mjs
// Writes computed-value-proof.json + 01-dark.png … 07-reduced-motion.png and exits non-zero
// if any Group-A computed value differs or any Group-D assertion fails.
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

// ─── Representative markup ────────────────────────────────────────────────────
// Exercises every migrated product AI surface (Group A/D probes) AND the canonical
// .ai-* primitives (for the screenshots). Attribute states ([data-level]/[data-on]/
// [data-live]/.run/.done) exercise stateful variants statically.
const BODY = `
<section class="ev-sec"><h3>Canonical DS 0.4.0 AI components (.ai-*)</h3>
  <div class="ai-msg"><span class="ai-avatar">✦</span><div class="ai-body">
    <div class="ai-thinking">Thinking<span class="dots"><i></i><i></i><i></i></span></div>
  </div></div>
  <div class="ai-msg"><span class="ai-avatar">✦</span><div class="ai-body">
    <div class="ai-response">The migration routes every AI surface onto the <code>--ai-*</code> tokens, so the change is visually identical<span class="ai-stream-cursor"></span></div>
  </div></div>
  <div class="ai-tool">
    <div class="ai-tool-head"><span class="ic">≡</span><span class="nm"><b>grep</b>(pattern, path)</span><span class="st run">Running</span></div>
    <div class="ai-tool-body"><span class="k">pattern:</span> "--accent" &nbsp; <span class="k">path:</span> "globals.css"</div>
  </div>
  <div class="ai-tool">
    <div class="ai-tool-head"><span class="ic">✓</span><span class="nm"><b>read_file</b>(path)</span><span class="st done">Done</span></div>
    <div class="ai-tool-body"><span class="k">→</span> 205 lines · no raw primitives found</div>
  </div>
  <div class="ai-response">High-contrast lives in one source<span class="ai-cite">1</span> and success uses status green<span class="ai-cite">2</span>.
    <div class="ai-sources">
      <div class="ai-source"><span class="n">1</span><span class="tl">keiko-tokens.css — HC palette</span><span class="ur">L110-164</span></div>
      <div class="ai-source"><span class="n">2</span><span class="tl">audit.html — status green</span><span class="ur">§04</span></div>
    </div></div>
  <div class="ai-conf" data-level="high"><span class="track"><i></i><i></i><i></i></span><span class="lbl">High</span></div>
  <div class="ai-conf" data-level="medium"><span class="track"><i></i><i></i><i></i></span><span class="lbl">Medium</span></div>
  <div class="ai-conf" data-level="low"><span class="track"><i></i><i></i><i></i></span><span class="lbl">Low — verify</span></div>
  <div class="ai-controls"><button class="ai-stop"><span class="sq"></span>Stop</button><button class="ai-stop" style="border-color:transparent;color:var(--text-secondary)">Regenerate</button></div>
  <div class="ai-permit">
    <div class="ai-permit-h"><span class="ic">🔒</span><div><div class="tt">Allow access to your repository?</div><div class="ts">Keiko needs read access to run the linter agent.</div></div></div>
    <div class="ai-permit-scope"><div class="row"><span class="gr">✓</span> Read files &amp; commit history</div><div class="row" style="color:var(--text-faint)">✗ No write access · no secrets</div></div>
    <div class="ai-permit-act"><button class="ai-stop" style="border-color:transparent;color:var(--text-secondary)">Not now</button></div>
  </div>
  <div class="ai-danger">
    <div class="ai-danger-h"><span class="ic">⚠</span><div class="tt">Delete 3 branches?</div></div>
    <p>This permanently removes <code>release/0.1</code> and <code>hotfix/login</code>. This can't be undone.</p>
    <div class="ai-danger-act"><button class="ai-stop">Cancel</button></div>
  </div>
</section>

<section class="ev-sec"><h3>Migrated product surfaces (Group A 0-diff · Group D deliberate)</h3>
  <div class="chatw-grounded">
    <div class="grounded-citations-wrap"><span class="grounded-citations-label">Evidence</span>
      <ul class="grounded-citations"><li class="grounded-citations-item">
        <span class="grounded-citation"><span class="grounded-citation-doc-badge">DOCX</span><span class="grounded-citation-range">src/foo.ts:1-4</span><span class="grounded-citation-score">0.90</span></span>
      </li></ul></div>
  </div>
  <span class="chat-typing"><i></i><i></i><i></i></span>
  <div class="arun">
    <div class="arun-head"><span class="arun-role">Agent run</span><span class="arun-status"><span class="dot" data-live="true"></span> Running</span><span class="arun-spin">◠</span></div>
    <div class="arun-meters"><div class="arun-meter"><span class="arun-mk">Searched</span><span class="arun-mv">3</span></div></div>
    <div class="arun-perms"><span class="arun-perm" data-on="true">read</span></div>
    <div class="arun-summary"><span>Summary</span><strong>ok</strong></div>
    <div class="arun-results">
      <div class="arun-result-card"><div class="arun-result-title">Hypothesis</div>
        <div class="arun-kv"><span>Confidence</span><span class="ai-conf" data-level="high"><span class="track"><i></i><i></i><i></i></span><span class="lbl">High</span></span></div>
      </div>
      <div class="arun-result-card arun-applied"><div class="arun-result-title">Applied</div></div>
      <details class="arun-input"><summary>Input</summary><pre>{ "target": "src/a.ts" }</pre></details>
    </div>
  </div>
</section>`;

// ─── Probes ───────────────────────────────────────────────────────────────────
// GROUP A — value-preserving migrations. Each computed value MUST be identical PRE vs POST.
const PROBES_A = [
  [".grounded-citation", ["borderTopColor", "backgroundColor"]],
  [".grounded-citation-doc-badge", ["backgroundColor"]],
  [".arun-meter", ["backgroundColor"]],
  [".arun-summary", ["backgroundColor"]],
  [".arun-result-card", ["backgroundColor"]],
  [".arun-input", ["backgroundColor"]],
  [".arun-spin", ["color"]],
  ['.arun .dot[data-live="true"]', ["backgroundColor"]],
  ['.arun-perm[data-on="true"]', ["borderTopColor", "backgroundColor", "color"]],
  [".arun-applied", ["borderTopColor", "backgroundColor"]],
];

// GROUP D — deliberate DS 0.4.0 alignment. Computed value is EXPECTED to differ PRE vs POST.
const PROBES_D = [
  {
    sel: ".chat-typing i",
    prop: "backgroundColor",
    label: "chat thinking dots: --text-faint (PRE) → --ai-thinking-indicator/--accent-text (POST)",
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

function pageHtml(cssText) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${cssText}
  body{margin:0;padding:20px;background:var(--background-primary);color:var(--text-primary);font-family:var(--font-ui),system-ui,sans-serif;display:flex;flex-direction:column;gap:20px}
  .ev-sec{display:flex;flex-direction:column;gap:14px;max-width:760px}
  .ev-sec h3{font:600 12px var(--font-mono);letter-spacing:.04em;text-transform:uppercase;color:var(--text-secondary);margin:0;border-bottom:1px solid var(--border-subtle);padding-bottom:8px}
  .ai-avatar{font-size:15px}.ai-tool-head .ic,.ai-permit-h .ic,.ai-danger-h .ic{font-size:13px}
  .arun{width:420px;display:flex;flex-direction:column;gap:10px}.arun-spin{display:inline-grid}
  </style></head><body><div id="root">${BODY}</div></body></html>`;
}

async function applyMode(page, cssText, mode) {
  await page.emulateMedia({ colorScheme: "dark", ...mode.media });
  await page.setContent(pageHtml(cssText), { waitUntil: "load" });
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

async function collectA(page, cssText, mode) {
  await applyMode(page, cssText, mode);
  return page.evaluate((probes) => {
    const out = {};
    for (const [sel, props] of probes) {
      const el = document.querySelector(sel);
      if (!el) {
        out[sel] = "__MISSING__";
        continue;
      }
      const cs = getComputedStyle(el);
      out[sel] = Object.fromEntries(props.map((p) => [p, cs[p]]));
    }
    return out;
  }, PROBES_A);
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

const browser = await chromium.launch();
const ctx = await browser.newContext({
  deviceScaleFactor: 2,
  viewport: { width: 1440, height: 1700 },
});
const page = await ctx.newPage();

let totalProbes = 0;
const diffs = [];
const missing = new Set();
const proof = {};
const dRaw = { pre: {}, post: {} };

for (const mode of MODES) {
  // ── Group A: 0-diff gate ─────────────────────────────────────────────────
  const pre = await collectA(page, PRE, mode);
  const post = await collectA(page, POST, mode);
  let modeDiffs = 0;
  let modeProbes = 0;
  for (const [sel] of PROBES_A) {
    if (post[sel] === "__MISSING__" || pre[sel] === "__MISSING__") {
      missing.add(sel);
      continue;
    }
    for (const p of Object.keys(post[sel])) {
      modeProbes++;
      totalProbes++;
      const a = pre[sel]?.[p];
      const b = post[sel]?.[p];
      if (a !== b) {
        modeDiffs++;
        diffs.push(`[${mode.id}] ${sel} { ${p}: PRE="${a}" POST="${b}" }`);
      }
    }
  }
  proof[mode.id] = { probes: modeProbes, diffs: modeDiffs };

  // ── Group D: record deliberate change ────────────────────────────────────
  dRaw.pre[mode.id] = await collectD(page, PRE, mode);
  dRaw.post[mode.id] = await collectD(page, POST, mode);

  // ── Screenshot (POST) ────────────────────────────────────────────────────
  await applyMode(page, POST, mode);
  await page.screenshot({ path: resolve(HERE, `${mode.id}.png`), fullPage: true });
  console.log(`${mode.id}: ${modeProbes} Group-A probes, ${modeDiffs} differing computed values`);
}

// ─── Group-D analysis: the thinking dots MUST differ in dark + light (deliberate) ──────
const dResults = {};
const dFailures = [];
for (const { sel, prop, label } of PROBES_D) {
  const key = `${sel}::${prop}`;
  const darkPre = dRaw.pre["01-dark"][key];
  const darkPost = dRaw.post["01-dark"][key];
  const lightPre = dRaw.pre["02-light"][key];
  const lightPost = dRaw.post["02-light"][key];
  const darkDiffers = darkPre !== darkPost;
  const lightDiffers = lightPre !== lightPost;
  dResults[key] = { label, darkPre, darkPost, darkDiffers, lightPre, lightPost, lightDiffers };
  if (!darkDiffers) {
    dFailures.push(
      `FAIL D dark should differ (accent thinking token): ${key} PRE="${darkPre}" POST="${darkPost}"`,
    );
  }
  if (!lightDiffers) {
    dFailures.push(
      `FAIL D light should differ (accent thinking token): ${key} PRE="${lightPre}" POST="${lightPost}"`,
    );
  }
}

// ─── Write proof JSON ──────────────────────────────────────────────────────────
writeFileSync(
  resolve(HERE, "computed-value-proof.json"),
  JSON.stringify(
    {
      issue: 1296,
      baseRef: BASE_REF,
      totalProbes,
      diffCount: diffs.length,
      missingSelectors: [...missing],
      byMode: proof,
      diffs,
      groupD: {
        description:
          "Deliberate DS 0.4.0 alignment (separate from the 0-diff gate). The chat thinking " +
          "dots adopt --ai-thinking-indicator (= --accent-text) in place of --text-faint, so the " +
          "computed value is EXPECTED to differ PRE vs POST in dark and light.",
        probes: dResults,
        failures: dFailures,
      },
    },
    null,
    2,
  ),
);

// ─── Summary ───────────────────────────────────────────────────────────────────
console.log(`\nTOTAL Group-A: ${totalProbes} computed-value probes across ${MODES.length} modes`);
console.log(`MISSING selectors (not in DOM, skipped): ${missing.size}`);
for (const s of missing) console.log(`  MISSING: ${s}`);
console.log(`DIFFERENCES (pre vs post): ${diffs.length}`);
for (const d of diffs.slice(0, 80)) console.log(d);
console.log(`\nGroup-D deliberate alignment (thinking dots):`);
for (const [key, r] of Object.entries(dResults)) {
  console.log(
    `  ${key}: dark ${r.darkDiffers ? "differs (expected)" : "FAIL"}  light ${r.lightDiffers ? "differs (expected)" : "FAIL"}`,
  );
  console.log(`    dark  PRE="${r.darkPre}"  POST="${r.darkPost}"`);
  console.log(`    light PRE="${r.lightPre}"  POST="${r.lightPost}"`);
}
if (dFailures.length > 0) {
  console.error(`\nGroup-D FAILURES:`);
  for (const f of dFailures) console.error(`  ${f}`);
}

await browser.close();
process.exit(diffs.length === 0 && dFailures.length === 0 ? 0 : 1);
