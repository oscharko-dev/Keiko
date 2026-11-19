import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
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

// A source tree that cannot be read must fail the inventory: a package silently left out would let
// the test pass without checking its writers.
function scanSources(directory: string): readonly string[] {
  try {
    return productionSources(directory);
  } catch (error: unknown) {
    throw new Error(`cannot scan ${directory} for forgetter surface writers`, { cause: error });
  }
}

// True for a directory, false only when nothing exists at the path. Any other error (for example a
// src/ directory that cannot be read) is thrown, so it cannot drop a package from the inventory.
function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`cannot inspect ${path} for forgetter surface writers`, { cause: error });
  }
}

function allProductionSources(): readonly string[] {
  // An entry of packages/ without a src/ directory holds no production source and is skipped on
  // purpose; every src/ directory that exists is scanned completely. Tombstones are written by
  // TypeScript sources of the packages and of the root src/ only (.ts, .mts); the UI never writes
  // one, so .tsx is not part of this inventory.
  const packageSrcDirs = readdirSync(PACKAGES_DIR)
    .map((name) => join(PACKAGES_DIR, name, "src"))
    .filter(isExistingDirectory);
  return [...packageSrcDirs, ROOT_SRC_DIR].flatMap(scanSources);
}

const CONSTANTS: ReadonlyMap<string, string> = new Map(
  Object.entries(surfaces).filter(
    (entry): entry is [string, string] =>
      entry[0].endsWith("_FORGETTER_SURFACE") && typeof entry[1] === "string",
  ),
);

function isClassified(surface: string): boolean {
  return (
    surfaces.isPersonForgetterSurface(surface) ||
    surfaces.MEMORY_UNATTENDED_FORGETTER_SURFACES.includes(surface)
  );
}

// An import or re-export names a constant without writing a tombstone under it.
function withoutModuleBindings(source: string): string {
  return source.replace(/\b(?:import|export)\s+(?:type\s+)?\{[^}]*\}\s*from\s*"[^"]*";?/gu, "");
}

const CONSTANT_REFERENCE = /\b[A-Z][A-Z_]*_FORGETTER_SURFACE\b/gu;

interface Writers {
  // A classification constant, wherever it stands: a property, a default parameter, a positional
  // argument. Keyed by constant name, each with the files that carry it.
  readonly constants: ReadonlyMap<string, ReadonlySet<string>>;
  readonly literals: number;
  readonly problems: readonly string[];
}

// What a `forgetterSurface` property may carry: a classified literal, a named classification
// constant, or a pass-through of a value that was itself written under one of those rules (a
// shorthand property, a member access, a type). Only a literal or a constant is a writer.
function propertyProblem(expression: string): string | undefined {
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

function scanWriters(files: ReadonlyMap<string, string>): Writers {
  const constants = new Map<string, Set<string>>();
  const problems: string[] = [];
  let literals = 0;
  for (const [file, text] of files) {
    const source = withoutModuleBindings(text);
    for (const match of source.matchAll(CONSTANT_REFERENCE)) {
      const files = constants.get(match[0]) ?? new Set<string>();
      files.add(file);
      constants.set(match[0], files);
    }
    for (const match of source.matchAll(/\bforgetterSurface\??\s*[:=]\s*([^,;\n)}]+)/gu)) {
      const expression = match[1] ?? "";
      if (/^\s*"/u.test(expression)) literals += 1;
      const problem = propertyProblem(expression);
      if (problem !== undefined) problems.push(`${file}: ${problem}`);
    }
  }
  return { constants, literals, problems };
}

function productionFiles(): ReadonlyMap<string, string> {
  const own = fileURLToPath(new URL("./forgetter-surfaces.ts", import.meta.url));
  return new Map(
    allProductionSources()
      .filter((file) => file !== own)
      .map((file) => [file, readFileSync(file, "utf8")] as const),
  );
}

// The four production writers of a forget tombstone, by constant and by the file that carries it.
const KNOWN_WRITERS: readonly (readonly [string, string])[] = [
  ["MEMORY_CENTER_FORGETTER_SURFACE", "memory-handlers.ts"],
  ["MEMORY_CHAT_STATEMENT_FORGETTER_SURFACE", "memory-handlers.ts"],
  ["MEMORY_MAINTENANCE_FORGETTER_SURFACE", "memory-maintenance-handlers.ts"],
  ["MEMORY_RETENTION_FORGETTER_SURFACE", "memory-retention.ts"],
];

describe("forgetter surface classification (#4223)", () => {
  it("fails the inventory when a source tree cannot be scanned, naming the directory", () => {
    const missing = join(PACKAGES_DIR, "no-such-package", "src");
    expect(() => scanSources(missing)).toThrow(`cannot scan ${missing}`);
  });

  it("skips a path where nothing exists and fails for one it cannot inspect", () => {
    expect(isExistingDirectory(join(PACKAGES_DIR, "no-such-package", "src"))).toBe(false);
    expect(isExistingDirectory(PACKAGES_DIR)).toBe(true);
    // A path below a regular file cannot be inspected (ENOTDIR): that is an error, not an absence.
    const belowAFile = join(fileURLToPath(import.meta.url), "src");
    expect(() => isExistingDirectory(belowAFile)).toThrow(`cannot inspect ${belowAFile}`);
  });

  it("classifies each surface exactly once, as a person's or as unattended", () => {
    for (const [, value] of CONSTANTS) {
      const classes = [
        surfaces.isPersonForgetterSurface(value),
        surfaces.MEMORY_UNATTENDED_FORGETTER_SURFACES.includes(value),
      ].filter(Boolean);
      expect(classes, value).toHaveLength(1);
    }
    expect(surfaces.isPersonForgetterSurface("never-seen")).toBe(false);
    expect(isClassified("never-seen")).toBe(false);
  });

  it("leaves no production writer of a tombstone unclassified", () => {
    const { problems } = scanWriters(productionFiles());
    expect(problems).toEqual([]);
  });

  it("reaches the four known production writers by name", () => {
    const { constants } = scanWriters(productionFiles());
    for (const [constant, file] of KNOWN_WRITERS) {
      const carriers = [...(constants.get(constant) ?? [])].map((path) => basename(path));
      expect(carriers, constant).toContain(file);
    }
  });

  it("uses every exported surface constant in a production file", () => {
    const { constants } = scanWriters(productionFiles());
    for (const name of CONSTANTS.keys()) {
      expect(constants.has(name), `${name} has no production use`).toBe(true);
    }
    expect([...CONSTANTS.keys()].sort()).toEqual(KNOWN_WRITERS.map(([name]) => name).sort());
  });

  it("sees a positional argument, a default parameter, a property and a shorthand", () => {
    const sample = new Map([
      [
        "sample.ts",
        [
          "run(db, MEMORY_CHAT_STATEMENT_FORGETTER_SURFACE);",
          "function f(forgetterSurface = MEMORY_CENTER_FORGETTER_SURFACE) {}",
          "g({ forgetterSurface: MEMORY_RETENTION_FORGETTER_SURFACE });",
          "h({ forgetterSurface });",
          'k({ forgetterSurface: "brand-new-writer" });',
          'import { MEMORY_MAINTENANCE_FORGETTER_SURFACE } from "./x.js";',
        ].join("\n"),
      ],
    ]);
    const { constants, literals, problems } = scanWriters(sample);
    expect([...constants.keys()].sort()).toEqual([
      "MEMORY_CENTER_FORGETTER_SURFACE",
      "MEMORY_CHAT_STATEMENT_FORGETTER_SURFACE",
      "MEMORY_RETENTION_FORGETTER_SURFACE",
    ]);
    expect(literals).toBe(1);
    expect(problems).toEqual(['sample.ts: unclassified literal "brand-new-writer"']);
  });

  it("rejects an unclassified literal writer (the scan is not vacuous)", () => {
    expect(propertyProblem('"brand-new-writer"')).toBeDefined();
    expect(propertyProblem("someHelper()")).toBeDefined();
    expect(propertyProblem('"retention"')).toBeUndefined();
  });
});
