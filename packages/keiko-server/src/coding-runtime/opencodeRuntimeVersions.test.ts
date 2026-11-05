import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  OPENCODE_PINNED_VERSION,
  OPENCODE_RUNTIME_VERSION_PINS,
  isApprovedOpenCodeRuntimeVersion,
  openCodeRuntimeVersionPin,
} from "./opencodeRuntimeVersions.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SCANNED_ROOTS = ["packages", "scripts", "tests/e2e/servers"];
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".next", "out", "coverage"]);
const SOURCE_FILE = /\.(?:ts|tsx|mjs)$/u;
const TEST_FILE = /(?:\.test\.(?:ts|tsx|mjs)|\/__tests__\/.*)$/u;

/**
 * The only production modules that may name an OpenCode version, each for a reason the pin source
 * cannot carry: facts of already published artifacts and per-version persistence schemas.
 */
const VERSION_FACT_MODULES: ReadonlySet<string> = new Set([
  "packages/keiko-server/src/coding-runtime/npmLaneRuntimeApprovals.ts",
  "packages/keiko-server/src/coding-runtime/opencodePersistenceContract.ts",
]);

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return SKIPPED_DIRECTORIES.has(entry.name) ? [] : sourceFiles(join(directory, entry.name));
    }
    return SOURCE_FILE.test(entry.name) ? [join(directory, entry.name)] : [];
  });
}

function escaped(version: string): string {
  return version.replaceAll(".", String.raw`\.`);
}

function repositorySources(): readonly { readonly path: string; readonly text: string }[] {
  return SCANNED_ROOTS.flatMap((root) => sourceFiles(join(REPOSITORY_ROOT, root))).map((path) => ({
    path: relative(REPOSITORY_ROOT, path).split(sep).join("/"),
    text: readFileSync(path, "utf8"),
  }));
}

describe("the one OpenCode version boundary", () => {
  it("names the current pin first and describes every pin completely", () => {
    expect(OPENCODE_RUNTIME_VERSION_PINS[0]?.version).toBe(OPENCODE_PINNED_VERSION);
    for (const pin of OPENCODE_RUNTIME_VERSION_PINS) {
      expect(pin.tag).toBe(`v${pin.version}`);
      expect(pin.commit).toMatch(/^[a-f0-9]{40}$/u);
      expect(pin.rawSchemaSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(pin.protocolSurfaceSha256).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it("resolves only approved versions, including against prototype keys", () => {
    expect(openCodeRuntimeVersionPin(OPENCODE_PINNED_VERSION)?.version).toBe(
      OPENCODE_PINNED_VERSION,
    );
    for (const value of ["0.0.0", "", "constructor", "__proto__", undefined, null, 2]) {
      expect(openCodeRuntimeVersionPin(value)).toBeUndefined();
      expect(isApprovedOpenCodeRuntimeVersion(value)).toBe(false);
    }
  });

  it("refuses a restated version outside the pin source", () => {
    const versions = OPENCODE_RUNTIME_VERSION_PINS.map((pin) => escaped(pin.version)).join("|");
    const literal = new RegExp(String.raw`["'\u0060]v?(?:${versions})["'\u0060]`, "u");
    // Older versions keep their committed captures; the current pin's fixtures follow the constant.
    const reference = new RegExp(
      String.raw`opencode-${escaped(OPENCODE_PINNED_VERSION)}\b|pinned (?:${versions})\b`,
      "u",
    );
    const offenders = repositorySources().flatMap(({ path, text }) => {
      if (VERSION_FACT_MODULES.has(path)) return [];
      const isTest = TEST_FILE.test(path);
      const restated = text.split("\n").filter((line) => {
        // A test may use a version as sample data; its fixture paths still follow the pin.
        return reference.test(line) || (!isTest && literal.test(line));
      });
      return restated.map((line) => `${path}: ${line.trim()}`);
    });
    expect(offenders).toEqual([]);
  });
});
