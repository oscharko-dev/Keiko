// Static contract for `scripts/installable-package-smoke.mjs` (Issue #169 D2). This test is
// intentionally lightweight: the npm-install round-trip belongs in the CI job, not in the unit
// suite. Here we only assert that the script file exists at the expected path, parses as ESM,
// and exposes only narrow, side-effect-free coverage seams. The npm-install round-trip remains
// guarded behind direct CLI execution.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptPath = resolve(repoRoot, "scripts", "installable-package-smoke.mjs");

describe("installable-package-smoke script", () => {
  it("exists at the expected path", () => {
    expect(existsSync(scriptPath)).toBe(true);
  });

  it("is an ESM script with .mjs extension", () => {
    expect(scriptPath.endsWith(".mjs")).toBe(true);
    const source = readFileSync(scriptPath, "utf8");
    expect(source).toMatch(/^import /m);
  });

  it("exposes only governed coverage seams while keeping direct CLI execution guarded", () => {
    const source = readFileSync(scriptPath, "utf8");
    expect(source).toContain("export const DEFAULT_NPM_INSTALL_TIMEOUT_MS");
    expect(source).toContain("export const WINDOWS_NPM_INSTALL_TIMEOUT_MS");
    expect(source).toContain("export function parseArgs");
    expect(source).toContain("export function parsePositiveTimeoutEnv");
    expect(source).toContain("void main()");
    expect(source).toContain("pathToFileURL(process.argv[1]).href");
    expect(source).not.toMatch(/^export\s+default\b/m);
  });

  it("declares the bundled-payload assertion, the root runtime/type contract checks, and the UI probe", () => {
    const source = readFileSync(scriptPath, "utf8");
    expect(source).toContain("bundleDependencies");
    expect(source).toMatch(/"dist"\s*,\s*"cli"\s*,\s*"index\.js"/);
    expect(source).toContain("root-package-surface.contract.json");
    expect(source).toContain("collectConsumerVisibleTypeExports");
    expect(source).toContain("getExportsOfModule");
    expect(source).toContain('dist", "ui", "static"');
    expect(source).toContain("/api/health");
    expect(source).toContain("/api/projects");
  });

  it("guards `npm install` with a hard timeout so a hung install cannot wedge CI", () => {
    const source = readFileSync(scriptPath, "utf8");
    expect(source).toMatch(/timeout:\s*NPM_INSTALL_TIMEOUT_MS/);
  });

  it("uses a long bounded `npm install` timeout and keeps an override escape hatch", () => {
    const source = readFileSync(scriptPath, "utf8");
    expect(source).toContain("DEFAULT_NPM_INSTALL_TIMEOUT_MS = 600_000");
    expect(source).toContain("WINDOWS_NPM_INSTALL_TIMEOUT_MS = 600_000");
    expect(source).toContain("KEIKO_SMOKE_INSTALL_TIMEOUT_MS");
    expect(source).toContain("must be a positive integer number of milliseconds");
    expect(source).toMatch(/process\.platform\s*===\s*"win32"/);
  });

  it("cleans up the tmpdir even on failure", () => {
    const source = readFileSync(scriptPath, "utf8");
    expect(source).toMatch(/\bfinally\s*{[\s\S]*?rmSync\([^)]*tmp/);
  });
});
