#!/usr/bin/env node
// Keeps keiko-ui's `browserslist` declaration TRUE.
//
// Why this gate exists: the declaration said chrome/edge >= 79, firefox >= 72, safari >= 13.1 while
// the shipped UI called `Array.prototype.at(-n)` (Firefox 90 / Safari 15.4) in 35 places across 22
// production files, `crypto.randomUUID` (Firefox 95 / Safari 15.4) in 19 across 13, `Object.hasOwn`
// (Firefox 92) in 7 across 6, and `AbortSignal.timeout` (Firefox 100 / Safari 16) in the API
// client. On any browser inside the declared-but-unsupported range the app does not degrade — it
// throws on first use. Nothing checked the claim, so it drifted silently for as long as it existed:
// a declaration a machine never verifies is documentation, not a guarantee.
//
// Counting note: the failure messages below report FILES, not occurrences — the two numbers differ
// (35 occurrences live in 22 files), and quoting one as the other is how the original commit
// message got all three of these counts wrong.
//
// What it checks: for each API below, if the UI source calls it, every floor in `browserslist` must
// be at or above that API's first supporting version. Fails closed — an unparsable declaration or
// an unreadable source tree is a FAILURE, never a skip, so the gate cannot silently disappear.
//
// The version table is curated and hand-maintained ON PURPOSE. caniuse-lite (already installed for
// browserslist) does not carry per-builtin ES features like `Array.prototype.at`, and adding an
// MDN compat-data dependency for this would be a supply-chain change ADR-0001 does not warrant.
// Each entry therefore records its source so a reviewer can re-check it; adding an API here is
// cheaper than discovering it from a customer's Firefox.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
// Imported, never restated: a second copy of these numbers here would drift from the transpiler's
// own copy exactly the way the browserslist declaration drifted from the product. The module is
// `isMainModule`-guarded, so importing it runs no transpilation.
import { TARGETS as TRANSPILE_TARGETS } from "./transpile-ui-static-js.mjs";

const UI_PACKAGE = "packages/keiko-ui/package.json";
const SOURCE_ROOTS = ["packages/keiko-ui/src", "packages/keiko-editor/src"];

// pattern: matched against production source (tests excluded — they run in Node, not a browser).
// Versions are the FIRST release of each engine that supports the API (MDN browser-compat-data).
const GUARDED_APIS = [
  {
    name: "Array.prototype.at",
    pattern: /\.at\(\s*-/,
    minimum: { chrome: 92, edge: 92, firefox: 90, safari: 15.4 },
  },
  {
    name: "crypto.randomUUID",
    pattern: /\bcrypto\.randomUUID\s*\(/,
    minimum: { chrome: 92, edge: 92, firefox: 95, safari: 15.4 },
  },
  {
    name: "AbortSignal.timeout",
    pattern: /\bAbortSignal\.timeout\s*\(/,
    minimum: { chrome: 103, edge: 103, firefox: 100, safari: 16 },
  },
  {
    name: "AbortSignal.any",
    pattern: /\bAbortSignal\.any\s*\(/,
    minimum: { chrome: 116, edge: 116, firefox: 124, safari: 17.4 },
  },
  {
    name: "structuredClone",
    pattern: /\bstructuredClone\s*\(/,
    minimum: { chrome: 98, edge: 98, firefox: 94, safari: 15.4 },
  },
  {
    name: "Object.hasOwn",
    pattern: /\bObject\.hasOwn\s*\(/,
    minimum: { chrome: 93, edge: 93, firefox: 92, safari: 15.4 },
  },
  {
    name: "Array.prototype.toSorted",
    pattern: /\.toSorted\s*\(/,
    minimum: { chrome: 110, edge: 110, firefox: 115, safari: 16 },
  },
  {
    name: "Array.prototype.findLast",
    pattern: /\.findLast(Index)?\s*\(/,
    minimum: { chrome: 97, edge: 97, firefox: 104, safari: 15.4 },
  },
  {
    name: "HTMLElement.showPopover",
    pattern: /\.(show|hide|toggle)Popover\s*\(/,
    minimum: { chrome: 114, edge: 114, firefox: 125, safari: 17 },
  },
  {
    name: "Intl.Segmenter",
    pattern: /\bIntl\.Segmenter\b/,
    minimum: { chrome: 87, edge: 87, firefox: 125, safari: 14.1 },
  },
];

function fail(message) {
  console.error(`browser-baseline: FAIL — ${message}`);
  process.exitCode = 1;
}

function collectSources() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
        files.push(path);
      }
    }
  };
  for (const root of SOURCE_ROOTS) walk(root);
  return files;
}

// "chrome >= 111" -> { engine: "chrome", floor: 111 }. Any other shape is a failure: this gate
// cannot reason about a query it does not understand, and guessing would defeat its purpose.
function parseDeclaredFloors(queries) {
  const floors = new Map();
  for (const query of queries) {
    const match = /^([a-z_]+)\s*>=\s*([0-9]+(?:\.[0-9]+)?)$/u.exec(query.trim());
    if (match === null) {
      fail(`browserslist entry ${JSON.stringify(query)} is not a "<engine> >= <version>" floor`);
      return undefined;
    }
    floors.set(match[1], Number.parseFloat(match[2]));
  }
  return floors;
}

// Reads the declaration, failing closed on anything unusable.
function readDeclaredFloors() {
  let declared;
  try {
    declared = JSON.parse(readFileSync(UI_PACKAGE, "utf8")).browserslist;
  } catch (error) {
    fail(`${UI_PACKAGE} could not be read: ${String(error)}`);
    return undefined;
  }
  if (!Array.isArray(declared) || declared.length === 0) {
    fail("keiko-ui declares no browserslist floors");
    return undefined;
  }
  const floors = parseDeclaredFloors(declared);
  return floors === undefined ? undefined : { count: declared.length, floors };
}

function violationsFor(api, users, floors) {
  const found = [];
  for (const [engine, required] of Object.entries(api.minimum)) {
    const floor = floors.get(engine);
    // An engine the declaration does not name is not this gate's business.
    if (floor !== undefined && floor < required) {
      found.push(
        // `users` holds FILES, so the count is a file count. It used to be printed as "call
        // site(s)", which read as an occurrence count and did not match a hand grep — a file using
        // the API three times still counts once here.
        `${api.name} needs ${engine} >= ${String(required)} but browserslist declares ` +
          `${engine} >= ${String(floor)} (${String(users.length)} file(s), e.g. ${users[0]})`,
      );
    }
  }
  return found;
}

// The SECOND question this gate answers, and the one no test could ask before `TARGETS` was
// exported: does the Babel syntax floor stay AT OR BELOW the declared support floor?
//
// Direction matters and only one direction is a defect. A transpile floor BELOW the declaration is
// deliberate slack — the bundle is lowered further than it has to be, so every declared-supported
// browser can parse it. A floor ABOVE the declaration means Babel emits syntax that a
// declared-supported browser cannot parse: not a missing feature but a blank page, and a failure
// that no amount of API guarding below would catch. The two numbers previously lived in two files
// with no link between them, so nothing noticed when one moved.
function transpileFloorViolations(floors) {
  const found = [];
  for (const [engine, target] of Object.entries(TRANSPILE_TARGETS)) {
    const declared = floors.get(engine);
    if (declared === undefined) continue;
    const transpiled = Number.parseFloat(target);
    if (Number.isNaN(transpiled)) {
      found.push(`transpile target for ${engine} (${target}) is not a version number`);
      continue;
    }
    if (transpiled > declared) {
      found.push(
        `transpile floor ${engine} ${target} is ABOVE the declared browserslist floor ` +
          `${engine} >= ${String(declared)} — the exported bundle would use syntax a ` +
          `declared-supported browser cannot parse`,
      );
    }
  }
  return found;
}

function main() {
  const declaration = readDeclaredFloors();
  if (declaration === undefined) return;

  const floorViolations = transpileFloorViolations(declaration.floors);
  if (floorViolations.length > 0) {
    for (const violation of floorViolations) fail(violation);
    return;
  }

  const sources = collectSources();
  if (sources.length === 0) {
    fail("no UI sources were found — the scan would pass vacuously");
    return;
  }

  const violations = [];
  for (const api of GUARDED_APIS) {
    const users = sources.filter((path) => api.pattern.test(readFileSync(path, "utf8")));
    if (users.length > 0) violations.push(...violationsFor(api, users, declaration.floors));
  }

  if (violations.length > 0) {
    for (const violation of violations) fail(violation);
    console.error(
      "\nEither raise the browserslist floor in packages/keiko-ui/package.json, or stop using the " +
        "API. A declared-but-unsupported browser does not degrade — it throws on first use.",
    );
    return;
  }
  console.log(
    `browser-baseline: PASS — ${String(declaration.count)} declared floor(s) satisfy every guarded ` +
      `API across ${String(sources.length)} UI source files.`,
  );
}

main();
