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
import { isMainModule } from "./lib/is-main-module.mjs";

const UI_PACKAGE = "packages/keiko-ui/package.json";
const SOURCE_ROOTS = ["packages/keiko-ui/src", "packages/keiko-editor/src"];

// CSS is scanned too, and the reason is not symmetry. A missing JS API throws on first use, which
// is loud; an unsupported SELECTOR is silently ignored, so the rule never applies and the app
// renders wrong with nothing in the console.
//
// The bar for an entry here is NOT "unsupported below some version" — it is "does NOT degrade
// gracefully". A declaration an old engine drops (`text-wrap: balance` leaves the text unbalanced,
// `scrollbar-width` leaves a default scrollbar) is progressive enhancement and belongs nowhere near
// a gate: listing it would manufacture pressure to raise a support floor for a cosmetic nicety.
// A SELECTOR that fails to match is different — the whole rule body never applies. `:has()` is the
// live case: several shipped rules use it to DEFINE custom properties that later declarations
// consume, so on an engine without it those properties are simply absent.
const GUARDED_CSS = [
  {
    name: "CSS :has()",
    pattern: /:has\(/u,
    minimum: { chrome: 105, edge: 105, firefox: 121, safari: 15.4 },
  },
  {
    name: "CSS :is()",
    pattern: /:is\(/u,
    minimum: { chrome: 88, edge: 88, firefox: 78, safari: 14 },
  },
];

// pattern: matched against production source (tests excluded — they run in Node, not a browser).
// Versions are the FIRST release of each engine that supports the API (MDN browser-compat-data).
export const GUARDED_APIS = [
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

function collectSources(roots = SOURCE_ROOTS) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|css)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
        files.push(path);
      }
    }
  };
  for (const root of roots) walk(root);
  return files;
}

// "chrome >= 111" -> { engine: "chrome", floor: 111 }. Any other shape is a failure: this gate
// cannot reason about a query it does not understand, and guessing would defeat its purpose.
//
// A repeated engine is ALSO a failure, never a silent overwrite: Browserslist itself resolves every
// query in the array and unions the results, so `["chrome >= 100", "chrome >= 111"]` still includes
// Chrome 100 in the real target set even though this function used to keep only the Map's last write
// (Chrome 111). A guarded API needing Chrome 103-110 would then pass this gate while remaining
// unreachable on a browser Browserslist still declares supported. Rejecting the duplicate keeps this
// function's model of "the declared floor" equal to Browserslist's, and matches every other
// unparsable-input path in this gate: fail closed rather than guess which entry the author meant.
export function parseDeclaredFloors(queries) {
  const floors = new Map();
  for (const query of queries) {
    const match = /^([a-z_]+)\s*>=\s*([0-9]+(?:\.[0-9]+)?)$/u.exec(query.trim());
    if (match === null) {
      fail(`browserslist entry ${JSON.stringify(query)} is not a "<engine> >= <version>" floor`);
      return undefined;
    }
    const [, engine, version] = match;
    if (floors.has(engine)) {
      fail(
        `browserslist declares ${engine} more than once (${String(floors.get(engine))} and ` +
          `${version}) — duplicate engine floors silently collapse to the last one; keep exactly ` +
          "one entry per engine",
      );
      return undefined;
    }
    floors.set(engine, Number.parseFloat(version));
  }
  return floors;
}

// Reads the declaration, failing closed on anything unusable.
function readDeclaredFloors(uiPackage = UI_PACKAGE) {
  let declared;
  try {
    declared = JSON.parse(readFileSync(uiPackage, "utf8")).browserslist;
  } catch (error) {
    fail(`${uiPackage} could not be read: ${String(error)}`);
    return undefined;
  }
  if (!Array.isArray(declared) || declared.length === 0) {
    fail("keiko-ui declares no browserslist floors");
    return undefined;
  }
  const floors = parseDeclaredFloors(declared);
  return floors === undefined ? undefined : { count: declared.length, floors };
}

export function violationsFor(api, users, floors) {
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
// `targets` defaults to the transpiler's REAL exported table, so production behaviour is unchanged;
// it is injectable only so a test can drive the malformed-version branch, which cannot be reached
// through the shipped table (and must never be reachable by editing it).
export function transpileFloorViolations(floors, targets = TRANSPILE_TARGETS) {
  const found = [];
  for (const [engine, target] of Object.entries(targets)) {
    const declared = floors.get(engine);
    if (declared === undefined) continue;
    // Validate the WHOLE string before comparing. `Number.parseFloat` reads a numeric PREFIX, so
    // "111junk" and "111.0.1" both come back as 111 — a malformed target would silently compare as
    // a plausible version and pass a gate whose entire job is to catch exactly that kind of drift.
    const transpiled = /^[0-9]+(?:\.[0-9]+)?$/u.test(String(target).trim())
      ? Number.parseFloat(String(target))
      : Number.NaN;
    if (Number.isNaN(transpiled)) {
      found.push(`transpile target for ${engine} (${String(target)}) is not a version number`);
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

// Every guarded API that the sources actually call, checked against the declared floors.
function apiViolations(sources, floors) {
  const violations = [];
  const scripts = sources.filter((path) => !path.endsWith(".css"));
  const styles = sources.filter((path) => path.endsWith(".css"));
  for (const api of GUARDED_APIS) {
    const users = scripts.filter((path) => api.pattern.test(readFileSync(path, "utf8")));
    if (users.length > 0) violations.push(...violationsFor(api, users, floors));
  }
  for (const feature of GUARDED_CSS) {
    const users = styles.filter((path) => feature.pattern.test(readFileSync(path, "utf8")));
    if (users.length > 0) violations.push(...violationsFor(feature, users, floors));
  }
  return violations;
}

// `uiPackage`/`sourceRoots` default to the production paths, so the CLI below is unchanged. They
// exist so a test can drive every branch of this orchestration against a fixture instead of leaving
// it to run only in CI, where a wrong branch shows up as a confusing pass rather than a failure.
export function main({ uiPackage = UI_PACKAGE, sourceRoots = SOURCE_ROOTS } = {}) {
  const declaration = readDeclaredFloors(uiPackage);
  if (declaration === undefined) return;

  const floorViolations = transpileFloorViolations(declaration.floors);
  if (floorViolations.length > 0) {
    for (const violation of floorViolations) fail(violation);
    return;
  }

  const sources = collectSources(sourceRoots);
  if (sources.length === 0) {
    fail("no UI sources were found — the scan would pass vacuously");
    return;
  }

  const violations = apiViolations(sources, declaration.floors);
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

// Run as a CLI unless imported by a test.
if (isMainModule(import.meta.url)) {
  main();
}
