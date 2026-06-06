import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
interface RootPackageSurfaceContract {
  packageExports: Record<string, unknown>;
  runtimeExports: string[];
  declarationExports: string[];
}

interface RootManifest {
  exports: Record<string, unknown>;
}

function readRootPackageSurfaceContract(path: string): RootPackageSurfaceContract {
  return JSON.parse(readFileSync(path, "utf8")) as RootPackageSurfaceContract;
}

function readRootManifest(path: string): RootManifest {
  return JSON.parse(readFileSync(path, "utf8")) as RootManifest;
}

const contract = readRootPackageSurfaceContract(
  resolve(repoRoot, "scripts", "root-package-surface.contract.json"),
);
const manifest = readRootManifest(resolve(repoRoot, "package.json"));

describe("root package surface contract", () => {
  it("keeps the root package monolithic-root only", () => {
    expect(manifest.exports).toEqual(contract.packageExports);
    expect(Object.keys(contract.packageExports)).toEqual(["."]);
  });

  it("records non-empty runtime and declaration export allowlists", () => {
    expect(Array.isArray(contract.runtimeExports)).toBe(true);
    expect(Array.isArray(contract.declarationExports)).toBe(true);
    expect(contract.runtimeExports.length).toBeGreaterThan(0);
    expect(contract.declarationExports.length).toBeGreaterThanOrEqual(contract.runtimeExports.length);
  });

  it("keeps the root runtime allowlist sorted and duplicate-free", () => {
    const sorted = [...contract.runtimeExports].sort();
    expect(contract.runtimeExports).toEqual(sorted);
    expect(new Set(contract.runtimeExports).size).toBe(contract.runtimeExports.length);
  });
});
