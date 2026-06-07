import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

import ts from "typescript";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const FIXTURE_ROOT = "tests/architecture/fixtures";

const PROVIDER_SDK_PATTERN = /^(openai($|\/)|@anthropic-ai\/|[^/]+-ai-sdk($|\/))/;
const CONTROLLED_TOOLS_FS_ADAPTER_PATTERN =
  /^packages\/keiko-tools\/src\/(_support|exec|writer)\.[cm]?tsx?$/;

const IMPORT_POLICY_RULES = [
  {
    name: "adr-0019-trust-1-provider-sdk-isolation",
    matchesFile: (path, mode) =>
      mode === "fixtures"
        ? path.startsWith(`${FIXTURE_ROOT}/provider-sdk-isolation/`)
        : /^(packages\/keiko-|src\/)/.test(path) &&
          !/^(packages\/keiko-model-gateway\/src\/|src\/gateway\/)/.test(path),
    matchesSpecifier: (specifier) => PROVIDER_SDK_PATTERN.test(specifier),
  },
  {
    name: "adr-0019-trust-4-no-direct-fs-outside-workspace",
    matchesFile: (path, mode) =>
      mode === "fixtures"
        ? path.startsWith(`${FIXTURE_ROOT}/direct-fs-outside-workspace/`)
        : /^(packages\/keiko-(tools|harness|workflows)\/src\/|src\/(tools|harness|workflows)\/)/.test(
            path,
          ) && !CONTROLLED_TOOLS_FS_ADAPTER_PATTERN.test(path),
    matchesSpecifier: (specifier) => specifier === "node:fs" || specifier === "fs",
  },
  {
    name: "adr-0019-trust-5-patch-routes-through-tools",
    matchesFile: (path, mode) =>
      mode === "fixtures"
        ? path.startsWith(`${FIXTURE_ROOT}/patch-routes-through-tools/`)
        : /^(packages\/keiko-(harness|workflows)\/src\/|src\/(harness|workflows)\/)/.test(path),
    matchesSpecifier: (specifier) =>
      specifier === "node:fs/promises" || specifier === "fs/promises",
  },
];

function normalizePath(path) {
  return path.split(sep).join("/");
}

function extensionOf(path) {
  const name = basename(path);
  const firstDot = name.indexOf(".");
  return firstDot === -1 ? "" : name.slice(firstDot);
}

function isSourceFile(path) {
  return SOURCE_EXTENSIONS.has(extensionOf(path));
}

function isProductionTestFile(path) {
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    path.includes("/__tests__/") ||
    path.includes("/__test-support__/") ||
    path.includes("/test-support/")
  );
}

async function pathExists(path) {
  return Boolean(await stat(path).catch(() => null));
}

async function collectFiles(dir) {
  if (!(await pathExists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path)));
      continue;
    }
    if (entry.isFile() && isSourceFile(path)) {
      files.push(path);
    }
  }
  return files;
}

async function collectProductionFiles(root) {
  const files = [];
  files.push(...(await collectFiles(join(root, "src"))));

  const packagesDir = join(root, "packages");
  if (await pathExists(packagesDir)) {
    for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("keiko-")) {
        files.push(...(await collectFiles(join(packagesDir, entry.name, "src"))));
      }
    }
  }

  return files
    .map((file) => ({ file, relativePath: normalizePath(relative(root, file)) }))
    .filter(({ relativePath }) => !isProductionTestFile(relativePath));
}

async function collectFixtureFiles(root) {
  return (await collectFiles(join(root, FIXTURE_ROOT))).map((file) => ({
    file,
    relativePath: normalizePath(relative(root, file)),
  }));
}

function isStringLiteralLike(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function moduleSpecifierEntry(node) {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
    return isStringLiteralLike(node.moduleSpecifier)
      ? { node: node.moduleSpecifier, specifier: node.moduleSpecifier.text }
      : undefined;
  }
  return undefined;
}

function importTypeEntry(node) {
  if (!ts.isImportTypeNode(node)) return undefined;
  const literal = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : null;
  return literal && isStringLiteralLike(literal)
    ? { node: literal, specifier: literal.text }
    : undefined;
}

function callExpressionEntry(node) {
  if (!ts.isCallExpression(node)) return undefined;
  const [firstArg] = node.arguments;
  if (!firstArg || !isStringLiteralLike(firstArg)) return undefined;
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return { node: firstArg, specifier: firstArg.text };
  }
  if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
    return { node: firstArg, specifier: firstArg.text };
  }
  return undefined;
}

function importSpecifierEntry(node) {
  return moduleSpecifierEntry(node) ?? importTypeEntry(node) ?? callExpressionEntry(node);
}

function collectImportSpecifiers(sourceFile) {
  const specifiers = [];

  function visit(node) {
    const entry = importSpecifierEntry(node);
    if (entry) specifiers.push(entry);
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

function parseSourceFile(path, text) {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
}

function violationFor(rule, file, relativePath, sourceFile, specifierEntry) {
  const location = sourceFile.getLineAndCharacterOfPosition(
    specifierEntry.node.getStart(sourceFile),
  );
  return {
    rule: rule.name,
    file: relativePath,
    line: location.line + 1,
    column: location.character + 1,
    specifier: specifierEntry.specifier,
  };
}

async function collectPolicyFiles(root, mode) {
  return mode === "fixtures" ? collectFixtureFiles(root) : collectProductionFiles(root);
}

function matchingRules(relativePath, mode, specifier) {
  return IMPORT_POLICY_RULES.filter(
    (rule) => rule.matchesFile(relativePath, mode) && rule.matchesSpecifier(specifier),
  );
}

async function violationsForFile(file, relativePath, mode) {
  const text = await readFile(file, "utf8");
  const sourceFile = parseSourceFile(file, text);
  const violations = [];
  for (const specifierEntry of collectImportSpecifiers(sourceFile)) {
    for (const rule of matchingRules(relativePath, mode, specifierEntry.specifier)) {
      violations.push(violationFor(rule, file, relativePath, sourceFile, specifierEntry));
    }
  }
  return violations;
}

export async function checkArchitectureImportPolicy(root, options = {}) {
  const mode = options.mode ?? "production";
  if (mode !== "production" && mode !== "fixtures") {
    throw new Error(`unsupported import-policy mode: ${mode}`);
  }

  const absoluteRoot = resolve(root);
  const files = await collectPolicyFiles(absoluteRoot, mode);
  const violations = [];

  for (const { file, relativePath } of files) {
    violations.push(...(await violationsForFile(file, relativePath, mode)));
  }

  return violations.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    if (a.line !== b.line) return a.line - b.line;
    return a.rule.localeCompare(b.rule);
  });
}

export function countImportPolicyViolationsByRule(violations) {
  const counts = new Map();
  for (const violation of violations) {
    counts.set(violation.rule, (counts.get(violation.rule) ?? 0) + 1);
  }
  return counts;
}

function parseArgs(argv) {
  const rootArg = argv.find((arg) => arg.startsWith("--root="));
  return {
    mode: argv.includes("--fixtures") ? "fixtures" : "production",
    root: resolve(rootArg ? rootArg.slice("--root=".length) : process.cwd()),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const { mode, root } = parseArgs(argv);
  const violations = await checkArchitectureImportPolicy(root, { mode });
  if (violations.length > 0) {
    console.error("import-policy: FAIL");
    for (const violation of violations) {
      console.error(
        `  - ${violation.rule} at ${violation.file}:${String(violation.line)}:${String(violation.column)} imports ${JSON.stringify(violation.specifier)}`,
      );
    }
    process.exit(1);
  }

  console.log("import-policy: PASS - ADR-0019 import-specifier policies passed.");
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]).endsWith("check-import-policy.mjs");
if (invokedDirectly) {
  await main();
}
