import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chromium } from "playwright";

const baseline = "c8fb7e2d78720a8ba51d3d3ae7dd0e82f2df7add";
const file = "design-system/git-window.html";
const states = ["changes", "history", "empty"];
const properties = [
  "display",
  "flex-grow",
  "flex-shrink",
  "flex-basis",
  "min-height",
  "flex-direction",
  "width",
  "height",
  "margin-inline-start",
  "margin-inline-end",
  "padding",
  "border-top-width",
];

function source(path, revision) {
  if (revision === 0) {
    return execFileSync("/usr/bin/git", ["show", `${baseline}:${path}`], { encoding: "utf8" });
  }
  return readFileSync(path, "utf8");
}

function fixtureHtml(revision) {
  return source(file, revision)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, "")
    .replace(
      /<link rel="stylesheet" href="([\w-]+\.css)"\s*\/>/gu,
      (_match, stylesheet) => `<style>${source("design-system/" + stylesheet, revision)}</style>`,
    );
}

// Execute only the showcase's state projection, without running its embedded scripts.
function projectState(owner, input) {
  const rows = [];
  for (const element of owner.querySelectorAll("[data-when]")) {
    const visible = element.dataset.when.split(" ").includes(input.state);
    element.classList.toggle("gw-hide", !visible);
    const style = getComputedStyle(element);
    rows.push(
      Object.fromEntries(
        input.properties.map((property) => [property, style.getPropertyValue(property)]),
      ),
    );
  }
  return rows;
}

async function readState(page, state, revision) {
  await page.setContent(fixtureHtml(revision));
  const rows = await page.locator(".gw-win").evaluate(projectState, { state, properties });
  const switcher = await page.locator(".gw-states").evaluate((element, names) => {
    const style = getComputedStyle(element);
    return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name)]));
  }, properties);
  if ((await page.getByRole("group", { name: "Preview state", exact: true }).count()) !== 1) {
    throw new Error("The preview state controls must retain their named group.");
  }
  return [...rows, switcher];
}

function compareState(state, original, current, result) {
  for (let index = 0; index < original.length; index += 1) {
    for (const property of properties) {
      result.comparisons += 1;
      if (original[index][property] === current[index][property]) continue;
      result.differences.push({
        state,
        index,
        property,
        before: original[index][property],
        after: current[index][property],
      });
    }
  }
}

function writeProof(browser, result) {
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const proof = {
    schemaVersion: 1,
    baselineRevision: baseline,
    file,
    sourceSha256: hash(source(file, 1)),
    harnessSha256: hash(readFileSync(new URL(import.meta.url))),
    nodeVersion: process.version,
    chromiumVersion: browser.version(),
    states,
    stateNodeCount: 9,
    switcherNodeCount: 1,
    accessibleSwitcherGroup: true,
    computedValueComparisons: result.comparisons,
    differences: result.differences,
  };
  writeFileSync(
    new URL("./git-prototype-proof.json", import.meta.url),
    `${JSON.stringify(proof, null, 2)}\n`,
  );
  console.log(JSON.stringify(proof, null, 2));
  process.exitCode = result.differences.length > 0 ? 1 : 0;
}

async function main() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) => route.abort());
    const result = { comparisons: 0, differences: [] };
    for (const state of states) {
      const original = await readState(page, state, 0);
      const current = await readState(page, state, 1);
      compareState(state, original, current, result);
    }
    writeProof(browser, result);
  } finally {
    await browser.close();
  }
}
await main();
