// Static contract for `scripts/installable-package-smoke.mjs` (Issue #169 D2). This test is
// intentionally lightweight: the npm-install round-trip belongs in the CI job, not in the unit
// suite. Here we only assert that the script file exists at the expected path, parses as ESM,
// and has no `export ...` declarations (it is a Node script, not a module that other code
// imports). A future refactor that turns the script into a re-exportable module would have to
// either move the assertions to the new module or update this test deliberately.

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

  it("exports nothing — it is a script, not a module", () => {
    const source = readFileSync(scriptPath, "utf8");
    expect(source).not.toMatch(/^export[\s{]/m);
    expect(source).not.toMatch(/^export\s+default\b/m);
  });

  it("declares the bundled-payload assertion, the CLI bin assertion, and the SDK probe", () => {
    const source = readFileSync(scriptPath, "utf8");
    expect(source).toContain("bundleDependencies");
    expect(source).toMatch(/"dist"\s*,\s*"cli"\s*,\s*"index\.js"/);
    expect(source).toContain("@oscharko-dev/keiko");
  });

  it("guards `npm install` with a hard timeout so a hung install cannot wedge CI", () => {
    const source = readFileSync(scriptPath, "utf8");
    expect(source).toMatch(/timeout:\s*NPM_INSTALL_TIMEOUT_MS/);
  });

  it("cleans up the tmpdir even on failure", () => {
    const source = readFileSync(scriptPath, "utf8");
    expect(source).toMatch(/\bfinally\s*{[\s\S]*?rmSync\([^)]*tmp/);
  });
});
