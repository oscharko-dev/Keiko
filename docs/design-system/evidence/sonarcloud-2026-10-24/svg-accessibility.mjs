import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { chromium } from "playwright";

const baseline = "c8fb7e2d78720a8ba51d3d3ae7dd0e82f2df7add";
const report = JSON.parse(
  readFileSync("docs/qa/sonarcloud-blocker-medium-2026-10-24.json", "utf8"),
);
const issues = report.inventory.filter((issue) => issue.rule === "Web:ImgWithoutAltCheck");
const files = [...new Set(issues.map((issue) => issue.file))];
const modes = [
  { theme: "dark", contrast: false },
  { theme: "light", contrast: false },
  { theme: "dark", contrast: true },
  { theme: "light", contrast: true },
];
const hash = (data) => createHash("sha256").update(data).digest("hex");
const semanticAttributes = new Set(["role", "aria-label", "aria-hidden"]);
const stylesheetHashes = new Map();

function svgGeometry(element) {
  return {
    tag: element.localName,
    attributes: [...element.attributes]
      .filter(({ name }) => !semanticAttributes.has(name))
      .map(({ name, value }) => [name, value])
      .sort(([a], [b]) => a.localeCompare(b)),
    children: [...element.children].map(svgGeometry),
  };
}

function targetRecord(issue, index, original, current) {
  if (JSON.stringify(svgGeometry(original)) !== JSON.stringify(svgGeometry(current))) {
    throw new Error("SVG geometry changed at " + issue.key);
  }
  const name = current.getAttribute("aria-label");
  const decorative = current.getAttribute("aria-hidden") === "true";
  if (!decorative && (current.getAttribute("role") !== "img" || !name)) {
    throw new Error("Missing accessible image name at " + issue.key);
  }
  if (current.querySelector('a[href], [tabindex]:not([tabindex="-1"])')) {
    throw new Error("An SVG contains interactive descendants at " + issue.key);
  }
  return {
    ...issue,
    svgIndex: index,
    disposition: decorative ? "decorative" : "named image",
    accessibleName: name,
  };
}

function pagePair(file) {
  const source = readFileSync(file, "utf8");
  const previous = execFileSync("/usr/bin/git", ["show", `${baseline}:${file}`], {
    encoding: "utf8",
  });
  const original = new JSDOM(previous, { includeNodeLocations: true });
  const current = new JSDOM(source, { includeNodeLocations: true });
  const oldSvgs = [...original.window.document.querySelectorAll("svg")];
  const newSvgs = [...current.window.document.querySelectorAll("svg")];
  if (oldSvgs.length !== newSvgs.length) throw new Error("SVG count changed in " + file);
  const patches = [];
  const targets = issues
    .filter((issue) => issue.file === file)
    .map((issue) => {
      const index = oldSvgs.findIndex(
        (svg) => original.nodeLocation(svg).startLine === issue.analysedLine,
      );
      if (index < 0) throw new Error("Missing baseline SVG at " + issue.key);
      const oldTag = original.nodeLocation(oldSvgs[index]).startTag;
      const newTag = current.nodeLocation(newSvgs[index]).startTag;
      patches.push({ ...newTag, text: previous.slice(oldTag.startOffset, oldTag.endOffset) });
      return targetRecord(issue, index, oldSvgs[index], newSvgs[index]);
    });
  let before = source;
  for (const patch of patches.toSorted((a, b) => b.startOffset - a.startOffset)) {
    before = before.slice(0, patch.startOffset) + patch.text + before.slice(patch.endOffset);
  }
  return { file, before, after: source, targets };
}

function inlineStyles(source) {
  return source.replace(/<link rel="stylesheet" href="([\w-]+\.css)"\s*\/>/gu, (_match, name) => {
    const file = "design-system/" + name;
    const css = readFileSync(file, "utf8");
    stylesheetHashes.set(file, hash(css));
    return `<style>${css}</style>`;
  });
}

function isolatedHtml(source) {
  return inlineStyles(source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, ""));
}

async function exerciseGrid(page, source) {
  const html = inlineStyles(source.replace(/<script\b[^>]*\bsrc=[^>]*>[\s\S]*?<\/script>/gu, ""));
  await page.setContent(html);
  const table = page.locator("#grid-table");
  const boxes = table.locator(".rowsel");
  const rowCount = await boxes.count();
  const sort = table.locator('th.sortable[data-key="runs"]');
  const initialSortDirection = await sort.getAttribute("aria-sort");
  await sort.focus();
  await page.keyboard.press("Enter");
  const sortedNames = await table
    .locator("tbody tr")
    .evaluateAll((rows) => rows.map((row) => row.dataset.name));
  const sortDirection = await sort.getAttribute("aria-sort");
  const selectAll = page.getByRole("checkbox", { name: "Select all", exact: true });
  await selectAll.focus();
  await page.keyboard.press("Space");
  const selectedAll = await table.locator(".rowsel:checked").count();
  await page.keyboard.press("Space");
  const cleared = await table.locator(".rowsel:checked").count();
  await boxes.first().focus();
  await page.keyboard.press("Space");
  const selectedOne = await table.locator(".rowsel:checked").count();
  const mixed = await selectAll.evaluate((element) => element.indeterminate);
  if (
    rowCount < 2 ||
    selectedAll !== rowCount ||
    cleared !== 0 ||
    selectedOne !== 1 ||
    !mixed ||
    sortDirection === initialSortDirection ||
    (sortDirection !== "ascending" && sortDirection !== "descending")
  ) {
    throw new Error(
      "Data table sorting or keyboard selection failed: " +
        JSON.stringify({ rowCount, selectedAll, cleared, selectedOne, mixed, sortDirection }),
    );
  }
  return {
    rowCount,
    sortedNames,
    initialSortDirection,
    sortDirection,
    selectedAll,
    cleared,
    selectedOne,
    mixed,
  };
}

async function checkGrid(page) {
  const file = "design-system/data-grid.html";
  const original = execFileSync("/usr/bin/git", ["show", `${baseline}:${file}`], {
    encoding: "utf8",
  });
  const before = await exerciseGrid(page, original);
  const after = await exerciseGrid(page, readFileSync(file, "utf8"));
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error("Data table behavior changed.");
  if ((await page.getByRole("table", { name: "Agents", exact: true }).count()) !== 1) {
    throw new Error("The showcase must expose native table semantics.");
  }
  return { identicalBehavior: true, nativeTable: true, ...after };
}

async function render(page, source, mode) {
  await page.setContent(isolatedHtml(source));
  await page.evaluate((input) => {
    document.documentElement.dataset.theme = input.theme;
    if (input.contrast) document.documentElement.dataset.hc = "more";
    else delete document.documentElement.dataset.hc;
    for (const animation of document.getAnimations()) {
      animation.pause();
      animation.currentTime = 0;
    }
    for (const svg of document.querySelectorAll("svg")) svg.pauseAnimations();
  }, mode);
  return await page.screenshot({ fullPage: true, animations: "disabled", caret: "hide" });
}

async function checkAccessibility(page) {
  await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
  return await page.evaluate(async () => {
    const result = await window.axe.run(
      { include: ["svg"] },
      {
        runOnly: { type: "rule", values: ["svg-img-alt", "aria-hidden-focus"] },
      },
    );
    return { violationCount: result.violations.length, incompleteCount: result.incomplete.length };
  });
}

async function checkPages(page) {
  const rows = [];
  const targets = [];
  for (const file of files) {
    const pair = pagePair(file);
    targets.push(...pair.targets);
    for (const mode of modes) {
      const before = await render(page, pair.before, mode);
      const after = await render(page, pair.after, mode);
      const accessibility = await checkAccessibility(page);
      rows.push({ file, ...mode, identicalPixels: before.equals(after), ...accessibility });
    }
  }
  return { rows, targets };
}

async function main() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
    });
    await page.route("**/*", (route) => route.abort());
    const dataGridInteraction = await checkGrid(page);
    const result = await checkPages(page);
    const failures = result.rows.filter(
      (row) => !row.identicalPixels || row.violationCount || row.incompleteCount,
    );
    const proof = {
      schemaVersion: 1,
      baselineRevision: baseline,
      nodeVersion: process.version,
      chromiumVersion: browser.version(),
      harnessSha256: hash(readFileSync(new URL(import.meta.url))),
      fileSha256: Object.fromEntries(files.map((file) => [file, hash(readFileSync(file))])),
      stylesheetSha256: Object.fromEntries(stylesheetHashes),
      scope:
        "Restore only the reported SVG start tags from the baseline in otherwise current HTML/CSS; scripts and network are disabled. Compare static pixels in four theme/contrast modes and run SVG-specific axe rules. This isolates SVG semantics from the separately verified CSS corrections.",
      dataGridInteraction,
      sourceGeometryComparisons: result.targets.length,
      pixelComparisons: result.rows.length,
      failedComparisons: failures.length,
      targets: result.targets,
      modes: result.rows,
    };
    writeFileSync(
      new URL("./svg-accessibility-proof.json", import.meta.url),
      JSON.stringify(proof, null, 2) + "\n",
    );
    console.log(
      JSON.stringify({
        svgTargets: proof.sourceGeometryComparisons,
        pixelComparisons: proof.pixelComparisons,
        failures: failures.length,
      }),
    );
    process.exitCode = failures.length ? 1 : 0;
  } finally {
    await browser.close();
  }
}
await main();
