import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptPath = resolve(repoRoot, "scripts", "check-package-surface.mjs");
const rulesPath = resolve(repoRoot, "scripts", "package-surface-rules.mjs");

describe("check-package-surface script", () => {
  it("exists at the expected path", () => {
    expect(existsSync(scriptPath)).toBe(true);
  });

  it("is an ESM script with .mjs extension", () => {
    expect(scriptPath.endsWith(".mjs")).toBe(true);
    const source = readFileSync(scriptPath, "utf8");
    expect(source).toMatch(/^import /m);
  });

  it("exposes only governed coverage seams while keeping import-only coverage fail-closed", () => {
    const source = readFileSync(scriptPath, "utf8");
    expect(source).toContain("export function assertTypeScriptRuntimeSurface");
    expect(source).toContain("KEIKO_PACKAGE_SURFACE_COVERAGE_IMPORT_ONLY");
    expect(source).toContain("__keikoPackageSurfaceCoverageSeam");
    expect(source).toContain("must never pass a release gate");
    expect(source).not.toMatch(/^export\s+default\b/m);
  });

  it("pins the root package export contract and declaration contract", () => {
    const source = readFileSync(scriptPath, "utf8");
    expect(source).toContain("root-package-surface.contract.json");
    expect(source).toContain("package.json exports drifted");
    expect(source).toContain("collectTypeExports");
    expect(source).toContain("root runtime export contract drifted");
    expect(source).toContain("root declaration export contract drifted");
  });

  it("delegates the forbidden-path rule set to the dependency-free rules module", () => {
    const source = readFileSync(scriptPath, "utf8");
    expect(source).toContain("package-surface-rules.mjs");
    expect(source).toContain("findForbiddenPaths");
  });

  it("keeps the editor package as an explicit non-bundled workspace exclusion", () => {
    const source = readFileSync(scriptPath, "utf8");
    expect(source).toContain("EXPECTED_BUNDLE_EXCLUSIONS");
    expect(source).toContain("@oscharko-dev/keiko-editor");
    expect(source).toContain("Issue #1191");
  });

  it("rejects bundled optional native canvas payloads and any native addon binary", () => {
    // The forbidden-path rules live in scripts/package-surface-rules.mjs (extracted so they are
    // unit-testable without running `npm pack` or importing the BFF).
    const rules = readFileSync(rulesPath, "utf8");
    expect(rules).toContain("node_modules/@napi-rs/canvas");
    expect(rules).toContain("platform-specific optional native canvas dependency");
    // Generic native-addon backstop (Issue #287 AC4): any `.node` binary is rejected, not just canvas.
    expect(rules).toContain(".node");
    expect(rules).toContain("a native addon binary");
  });
});
