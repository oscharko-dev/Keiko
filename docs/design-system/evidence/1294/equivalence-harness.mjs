// Issue #1294 — computed-value equivalence proof for the reusable-controls /
// component-primitive token migration.
//
// Renders representative component-primitive markup with the PRE-migration
// (release/0.2.0 base) and the POST-migration (working-tree) globals.css, reads
// getComputedStyle for the migrated properties on every primitive across all
// theme/contrast/motion modes, and asserts the resolved values are byte-identical —
// the objective "no visual change" proof. Because every #1294 target token is a
// value-preserving :root alias over the exact primitive it replaced, the expected
// result is 0 differences in all 7 modes. Also captures one screenshot per mode
// (POST) as committed evidence.
//
// Self-contained reproduction (from the repo root, after `npm ci` +
// `npx playwright install chromium`):
//   BASE_REF=ba113ac373ebf1114af7de217b07935036adba08 node docs/design-system/evidence/1294/equivalence-harness.mjs
// Writes computed-value-proof.json + 01-dark.png … 07-reduced-motion.png next to
// itself and exits non-zero if any computed value differs between the two stylesheets.
import { chromium } from "playwright";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const CSS_PATH = "packages/keiko-ui/src/app/globals.css";
const PRE_MIGRATION_BASE_REF = "ba113ac373ebf1114af7de217b07935036adba08";
const BASE_REF = process.env.BASE_REF ?? PRE_MIGRATION_BASE_REF;

const PRE = execSync(`git -C "${REPO}" show ${BASE_REF}:${CSS_PATH}`, {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const POST = readFileSync(resolve(REPO, CSS_PATH), "utf8");

// Representative static markup exercising the exact component-primitive classes the
// migration touched (buttons, inputs, selects, toggles, steppers, tabs, menus,
// badges/chips/pills, cards, dialogs, popovers/tooltips, toasts/alerts, composer,
// tree rows, command-palette rows). Attribute-states ([data-active]/[data-on]/
// [aria-invalid]/[data-sel]/[data-status]) exercise stateful variants statically.
const BODY = `
<div class="dlg" role="dialog">
  <div class="dlg-head"><div class="dlg-ico"></div><div class="dlg-title">Dialog</div><div class="dlg-sub">sub</div></div>
  <div class="dlg-body">
    <label class="dlg-label">Field</label>
    <input class="dlg-input" placeholder="placeholder" />
    <input class="dlg-input" aria-invalid="true" placeholder="error" />
    <textarea class="dlg-input dlg-textarea" placeholder="ph"></textarea>
    <div class="dlg-current-file"><span class="mono">file.ts</span></div>
    <div class="dlg-error">error text</div>
    <div class="dlg-agent-warning">warning</div>
  </div>
  <div class="dlg-foot">
    <button class="dlg-btn">Cancel</button>
    <button class="dlg-btn dlg-primary">Confirm</button>
  </div>
</div>

<div class="qi-panel">
  <button class="qi-btn">QI</button>
  <button class="qi-btn qi-btn-primary">QI primary</button>
  <button class="qi-btn-approve">approve</button>
  <button class="qi-btn-reject">reject</button>
  <input class="qi-input" placeholder="qi" />
  <textarea class="qi-textarea"></textarea>
  <select class="qi-select"><option>a</option></select>
  <span class="qi-badge-default">default</span>
  <span class="qi-badge-succeeded">ok</span>
  <span class="qi-sev-low">low</span>
  <span class="qi-cov-covered">covered</span>
</div>

<div class="bw">
  <button class="bw-btn">BW</button>
  <button class="bw-btn bw-btn-primary">primary</button>
  <button class="bw-btn-danger">danger</button>
  <input class="bw-input" placeholder="bw" />
</div>

<div class="lk">
  <button class="lk-btn">LK</button>
  <button class="lk-btn lk-btn-primary">primary</button>
  <button class="lk-btn-ghost">ghost</button>
  <button class="lk-btn-danger">danger</button>
  <span class="lk-badge" data-state="ready">ready</span>
  <span class="lk-badge" data-state="error">error</span>
  <div class="lk-alert">alert<button class="lk-alert-retry">retry</button></div>
</div>

<div class="ksel">
  <button class="ksel-trigger"><span class="ksel-trigger-desc">desc</span><span class="ksel-trigger-caret">v</span></button>
  <button class="ksel-trigger ksel-trigger-open">open</button>
  <div class="ksel-menu">
    <div class="ksel-menu-head">head</div>
    <div class="ksel-section"><div class="ksel-section-label">label</div></div>
    <div class="ksel-section"></div>
    <button class="ksel-option">option</button>
    <button class="ksel-option ksel-option-active">active</button>
    <span class="ksel-option-badge">badge</span>
    <span class="ksel-option-desc">desc</span>
    <div class="ksel-menu-note">note</div>
  </div>
  <div class="ksel-overflow-tooltip">tooltip</div>
</div>

<div class="number-control">
  <button class="number-control-stepper number-control-stepper-button">-</button>
</div>

<div class="modesw" data-mode="autonomous">
  <button class="modesw-opt">manual</button>
  <button class="modesw-opt" data-on="true">auto<span class="modesw-av">AV</span></button>
</div>

<button class="auto-toggle"><span></span></button>
<button class="perm-toggle">perm</button>
<button class="perm-sw"></button>
<button class="brg-tg"></button>
<button class="perm-opt" data-on="true">opt</button>

<div class="ed-tabs">
  <div class="ed-tab">tab<button class="ed-tab-close">x</button></div>
  <div class="ed-tab" data-active="true">active</div>
  <button class="ed-icon-action">i</button>
  <div class="ed-empty">empty</div>
</div>

<div class="edm">
  <button class="edm-trigger"><span class="edm-trigger-label">menu</span></button>
  <div class="edm-menu">
    <div class="edm-head">head</div>
    <button class="edm-item">item</button>
    <button class="edm-item" data-sel="true">selected</button>
  </div>
</div>

<span class="chip">chip</span>
<span class="mc-badge-proposed">proposed</span>
<span class="mc-badge-count">3</span>
<div class="scope-pill">pill<button class="scope-pill-disconnect">x</button></div>
<div class="arun-status"><span class="dot" data-status="completed"></span>done</div>

<div class="pal-card"><div class="pal-main"><div class="pal-name">name</div><div class="pal-desc">desc</div></div></div>
<div class="run-summary-card">
  <div class="run-summary-card-workflow">wf</div>
  <span class="run-summary-card-status" data-status="succeeded">ok</span>
  <span class="run-summary-card-status" data-status="failed">fail</span>
  <div class="run-summary-card-meta">meta</div>
  <div class="run-summary-card-result">result</div>
  <button class="run-summary-card-action">action</button>
</div>

<div class="cmp-box">
  <textarea class="cmp-input" placeholder="ph"></textarea>
  <div class="cmp-footer-row">
    <button class="cmp-icon">i</button>
    <button class="cmp-add">+</button>
    <button class="cmp-mode">mode</button>
    <button class="cmp-model"><span class="cmp-model-select">model</span></button>
    <span class="cmp-budget-badge-low">low</span>
    <button class="cmp-send">send</button>
  </div>
  <div class="cmp-err">composer error</div>
</div>

<div class="attach-chip">chip<button class="attach-chip-remove">x</button></div>
<div class="attach-rejection-alert">rejected</div>
<div class="source-limit-alert">limit<button class="source-limit-alert-dismiss">x</button></div>

<div class="tr">
  <div class="tr-row">
    <button class="tr-caret-btn">v</button>
    <span class="tr-caret"></span>
    <span class="tr-name">name</span>
    <span class="tr-folder">folder</span>
  </div>
  <div class="tr-file" data-active="true">active file</div>
</div>

<div class="cmdk">
  <div class="cmdk-input"><input placeholder="cmd" /></div>
  <div class="cmdk-list">
    <div class="cmdk-row"><span class="cmdk-ico">i</span><span class="cmdk-label">label</span></div>
    <div class="cmdk-row" data-sel="true"><span class="cmdk-ico">i</span><span class="cmdk-label">sel</span></div>
    <div class="cmdk-group">group</div>
    <div class="cmdk-empty">empty</div>
  </div>
</div>

<div class="wf-dialog">
  <button class="wf-dialog-close">x</button>
  <div class="wf-dialog-choice"><div class="wf-dialog-choice-label">choice</div><div class="wf-dialog-choice-desc">d</div></div>
  <input class="wf-dialog-input" />
  <div class="wf-dialog-error">err</div>
  <button class="wf-dialog-cancel">cancel</button>
  <button class="wf-dialog-launch">launch</button>
</div>

<div class="mc-dialog">
  <div class="mc-dialog-title">title</div>
  <div class="mc-dialog-body"><div class="mc-dialog-quote">quote</div></div>
  <input class="mc-dialog-input" />
  <div class="mc-dialog-error">err</div>
</div>

<div class="ui-error-notice">
  <div class="ui-error-notice-title-row"><div class="ui-error-notice-title">title</div><button class="ui-error-notice-close">x</button></div>
  <div class="ui-error-notice-message">message</div>
  <div class="ui-error-notice-remediation">remediation</div>
  <code class="ui-error-notice-code">code</code>
</div>

<div class="qi-source-kind-grid">
  <button class="qi-source-kind-option"><span class="qi-source-kind-label">opt</span></button>
  <button class="qi-source-kind-option" aria-checked="true"><span class="qi-source-kind-label">sel</span></button>
</div>

<div class="perm-row"><button class="perm-toggle">perm</button><div class="perm-note">note</div></div>
<div class="plg"><button class="plg-row">plugin row</button></div>
`;

const PROBES = [
  // buttons
  [".dlg-btn", ["color", "borderTopColor", "backgroundColor"]],
  [".dlg-primary", ["color", "backgroundColor", "borderTopColor"]],
  [".qi-btn", ["color", "backgroundColor", "borderTopColor"]],
  [".qi-btn-approve", ["color", "backgroundColor"]],
  [".bw-btn", ["color", "backgroundColor"]],
  [".bw-btn-danger", ["color", "backgroundColor"]],
  [".lk-btn", ["color", "backgroundColor"]],
  [".lk-btn-danger", ["color", "backgroundColor"]],
  [".run-summary-card-action", ["color", "backgroundColor", "borderTopColor"]],
  [".wf-dialog-launch", ["color", "backgroundColor"]],
  [".wf-dialog-cancel", ["color", "backgroundColor", "borderTopColor"]],
  // inputs / fields
  [".dlg-input", ["color", "backgroundColor", "borderTopColor"]],
  ['.dlg-input[aria-invalid="true"]', ["borderTopColor"]],
  [".qi-input", ["color", "backgroundColor", "borderTopColor"]],
  [".bw-input", ["color", "backgroundColor", "borderTopColor"]],
  [".mc-dialog-input", ["color", "backgroundColor", "borderTopColor"]],
  [".wf-dialog-input", ["color", "backgroundColor"]],
  // selects / combobox
  [".ksel-trigger", ["color", "backgroundColor", "borderTopColor"]],
  [".ksel-trigger-open", ["borderTopColor"]],
  [".ksel-trigger-caret", ["color"]],
  [".ksel-menu", ["backgroundColor", "borderTopColor", "boxShadow"]],
  [".ksel-menu-head", ["backgroundColor", "borderBottomColor"]],
  [".ksel-option", ["color"]],
  [".ksel-option-active", ["borderTopColor"]],
  [".ksel-option-badge", ["backgroundColor", "borderTopColor"]],
  [".ksel-option-desc", ["color"]],
  [".ksel-menu-note", ["color"]],
  [".ksel-overflow-tooltip", ["backgroundColor", "color", "borderTopColor", "boxShadow"]],
  [".qi-select", ["color", "backgroundColor"]],
  // steppers / toggles
  [".number-control-stepper", ["color"]],
  [".modesw-opt", ["color"]],
  [".auto-toggle", ["backgroundColor", "borderTopColor"]],
  [".perm-toggle", ["borderTopColor"]],
  // tabs / menus
  [".ed-tab", ["color"]],
  ['.ed-tab[data-active="true"]', ["color"]],
  [".edm-trigger", ["color", "backgroundColor", "borderTopColor"]],
  [".edm-trigger-label", ["color"]],
  [".edm-menu", ["backgroundColor", "borderTopColor", "boxShadow"]],
  [".edm-head", ["color"]],
  [".edm-item", ["color"]],
  // badges / chips / pills / dots
  [".chip", ["color", "backgroundColor", "borderTopColor"]],
  [".qi-badge-default", ["color", "backgroundColor"]],
  [".qi-sev-low", ["color", "backgroundColor"]],
  [".qi-cov-covered", ["color"]],
  [".mc-badge-count", ["color", "backgroundColor"]],
  [".scope-pill", ["color", "backgroundColor"]],
  ['.arun-status .dot[data-status="completed"]', ["backgroundColor"]],
  // cards
  [".pal-card", ["backgroundColor", "borderTopColor"]],
  [".pal-name", ["color"]],
  [".pal-desc", ["color"]],
  [".run-summary-card", ["backgroundColor", "borderTopColor"]],
  ['.run-summary-card-status[data-status="failed"]', ["color"]],
  [".run-summary-card-meta", ["color"]],
  // composer
  [".cmp-box", ["backgroundColor", "borderTopColor", "boxShadow"]],
  [".cmp-input", ["color"]],
  [".cmp-icon", ["color", "borderTopColor"]],
  [".cmp-mode", ["color", "borderTopColor"]],
  [".cmp-send", ["backgroundColor", "color"]],
  [".cmp-err", ["color"]],
  // alerts / toasts
  [".lk-alert", ["color", "backgroundColor", "borderTopColor"]],
  [".attach-rejection-alert", ["color", "backgroundColor"]],
  [".source-limit-alert", ["color", "backgroundColor"]],
  [".dlg-error", ["color"]],
  [".dlg-agent-warning", ["color"]],
  [".wf-dialog-error", ["color", "backgroundColor"]],
  // tree rows / cmdk
  [".tr-row", ["color"]],
  [".tr-caret-btn", ["color"]],
  ['.tr-file[data-active="true"]', ["color", "backgroundColor"]],
  [".cmdk-row", ["color"]],
  ['.cmdk-row[data-sel="true"]', ["color", "backgroundColor"]],
  [".cmdk-group", ["color"]],
  [".cmdk-empty", ["color"]],
  // dialogs
  [".dlg", ["backgroundColor", "borderTopColor", "boxShadow"]],
  [".dlg-head", ["borderBottomColor"]],
  [".dlg-title", ["color"]],
  [".mc-dialog", ["backgroundColor", "borderTopColor"]],
  [".wf-dialog", ["backgroundColor", "borderTopColor"]],
  [".wf-dialog-choice-label", ["color"]],
  // PR #1400 review follow-up — reusable-control rules whose prefixes were missing from
  // the classifier and were migrated as part of the same follow-up.
  [".ui-error-notice", ["color", "backgroundColor", "borderTopColor"]],
  [".ui-error-notice-title", ["color"]],
  [".ui-error-notice-close", ["color"]],
  [".ui-error-notice-message", ["color"]],
  [".ui-error-notice-remediation", ["color"]],
  [".ui-error-notice-code", ["color", "backgroundColor", "borderTopColor"]],
  [".qi-source-kind-grid", ["backgroundColor", "borderTopColor"]],
  [".qi-source-kind-option", ["color"]],
  ['.qi-source-kind-option[aria-checked="true"]', ["color"]],
  [".perm-note", ["color"]],
  [".plg-row", ["color"]],
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
  body{margin:0;padding:16px;display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start}
  .ksel-menu,.edm-menu,.cmdk-list{display:block}
  </style></head><body><div id="root">${BODY}</div></body></html>`;
}

async function collect(page, cssText, mode) {
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
  }, PROBES);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  deviceScaleFactor: 2,
  viewport: { width: 1280, height: 1400 },
});
const page = await ctx.newPage();

let totalProbes = 0;
const diffs = [];
const missing = new Set();
const proof = {};

for (const mode of MODES) {
  const pre = await collect(page, PRE, mode);
  const post = await collect(page, POST, mode);
  let modeDiffs = 0;
  let modeProbes = 0;
  for (const [sel] of PROBES) {
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
  await collect(page, POST, mode);
  await page.screenshot({ path: resolve(HERE, `${mode.id}.png`), fullPage: true });
  console.log(`${mode.id}: ${modeProbes} probes, ${modeDiffs} differing computed values`);
}

writeFileSync(
  resolve(HERE, "computed-value-proof.json"),
  JSON.stringify(
    {
      issue: 1294,
      baseRef: BASE_REF,
      totalProbes,
      diffCount: diffs.length,
      missingSelectors: [...missing],
      byMode: proof,
      diffs,
    },
    null,
    2,
  ),
);
console.log(`\nTOTAL: ${totalProbes} computed-value probes across ${MODES.length} modes`);
console.log(`MISSING selectors (not in DOM, skipped): ${missing.size}`);
console.log(`DIFFERENCES (pre vs post): ${diffs.length}`);
for (const d of diffs.slice(0, 80)) console.log(d);
await browser.close();
process.exit(diffs.length === 0 ? 0 : 1);
