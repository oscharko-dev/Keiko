import fs from "node:fs";
import cp from "node:child_process";
import path from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "playwright";

// Fixture-owned Chromium cascade comparison for the reported SonarCloud CSS changes.
// Run from the repository root. External requests are blocked; no product data is read.
const BASELINE = "c8fb7e2d78720a8ba51d3d3ae7dd0e82f2df7add";

const root = process.cwd();
const file = "packages/keiko-ui/src/app/globals.css";
const before = cp.execFileSync("/usr/bin/git", ["show", BASELINE + ":" + file], {
  encoding: "utf8",
});
const after = fs.readFileSync(file, "utf8");
const fixtures = [
  ["number", '<input class="mc-dialog-input number-control-input" type="number">'],
  [
    "select-down",
    '<div class="cmp-model"><button class="ksel-trigger cmp-model-select ksel-trigger-open-down">Select</button></div>',
  ],
  [
    "select-up",
    '<div class="cmp-model"><button class="ksel-trigger cmp-model-select ksel-trigger-open-up">Select</button></div>',
  ],
  ["badge", '<button class="rb-edge-badge-btn">Badge</button>'],
  ["search", '<div class="srch"><div class="tw-label srch-label">Search</div></div>'],
  ["connection", '<svg><path class="conn-path" data-reduced-motion="true"></path></svg>'],
  ["memory-focus", '<div class="mem-add"><input></div>'],
  ["dialog-focus", '<input class="dlg-input">'],
  ["gateway-focus", '<input class="gw-input">'],
  ["model-focus", '<select class="cmp-model-select"><option>Model</option></select>'],
  ["textarea-focus", '<textarea class="mc-dialog-textarea"></textarea>'],
  ["quality-focus", '<input class="qi-input">'],
  ["figma-focus", '<input class="figma-snapshot-input">'],
  ["workflow-focus", '<input class="wf-dialog-input">'],
  ["scope-focus", '<select class="scope-grounding-select"><option>Scope</option></select>'],
  ["history-focus", '<button class="chat-history-open">History</button>'],
  [
    "skeleton",
    '<table class="c-table is-loading"><tbody><tr><td class="num">Value</td></tr></tbody></table>',
  ],
  [
    "safety",
    '<section class="pe-section"><p class="pe-safety-warning">Warning</p><p class="pe-grounding-meta">Evidence</p></section>',
  ],
  [
    "destructive",
    '<div class="dlg-foot"><button class="dlg-btn lkd-btn-destructive">Delete</button></div>',
  ],
  [
    "slider",
    '<div class="ed-host"><div class="monaco-editor"><div class="scrollbar vertical"><div class="slider" style="width:4px;height:30px"></div></div><div class="scrollbar horizontal"><div class="slider" style="height:4px;width:30px"></div></div></div></div>',
  ],
  [
    "hover",
    '<div class="ed-host"><div class="monaco-editor"><div class="monaco-resizable-hover" style="width:600px;max-width:600px"><div class="monaco-hover" style="width:600px;max-width:600px;--vscode-hover-whiteSpace:nowrap"><div class="monaco-scrollable-element" style="width:600px;max-width:600px"><div class="monaco-hover-content"><div class="hover-row"><div class="hover-row-contents"><div class="hover-contents"><div class="rendered-markdown">Long hover text <a href="#">link</a><code>code</code><pre>pre</pre></div></div><div class="actions"><span class="action-label">Action</span></div></div></div><button class="hover-copy-button codicon"><span class="codicon">Copy</span></button></div></div></div></div></div></div>',
  ],
  [
    "workbench-hover",
    '<div class="workbench-hover-container"><div class="monaco-hover workbench-hover" style="max-width:600px"><div class="hover-contents">Copy</div></div><div class="workbench-hover-pointer"></div></div>',
  ],
  [
    "workbench-pointer",
    '<div class="workbench-hover-container"><div class="monaco-hover workbench-hover with-pointer" style="max-width:600px"><div class="hover-contents">Copy</div></div><div class="workbench-hover-pointer"></div></div>',
  ],
  [
    "destructive-hover",
    '<div class="dlg-foot"><button class="dlg-btn lkd-btn-destructive">Delete</button></div>',
  ],
  [
    "destructive-disabled",
    '<div class="dlg-foot"><button class="dlg-btn lkd-btn-destructive" disabled>Delete</button></div>',
  ],
  [
    "workbench-locked",
    '<div class="workbench-hover-container locked"><div class="monaco-hover workbench-hover" style="max-width:600px"><div class="hover-contents">Copy</div></div><div class="workbench-hover-pointer"></div></div>',
  ],
  [
    "workbench-locked-focus",
    '<div class="workbench-hover-container locked"><div class="monaco-hover workbench-hover" tabindex="0" style="max-width:600px"><div class="hover-contents">Copy</div></div><div class="workbench-hover-pointer"></div></div>',
  ],
  [
    "slider-hover",
    '<div class="ed-host"><div class="monaco-editor"><div class="scrollbar vertical"><div class="slider" style="width:4px;height:30px"></div></div></div></div>',
  ],
  [
    "copy-hover",
    '<div class="ed-host"><div class="monaco-editor"><div class="monaco-hover"><button class="hover-copy-button codicon">Copy</button></div></div></div>',
  ],
  [
    "workbench-summary",
    '<div class="cmpContextUsage"><dl class="cmpContextSummary"><dt>Context</dt><dd>100</dd></dl></div>',
    "packages/keiko-ui/src/app/components/desktop/widgets/coding-workbench/CodingWorkbenchWindow.module.css",
  ],
  [
    "terminal-focus",
    '<div class="lazyWidgetScope"><label class="tm-field"><input></label></div>',
    "packages/keiko-ui/src/app/components/desktop/widgets/cards/TerminalWidget.module.css",
  ],
  [
    "debug-toggle",
    '<input class="toggle" type="checkbox" checked>',
    "packages/keiko-ui/src/app/components/desktop/widgets/panels/DebuggingSettings.module.css",
  ],
];
const properties = [
  "padding-right",
  "border-radius",
  "margin",
  "color",
  "background-color",
  "border-color",
  "box-shadow",
  "outline",
  "min-width",
  "min-height",
  "max-width",
  "white-space",
  "display",
  "overflow-wrap",
  "border-right-width",
  "border-bottom-width",
];
function cssFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...cssFiles(candidate));
    else if (entry.name.endsWith(".css")) files.push(candidate);
  }
  return files;
}

const vendor = cssFiles(path.join(root, "node_modules/monaco-editor/esm/vs"))
  .map((source) => fs.readFileSync(source, "utf8"))
  .join("\n");
const hoverSelectors = {
  "destructive-hover": ".lkd-btn-destructive",
  "slider-hover": ".slider",
  "copy-hover": ".hover-copy-button",
};

function modeCases() {
  return ["dark", "light"].flatMap((theme) =>
    ["no-preference", "more"].flatMap((contrast) =>
      ["pointer", "keyboard"].map((modality) => ({ theme, contrast, modality })),
    ),
  );
}

function moduleCss(modulePath, revision) {
  if (modulePath === undefined) return "";
  const source =
    revision === 0
      ? cp.execFileSync("/usr/bin/git", ["show", `${BASELINE}:${modulePath}`], { encoding: "utf8" })
      : fs.readFileSync(modulePath, "utf8");
  return source.replace(/:global\(([^)]+)\)/gu, "$1");
}

async function forceHover(page, name) {
  const selector = hoverSelectors[name];
  if (selector === undefined) return undefined;
  const session = await page.context().newCDPSession(page);
  await session.send("DOM.enable");
  await session.send("CSS.enable");
  const document = await session.send("DOM.getDocument");
  const { nodeId } = await session.send("DOM.querySelector", {
    nodeId: document.root.nodeId,
    selector,
  });
  await session.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] });
  return session;
}

// This function executes in the fixture browser, without closing over Node state.
function computedProperties(elements, selectedProperties) {
  const rows = [];
  for (const element of elements) {
    for (const pseudo of [null, "::before", "::after"]) {
      const style = getComputedStyle(element, pseudo);
      rows.push(
        Object.fromEntries(
          selectedProperties.map((property) => [property, style.getPropertyValue(property)]),
        ),
      );
    }
  }
  return rows;
}

async function readFixture(page, mode, fixture, revision) {
  const [name, html, modulePath] = fixture;
  const css = revision === 0 ? before : after;
  await page.setContent(
    `<html data-theme="${mode.theme}" data-input-modality="${mode.modality}"><head>` +
      `<style>${css}\n${moduleCss(modulePath, revision)}</style><style>${vendor}</style>` +
      `<style>*,*::before,*::after { transition:none !important; animation:none !important; }</style>` +
      `</head><body>${html}</body></html>`,
  );
  if (name.endsWith("focus"))
    await page.locator("input,textarea,select,button,[tabindex]").first().focus();
  const session = await forceHover(page, name);
  try {
    await page.evaluate(() => {
      for (const animation of document.getAnimations()) animation.finish();
    });
    return await page.locator("body *").evaluateAll(computedProperties, properties);
  } finally {
    await session?.detach();
  }
}

function compareValues(original, current, context, state) {
  state.probes += original.length * properties.length;
  for (let index = 0; index < original.length; index += 1) {
    for (const property of properties) {
      if (original[index][property] === current[index][property]) continue;
      state.differences.push({
        ...context,
        index,
        property,
        before: original[index][property],
        after: current[index][property],
      });
    }
  }
}

async function compareFixture(page, mode, fixture, state) {
  await page.emulateMedia({
    colorScheme: mode.theme,
    contrast: mode.contrast,
    reducedMotion: "no-preference",
  });
  const original = await readFixture(page, mode, fixture, 0);
  const current = await readFixture(page, mode, fixture, 1);
  compareValues(original, current, { ...mode, name: fixture[0] }, state);
}

function sha256File(source) {
  return createHash("sha256").update(fs.readFileSync(source)).digest("hex");
}

function writeProof(browser, state) {
  const modulePaths = fixtures.flatMap((fixture) => (fixture[2] === undefined ? [] : [fixture[2]]));
  const sources = [file, ...new Set(modulePaths)];
  const proof = {
    schemaVersion: 1,
    baselineRevision: BASELINE,
    harnessSha256: sha256File(new URL(import.meta.url)),
    sourceSha256: Object.fromEntries(sources.map((source) => [source, sha256File(source)])),
    nodeVersion: process.version,
    chromiumVersion: browser.version(),
    fixtureIds: fixtures.map(([name]) => name),
    postCssSha256: createHash("sha256").update(after).digest("hex"),
    fixtureCount: fixtures.length,
    computedValueComparisons: state.probes,
    differences: state.differences,
  };
  fs.writeFileSync(
    new URL("./css-preservation-proof.json", import.meta.url),
    `${JSON.stringify(proof, null, 2)}\n`,
  );
  console.log(JSON.stringify({ probes: state.probes, differences: state.differences }, null, 2));
  process.exitCode = state.differences.length > 0 ? 1 : 0;
}

async function main() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.route("**/*", (route) => route.abort());
    const state = { probes: 0, differences: [] };
    for (const mode of modeCases()) {
      for (const fixture of fixtures) await compareFixture(page, mode, fixture, state);
    }
    writeProof(browser, state);
  } finally {
    await browser.close();
  }
}
await main();
