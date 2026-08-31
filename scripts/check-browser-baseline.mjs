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
//
// SOURCE_ROOTS is first-party code only, but the exported UI also SHIPS dependency code unmodified
// — Babel's post-build pass (transpile-ui-static-js.mjs) runs with `useBuiltIns: false`, so it
// lowers syntax but never adds a missing runtime API, and it never touches a dependency's own
// guarded-API *calls* either way. The dependency scan is therefore a graph, not a hand-maintained
// list: value imports, dynamic imports and `new URL(..., import.meta.url)` worker edges in the two
// first-party roots seed a recursive browser dependency closure. That reaches both PDF.js realms,
// Monaco's main module and worker, every Monaco feature/language registration Keiko actually
// imports, and their transitive JS/CSS edges. Type-only imports, tests and declarations are not
// runtime edges. An unreadable or unresolved edge fails closed instead of silently shrinking the
// proof.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as babelParse } from "@babel/parser";
// Imported, never restated: a second copy of these numbers here would drift from the transpiler's
// own copy exactly the way the browserslist declaration drifted from the product. The module is
// `isMainModule`-guarded, so importing it runs no transpilation.
import { TARGETS as TRANSPILE_TARGETS } from "./transpile-ui-static-js.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";

const UI_PACKAGE = "packages/keiko-ui/package.json";
const SOURCE_ROOTS = ["packages/keiko-ui/src", "packages/keiko-editor/src"];
const DEPENDENCY_SCRIPT_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);
const SCANNABLE_DEPENDENCY_EXTENSIONS = new Set([...DEPENDENCY_SCRIPT_EXTENSIONS, ".css"]);
const RESOLUTION_EXTENSIONS = ["", ".js", ".mjs", ".cjs", ".css", ".json"];

/** Matches Array#sort's locale-independent UTF-16 code-unit ordering. */
function compareCodeUnits(left, right) {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

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
  // Colour FUNCTIONS, and they belong here for the same reason as the selectors above rather than
  // with the gracefully-degrading declarations: an engine that cannot parse the value drops the
  // whole declaration, so the element falls back to an inherited or initial colour. For a theme
  // built almost entirely on them that is not "slightly off" — it is potentially unreadable text on
  // an unreadable background, with nothing in the console.
  {
    name: "CSS oklch()",
    pattern: /\boklch\(/u,
    minimum: { chrome: 111, edge: 111, firefox: 113, safari: 15.4 },
  },
  {
    name: "CSS color-mix()",
    pattern: /\bcolor-mix\(/u,
    minimum: { chrome: 111, edge: 111, firefox: 113, safari: 16.2 },
  },
];

// pattern: matched against production source (tests excluded — they run in Node, not a browser).
// Versions are the FIRST release of each engine that supports the API (MDN browser-compat-data).
export const GUARDED_APIS = [
  {
    name: "Array.prototype.at",
    // Was `/\.at\(\s*-/`, which only matched a negative LITERAL immediately after the paren.
    // `Array.prototype.at` (and the identically-gated `String.prototype.at` /
    // `TypedArray.prototype.at`) is the same method call regardless of what index it is called
    // with: `items.at(items.length - 1)`, `items.at(i)` and `items.at(0)` all invoke it and all
    // need the same floors, but only the literal-negative form used to match. The dot-then-"at("
    // shape already excludes a longer identifier that merely contains "at" (`.rotate(`, `.format(`)
    // and a bare property read with no call (`.at` alone) — narrowing was never the safety
    // property here, so widening to any argument shape adds coverage without adding a new class of
    // false positive.
    //
    // Widened again to `/\.at\s*\(/`: the plain `/\.at\(/` form still missed a call written with
    // whitespace before the opening paren (`items.at (0)`) — still the exact same gated method, a
    // formatter/linter is free to produce that spacing, and `\s*` cannot match into "attribute("/
    // "attend(" because the literal "at" must be followed immediately by either whitespace or "("
    // and neither appears there.
    pattern: /\.at\s*\(/,
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
  // PDF.js's legacy bundle retains these call sites but executes bundled core-js implementations
  // before them. `providedBy` is satisfied only when an unconditionally reached webpack module
  // imports a semantically verified core-js exporter and calls it at module top level before the
  // guarded API's first use — not by a comment, string, local `$`, dead branch, or similarly-shaped
  // arbitrary call. A modern bundle (or a broken legacy update) still fails at the declared floor. The
  // real-browser PDF smoke independently removes the host implementations in both realms before
  // parsing a PDF.
  {
    name: "Promise.try",
    pattern: /\bPromise\.try\s*\(/,
    providedBy: "Promise.try",
    minimum: { chrome: 128, edge: 128, firefox: 134, safari: 18.2 },
  },
  {
    name: "Promise.withResolvers",
    pattern: /\bPromise\.withResolvers\s*\(/,
    providedBy: "Promise.withResolvers",
    minimum: { chrome: 119, edge: 119, firefox: 121, safari: 17.4 },
  },
  {
    name: "URL.parse",
    pattern: /\bURL\.parse\s*\(/,
    providedBy: "URL.parse",
    minimum: { chrome: 126, edge: 126, firefox: 126, safari: 18 },
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
      else if (
        /\.(ts|tsx|css)$/u.test(entry.name) &&
        !/\.(?:d|test)\.(?:ts|tsx)$/u.test(entry.name)
      ) {
        files.push(path);
      }
    }
  };
  for (const root of roots) walk(root);
  return files;
}

function isImportMetaUrl(node) {
  if (node?.type !== "MemberExpression" || node.computed) return false;
  if (node.property?.type !== "Identifier" || node.property.name !== "url") return false;
  const object = node.object;
  if (object.type !== "MetaProperty") return false;
  return object.meta.name === "import" && object.property.name === "meta";
}

function importDeclarationSpecifier(node) {
  if (node.type !== "ImportDeclaration" || node.importKind === "type") return undefined;
  const hasRuntimeBinding = node.specifiers.some((specifier) => specifier.importKind !== "type");
  return node.specifiers.length === 0 || hasRuntimeBinding ? node.source.value : undefined;
}

function exportDeclarationSpecifier(node) {
  if (node.type === "ExportAllDeclaration") {
    return node.exportKind === "type" ? undefined : node.source.value;
  }
  if (node.type !== "ExportNamedDeclaration" || node.exportKind === "type") return undefined;
  // Babel marks `export { type Foo } from "pkg"` as a value declaration whose individual
  // specifier is type-only. Mirror importDeclarationSpecifier: a mixed re-export is a runtime edge,
  // while a declaration containing only inline `type` specifiers disappears from emitted JS.
  const hasRuntimeBinding = node.specifiers.some((specifier) => specifier.exportKind !== "type");
  return node.specifiers.length === 0 || hasRuntimeBinding ? node.source?.value : undefined;
}

function dynamicImportSpecifier(node) {
  const argument = node.arguments?.[0];
  if (node.type === "CallExpression" && node.callee?.type === "Import") {
    return argument?.type === "StringLiteral" ? argument.value : undefined;
  }
  return undefined;
}

function requireSpecifier(node, functionDepth, allowRequire) {
  const argument = node.arguments?.[0];
  if (
    allowRequire &&
    functionDepth === 0 &&
    node.type === "CallExpression" &&
    node.callee?.type === "Identifier" &&
    node.callee.name === "require"
  ) {
    return argument?.type === "StringLiteral" ? argument.value : undefined;
  }
  return undefined;
}

function workerUrlSpecifier(node) {
  const argument = node.arguments?.[0];
  if (
    node.type === "NewExpression" &&
    node.callee?.type === "Identifier" &&
    node.callee.name === "URL" &&
    argument?.type === "StringLiteral" &&
    isImportMetaUrl(node.arguments?.[1])
  ) {
    return argument.value;
  }
  return undefined;
}

function expressionSpecifier(node, functionDepth, allowRequire) {
  const dynamicImport = dynamicImportSpecifier(node);
  if (dynamicImport !== undefined) return dynamicImport;
  const required = requireSpecifier(node, functionDepth, allowRequire);
  return required ?? workerUrlSpecifier(node);
}

function runtimeSpecifier(node, functionDepth, allowRequire) {
  const declaration = importDeclarationSpecifier(node);
  if (declaration !== undefined) return declaration;
  const exported = exportDeclarationSpecifier(node);
  if (exported !== undefined) return exported;
  if (node.type === "ImportExpression") {
    return node.source?.type === "StringLiteral" ? node.source.value : undefined;
  }
  return expressionSpecifier(node, functionDepth, allowRequire);
}

function childFunctionDepth(node, functionDepth) {
  return /^(?:ArrowFunctionExpression|ClassMethod|FunctionDeclaration|FunctionExpression|ObjectMethod)$/u.test(
    node.type,
  )
    ? functionDepth + 1
    : functionDepth;
}

function walkRuntimeValue(value, state, functionDepth) {
  if (Array.isArray(value)) {
    for (const child of value) walkRuntimeSpecifiers(child, state, functionDepth);
  } else if (value !== null && typeof value === "object" && typeof value.type === "string") {
    walkRuntimeSpecifiers(value, state, functionDepth);
  }
}

function walkRuntimeSpecifiers(node, state, functionDepth = 0) {
  if (node === null || typeof node !== "object") return;
  const specifier = runtimeSpecifier(node, functionDepth, state.allowRequire);
  if (typeof specifier === "string") state.specifiers.add(specifier);
  const childDepth = childFunctionDepth(node, functionDepth);
  for (const value of Object.values(node)) walkRuntimeValue(value, state, childDepth);
}

function parserPlugins(path) {
  if (path.endsWith(".tsx")) return ["jsx", "typescript"];
  return path.endsWith(".ts") ? ["typescript"] : [];
}

export function runtimeSpecifiers(path, text = readFileSync(path, "utf8")) {
  if (path.endsWith(".css")) return [];
  const ast = babelParse(text, {
    sourceType: "unambiguous",
    plugins: parserPlugins(path),
  });
  const state = {
    // ESM dependencies occasionally create a local `require` for a Node-only fallback (PDF.js's
    // optional native canvas path is the live case). A browser bundler does not follow that local
    // call. CJS entry points do use top-level global `require`, which remains part of their graph.
    allowRequire: !path.endsWith(".mjs"),
    specifiers: new Set(),
  };
  walkRuntimeSpecifiers(ast, state);
  return [...state.specifiers];
}

function resolvedFileCandidate(candidate) {
  for (const suffix of RESOLUTION_EXTENSIONS) {
    try {
      const path = `${candidate}${suffix}`;
      if (statSync(path).isFile()) return path;
    } catch {
      // Try the next deterministic candidate.
    }
  }
  for (const suffix of RESOLUTION_EXTENSIONS.slice(1)) {
    try {
      const path = join(candidate, `index${suffix}`);
      if (statSync(path).isFile()) return path;
    } catch {
      // Try the next deterministic candidate.
    }
  }
  return undefined;
}

function isIgnoredRuntimeSpecifier(specifier) {
  return specifier.startsWith("node:") || specifier.startsWith("@/");
}

function isWorkspaceRuntimeSpecifier(specifier) {
  return specifier.startsWith("@oscharko-dev/");
}

function resolvePackageRuntimeSpecifier(importer, specifier) {
  try {
    // Keiko workspace packages expose ESM-only runtime entries. createRequire().resolve() applies
    // the `require` export condition and therefore rejects those valid `import` exports. Resolve
    // the fixed workspace scope through Node's ESM resolver so their built browser runtime joins
    // the same closure as third-party packages. All workspaces are installed at the repository
    // root, where this gate itself lives; ordinary dependencies retain importer-relative require
    // resolution below so nested dependency graphs keep their existing semantics.
    if (isWorkspaceRuntimeSpecifier(specifier)) {
      return fileURLToPath(import.meta.resolve(specifier));
    }
    return createRequire(resolve(importer)).resolve(specifier);
  } catch (error) {
    throw new Error(`cannot resolve ${JSON.stringify(specifier)} from ${importer}`, {
      cause: error,
    });
  }
}

export function resolveRuntimeSpecifier(importer, specifier) {
  if (isIgnoredRuntimeSpecifier(specifier)) return undefined;
  if (specifier.startsWith(".") || isAbsolute(specifier)) {
    const candidate = isAbsolute(specifier) ? specifier : resolve(dirname(importer), specifier);
    const resolved = resolvedFileCandidate(candidate);
    if (resolved !== undefined) return resolved;
    throw new Error(`cannot resolve ${JSON.stringify(specifier)} from ${importer}`);
  }
  return resolvePackageRuntimeSpecifier(importer, specifier);
}

function scannableDependencyPath(path) {
  return SCANNABLE_DEPENDENCY_EXTENSIONS.has(extname(path));
}

export function collectDependencyClosure(entryFiles, resolver = resolveRuntimeSpecifier) {
  const pending = [...entryFiles];
  const paths = new Set();
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || paths.has(path) || !scannableDependencyPath(path)) continue;
    const text = readFileSync(path, "utf8");
    paths.add(path);
    if (!DEPENDENCY_SCRIPT_EXTENSIONS.has(extname(path))) continue;
    for (const specifier of runtimeSpecifiers(path, text)) {
      const resolved = resolver(path, specifier);
      if (resolved !== undefined) pending.push(resolved);
    }
  }
  return [...paths].sort(compareCodeUnits);
}

export function deriveDependencyEntryFiles(firstPartySources, resolver = resolveRuntimeSpecifier) {
  const entries = new Set();
  for (const source of firstPartySources) {
    for (const specifier of runtimeSpecifiers(source.path, source.text)) {
      if (specifier.startsWith(".") || isIgnoredRuntimeSpecifier(specifier)) continue;
      const resolved = resolver(source.path, specifier);
      if (
        resolved !== undefined &&
        (resolved.includes(`${join("node_modules", "")}`) || isWorkspaceRuntimeSpecifier(specifier))
      ) {
        entries.add(resolved);
      }
    }
  }
  return [...entries].sort(compareCodeUnits);
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
    const match = /^([a-z_]+)\s*>=\s*(\d+(?:\.\d+)?)$/u.exec(query.trim());
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
    const transpiled = /^\d+(?:\.\d+)?$/u.test(String(target).trim())
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

function propertyKey(property) {
  if (property?.computed === true) return undefined;
  if (property?.key?.type === "Identifier") return property.key.name;
  return property?.key?.type === "StringLiteral" ? property.key.value : undefined;
}

function objectProperty(object, key) {
  return object?.type === "ObjectExpression"
    ? object.properties.find((property) => propertyKey(property) === key)
    : undefined;
}

function exportCallOptions(node) {
  if (node.type !== "CallExpression" || node.callee?.type !== "Identifier") return undefined;
  return node.arguments[0];
}

function staticExportTarget(node) {
  const options = exportCallOptions(node);
  if (options === undefined) return undefined;
  const targetProperty = objectProperty(options, "target");
  const staticProperty = objectProperty(options, "stat");
  const target = targetProperty?.value;
  if (target?.type !== "StringLiteral") return undefined;
  return staticProperty?.value?.type === "BooleanLiteral" && staticProperty.value.value
    ? target.value
    : undefined;
}

function functionExportName(property) {
  const member = propertyKey(property);
  if (member === undefined) return undefined;
  return property.value?.type === "FunctionExpression" || property.type === "ObjectMethod"
    ? member
    : undefined;
}

function providedApiFromCall(node) {
  const target = staticExportTarget(node);
  if (target === undefined) return undefined;
  const exports = node.arguments[1];
  for (const property of exports?.type === "ObjectExpression" ? exports.properties : []) {
    const member = functionExportName(property);
    if (member !== undefined) return { name: `${target}.${member}`, position: node.start ?? 0 };
  }
  return undefined;
}

function webpackModuleId(node) {
  if (
    node?.type !== "CallExpression" ||
    node.callee?.type !== "Identifier" ||
    node.callee.name !== "__webpack_require__"
  ) {
    return undefined;
  }
  const value = node.arguments[0];
  return value?.type === "NumericLiteral" || value?.type === "StringLiteral"
    ? String(value.value)
    : undefined;
}

function directRequireBindings(statements) {
  const bindings = new Map();
  for (const statement of statements) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declaration of statement.declarations) {
      const id = webpackModuleId(declaration.init);
      if (declaration.id?.type === "Identifier" && id !== undefined) {
        bindings.set(declaration.id.name, {
          moduleId: id,
          position: declaration.start ?? statement.start ?? 0,
        });
      }
    }
  }
  return bindings;
}

function directRequirePositions(statements) {
  const positions = new Map();
  for (const statement of statements) {
    if (statement.type === "ExpressionStatement") {
      const id = webpackModuleId(statement.expression);
      if (id !== undefined) positions.set(id, statement.start ?? 0);
    }
    if (statement.type !== "VariableDeclaration") continue;
    for (const declaration of statement.declarations) {
      const id = webpackModuleId(declaration.init);
      if (id !== undefined) positions.set(id, declaration.start ?? statement.start ?? 0);
    }
  }
  return positions;
}

function webpackFactoryKey(property) {
  if (property?.computed === true) return undefined;
  const key = property?.key;
  return key?.type === "NumericLiteral" || key?.type === "StringLiteral"
    ? String(key.value)
    : undefined;
}

function webpackModuleFactories(ast) {
  const declarators = ast.program.body
    .filter((node) => node.type === "VariableDeclaration")
    .flatMap((node) => node.declarations);
  const table = declarators.find(
    (declaration) =>
      declaration.id?.type === "Identifier" && declaration.id.name === "__webpack_modules__",
  )?.init;
  const factories = new Map();
  for (const property of table?.type === "ObjectExpression" ? table.properties : []) {
    const key = webpackFactoryKey(property);
    if (key !== undefined && property.type === "ObjectMethod") factories.set(key, property);
  }
  return factories;
}

function isMember(node, objectName, propertyName) {
  return (
    node?.type === "MemberExpression" &&
    !node.computed &&
    node.object?.type === "Identifier" &&
    node.object.name === objectName &&
    node.property?.type === "Identifier" &&
    node.property.name === propertyName
  );
}

function assignedExportFunction(statement, moduleName) {
  if (statement.type !== "ExpressionStatement") return undefined;
  const expression = statement.expression;
  if (expression.type !== "AssignmentExpression") return undefined;
  if (!isMember(expression.left, moduleName, "exports")) return undefined;
  return expression.right.type === "FunctionExpression" ? expression.right : undefined;
}

function exportedFunction(factory) {
  if (factory === undefined) return undefined;
  const moduleParameter = factory.params[0];
  if (moduleParameter?.type !== "Identifier") return undefined;
  for (const statement of factory.body.body) {
    const exported = assignedExportFunction(statement, moduleParameter.name);
    if (exported !== undefined) return exported;
  }
  return undefined;
}

function collectNodeValue(value, visit) {
  if (Array.isArray(value)) {
    for (const child of value) walkNodes(child, visit);
  } else if (value !== null && typeof value === "object" && typeof value.type === "string") {
    walkNodes(value, visit);
  }
}

function walkNodes(node, visit) {
  if (node === null || typeof node !== "object") return;
  visit(node);
  for (const value of Object.values(node)) collectNodeValue(value, visit);
}

function isImportedTargetWrite(node, options, bindings, factories) {
  if (node.type !== "CallExpression" || node.callee?.type !== "Identifier") return false;
  const required = bindings.get(node.callee.name);
  const optionsArgument = node.arguments[3];
  return (
    required !== undefined &&
    factories.has(required.moduleId) &&
    optionsArgument?.type === "Identifier" &&
    optionsArgument.name === options
  );
}

function recordCoreJsExporterSignal(node, state) {
  if (isMember(node, state.options, "stat")) state.signals.readsStat = true;
  if (isMember(node, state.options, "target")) state.signals.readsTarget = true;
  if (node.type === "ForInStatement" && node.right?.name === state.source) {
    state.signals.loopsSource = true;
  }
  if (isImportedTargetWrite(node, state.options, state.bindings, state.factories)) {
    state.signals.writesTarget = true;
  }
}

function coreJsExporterSignals(exporter, bindings, factories) {
  const options = exporter.params[0]?.type === "Identifier" ? exporter.params[0].name : undefined;
  const source = exporter.params[1]?.type === "Identifier" ? exporter.params[1].name : undefined;
  const signals = { loopsSource: false, readsStat: false, readsTarget: false, writesTarget: false };
  const state = { bindings, factories, options, signals, source };
  walkNodes(exporter.body, (node) => recordCoreJsExporterSignal(node, state));
  return signals;
}

function isCoreJsExporterFactory(factory, factories) {
  const exporter = factory === undefined ? undefined : exportedFunction(factory);
  if (exporter === undefined || exporter.params.length < 2) return false;
  const bindings = directRequireBindings(factory.body.body);
  const signals = coreJsExporterSignals(exporter, bindings, factories);
  return Object.values(signals).every(Boolean);
}

function providedApiForStatement(statement, bindings, factories) {
  if (statement.type !== "ExpressionStatement") return undefined;
  const call = statement.expression;
  if (call.type !== "CallExpression" || call.callee?.type !== "Identifier") return undefined;
  const provider = bindings.get(call.callee.name);
  if (provider === undefined || provider.position >= (call.start ?? 0)) return undefined;
  return isCoreJsExporterFactory(factories.get(provider.moduleId), factories)
    ? providedApiFromCall(call)
    : undefined;
}

function providedApisForFactory(factory, factories) {
  const positions = new Map();
  const bindings = directRequireBindings(factory.body.body);
  for (const statement of factory.body.body) {
    const provided = providedApiForStatement(statement, bindings, factories);
    if (provided !== undefined) positions.set(provided.name, provided.position);
  }
  return positions;
}

export function providedRuntimeApiPositions(path, text = readFileSync(path, "utf8")) {
  const ast = babelParse(text, { sourceType: "unambiguous", plugins: parserPlugins(path) });
  const positions = new Map();
  const factories = webpackModuleFactories(ast);
  const rootImports = directRequirePositions(ast.program.body);
  for (const [moduleId, factory] of factories) {
    const importPosition = rootImports.get(moduleId);
    if (importPosition === undefined) continue;
    for (const name of providedApisForFactory(factory, factories).keys()) {
      if (!positions.has(name)) positions.set(name, importPosition);
    }
  }
  return positions;
}

export function providedRuntimeApis(path, text = readFileSync(path, "utf8")) {
  return new Set(providedRuntimeApiPositions(path, text).keys());
}

function providerPrecedesFirstCall(path, text, api) {
  if (api.providedBy === undefined) return false;
  const firstCall = text.search(api.pattern);
  const provider = providedRuntimeApiPositions(path, text).get(api.providedBy);
  return provider !== undefined && provider < firstCall;
}

function matchingSourcePaths(sources, api) {
  return sources
    .filter(
      ({ path, text }) => api.pattern.test(text) && !providerPrecedesFirstCall(path, text, api),
    )
    .map(({ path }) => path);
}

function sourceEntries(paths) {
  return paths.map((path) => ({ path, text: readFileSync(path, "utf8") }));
}

export function dependencyClosureForSources(sourceRoots = SOURCE_ROOTS) {
  const firstPartySources = sourceEntries(collectSources(sourceRoots));
  return collectDependencyClosure(deriveDependencyEntryFiles(firstPartySources));
}

// Every guarded API that the sources actually call, checked against the declared floors.
function apiViolations(sources, floors) {
  const violations = [];
  const scripts = sources.filter(({ path }) => !path.endsWith(".css"));
  for (const api of GUARDED_APIS) {
    const users = matchingSourcePaths(scripts, api);
    if (users.length > 0) violations.push(...violationsFor(api, users, floors));
  }
  // GUARDED_CSS is checked against `.css` files AND script sources that can inject CSS at runtime.
  // First-party debug-monaco-styles.ts builds a `<style>` element from a `color-mix(...)` template
  // literal, and bundled dependency JS assigns the same function through an inline style.
  // Restricting this scan to stylesheet extensions — or only first-party TS/TSX — leaves shipped
  // runtime CSS invisible even though the dependency entries are already in `sources`.
  const cssCapableSources = sources.filter(({ path }) =>
    /\.(?:cjs|css|js|mjs|ts|tsx)$/u.test(path),
  );
  for (const feature of GUARDED_CSS) {
    const users = matchingSourcePaths(cssCapableSources, feature);
    if (users.length > 0) violations.push(...violationsFor(feature, users, floors));
  }
  return violations;
}

// `uiPackage`/`sourceRoots` default to the production paths, so the CLI below is unchanged. Tests
// can inject `dependencyFiles` as graph roots to isolate a fixture; production derives those roots
// from every first-party runtime import and worker URL. Injected roots still follow their transitive
// edges, so the test seam cannot turn the closure scan into another flat allowlist.
//
// Broken out of `main` itself: the `complexity` ESLint rule charges one point per default value in
// a destructured parameter, and three of them (plus the outer `= {}`) would push `main` over this
// file's own complexity ceiling for a change that adds no new decision to `main`'s own control flow.
function resolveMainOptions(options = {}) {
  const { uiPackage = UI_PACKAGE, sourceRoots = SOURCE_ROOTS, dependencyFiles } = options;
  return { uiPackage, sourceRoots, dependencyFiles };
}

function dependencyEntries(firstPartySources, dependencyFiles) {
  const entryFiles = dependencyFiles ?? deriveDependencyEntryFiles(firstPartySources);
  return sourceEntries(collectDependencyClosure(entryFiles));
}

export function main(options = {}) {
  const { uiPackage, sourceRoots, dependencyFiles } = resolveMainOptions(options);
  const declaration = readDeclaredFloors(uiPackage);
  if (declaration === undefined) return;

  const floorViolations = transpileFloorViolations(declaration.floors);
  if (floorViolations.length > 0) {
    for (const violation of floorViolations) fail(violation);
    return;
  }

  const firstPartySources = sourceEntries(collectSources(sourceRoots));
  let bundledSources;
  try {
    bundledSources = dependencyEntries(firstPartySources, dependencyFiles);
  } catch (error) {
    fail(`bundled dependency closure could not be derived: ${String(error)}`);
    return;
  }
  const sources = [...firstPartySources, ...bundledSources];
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
      `API across ${String(firstPartySources.length)} first-party and ` +
      `${String(bundledSources.length)} bundled dependency source files.`,
  );
}

// Run as a CLI unless imported by a test.
if (isMainModule(import.meta.url)) {
  main();
}
