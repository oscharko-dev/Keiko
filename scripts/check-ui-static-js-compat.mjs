// Release gate for the bundled static UI: the npm package serves these files directly to the
// customer's browser. Parse the emitted JavaScript with Acorn's dynamic-import support, then
// explicitly reject modern syntax such as optional chaining, nullish coalescing, class static
// blocks, or import.meta so it cannot silently ship again. Dynamic import is intentionally allowed:
// all packaged UI browser targets support it, and PDF.js uses it internally for worker/fallback
// loading without weakening the ES2019 baseline for ordinary syntax.

import { parse } from "acorn";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_STATIC_ROOT = join(repoRoot, "dist", "ui", "static");
const PARSE_ECMASCRIPT_VERSION = 2020;
const COMPATIBILITY_BASELINE = "ES2019-compatible syntax plus dynamic import";

async function collectJavaScriptFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJavaScriptFiles(full)));
      continue;
    }
    if (entry.name.endsWith(".js")) {
      files.push(full);
    }
  }
  return files;
}

function nodeLocation(node) {
  if (node?.loc?.start === undefined) return "";
  const { line, column } = node.loc.start;
  return `:${String(line)}:${String(column + 1)}`;
}

function collectSyntaxViolations(node, violations) {
  if (node === null || typeof node !== "object") return;

  switch (node.type) {
    case "ChainExpression":
      violations.push(`${nodeLocation(node)} optional chaining is not allowed`);
      break;
    case "LogicalExpression":
      if (node.operator === "??") {
        violations.push(`${nodeLocation(node)} nullish coalescing is not allowed`);
      }
      break;
    case "AssignmentExpression":
      if (node.operator === "??=") {
        violations.push(`${nodeLocation(node)} nullish assignment is not allowed`);
      }
      break;
    case "MetaProperty":
      if (node.meta?.name === "import" && node.property?.name === "meta") {
        violations.push(`${nodeLocation(node)} import.meta is not allowed`);
      }
      break;
  }

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) collectSyntaxViolations(child, violations);
    } else if (value !== null && typeof value === "object" && typeof value.type === "string") {
      collectSyntaxViolations(value, violations);
    }
  }
}

function parseJavaScript(source) {
  const ast = parse(source, {
    ecmaVersion: PARSE_ECMASCRIPT_VERSION,
    sourceType: "script",
    allowHashBang: true,
    locations: true,
  });
  const violations = [];
  collectSyntaxViolations(ast, violations);
  if (violations.length > 0) {
    throw new Error(violations.join("\n"));
  }
}

export async function checkUiStaticJavaScriptCompatibility(staticRoot = DEFAULT_STATIC_ROOT) {
  const files = await collectJavaScriptFiles(staticRoot);
  const failures = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    try {
      parseJavaScript(source);
    } catch (error) {
      const location =
        error && typeof error === "object" && "loc" in error && error.loc
          ? `:${String(error.loc.line)}:${String(error.loc.column + 1)}`
          : "";
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${relative(repoRoot, file)}${location} ${message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      [
        `UI static JavaScript compatibility check failed: ${String(
          failures.length,
        )} file(s) are not ${COMPATIBILITY_BASELINE}.`,
        ...failures.slice(0, 20),
      ].join("\n"),
    );
  }

  console.log(
    `UI static JavaScript compatibility: PASS — ${String(
      files.length,
    )} file(s) use ${COMPATIBILITY_BASELINE}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await checkUiStaticJavaScriptCompatibility(process.argv[2] ?? DEFAULT_STATIC_ROOT);
}
