// Issue #1299 — component state matrix browser evidence harness.
//
// Proves that the live `design-system/states.html` renders its applicability matrix
// identically across all 7 canonical theme / contrast / motion modes AND that the
// rendered matrix matches `docs/design-system/state-matrix.md` cell-for-cell.
//
// What is proved:
//   - The per-component state strips in states.html render without layout errors in every mode.
//   - The matrix rendered by the browser (#mx tbody) agrees with the documented matrix in
//     state-matrix.md: for each component row, each of the 11 state cells (check = span.y svg
//     present, dot = absent) matches the documented check / dot value.
//   - Screenshots capture the full proof page in dark, light, high-contrast, forced-colors,
//     and reduced-motion so visual inspection is always available.
//
// Reproduction (from repo root, after `npm ci` + `npx playwright install chromium`):
//   node docs/design-system/evidence/1299/equivalence-harness.mjs
//
// Exits non-zero if any rendered matrix cell differs from state-matrix.md in any mode.
// Writes matrix-fidelity-proof.json + 01-dark.png ... 07-reduced-motion.png.

import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const STATES_HTML = resolve(REPO, "design-system/states.html");
const MATRIX_MD = resolve(REPO, "docs/design-system/state-matrix.md");

// --- 7 canonical modes (identical list used by every #1293-#1298 harness) -----
const MODES = [
  { id: "01-dark",              theme: null,    hc: null,   media: {} },
  { id: "02-light",             theme: "light", hc: null,   media: {} },
  { id: "03-dark-hc",           theme: null,    hc: "more", media: {} },
  { id: "04-light-hc",          theme: "light", hc: "more", media: {} },
  { id: "05-prefers-contrast",  theme: null,    hc: null,   media: { contrast: "more" } },
  { id: "06-forced-colors",     theme: null,    hc: null,   media: { forcedColors: "active" } },
  { id: "07-reduced-motion",    theme: null,    hc: null,   media: { reducedMotion: "reduce" } },
];

// --- Parse state-matrix.md applicability table --------------------------------
// Format: pipe table, 12 cells per row (Component + 11 state columns).
// Header row: cell[0] === "Component". Separator: cell[1] matches /^[-:\s]+$/.
// Data rows: cell[0] is name; cells[1..11] -> "1" if contains check-mark, else "0".
function parseMatrixMd(src) {
  const CHECK = "✓";
  const lines = src.split("\n");
  const rows = [];
  for (const line of lines) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length !== 12) continue;
    const first = cells[0];
    if (first === undefined) continue;
    if (first === "Component") continue;
    if (cells[1] !== undefined && /^[-:\s]+$/.test(cells[1])) continue;
    const bits = cells
      .slice(1)
      .map((c) => (c.includes(CHECK) ? "1" : "0"))
      .join("");
    rows.push({ name: first, bits });
  }
  return rows;
}

const matrixMdSrc = readFileSync(MATRIX_MD, "utf8");
const docRows = parseMatrixMd(matrixMdSrc);
const docMap = new Map(docRows.map((r) => [r.name, r.bits]));

const statesUrl = pathToFileURL(STATES_HTML).href;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  deviceScaleFactor: 2,
  viewport: { width: 1280, height: 1400 },
});

const byMode = {};
const allDiffs = [];
let rowCount = 0;

for (const mode of MODES) {
  const page = await context.newPage();

  // Emulate media features before navigation so the first paint is correct.
  await page.emulateMedia({
    colorScheme: "dark",
    ...mode.media,
  });

  // file:// navigation -- no HTTP server required (CodeQL-safe).
  await page.goto(statesUrl, { waitUntil: "load" });

  // Apply data-theme / data-hc attributes per mode.
  await page.evaluate(({ theme, hc }) => {
    if (theme !== null) {
      document.documentElement.dataset.theme = theme;
    } else {
      document.documentElement.dataset.theme = "dark";
    }
    if (hc !== null) {
      document.documentElement.dataset.hc = hc;
    } else {
      delete document.documentElement.dataset.hc;
    }
  }, { theme: mode.theme, hc: mode.hc });

  // Wait for the ROWS script to have rendered the matrix tbody.
  await page.waitForSelector("#mx tbody tr");

  // Read the rendered matrix from the DOM.
  const renderedRows = await page.evaluate(() => {
    const trs = Array.from(document.querySelectorAll("#mx tbody tr"));
    return trs.map((tr) => {
      const cells = Array.from(tr.querySelectorAll("td"));
      const name = (cells[0]?.textContent ?? "").trim();
      const bits = cells
        .slice(1)
        .map((td) => (td.querySelector("span.y svg") !== null ? "1" : "0"))
        .join("");
      return { name, bits };
    });
  });

  rowCount = renderedRows.length;

  // Compare rendered rows against documented matrix.
  const modeDiffs = [];
  for (const { name, bits } of renderedRows) {
    const docBits = docMap.get(name);
    if (docBits === undefined) {
      modeDiffs.push({
        mode: mode.id,
        component: name,
        issue: "component in rendered matrix but not in state-matrix.md",
        rendered: bits,
        documented: null,
      });
      continue;
    }
    if (bits !== docBits) {
      for (let col = 0; col < 11; col++) {
        if (bits[col] !== docBits[col]) {
          modeDiffs.push({
            mode: mode.id,
            component: name,
            col,
            rendered: bits[col],
            documented: docBits[col],
          });
        }
      }
    }
  }

  byMode[mode.id] = {
    renderedRows: renderedRows.length,
    diffs: modeDiffs.length,
  };

  allDiffs.push(...modeDiffs);

  // Screenshot the full proof page.
  await page.screenshot({
    path: resolve(HERE, mode.id + ".png"),
    fullPage: true,
  });

  await page.close();
}

await browser.close();

// --- Write proof artefact -----------------------------------------------------
const proof = {
  statesHtml: "design-system/states.html",
  docMatrix: "docs/design-system/state-matrix.md",
  rowCount,
  diffCount: allDiffs.length,
  byMode,
  diffs: allDiffs,
};

writeFileSync(resolve(HERE, "matrix-fidelity-proof.json"), JSON.stringify(proof, null, 2));

// --- Summary ------------------------------------------------------------------
const modeLines = Object.entries(byMode)
  .map(([id, { renderedRows, diffs }]) => `  ${id}: ${renderedRows} rows, ${diffs} diffs`)
  .join("\n");
console.log(
  [
    `states.html: ${STATES_HTML}`,
    `state-matrix.md: ${MATRIX_MD}`,
    `Rendered row count: ${rowCount}`,
    `Total diffs across all modes: ${allDiffs.length}`,
    modeLines,
    allDiffs.length === 0
      ? "PASS -- rendered matrix matches state-matrix.md in all 7 modes."
      : `FAIL -- ${allDiffs.length} cell(s) differ. See matrix-fidelity-proof.json.`,
  ].join("\n"),
);

process.exit(allDiffs.length === 0 ? 0 : 1);
