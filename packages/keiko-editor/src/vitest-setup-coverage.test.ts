import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// KEIKO-0134: packages/keiko-editor/vitest.config.ts wires vitest.setup.ts's DOM polyfills via
// `setupFiles`, but vitest.coverage.packages.config.ts (the other required-CI lane that collects
// these same files, per its own "measure the lifecycle code it gates" comment) declares no
// `setupFiles` at all — its `environment: "node"` is shared by every other package's plain Node
// tests, so vitest.setup.ts's `HTMLElement`/`window`/`HTMLCanvasElement` globals cannot be wired
// in unconditionally there. The repository's workaround is that each jsdom-environment test file
// self-imports the setup module directly. This guard enumerates that exact file set — every
// `*.test.tsx` file and every `*.test.ts` file carrying the `@vitest-environment jsdom` pragma —
// and fails, naming the offender, if any one of them omits the import. This file itself is a
// plain `.test.ts` file with no jsdom pragma, so it is not part of the guarded set.

const here = dirname(fileURLToPath(import.meta.url));

// Both patterns below are anchored to a whole line (`^...$/m`) on purpose: a bare `.includes()`
// on the pragma text or the module name matches this very file's own explanatory prose (the
// sentence above quotes both `@vitest-environment jsdom` and `vitest.setup` verbatim), which
// would silently fold this guard file into the guarded set and then pass it on comment text
// alone -- exactly the false-positive class this guard exists to catch in every other file.
// Trailing text is allowed after the environment name (vitest's own pragma scan tolerates it, so a
// file carrying "// @vitest-environment jsdom // reason" WOULD run under jsdom and must therefore
// still be guarded); a word boundary keeps "jsdomX" from matching.
const JSDOM_PRAGMA_LINE = /^\/\/\s*@vitest-environment\s+jsdom\b/m;
const SETUP_IMPORT_STATEMENT = /^import\s+["']\.\.?\/(\.\.\/)?vitest\.setup(\.js)?["'];?$/m;

interface GuardedFile {
  readonly relativePath: string;
  readonly source: string;
}

function listTestFiles(dir: string): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      paths.push(...listTestFiles(fullPath));
      continue;
    }
    if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) {
      paths.push(fullPath);
    }
  }
  return paths;
}

function requiresSetupImport(filePath: string, source: string): boolean {
  return filePath.endsWith(".test.tsx") || JSDOM_PRAGMA_LINE.test(source);
}

function collectGuardedFiles(): GuardedFile[] {
  return listTestFiles(here)
    .map((filePath) => ({
      relativePath: filePath.slice(here.length + 1),
      source: readFileSync(filePath, "utf8"),
    }))
    .filter(({ relativePath, source }) => requiresSetupImport(relativePath, source));
}

describe("vitest.setup import coverage (KEIKO-0134)", () => {
  const guardedFiles = collectGuardedFiles();

  it("finds at least one jsdom-environment test file to guard", () => {
    expect(guardedFiles.length).toBeGreaterThan(0);
  });

  it.each(guardedFiles.map(({ relativePath, source }) => [relativePath, source] as const))(
    "%s imports the shared vitest.setup module",
    (relativePath, source) => {
      expect(
        SETUP_IMPORT_STATEMENT.test(source),
        `${relativePath} must import "../../vitest.setup" via an actual side-effect import ` +
          "statement (mentioning it in a comment does not count) so jest-dom matchers and the " +
          "canvas facade are active in every required-CI lane that collects this file (KEIKO-0134)",
      ).toBe(true);
    },
  );
});
