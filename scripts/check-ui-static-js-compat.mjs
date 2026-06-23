// Release gate for the bundled static UI: the npm package serves these files directly to the
// customer's browser. Parse the emitted JavaScript as ES2019 so modern syntax such as optional
// chaining, nullish coalescing, class static blocks, or import.meta cannot silently ship again.

import { parse } from "acorn";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_STATIC_ROOT = join(repoRoot, "dist", "ui", "static");
const ECMASCRIPT_VERSION = 2019;

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

function parseJavaScript(source, file) {
  parse(source, {
    ecmaVersion: ECMASCRIPT_VERSION,
    sourceType: "script",
    allowHashBang: true,
    locations: true,
  });
}

export async function checkUiStaticJavaScriptCompatibility(staticRoot = DEFAULT_STATIC_ROOT) {
  const files = await collectJavaScriptFiles(staticRoot);
  const failures = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    try {
      parseJavaScript(source, file);
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
        )} file(s) are not parseable as ES${String(ECMASCRIPT_VERSION)}.`,
        ...failures.slice(0, 20),
      ].join("\n"),
    );
  }

  console.log(
    `UI static JavaScript compatibility: PASS — ${String(
      files.length,
    )} file(s) parse as ES${String(ECMASCRIPT_VERSION)}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await checkUiStaticJavaScriptCompatibility(process.argv[2] ?? DEFAULT_STATIC_ROOT);
}
