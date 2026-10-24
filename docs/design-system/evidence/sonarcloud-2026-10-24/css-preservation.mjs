import { readStylesheet } from "../../../../packages/keiko-ui/read-stylesheet.mjs";
import fs from "node:fs";
import cp from "node:child_process";
import path from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import fixtures from "./css-fixtures.json" with { type: "json" };

// Fixture-owned Chromium cascade comparison for the reported SonarCloud CSS changes.
// Run from the repository root. External requests are blocked; no product data is read.
const BASELINE = "c8fb7e2d78720a8ba51d3d3ae7dd0e82f2df7add";

const root = process.cwd();
const file = "packages/keiko-ui/src/app/globals.css";
const before = cp.execFileSync("/usr/bin/git", ["show", BASELINE + ":" + file], {
  encoding: "utf8",
});
const after = readStylesheet(file);

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
      : readStylesheet(modulePath);
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
    fixtureDataSha256: sha256File(new URL("./css-fixtures.json", import.meta.url)),
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
