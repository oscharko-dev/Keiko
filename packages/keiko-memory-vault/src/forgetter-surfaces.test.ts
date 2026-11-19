import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as surfaces from "./forgetter-surfaces.js";

const PACKAGES_DIR = fileURLToPath(new URL("../../", import.meta.url));
const ROOT_SRC_DIR = fileURLToPath(new URL("../../../src/", import.meta.url));

function productionSources(directory: string): readonly string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (entry === "node_modules" || entry === "dist") return [];
    if (statSync(path).isDirectory()) return productionSources(path);
    const isSource = path.endsWith(".ts") || path.endsWith(".mts");
    return isSource && !/\.(test|spec)\./u.test(entry) && !path.includes("__tests__") ? [path] : [];
  });
}

function allProductionSources(): readonly string[] {
  const packageSrcDirs = readdirSync(PACKAGES_DIR)
    .map((name) => join(PACKAGES_DIR, name, "src"))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
  return [...packageSrcDirs, ROOT_SRC_DIR].flatMap((dir) => {
    try {
      return productionSources(dir);
    } catch {
      return [];
    }
  });
}

const CONSTANTS: ReadonlyMap<string, string> = new Map(
  Object.entries(surfaces).filter(
    (entry): entry is [string, string] =>
      entry[0].endsWith("_FORGETTER_SURFACE") && typeof entry[1] === "string",
  ),
);

function isClassified(surface: string): boolean {
  return (
    surfaces.isPersonForgetterSurface(surface) || surfaces.isUnattendedForgetterSurface(surface)
  );
}

// What a `forgetterSurface` assignment may carry: a classified literal, a named classification
// constant, a pass-through of a value that was itself written under one of those rules, or a type.
function expressionIsAccountedFor(expression: string): string | undefined {
  const text = expression.trim();
  const literal = /^"([^"]*)"$/u.exec(text);
  if (literal !== null) {
    return isClassified(literal[1] ?? "") ? undefined : `unclassified literal ${text}`;
  }
  if (CONSTANTS.has(text)) return undefined;
  if (/^string(?: \| undefined)?$/u.test(text)) return undefined;
  if (/^(?:[A-Za-z_]\w*\.)*forgetter(?:S|_s)urface$/u.test(text)) return undefined;
  return `unaccounted expression ${text}`;
}

describe("forgetter surface classification (#4223)", () => {
  it("classifies each surface exactly once, as a person's or as unattended", () => {
    for (const [, value] of CONSTANTS) {
      const classes = [
        surfaces.isPersonForgetterSurface(value),
        surfaces.isUnattendedForgetterSurface(value),
      ].filter(Boolean);
      expect(classes, value).toHaveLength(1);
    }
    expect(surfaces.isPersonForgetterSurface("never-seen")).toBe(false);
    expect(surfaces.isUnattendedForgetterSurface("never-seen")).toBe(false);
  });

  it("leaves no production writer of a tombstone unclassified", () => {
    const problems: string[] = [];
    let writers = 0;
    for (const file of allProductionSources()) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/\bforgetterSurface\??\s*[:=]\s*([^,;\n)]+)/gu)) {
        writers += 1;
        const problem = expressionIsAccountedFor(match[1] ?? "");
        if (problem !== undefined) problems.push(`${file}: ${problem}`);
      }
    }
    expect(writers).toBeGreaterThan(3);
    expect(problems).toEqual([]);
  });

  it("rejects an unclassified literal writer (the scan is not vacuous)", () => {
    expect(expressionIsAccountedFor('"brand-new-writer"')).toBeDefined();
    expect(expressionIsAccountedFor("someHelper()")).toBeDefined();
    expect(expressionIsAccountedFor('"retention"')).toBeUndefined();
  });
});
