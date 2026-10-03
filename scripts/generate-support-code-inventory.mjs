import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import ts from "typescript";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { releasePrecedes, supportedReleases } from "./generate-support-registry-history.mjs";
import { resolveHostExecutable } from "./lib/host-executable.mjs";

import { normalizeKeikoFrame } from "../packages/keiko-contracts/dist/observability.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = "packages/keiko-activity-log/src/reader/support-code-inventory.generated.ts";
const excluded =
  /(?:(?:^|\/)(?:__tests__|test-support|fixtures|__fixtures__)(?:\/|$))|(?:\.(?:test|spec|generated)\.)|(?:\.d\.ts$)/u;
const tokenFields = new Set([
  "code",
  "errorKind",
  "source",
  "signal",
  "subcommand",
  "operation",
  "diagnosticOperation",
  "canonicalId",
  "toolCanonicalId",
  "profileId",
]);
const builtinClasses = [
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "URIError",
  "EvalError",
  "AggregateError",
  // Node's bundled fetch implementation exposes this closed Undici transport vocabulary.
  "ConnectTimeoutError",
  "HeadersTimeoutError",
  "BodyTimeoutError",
  "SocketError",
  "RequestAbortedError",
  "ResponseStatusCodeError",
  "ClientClosedError",
  "ClientDestroyedError",
];

// Preserve the code-unit ordering of the original attested inventory on every platform.
function compareCodeUnits(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sourceFiles(directory, root) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (excluded.test(relative(root, path).replaceAll("\\", "/")) || entry.isSymbolicLink())
      continue;
    if (entry.isDirectory()) files.push(...sourceFiles(path, root));
    else if (entry.isFile() && /\.tsx?$/u.test(entry.name)) files.push(path);
  }
  return files.sort(compareCodeUnits);
}

function productFiles(root) {
  const packages = readdirSync(join(root, "packages"), { withFileTypes: true });
  const files = packages
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("keiko-"))
    .flatMap((entry) => sourceFiles(join(root, "packages", entry.name, "src"), root));
  return [...files, ...sourceFiles(join(root, "src", "cli"), root)].sort(compareCodeUnits);
}

function collectClass(node, classes) {
  if (ts.isClassDeclaration(node) && node.name !== undefined) {
    const parent = node.heritageClauses?.find(
      (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
    )?.types[0]?.expression;
    if (parent !== undefined && ts.isIdentifier(parent)) classes.set(node.name.text, parent.text);
  }
}

function addTechnicalToken(value, tokens) {
  if (/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(value)) tokens.add(value);
}

function collectClosedGitKinds(node, tokens) {
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
  if (node.name.text !== "CLOSED_GIT_ERROR_KINDS" || !node.initializer) return;
  if (!ts.isObjectLiteralExpression(node.initializer)) return;
  for (const property of node.initializer.properties) {
    if (ts.isPropertyAssignment(property) && ts.isStringLiteral(property.name))
      addTechnicalToken(property.name.text, tokens);
  }
}

function collectGitCall(node, tokens) {
  if (!ts.isCallExpression(node) || !node.arguments[0]) return;
  if (!ts.isArrayLiteralExpression(node.arguments[0])) return;
  const first = node.arguments[0].elements[0];
  if (!first || !ts.isStringLiteral(first)) return;
  if (/(?:observed|git|Git)/u.test(node.expression.getText()))
    addTechnicalToken(first.text, tokens);
}

function collectProfile(node, tokens) {
  if (!ts.isPropertyAssignment(node) || !ts.isIdentifier(node.name)) return;
  if (node.name.text !== "profile" || !ts.isObjectLiteralExpression(node.initializer)) return;
  for (const property of node.initializer.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
    if (property.name.text === "id" && ts.isStringLiteral(property.initializer))
      addTechnicalToken(property.initializer.text, tokens);
  }
}

function collectCatalogIdentity(node, tokens, source) {
  if (!source.startsWith("packages/keiko-tool-catalog/src/")) return;
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
  if (!new Set(["registration", "createToolRef"]).has(node.expression.text)) return;
  const id = node.arguments[0];
  if (id && ts.isStringLiteral(id)) addTechnicalToken(id.text, tokens);
}

function collectGitConfigSubcommand(node, tokens, source) {
  if (source !== "packages/keiko-git/src/runner.ts" || !ts.isStringLiteral(node)) return;
  const match = /^(?:alias|pager)\.([a-z][a-z0-9-]{0,31})=/u.exec(node.text);
  if (match?.[1]) addTechnicalToken(match[1], tokens);
}

function indexingFailurePrefix(node) {
  const producer = node
    .getSourceFile()
    .statements.find(
      (statement) =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === "activityFailureKind",
    );
  const returned = producer?.body?.statements.find(ts.isReturnStatement)?.expression;
  if (!returned || !ts.isConditionalExpression(returned)) return;
  if (!ts.isTemplateExpression(returned.whenFalse)) return;
  const prefix = returned.whenFalse.head.text;
  if (/^[A-Z_]+\.$/u.test(prefix)) return prefix;
}

function indexingFailureMap(node, source) {
  if (source !== "packages/keiko-local-knowledge/src/indexing/orchestrator-activity-log.ts") return;
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
  if (node.name.text !== "EXACT_FAILURE_ERROR_KINDS" || !node.initializer) return;
  if (ts.isObjectLiteralExpression(node.initializer)) return node.initializer;
}

function collectIndexingFailureKinds(node, tokens, source) {
  const map = indexingFailureMap(node, source);
  if (!map) return;
  const prefix = indexingFailurePrefix(node);
  for (const property of map.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
    addTechnicalToken(property.name.text, tokens);
    if (prefix) addTechnicalToken(`${prefix}${property.name.text}`, tokens);
  }
}

function collectOwnedVocabulary(node, tokens, source) {
  collectClosedGitKinds(node, tokens);
  collectGitCall(node, tokens);
  collectProfile(node, tokens);
  collectCatalogIdentity(node, tokens, source);
  collectGitConfigSubcommand(node, tokens, source);
  collectIndexingFailureKinds(node, tokens, source);
  if (!source.includes("packages/keiko-git/src/")) return;
  if (ts.isReturnStatement(node) && node.expression && ts.isStringLiteral(node.expression))
    addTechnicalToken(node.expression.text, tokens);
}

function sameFileConstant(expression) {
  const declarations = expression
    .getSourceFile()
    .statements.flatMap((statement) =>
      ts.isVariableStatement(statement) &&
      (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
        ? [...statement.declarationList.declarations]
        : [],
    );
  return declarations.find(
    (declaration) =>
      ts.isIdentifier(declaration.name) && declaration.name.text === expression.expression.text,
  )?.initializer;
}

function referencedCodeToken(expression) {
  if (!ts.isPropertyAccessExpression(expression) || !ts.isIdentifier(expression.expression))
    return undefined;
  const constant = sameFileConstant(expression);
  if (constant === undefined) return undefined;
  const value = ts.isAsExpression(constant) ? constant.expression : constant;
  if (!ts.isObjectLiteralExpression(value)) return undefined;
  const property = value.properties.find(
    (entry) =>
      ts.isPropertyAssignment(entry) &&
      ts.isIdentifier(entry.name) &&
      entry.name.text === expression.name.text,
  );
  return property !== undefined && ts.isStringLiteral(property.initializer)
    ? property.initializer.text
    : undefined;
}

function collectToken(node, tokens) {
  if (!ts.isPropertyAssignment(node) && !ts.isPropertyDeclaration(node)) return;
  if (!ts.isIdentifier(node.name) || !tokenFields.has(node.name.text)) return;
  if (node.initializer === undefined) return;
  if (ts.isStringLiteral(node.initializer)) {
    addTechnicalToken(node.initializer.text, tokens);
  } else if (node.name.text === "code") {
    // Resolve only the selected literal of a same-file const table referenced by a code producer.
    // Unused table members, dynamic/imported values and arbitrary source strings stay excluded.
    const value = referencedCodeToken(node.initializer);
    if (value !== undefined) addTechnicalToken(value, tokens);
  }
}

function ownedDiagnosticImport(statement, source) {
  if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return;
  const module = statement.moduleSpecifier.text;
  if (!module.startsWith("./") && !module.startsWith("../")) return;
  if (
    join(dirname(source), module).replaceAll("\\", "/") !==
    "packages/keiko-server/src/diagnostics-log.js"
  )
    return;
  const named = statement.importClause?.namedBindings;
  return named && ts.isNamedImports(named) ? named : undefined;
}

function diagnosticEmitterBindings(tree, source) {
  const bindings = new Set();
  if (!source.startsWith("packages/keiko-server/src/")) return bindings;
  for (const statement of tree.statements) {
    const named = ownedDiagnosticImport(statement, source);
    if (!named) continue;
    for (const binding of named.elements)
      if ((binding.propertyName ?? binding.name).text === "emitServerDiagnostic")
        bindings.add(binding.name.text);
  }
  return bindings;
}

function collectDiagnosticLiteral(expression, errors) {
  if (ts.isStringLiteral(expression) && /^[A-Z][A-Za-z0-9]{0,63}$/u.test(expression.text))
    errors.add(expression.text);
  if (ts.isConditionalExpression(expression)) {
    collectDiagnosticLiteral(expression.whenTrue, errors);
    collectDiagnosticLiteral(expression.whenFalse, errors);
  }
}

function collectDiagnosticClass(node, emitters, errors) {
  if (!ts.isPropertyAssignment(node) || !ts.isIdentifier(node.name)) return;
  if (node.name.text !== "errorClass") return;
  const call = node.parent.parent;
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return;
  if (!emitters.has(call.expression.text) || call.arguments[1] !== node.parent) return;
  collectDiagnosticLiteral(node.initializer, errors);
}

function collectNode(node, classes, tokens, source, emitters, diagnostics) {
  collectClass(node, classes);
  collectToken(node, tokens);
  collectDiagnosticClass(node, emitters, diagnostics);
  collectOwnedVocabulary(node, tokens, source);
  ts.forEachChild(node, (child) =>
    collectNode(child, classes, tokens, source, emitters, diagnostics),
  );
}

function errorClasses(classes, diagnostics) {
  const errors = new Set(builtinClasses);
  let previousSize;
  do {
    previousSize = errors.size;
    for (const [name, parent] of classes) if (errors.has(parent)) errors.add(name);
  } while (previousSize !== errors.size);
  return [...new Set([...errors, ...diagnostics])].sort(compareCodeUnits);
}

export function archivedCodeModules(version, execute = execFileSync) {
  const runGit = (args) =>
    execute(resolveHostExecutable("git"), args, {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  return supportedReleases(version, execute)
    .filter(({ release }) => releasePrecedes(release, version))
    .map(({ release, sourceCommit }) => {
      const paths = runGit(["ls-tree", "-r", "--name-only", sourceCommit]).trimEnd().split("\n");
      const modules = paths
        .filter(
          (path) =>
            /^(?:packages\/keiko-[^/]+\/src\/|src\/cli\/).*\.tsx?$/u.test(path) &&
            !excluded.test(path),
        )
        .flatMap((path) => {
          const frame = path.replace("/src/", "/dist/").replace(/\.tsx?$/u, ".js");
          const normalized = normalizeKeikoFrame(`${frame}:1:1`);
          return normalized === undefined ? [] : [normalized];
        });
      const registry = JSON.parse(
        runGit(["show", `${sourceCommit}:docs/observability/op-catalog.generated.json`]),
      ).typedRegistry;
      const json = JSON.stringify([...new Set(modules)].sort(compareCodeUnits));
      if (Buffer.byteLength(json) > 1024 * 1024)
        throw new RangeError("Archived code inventory exceeds its ceiling");
      return {
        release,
        sourceCommit,
        catalogDigest: registry.catalogDigest,
        modules: deflateSync(json, { level: 9 }).toString("base64"),
      };
    });
}

export async function generateSupportCodeInventory(root = repoRoot) {
  const modules = new Set();
  const classes = new Map();
  const tokens = new Set();
  const diagnostics = new Set();
  for (const path of productFiles(root)) {
    const source = relative(root, path).replaceAll("\\", "/");
    const frame = source.replace("/src/", "/dist/").replace(/\.tsx?$/u, ".js");
    const module = normalizeKeikoFrame(`${frame}:1:1`);
    if (module !== undefined) modules.add(module);
    const tree = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    collectNode(
      tree,
      classes,
      tokens,
      source,
      diagnosticEmitterBindings(tree, source),
      diagnostics,
    );
  }
  const history =
    resolve(root) === repoRoot
      ? archivedCodeModules(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version)
      : [];
  const declaration = (name, values) =>
    `export const ${name}: readonly string[] = ${JSON.stringify(values)};\n`;
  return format(
    "// Generated by scripts/generate-support-code-inventory.mjs. Never edit by hand.\n" +
      "// Only code-owned symbols are admissible in exported diagnostic details.\n" +
      declaration("SUPPORT_CODE_MODULES", [...modules].sort(compareCodeUnits)) +
      declaration("SUPPORT_CODE_ERROR_CLASSES", errorClasses(classes, diagnostics)) +
      declaration("SUPPORT_CODE_TOKENS", [...tokens].sort(compareCodeUnits)) +
      `export const SUPPORT_CODE_MODULE_HISTORY = ${JSON.stringify(history)} as const;\n`,
    { parser: "typescript", printWidth: 100 },
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const generated = await generateSupportCodeInventory();
  if (process.argv.includes("--check")) {
    if (readFileSync(join(repoRoot, target), "utf8") !== generated)
      throw new Error(
        "Support code inventory is stale; run npm run generate:support-code-inventory",
      );
  } else writeFileSync(join(repoRoot, target), generated);
}
