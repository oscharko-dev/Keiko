// Pins the termination-evidence seam across EVERY production runCommand caller (PR #3354 review,
// comment 3887021650). The defect class: `onTerminated` is optional, so a production path can call
// keiko-tools' runCommand without it and a Windows timeout/abort on that path terminates with no
// activity-log evidence at all — the always-on `run_command` tool, the governed git lanes and the
// verification orchestrator all shipped exactly that way while only the direct server call sites
// were wired.
//
// The pin is fail-closed and STRUCTURAL: caller discovery resolves import bindings off the TypeScript
// AST (alias-aware: `import { runCommand as execute }` is recognized; quote-style agnostic, since a
// parsed string-literal's decoded `.text` never carries the source's quote character), and the wiring
// check binds each INDIVIDUAL runCommand-shaped call expression, not the file as a whole. A file with
// two call sites where only one references `onTerminated` used to read as "the file contains the
// token" and pass in full — exactly the split the F1 audit found in execution.ts's sibling readers
// (readWorktreeSnapshotFor/adapterFor wired, readStagedPathsFor/readStagedConflictMarkerFileCountFor
// silently not, in ONE file). This version resolves each call's own arguments (object literals,
// conditionals, and a bounded same-file identifier hop for the `...seams`-style spread this repo's
// helpers use — see `gitDeliveryTerminationHandler` in packages/keiko-server/src/gitDelivery/
// execution.ts) and only falls back to file-scoped detection when an argument is a genuinely
// unresolvable indirection (e.g. a typed context parameter threaded in from a caller, as
// git-worktree-snapshot-node.ts's `runRead(ctx, …)` does) — never as a substitute for a call site this
// scanner CAN read precisely. There is deliberately NO exemption list.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const PACKAGES_ROOT = join(process.cwd(), "packages");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

function sourceFiles() {
  const out = [];
  for (const pkg of readdirSync(PACKAGES_ROOT, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const src = join(PACKAGES_ROOT, pkg.name, "src");
    try {
      out.push(...walk(src));
    } catch {
      // A package without src/ carries no callers.
    }
  }
  return out.filter((path) => !/\.test\.ts$/.test(path) && !/[\\/]testing[\\/]/.test(path));
}

// ─── Structural import-binding resolution (fixes F2(b): alias-aware, quote-style agnostic) ────────
//
// A parsed string-literal's `.text` is the DECODED value TypeScript's own lexer produced — it is
// identical whether the source wrote `'@oscharko-dev/keiko-tools'` or `"@oscharko-dev/keiko-tools"`.
// Resolving specifiers off the AST rather than a `"…"`-anchored regex makes quote-style irrelevant by
// construction, not by covering both quote characters in the pattern.

function isStringLiteralLike(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

// `./exec.js` only resolves to keiko-tools' own exec module from WITHIN packages/keiko-tools/src
// itself; every other package reaches it through the published barrel or one of its subpaths (e.g.
// `@oscharko-dev/keiko-tools/internal/exec`).
function isExecModuleSpecifier(specifier) {
  return (
    specifier === "./exec.js" ||
    specifier === "@oscharko-dev/keiko-tools" ||
    specifier.startsWith("@oscharko-dev/keiko-tools/")
  );
}

function parseSourceFile(path, text) {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
}

// Every LOCAL identifier this file binds to keiko-tools' real `runCommand` (bare or `as`-aliased),
// every namespace alias bound to the exec module (`import * as ns from …` → `ns.runCommand(…)`), and
// whether the file references RunCommandDeps/RunCommandInput by name anywhere (the existing,
// necessarily coarser corroboration for the injected-port shape below — resolving an ARBITRARY
// object's property type back to those interfaces would need a full type-checked Program, not just a
// per-file parse, so this one corroboration stays name-based; see the port-call comment).
function isNamedImportsClause(bindings) {
  return bindings !== undefined && ts.isNamedImports(bindings);
}

// The runCommand/RunCommandDeps/RunCommandInput contributions from ONE named-import element list —
// split out of collectRunCommandBindings purely to keep that function's own complexity low; it holds
// no state of its own.
function namedImportContributions(elements) {
  const localNames = [];
  let sawDepsOrInputType = false;
  for (const element of elements) {
    const importedName = (element.propertyName ?? element.name).text;
    if (importedName === "runCommand") localNames.push(element.name.text);
    if (importedName === "RunCommandDeps" || importedName === "RunCommandInput") {
      sawDepsOrInputType = true;
    }
  }
  return { localNames, sawDepsOrInputType };
}

function isExecModuleImport(node) {
  return (
    ts.isImportDeclaration(node) &&
    node.moduleSpecifier !== undefined &&
    isStringLiteralLike(node.moduleSpecifier) &&
    isExecModuleSpecifier(node.moduleSpecifier.text)
  );
}

// Folds ONE import declaration's contribution into the running bindings — split out of
// collectRunCommandBindings purely to keep its own AST-walking `visit` free of branching (and thus
// trivially low complexity); `state` carries the single boolean field mutably since a Set can be
// mutated in place but a plain boolean return would require the caller to OR it in anyway.
function recordImportDeclaration(node, localNames, namespaceNames, state) {
  if (!isExecModuleImport(node)) return;
  const bindings = node.importClause?.namedBindings;
  if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
    namespaceNames.add(bindings.name.text);
    return;
  }
  if (!isNamedImportsClause(bindings)) return;
  const contributions = namedImportContributions(bindings.elements);
  for (const name of contributions.localNames) localNames.add(name);
  state.referencesRunCommandDepsOrInputType ||= contributions.sawDepsOrInputType;
}

function collectRunCommandBindings(sourceFile) {
  const localNames = new Set();
  const namespaceNames = new Set();
  const state = { referencesRunCommandDepsOrInputType: false };

  function visit(node) {
    recordImportDeclaration(node, localNames, namespaceNames, state);
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return {
    localNames,
    namespaceNames,
    referencesRunCommandDepsOrInputType: state.referencesRunCommandDepsOrInputType,
  };
}

function isNamespacedRunCommandCall(callee, bindings) {
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "runCommand" &&
    ts.isIdentifier(callee.expression) &&
    bindings.namespaceNames.has(callee.expression.text)
  );
}

// The injected-port shape: SOME expression's `.runCommand(…)` method, where the receiver is NOT one
// of this file's own keiko-tools namespace aliases (that shape is handled — and does not need this
// corroboration — by isNamespacedRunCommandCall above). Corroborated at the file level by a
// RunCommandDeps/RunCommandInput reference; see collectRunCommandBindings's doc comment for why that
// stays name-based rather than a resolved property type.
function isPortRunCommandCall(callee, bindings) {
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "runCommand" &&
    !isNamespacedRunCommandCall(callee, bindings) &&
    bindings.referencesRunCommandDepsOrInputType
  );
}

function isDirectRunCommandCall(callee, bindings) {
  return ts.isIdentifier(callee) && bindings.localNames.has(callee.text);
}

function isRunCommandShapedCall(node, bindings) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return (
    isDirectRunCommandCall(callee, bindings) ||
    isNamespacedRunCommandCall(callee, bindings) ||
    isPortRunCommandCall(callee, bindings)
  );
}

// Every `runCommand`-shaped CallExpression: a direct call through a local binding (bare or aliased),
// a namespace-qualified call, or an injected `<expr>.runCommand(…)` port call (RunCommandDeps/
// RunCommandInput-corroborated at the file level — see collectRunCommandBindings). Namespace-import
// note (kept from the previous version): the import statement alone proves the alias IS keiko-tools'
// real runCommand, so — unlike the port-call heuristic — this shape needs no further corroboration.
function findRunCommandCallSites(sourceFile, bindings) {
  const sites = [];

  function visit(node) {
    if (isRunCommandShapedCall(node, bindings)) sites.push(node);
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return sites;
}

// ─── Per-call-site wiring resolution (fixes F2(a): binds each call, not the file) ──────────────────
//
// Every same-file `const NAME = <initializer>;` (module scope or nested — deliberately NOT
// scope-precise: a same-named local in an unrelated function could theoretically be picked up
// instead of the real one, but a naming COLLISION between an unrelated binding and this repo's
// consistent `onTerminated`/`terminationDeps`/`ctx`-style helper names is not a real risk this
// syntactic gate needs to close, and the existing pin already accepted comparable syntactic
// approximations — e.g. the namespace-import shape above has always trusted the import statement
// without re-verifying every call site's receiver type). Used to take ONE identifier hop (`...seams`
// spreading a locally-built object) without requiring a type-checked Program.
function collectLocalDeclarationInitializers(sourceFile) {
  const byName = new Map();
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      !byName.has(node.name.text)
    ) {
      byName.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return byName;
}

function unwrapParens(expr) {
  let current = expr;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function propertyIsNamedOnTerminated(prop) {
  return (
    (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) &&
    ts.isIdentifier(prop.name) &&
    prop.name.text === "onTerminated"
  );
}

function objectLiteralProvidesOnTerminated(node, declByName, hopsRemaining) {
  let sawUnresolvedSpread = false;
  for (const prop of node.properties) {
    if (propertyIsNamedOnTerminated(prop)) return "true";
    if (!ts.isSpreadAssignment(prop)) continue;
    const result = expressionProvidesOnTerminated(prop.expression, declByName, hopsRemaining - 1);
    if (result === "true") return "true";
    if (result === "unresolved") sawUnresolvedSpread = true;
  }
  return sawUnresolvedSpread ? "unresolved" : "false";
}

// One wired branch does NOT wire the call site: `flag ? { onTerminated } : {}` leaves a real runtime
// path silent, which is the exact omission this gate exists to prevent (PR #3355 review, P1). So a
// conditional is wired only when BOTH branches are, a resolved-false branch makes it unwired, and
// anything else stays unresolved rather than being rounded up to "wired".
function combineBranchResults(whenTrue, whenFalse) {
  if (whenTrue === "false" || whenFalse === "false") return "false";
  if (whenTrue === "true" && whenFalse === "true") return "true";
  return "unresolved";
}

// The ONE shape where an empty branch is not a silent path: the optional-port pass-through
// `...(deps.onTerminated !== undefined ? { onTerminated: deps.onTerminated } : {})`. The seam IS
// threaded here — the empty branch means this caller was given no handler to thread, not that the
// code forgot one — and `exactOptionalPropertyTypes` forces exactly this spelling, because an
// `onTerminated?: T | undefined` target may not receive the key at all rather than receive
// `undefined`. It is live production code (git-merge-node.ts:120), so the rule above must recognise
// it by SHAPE instead of flagging the idiom the type system requires.
// The equivalent inverted spelling is live too (keiko-verification/orchestrator.ts):
// `deps.onTerminated === undefined ? {} : { onTerminated: deps.onTerminated }`. Equality therefore
// guards the false branch while inequality, truthiness and `in` guard the true branch.
//
// Deliberately narrow: the guard must test `onTerminated` itself. `someOtherFlag ? {…} : {}` is not
// this idiom and stays unwired, which is the case the review named.
function namesOnTerminated(node) {
  const propertyAccess =
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === "onTerminated";
  const identifier = ts.isIdentifier(node) && node.text === "onTerminated";
  const elementAccess =
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression) &&
    node.argumentExpression.text === "onTerminated";
  return propertyAccess || identifier || elementAccess;
}

function comparisonGuardBranch(operatorKind) {
  switch (operatorKind) {
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      return "whenTrue";
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
      return "whenFalse";
    default:
      return undefined;
  }
}

function isUndefinedIdentifier(node) {
  const candidate = unwrapParens(node);
  return ts.isIdentifier(candidate) && candidate.text === "undefined";
}

function onTerminatedGuardBranch(condition) {
  if (namesOnTerminated(condition)) return "whenTrue";
  if (!ts.isBinaryExpression(condition)) return undefined;
  const { operatorToken, left, right } = condition;
  if (
    operatorToken.kind === ts.SyntaxKind.InKeyword &&
    ts.isStringLiteralLike(left) &&
    left.text === "onTerminated"
  ) {
    return "whenTrue";
  }
  const leftNamesPort = namesOnTerminated(left);
  const rightNamesPort = namesOnTerminated(right);
  if (leftNamesPort === rightNamesPort) return undefined;
  const comparisonValue = leftNamesPort ? right : left;
  // Only an explicit undefined comparison proves presence/absence. Treating
  // `deps.onTerminated === arbitrarySentinel` as a presence guard would let the empty branch hide a
  // real runtime path with no evidence handler.
  if (!isUndefinedIdentifier(comparisonValue)) return undefined;
  return comparisonGuardBranch(operatorToken.kind);
}

function conditionalProvidesOnTerminated(node, declByName, hopsRemaining) {
  const whenTrue = expressionProvidesOnTerminated(node.whenTrue, declByName, hopsRemaining);
  const whenFalse = expressionProvidesOnTerminated(node.whenFalse, declByName, hopsRemaining);
  const guardedBranch = onTerminatedGuardBranch(node.condition);
  if (guardedBranch === "whenTrue" && whenTrue === "true") return "true";
  if (guardedBranch === "whenFalse" && whenFalse === "true") return "true";
  return combineBranchResults(whenTrue, whenFalse);
}

function identifierProvidesOnTerminated(node, declByName, hopsRemaining) {
  if (hopsRemaining <= 0) return "unresolved";
  const declaration = declByName.get(node.text);
  if (declaration === undefined) return "unresolved";
  return expressionProvidesOnTerminated(declaration, declByName, hopsRemaining - 1);
}

// Tri-state: "true" (this expression provably carries onTerminated), "false" (it is a fully resolved
// expression that provably does NOT), or "unresolved" (some part of it could not be traced without
// deeper — file-crossing or type-level — analysis, e.g. a bare parameter or a call to an imported
// function). "unresolved" is never treated as a pass by this function itself; the caller decides
// whether to fall back to file-scoped detection (see callSiteVerdict below) — this function only ever
// reports what it could actually prove. A PropertyAccessExpression (e.g. `ctx.runDeps`), a
// CallExpression, or anything else the three helpers above don't model falls through to "unresolved",
// never to a negative — see the module doc comment for WHY (git-worktree-snapshot-node.ts's
// shared-context lane threads its deps this way).
function expressionProvidesOnTerminated(expr, declByName, hopsRemaining) {
  const node = unwrapParens(expr);
  if (ts.isObjectLiteralExpression(node)) {
    return objectLiteralProvidesOnTerminated(node, declByName, hopsRemaining);
  }
  if (ts.isConditionalExpression(node)) {
    return conditionalProvidesOnTerminated(node, declByName, hopsRemaining);
  }
  if (ts.isIdentifier(node)) {
    return identifierProvidesOnTerminated(node, declByName, hopsRemaining);
  }
  return "unresolved";
}

const MAX_IDENTIFIER_HOPS = 4;

// How many call sites may pass on FILE-LEVEL evidence alone (see `callSiteVerdict`). MEASURED from
// the current tree, never chosen: a ratchet, not a target. Lowering it is always welcome; raising it
// means a new call site now leans on the one soft spot in this pin and must be justified
// deliberately rather than slipped in.
//
// Deliberately independent of EXPECTED_SOFT_VERDICT_SITES below rather than derived from its length:
// this number is the ratchet a reviewer edits on purpose when the set legitimately grows, and keeping
// it hand-maintained means adding a tenth entry to the set without ALSO raising this constant still
// fails the budget assertion, exactly as it should.
const SOFT_VERDICT_BUDGET = 9;

// The exact nine call sites the budget above ratchets — every one the SAME shape: a Node effect
// module whose `runCommand` argument is a typed parameter (`ctx`, `deps`) declared in ANOTHER module,
// which this single-file analyzer cannot follow. Each was separately confirmed wired by reading it.
// This is the FIX for the gap the budget-only assertion left open (review finding): a length-only
// check (`rendered.length <= SOFT_VERDICT_BUDGET`) never notices a KNOWN-safe site silently swapping
// for a different, newly-unsafe one while the count stays put — invisible to a pin whose own title
// promises "does not grow the set". Listing the exact set here and asserting equality below closes
// that gap; the budget constant stays as a secondary, independently-edited sanity ceiling.
const EXPECTED_SOFT_VERDICT_SITES = [
  { pkg: "keiko-tools", file: "git-merge-node.ts", line: 156 },
  { pkg: "keiko-tools", file: "git-mutation-node.ts", line: 176 },
  { pkg: "keiko-tools", file: "git-mutation-node.ts", line: 209 },
  { pkg: "keiko-tools", file: "git-pr-node.ts", line: 145 },
  { pkg: "keiko-tools", file: "git-publish-node.ts", line: 161 },
  { pkg: "keiko-tools", file: "git-worktree-adapter.ts", line: 402 },
  { pkg: "keiko-tools", file: "git-worktree-snapshot-node.ts", line: 117 },
  { pkg: "keiko-tools", file: "git-worktree-snapshot-node.ts", line: 301 },
  { pkg: "keiko-verification", file: "orchestrator.ts", line: 334 },
];

// Renders EXPECTED_SOFT_VERDICT_SITES in the SAME `${path}:${line}` shape (and against the SAME
// PACKAGES_ROOT) `analyzeFile`'s real call sites are rendered in, so the comparison in the test below
// holds regardless of the absolute checkout path (CI vs. a local clone) — never a literal absolute
// path hardcoded into the fixture.
function expectedSoftVerdictSiteStrings() {
  return EXPECTED_SOFT_VERDICT_SITES.map(
    ({ pkg, file, line }) => `${join(PACKAGES_ROOT, pkg, "src", file)}:${String(line)}`,
  ).sort();
}

// A call site is "wired" when at least one argument provably carries onTerminated, OR when every
// argument that could not be resolved leaves the file's own text as the only available evidence AND
// that text references the seam. It is "unwired" — the pin's actual fail-closed verdict — only when
// EVERY argument was fully, syntactically resolved and NONE of them carry it: a proven omission, not
// an analysis gap.
function callSiteVerdict(callExpression, declByName, fileText) {
  let anyUnresolved = false;
  for (const argument of callExpression.arguments) {
    const result = expressionProvidesOnTerminated(argument, declByName, MAX_IDENTIFIER_HOPS);
    if (result === "true") return "wired";
    if (result === "unresolved") anyUnresolved = true;
  }
  if (anyUnresolved) {
    // The file-text fallback, and the ONE soft spot in this pin: an argument this analyzer cannot
    // resolve (a typed parameter such as `ctx`, whose value lives in another module) leaves the
    // file's own text as the only evidence, and any `onTerminated` in it — including one belonging
    // to a DIFFERENT, correctly wired call — satisfies that. A genuinely unwired call in such a file
    // would therefore pass.
    //
    // It is not hardened into a hard "unwired" because that verdict would be a false accusation for
    // every legitimately cross-module case, and a gate that cries wolf gets weakened rather than
    // obeyed. Instead the soft verdict is COUNTED and pinned below, so the set of call sites relying
    // on it cannot grow unnoticed: a new one fails the pin and has to be made resolvable or
    // explicitly re-justified.
    return fileText.includes("onTerminated") ? "wired-by-file-text" : "unwired";
  }
  return "unwired";
}

function locationOf(sourceFile, node) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: line + 1, column: character + 1 };
}

function analyzeFile(path, text) {
  const sourceFile = parseSourceFile(path, text);
  const bindings = collectRunCommandBindings(sourceFile);
  const callSites = findRunCommandCallSites(sourceFile, bindings);
  if (callSites.length === 0) return undefined;
  const declByName = collectLocalDeclarationInitializers(sourceFile);
  const verdicts = callSites.map((call) => ({
    call,
    verdict: callSiteVerdict(call, declByName, text),
  }));
  const unwired = verdicts
    .filter(({ verdict }) => verdict === "unwired")
    .map(({ call }) => ({ path, ...locationOf(sourceFile, call) }));
  const softlyWired = verdicts
    .filter(({ verdict }) => verdict === "wired-by-file-text")
    .map(({ call }) => ({ path, ...locationOf(sourceFile, call) }));
  return { path, callSiteCount: callSites.length, unwired, softlyWired };
}

// exec.ts itself needs no explicit exclusion (unlike the previous regex-based version): it DEFINES
// `runCommand` rather than importing it from anywhere, so collectRunCommandBindings never adds a
// local binding for it there, and findRunCommandCallSites correctly finds zero call sites — a
// `function runCommand(...)` DECLARATION is a FunctionDeclaration node, never a CallExpression, so it
// was never at risk of being misread as a call the way the old text regex had to guard against.
function analyzeProductionCallers() {
  return sourceFiles()
    .map((path) => analyzeFile(path, readFileSync(path, "utf8")))
    .filter((entry) => entry !== undefined);
}

describe("runCommand termination-evidence wiring (PR #3354, comment 3887021650)", () => {
  const analyses = analyzeProductionCallers();

  it("finds the known production caller surface (the scanner itself is not vacuous)", () => {
    // The scanner must SEE the surface it polices. If a refactor moves these files, update the
    // list — never below the tool-host, the git lanes, and the verification orchestrator.
    const names = analyses.map(({ path }) => path.split(/[\\/]/).at(-1)).sort();
    for (const required of [
      "registry.ts",
      "git-mutation-node.ts",
      "git-worktree-adapter.ts",
      "orchestrator.ts",
      "terminal.ts",
    ]) {
      expect(names).toContain(required);
    }
    expect(analyses.length).toBeGreaterThanOrEqual(10);
  });

  // The soft verdict, ratcheted. `callSiteVerdict` falls back to file-level text evidence when an
  // argument cannot be resolved across modules, and that fallback is the one way a genuinely unwired
  // call could still pass — any `onTerminated` in the file satisfies it, including one belonging to a
  // different, correctly wired call. Hardening it into a flat "unwired" would falsely accuse every
  // legitimate cross-module case, and a gate that cries wolf gets weakened rather than obeyed. So the
  // soft path is checked against the exact expected SET (not merely counted): a length-only check
  // cannot notice one known-safe site silently swapping for a different, newly-unsafe one while the
  // count stays put (review finding) — `toEqual` against EXPECTED_SOFT_VERDICT_SITES catches exactly
  // that swap, since a new/different site changes the rendered array even when its length does not.
  it("does not grow OR change the set of call sites that pass only on file-level evidence", () => {
    const soft = analyses.flatMap(({ softlyWired }) => softlyWired);
    const rendered = soft.map((site) => `${site.path}:${String(site.line)}`).sort();
    expect(
      rendered,
      `call sites passing only on file-text evidence:\n${rendered.join("\n")}`,
    ).toEqual(expectedSoftVerdictSiteStrings());
    // Secondary sanity check: the exact-set assertion above already pins the count, but the explicit
    // ratchet stays legible as its own number rather than only implied by the array's length.
    expect(rendered.length).toBeLessThanOrEqual(SOFT_VERDICT_BUDGET);
  });

  it("every production runCommand call site references the onTerminated evidence seam", () => {
    const unwired = analyses.flatMap((entry) => entry.unwired);
    expect(unwired).toEqual([]);
  });
});

// ─── Structural-resolver unit coverage (proves F2(a) and F2(b) directly, on synthetic sources) ─────
//
// The suite above asserts the real repository is clean; these fixtures assert the RESOLVER ITSELF
// can tell the difference — independent of whatever the repository currently happens to contain.

function silentCallSites(sourcePath, sourceText) {
  const analysis = analyzeFile(sourcePath, sourceText);
  return analysis === undefined ? undefined : analysis.unwired;
}

describe("structural caller discovery and per-call wiring resolution (unit fixtures)", () => {
  it("F2(b): recognizes an aliased named import (`runCommand as execute`)", () => {
    const source = `
      import { runCommand as execute } from "@oscharko-dev/keiko-tools";
      export async function run(): Promise<void> {
        await execute({ command: "git", args: [], cwd: undefined, timeoutMs: 1, signal: s }, {});
      }
    `;
    const unwired = silentCallSites("fixture-aliased-import.ts", source);
    expect(unwired).toHaveLength(1); // detected AND correctly flagged unwired (no onTerminated at all)
  });

  it("F2(b): recognizes a single-quoted module specifier identically to a double-quoted one", () => {
    const singleQuoted = `
      import { runCommand } from '@oscharko-dev/keiko-tools';
      export async function run(): Promise<void> {
        await runCommand({ command: "git", args: [], cwd: undefined, timeoutMs: 1, signal: s }, {
          onTerminated: (e) => log(e),
        });
      }
    `;
    expect(silentCallSites("fixture-single-quote.ts", singleQuoted)).toEqual([]);
  });

  it("F2(a): catches a per-call omission the old whole-file substring check could not — one wired sibling function does not excuse another in the SAME file", () => {
    const source = `
      import { runCommand } from "@oscharko-dev/keiko-tools";
      export async function wired(): Promise<void> {
        await runCommand({ command: "git", args: [], cwd: undefined, timeoutMs: 1, signal: s }, {
          onTerminated: (e) => log(e),
        });
      }
      export async function silent(): Promise<void> {
        await runCommand({ command: "git", args: [], cwd: undefined, timeoutMs: 1, signal: s }, {});
      }
    `;
    const unwired = silentCallSites("fixture-split-wiring.ts", source);
    // Exactly the `silent()` call site is flagged; `wired()`'s is not — this is the assertion the
    // PREVIOUS `!text.includes("onTerminated")` whole-file check could never make (the file as a
    // whole contains the token, so the old check passed it in full).
    expect(unwired).toHaveLength(1);
  });

  it("does not false-positive a same-file shared-context lane (git-worktree-snapshot-node.ts's actual shape)", () => {
    const source = `
      import { runCommand } from "@oscharko-dev/keiko-tools";
      function buildReadContext(deps) {
        return {
          runDeps: {
            workspace: deps.workspace,
            ...(deps.onTerminated !== undefined ? { onTerminated: deps.onTerminated } : {}),
          },
        };
      }
      async function runRead(ctx, argv) {
        return runCommand({ command: "git", args: argv, cwd: undefined, timeoutMs: 1, signal: s }, ctx.runDeps);
      }
      export async function readSomething(deps) {
        const ctx = buildReadContext(deps);
        return runRead(ctx, ["status"]);
      }
    `;
    // runRead's own call site cannot be resolved (ctx is a bare parameter) and falls back to
    // file-scoped detection, which finds "onTerminated" in buildReadContext — correctly wired, not a
    // regression on the real production pattern this fixture mirrors.
    expect(silentCallSites("fixture-shared-context.ts", source)).toEqual([]);
  });

  // The four conditional shapes, after the PR #3355 review P1: one wired branch used to make the
  // whole site "wired", so a real silent runtime path passed the gate that exists to catch it.
  const conditionalFixture = (condition, whenFalse) => `
      import { runCommand } from "@oscharko-dev/keiko-tools";
      export async function run(deps): Promise<void> {
        await runCommand({ command: "git", args: [], cwd: undefined, timeoutMs: 1, signal: s }, {
          ...(${condition} ? { onTerminated: (e) => log(e) } : ${whenFalse}),
        });
      }
    `;

  const invertedOptionalPortFixture = (condition) => `
      import { runCommand } from "@oscharko-dev/keiko-tools";
      export async function run(deps): Promise<void> {
        await runCommand({ command: "git", args: [], cwd: undefined, timeoutMs: 1, signal: s }, {
          ...(${condition} ? {} : { onTerminated: (e) => log(e) }),
        });
      }
    `;

  it("P1: a one-sided conditional is UNWIRED — `flag ? { onTerminated } : {}` leaves a silent path", () => {
    // Red before green: with the previous `whenTrue === "true" || whenFalse === "true"` this
    // returned "wired" and the call site was never reported.
    const unwired = silentCallSites(
      "fixture-one-sided.ts",
      conditionalFixture("deps.verbose === true", "{}"),
    );
    expect(unwired).toHaveLength(1);
  });

  it("P1: both branches wired is still WIRED", () => {
    const unwired = silentCallSites(
      "fixture-both-branches.ts",
      conditionalFixture("deps.verbose === true", "{ onTerminated: (e) => audit(e) }"),
    );
    expect(unwired).toEqual([]);
  });

  it("P1: a wired branch against an UNRESOLVED one stays unresolved, not silently wired", () => {
    // `deps.fallbackSeams` cannot be resolved in this file, so the site must fall through to the
    // counted soft verdict rather than being rounded up to a hard "wired".
    const source = conditionalFixture("deps.verbose === true", "deps.fallbackSeams");
    const analysis = analyzeFile("fixture-unresolved-branch.ts", source);
    expect(analysis?.unwired).toEqual([]);
    expect(analysis?.softlyWired).toHaveLength(1);
  });

  // The idiom `exactOptionalPropertyTypes` forces on every optional-port pass-through, live at
  // packages/keiko-tools/src/git-merge-node.ts:120. The empty branch means this caller was handed no
  // handler to thread — not that the seam was forgotten — so it must stay wired, or the rule above
  // would flag the spelling the type system requires.
  it.each([
    ["a !== undefined guard", "deps.onTerminated !== undefined"],
    ["a truthiness guard", "deps.onTerminated"],
    ["an `in` guard", '"onTerminated" in deps'],
  ])("P1: the optional-port pass-through stays WIRED (%s)", (_label, condition) => {
    expect(
      silentCallSites("fixture-optional-port.ts", conditionalFixture(condition, "{}")),
    ).toEqual([]);
  });

  it("does not mistake an arbitrary equality comparison for an optional-port guard", () => {
    const unwired = silentCallSites(
      "fixture-not-a-presence-guard.ts",
      invertedOptionalPortFixture("deps.onTerminated === deps.fallback"),
    );
    expect(unwired).toHaveLength(1);
  });

  it.each([
    ["strict equality", "deps.onTerminated === undefined"],
    ["loose equality with reversed operands", "undefined == deps.onTerminated"],
  ])("P1: the inverted optional-port pass-through stays WIRED (%s)", (_label, condition) => {
    expect(
      silentCallSites("fixture-inverted-optional-port.ts", invertedOptionalPortFixture(condition)),
    ).toEqual([]);
  });

  it("catches a genuinely omitted seam even when the file mentions onTerminated elsewhere in an unrelated function", () => {
    const source = `
      import { runCommand } from "@oscharko-dev/keiko-tools";
      export async function unrelatedButMentionsTheWord(onTerminated: () => void): Promise<void> {
        onTerminated();
      }
      export async function silent(): Promise<void> {
        await runCommand({ command: "git", args: [], cwd: undefined, timeoutMs: 1, signal: s }, {
          workspace: w,
          processEnv: e,
        });
      }
    `;
    const unwired = silentCallSites("fixture-unrelated-mention.ts", source);
    expect(unwired).toHaveLength(1);
  });

  it("recognizes the injected port shape (`deps.runCommand(...)`) corroborated by a RunCommandDeps reference", () => {
    const source = `
      import type { RunCommandDeps } from "@oscharko-dev/keiko-tools";
      export async function probe(deps: { runCommand: Function }, runDeps: RunCommandDeps): Promise<void> {
        await deps.runCommand({ command: "docker", args: [], cwd: undefined, timeoutMs: 1, signal: s }, runDeps);
      }
    `;
    const unwired = silentCallSites("fixture-port-call.ts", source);
    expect(unwired).toHaveLength(1); // detected as a call site AND correctly flagged unwired
  });

  it("recognizes a namespace import (`ns.runCommand(...)`)", () => {
    const source = `
      import * as tools from "@oscharko-dev/keiko-tools";
      export async function run(): Promise<void> {
        await tools.runCommand({ command: "git", args: [], cwd: undefined, timeoutMs: 1, signal: s }, {
          onTerminated: (e) => log(e),
        });
      }
    `;
    expect(silentCallSites("fixture-namespace-import.ts", source)).toEqual([]);
  });
});
