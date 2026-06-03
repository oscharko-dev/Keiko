// Dependency-graph guard for @oscharko-dev/keiko-contracts. Asserts that:
//   1. No source file imports from any other @oscharko-dev/keiko-* package (contracts is a leaf).
//   2. No source file re-imports back into the src/ source tree via relative "../../../src/" paths.
//   3. The package.json has no runtime @oscharko-dev/keiko-* dependencies.
//
// A single violation produces a message with file path and line number for fast diagnosis.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(HERE, ".");
const PKG_JSON: Record<string, unknown> = JSON.parse(
  readFileSync(resolve(HERE, "../package.json"), "utf8"),
) as Record<string, unknown>;

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "dist") {
        continue;
      }
      results.push(...collectTsFiles(join(dir, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      results.push(join(dir, entry.name));
    }
  }
  return results;
}

describe("keiko-contracts boundary: no external keiko-* imports", () => {
  const files = collectTsFiles(SRC_DIR);

  it("discovers at least one source file", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("no source file imports from a sibling @oscharko-dev/keiko-* package", () => {
    const violations: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/from\s+["']@oscharko-dev\/keiko-(?!contracts)/.test(line ?? "")) {
          violations.push(`${file}:${String(i + 1)}: ${(line ?? "").trim()}`);
        }
      }
    }
    expect(
      violations,
      `Found forbidden sibling-package imports:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("no source file re-imports back into the src/ tree via relative paths", () => {
    const violations: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/from\s+["']\.\.\/\.\.\/\.\.\/src\//.test(line ?? "")) {
          violations.push(`${file}:${String(i + 1)}: ${(line ?? "").trim()}`);
        }
      }
    }
    expect(violations, `Found forbidden src/ re-imports:\n${violations.join("\n")}`).toEqual([]);
  });
});

describe("keiko-contracts boundary: package.json has no keiko-* runtime deps", () => {
  it("dependencies contains no @oscharko-dev/keiko-* entries", () => {
    const deps = PKG_JSON.dependencies;
    if (deps !== undefined && deps !== null && typeof deps === "object") {
      const forbidden = Object.keys(deps as Record<string, unknown>).filter((k) =>
        k.startsWith("@oscharko-dev/keiko-"),
      );
      expect(
        forbidden,
        `Found forbidden keiko-* runtime dependencies: ${forbidden.join(", ")}`,
      ).toEqual([]);
    }
  });

  it("peerDependencies contains no @oscharko-dev/keiko-* entries", () => {
    const deps = PKG_JSON.peerDependencies;
    if (deps !== undefined && deps !== null && typeof deps === "object") {
      const forbidden = Object.keys(deps as Record<string, unknown>).filter((k) =>
        k.startsWith("@oscharko-dev/keiko-"),
      );
      expect(
        forbidden,
        `Found forbidden keiko-* peer dependencies: ${forbidden.join(", ")}`,
      ).toEqual([]);
    }
  });
});
