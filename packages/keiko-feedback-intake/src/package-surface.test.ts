import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface PackFile {
  readonly path: string;
}

interface PackEntry {
  readonly files: readonly PackFile[];
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productionModules = [
  "config",
  "crypto",
  "file-secret-provider",
  "http",
  "index",
  "main",
  "postgres-client",
  "postgres-live-key-snapshot",
  "postgres-retention",
  "postgres-types",
  "postgres",
  "production-service",
  "proxy",
  "runtime-config",
  "runtime-key-custody",
  "runtime",
  "types",
] as const;
const forbiddenModules = ["intake", "keys", "memory-store", "postgres-integration-helpers"];

function packedPaths(): readonly string[] {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`npm pack --dry-run failed: ${result.stderr}`);
  }
  const parsed = JSON.parse(result.stdout) as readonly PackEntry[];
  return (parsed[0]?.files ?? []).map((file) => file.path).sort();
}

function expectedPaths(): readonly string[] {
  const compiled = productionModules.flatMap((module) => [
    `dist/${module}.d.ts`,
    `dist/${module}.d.ts.map`,
    `dist/${module}.js`,
  ]);
  return ["migrations/001_feedback_intake.sql", "package.json", ...compiled].sort();
}

function relativeRuntimeImports(path: string): readonly string[] {
  const source = readFileSync(resolve(packageRoot, path), "utf8");
  return [...source.matchAll(/(?:from\s+|import\s*)["'](\.\.?\/[^"']+\.js)["']/gu)].map((match) =>
    relative(packageRoot, resolve(packageRoot, dirname(path), match[1] ?? "")),
  );
}

describe("hosted npm package surface", () => {
  it("ships exactly the production runtime, declarations, and migration", () => {
    expect(packedPaths()).toEqual(expectedPaths());
  });

  it("physically excludes test and in-memory-only compiled modules", () => {
    const paths = packedPaths();
    for (const module of forbiddenModules) {
      expect(paths.filter((path) => path.startsWith(`dist/${module}.`))).toEqual([]);
    }
  });

  it("includes every relative JavaScript dependency of every shipped module", () => {
    const paths = new Set(packedPaths());
    for (const path of paths) {
      if (!path.endsWith(".js")) continue;
      for (const imported of relativeRuntimeImports(path)) {
        expect(paths, `${path} imports missing ${imported}`).toContain(imported);
      }
    }
  });
});
