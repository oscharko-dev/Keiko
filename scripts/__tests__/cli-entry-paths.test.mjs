import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
let fixtureRoot;

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "keiko-cli-entry-"));
  for (const name of ["plain", "workspace # %"]) {
    symlinkSync(repoRoot, join(fixtureRoot, name), "junction");
  }
});

afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

function invoke(rootName, script, args) {
  // Preserve the main entry's alias so every platform exercises URL-encoded paths,
  // even when CI's real checkout has no spaces. Dependencies remain the real modules.
  return spawnSync(
    process.execPath,
    ["--preserve-symlinks-main", join(fixtureRoot, rootName, "scripts", script), ...args],
    { cwd: repoRoot, encoding: "utf8", timeout: 10_000 },
  );
}

describe.each(["plain", "workspace # %"])("real CLI entry in %s", (rootName) => {
  it.each([
    ["release-portable-prerelease.mjs", ["--bogus"], 1, "usage: release-portable-prerelease"],
    ["release-tag-contract.mjs", ["invalid-tag"], 1, "release-tag-contract: FAIL"],
    ["check-perf-evidence.mjs", [], 2, "is the measurement/digest library and has no CLI"],
  ])("%s refuses invalid direct execution", (script, args, status, message) => {
    const result = invoke(rootName, script, args);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(status);
    expect(result.stderr).toContain(message);
  });

  it("accepts the actual release version through the real CLI", () => {
    const result = invoke(rootName, "release-tag-contract.mjs", [`v${version}`]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("release-tag-contract: PASS");
    expect(result.stderr).toBe("");
  });
});

it("importing the modules does not execute a CLI", () => {
  const imports = [
    "release-portable-prerelease.mjs",
    "release-tag-contract.mjs",
    "check-perf-evidence.mjs",
  ].map((script) => pathToFileURL(join(repoRoot, "scripts", script)).href);
  const importer = join(fixtureRoot, "importer.mjs");
  writeFileSync(importer, `for (const url of ${JSON.stringify(imports)}) await import(url);`);
  const result = spawnSync(process.execPath, [importer], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
});
