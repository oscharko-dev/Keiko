import fixtureData from "../1300/component-fixture-data.json" with { type: "json" };
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import postcss from "postcss";
import { chromium } from "playwright";
import { readStylesheet } from "../../../../packages/keiko-ui/read-stylesheet.mjs";
import { designEvidenceSourceHashes } from "../../../../scripts/lib/design-evidence-sources.mjs";

// Owned, network-isolated fixtures; this proves the data/code separation against the original
// product styles, including motion policy. One page is reused, so comparisons must be serial.
const BASELINE = "c8fb7e2d78720a8ba51d3d3ae7dd0e82f2df7add";
const CSS_PATH = "packages/keiko-ui/src/app/globals.css";
const root = process.cwd();
const previous = execFileSync("/usr/bin/git", ["show", `${BASELINE}:${CSS_PATH}`], {
  encoding: "utf8",
});
const current = readStylesheet(CSS_PATH);
const body =
  fixtureData.body
    .join("\n")
    .replaceAll("{{ICON}}", "▾")
    .replaceAll("{{CHECK}}", "✓")
    .replaceAll("{{PERF_ROWS}}", "") +
  '<div class="ai-thinking"><span class="dots"><i></i><i></i><i></i></span></div><span class="ai-caret"></span><div class="c-slider"><input type="range"></div>';

function propertyNames(custom) {
  const names = new Set(
    custom ? ["color", "background-color", "font-family", "font-size", "color-scheme"] : [],
  );
  for (const css of [previous, current])
    postcss.parse(css).walkDecls((declaration) => {
      if (declaration.prop.startsWith("--") === custom) names.add(declaration.prop);
    });
  return [...names].sort((left, right) => left.localeCompare(right));
}
function comparisonModes() {
  const dimensions = {
    theme: ["dark", "light"],
    contrast: ["no-preference", "more"],
    reducedMotion: ["no-preference", "reduce"],
    forcedColors: ["none", "active"],
    hc: ["", "more"],
    density: ["", "compact"],
  };
  return Object.entries(dimensions).reduce(
    (modes, [name, values]) =>
      modes.flatMap((mode) => values.map((value) => ({ ...mode, [name]: value }))),
    [{}],
  );
}
function browserSnapshot({ properties, component }) {
  for (const animation of globalThis.document.getAnimations()) {
    animation.pause();
    animation.currentTime = 0;
  }
  const elements = component
    ? [...globalThis.document.querySelectorAll("body *")]
    : [globalThis.document.documentElement];
  return elements.flatMap((element) =>
    (component ? [null, "::before", "::after"] : [null]).map((pseudo) => {
      const style = globalThis.getComputedStyle(element, pseudo);
      return Object.fromEntries(
        properties.map((property) => [property, style.getPropertyValue(property)]),
      );
    }),
  );
}
async function snapshot(page, css, mode, properties, component) {
  await page.setContent(
    `<html data-theme="${mode.theme}" data-hc="${mode.hc}" data-density="${mode.density}"><head><style>${css}</style></head><body>${component ? body : ""}</body></html>`,
    { waitUntil: "domcontentloaded" },
  );
  return page.evaluate(browserSnapshot, { properties, component });
}
function compareSnapshots(before, after, mode, properties, state) {
  if (before.length !== after.length) throw new Error("Style preservation fixture shape changed");
  state.comparisons += before.length * properties.length;
  before.forEach((row, element) =>
    properties.forEach((property) => {
      if (row[property] !== after[element][property])
        state.differences.push({
          mode,
          element,
          property,
          previous: row[property],
          current: after[element][property],
        });
    }),
  );
}
async function compareMode(page, mode, component, state) {
  await page.emulateMedia({
    colorScheme: mode.theme,
    contrast: mode.contrast,
    reducedMotion: mode.reducedMotion,
    forcedColors: mode.forcedColors,
  });
  const properties = propertyNames(!component);
  const before = await snapshot(page, previous, mode, properties, component);
  const after = await snapshot(page, current, mode, properties, component);
  compareSnapshots(before, after, mode, properties, state);
}
async function compareModes(page, modes, component) {
  const state = { comparisons: 0, differences: [] };
  for (const mode of modes) await compareMode(page, mode, component, state);
  return state;
}
async function main() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.route("**/*", (route) => route.abort());
    const modes = comparisonModes();
    const tokens = await compareModes(page, modes, false);
    const components = await compareModes(
      page,
      modes.filter((mode) => mode.forcedColors === "none" && mode.hc === "" && mode.density === ""),
      true,
    );
    const proof = {
      baseline: BASELINE,
      nodeVersion: process.version,
      chromiumVersion: browser.version(),
      sourceFiles: designEvidenceSourceHashes(root),
      producerSha256: createHash("sha256")
        .update(readFileSync(new URL(import.meta.url)))
        .digest("hex"),
      tokenModes: modes.length,
      tokens,
      components,
    };
    writeFileSync(
      new URL("./design-style-preservation-proof.json", import.meta.url),
      JSON.stringify(proof, null, 2) + "\n",
    );
    console.log(
      JSON.stringify({
        tokenComparisons: tokens.comparisons,
        componentComparisons: components.comparisons,
        differences: tokens.differences.length + components.differences.length,
      }),
    );
    if (tokens.differences.length + components.differences.length > 0) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}
await main();
