// Issue #1293 — computed-value equivalence proof for the shell/chrome token migration.
//
// Renders representative shell markup with the PRE-migration (release/0.2.0 base) and the
// POST-migration (working-tree) globals.css, reads getComputedStyle for the migrated
// properties on every shell element across all theme/contrast/motion modes, and asserts
// the resolved values are byte-identical — the objective "no visual change" proof. Also
// captures one screenshot per mode (POST) as committed evidence.
//
// Self-contained reproduction (from the repo root, after `npm ci`):
//   node docs/design-system/evidence/1293/equivalence-harness.mjs
// Writes computed-value-proof.json + 01-dark.png … 07-reduced-motion.png next to itself and
// exits non-zero if any computed value differs between the two stylesheets.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const CSS_PATH = "packages/keiko-ui/src/app/globals.css";
const BASE_REF = process.env.BASE_REF ?? "origin/release/0.2.0";

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
if (
  !REF_RE.test(BASE_REF) ||
  BASE_REF.includes("..") ||
  BASE_REF.includes("@{") ||
  BASE_REF.endsWith(".lock") ||
  BASE_REF.endsWith("/")
) {
  throw new Error(`refusing unsafe BASE_REF: ${BASE_REF}`);
}

const BASE_SHA = execFileSync("git", ["-C", REPO, "rev-parse", "--verify", `${BASE_REF}^{commit}`], {
  encoding: "utf8",
}).trim();

const PRE = execFileSync("git", ["-C", REPO, "show", `${BASE_SHA}:${CSS_PATH}`], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const POST = readFileSync(resolve(REPO, CSS_PATH), "utf8");

// Representative static shell DOM — exercises the exact class names the migration touched.
const BODY = `
<div class="app">
  <div class="header">
    <div class="hd-brand"><div class="hd-logo"></div><div class="hd-wordmark">Keiko</div></div>
    <div class="hd-div"></div>
    <button class="tb-btn">T</button>
    <div class="tb-tabs"><div class="tb-tab" data-active="true">Tab</div></div>
    <div class="tb-status"><span class="dot" data-tone="ok"></span>Ready</div>
    <div class="hd-tools"><button class="hd-tool">H</button><button class="hd-tool-cta">New</button></div>
  </div>
  <div class="mid">
    <div class="rail rail-left">
      <button class="rail-new">+</button>
      <div class="rail-div"></div>
      <div class="rail-group">
        <button class="rail-btn">A</button>
        <button class="rail-btn" data-active="true" data-side="left">B</button>
      </div>
      <div class="rail-avatar">JS</div>
    </div>
    <div class="stage">
      <div class="workspace">
        <div class="ws-grid"></div>
        <div class="ws-scene">
          <div class="window" data-top="true">
            <div class="win-head">
              <div class="win-ico"></div>
              <div class="win-title">Window</div>
              <div class="win-sub"><span class="win-sub-text">sub</span></div>
              <div class="win-zoom"><button class="win-zbtn">-</button><span class="win-zpct">100%</span></div>
              <div class="win-traffic">
                <button class="win-traffic-btn win-traffic-maximize">M</button>
                <button class="win-traffic-btn win-traffic-close">X</button>
              </div>
              <button class="win-btn">.</button>
            </div>
            <div class="win-body">body</div>
            <button class="win-port wp-t"></button>
          </div>
          <div class="conn-badge">edge</div>
        </div>
        <div class="ws-zoom">
          <button class="ws-zoom-btn">-</button>
          <span class="ws-zoom-pct">100%</span>
        </div>
        <button class="ws-fab">+</button>
        <div class="ws-connect-hint">Click a port</div>
      </div>
    </div>
    <div class="rail rail-right"></div>
  </div>
  <div class="footer">
    <div class="ft-seg"><span class="ft-accent">accent</span></div>
    <div class="ft-window-wrap"><button class="ft-window-trigger">2 windows</button></div>
    <div class="ft-gov" data-mode="autonomous">Auto</div>
    <div class="ft-you">JS</div>
    <span class="ft-dim">dim</span>
  </div>
  <div class="install-banner">
    <div class="install-banner-body">
      <div class="install-banner-text">
        <div class="install-banner-heading">Install</div>
        <div class="install-banner-desc">Add to home screen</div>
      </div>
      <div class="install-banner-actions">
        <button class="install-banner-btn-install">Install</button>
        <button class="install-banner-btn-dismiss">Dismiss</button>
      </div>
    </div>
  </div>
</div>`;

const PROBES = [
  [".app", ["backgroundImage", "backgroundColor"]],
  [".rail-new", ["color", "backgroundColor", "borderTopColor"]],
  [".header", ["backgroundColor", "columnGap", "paddingLeft"]],
  [".hd-wordmark", ["fontSize", "fontWeight"]],
  [".hd-div", ["backgroundColor"]],
  [".tb-btn", ["color", "borderRadius"]],
  [".tb-tab[data-active='true']", ["backgroundColor", "color", "borderTopColor", "borderRadius"]],
  [".tb-status", ["color", "borderTopColor", "borderRadius"]],
  [".tb-status .dot[data-tone='ok']", ["backgroundColor"]],
  [".hd-tool", ["color"]],
  [".hd-tool-cta", ["color", "borderTopColor", "backgroundImage"]],
  [".rail", ["backgroundColor", "zIndex"]],
  [".rail-left", ["borderTopLeftRadius", "borderTopRightRadius"]],
  [".rail-div", ["backgroundColor"]],
  [".rail-btn", ["color", "borderRadius"]],
  [".rail-btn[data-active='true']", ["backgroundColor", "color"]],
  [".rail-avatar", ["color", "backgroundColor", "fontSize"]],
  [".stage", ["paddingLeft"]],
  [".workspace", ["borderRadius", "backgroundColor", "boxShadow", "borderTopColor"]],
  [".ws-grid", ["zIndex"]],
  [
    ".ws-zoom",
    ["columnGap", "borderRadius", "backgroundColor", "borderTopColor", "backdropFilter"],
  ],
  [".ws-zoom-btn", ["color"]],
  [".ws-zoom-pct", ["color"]],
  [".ws-fab", ["color", "backgroundImage"]],
  [
    ".ws-connect-hint",
    [
      "paddingLeft",
      "borderRadius",
      "backgroundColor",
      "borderTopColor",
      "boxShadow",
      "fontSize",
      "color",
    ],
  ],
  [".window", ["backgroundColor", "borderTopColor", "borderRadius", "boxShadow"]],
  [".win-head", ["columnGap", "borderBottomColor"]],
  [".win-title", ["fontWeight", "color"]],
  [".win-sub", ["color", "backgroundColor", "borderTopColor", "paddingLeft"]],
  [".win-btn", ["color"]],
  [".win-traffic", ["paddingLeft"]],
  [".win-traffic-btn", ["color"]],
  [".win-zbtn", ["color"]],
  [".win-zpct", ["color"]],
  [
    ".conn-badge",
    ["borderRadius", "backgroundColor", "color", "fontSize", "boxShadow", "borderTopColor"],
  ],
  [".win-port", ["zIndex", "backgroundColor", "borderTopColor"]],
  [".footer", ["columnGap", "paddingLeft", "backgroundColor", "color"]],
  [".ft-accent", ["color"]],
  [".ft-gov", ["columnGap", "borderTopColor", "borderRadius", "color"]],
  [".ft-you", ["backgroundColor", "color"]],
  [".ft-dim", ["color"]],
  [".ft-window-trigger", ["color"]],
  [
    ".install-banner",
    ["backgroundColor", "borderTopColor", "borderRadius", "boxShadow", "paddingLeft"],
  ],
  [".install-banner-heading", ["fontSize", "fontWeight", "color"]],
  [".install-banner-desc", ["fontSize", "color"]],
  [".install-banner-actions", ["columnGap"]],
  [
    ".install-banner-btn-install",
    ["paddingLeft", "borderRadius", "backgroundColor", "color", "fontSize", "fontWeight"],
  ],
  [
    ".install-banner-btn-dismiss",
    ["paddingLeft", "borderRadius", "borderTopColor", "color", "fontSize"],
  ],
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
  .app{display:flex;flex-direction:column;height:100vh}.mid{display:flex;flex:1;min-height:0}
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
  viewport: { width: 1280, height: 860 },
});
const page = await ctx.newPage();

let totalProbes = 0;
const diffs = [];
const proof = {};

for (const mode of MODES) {
  const pre = await collect(page, PRE, mode);
  const post = await collect(page, POST, mode);
  let modeDiffs = 0;
  let modeProbes = 0;
  for (const [sel, props] of PROBES) {
    if (post[sel] === "__MISSING__") {
      diffs.push(`[${mode.id}] ${sel} MISSING in DOM`);
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
  await page.screenshot({ path: resolve(HERE, `${mode.id}.png`) });
  console.log(`${mode.id}: ${modeProbes} probes, ${modeDiffs} differing computed values`);
}

writeFileSync(
  resolve(HERE, "computed-value-proof.json"),
  JSON.stringify(
    { baseRef: BASE_REF, totalProbes, diffCount: diffs.length, byMode: proof, diffs },
    null,
    2,
  ),
);
console.log(`\nTOTAL: ${totalProbes} computed-value probes across ${MODES.length} modes`);
console.log(`DIFFERENCES (pre vs post): ${diffs.length}`);
for (const d of diffs.slice(0, 80)) console.log(d);
await browser.close();
process.exit(diffs.length === 0 ? 0 : 1);
