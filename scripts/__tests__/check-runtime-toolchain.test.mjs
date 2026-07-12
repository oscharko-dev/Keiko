import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  evaluateRuntimeToolchain,
  readNpmVersionFromPath,
  readWorkspaceNodeEngines,
} from "../check-runtime-toolchain.mjs";

const fixtureRoots = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function npmFixture(version) {
  const root = mkdtempSync(join(tmpdir(), "keiko-runtime-toolchain-"));
  fixtureRoots.push(root);
  const npmRoot = join(root, "node_modules", "npm");
  const npmCli = join(npmRoot, "bin", "npm-cli.js");
  mkdirSync(dirname(npmCli), { recursive: true });
  writeFileSync(join(npmRoot, "package.json"), `${JSON.stringify({ version })}\n`);
  writeFileSync(npmCli, "#!/usr/bin/env node\n");
  return { npmCli, root };
}

const baseline = {
  rootNodeEngine: ">=24.18.0 <25",
  rootNpmEngine: "11.16.0",
  packageManager: "npm@11.16.0",
  portableNodeVersion: "24.18.0",
  runtimeNodeVersion: "24.18.0",
  runtimeNpmVersion: "11.16.0",
  workspaceNodeEngines: [
    { name: "@oscharko-dev/keiko-contracts", value: ">=24.18.0 <25" },
    { name: "@oscharko-dev/keiko-ui", value: ">=24.18.0 <25" },
  ],
};

describe("evaluateRuntimeToolchain", () => {
  it("accepts the exact governed Node.js 24 LTS and bundled npm baseline", () => {
    expect(evaluateRuntimeToolchain(baseline, { exactNode: true })).toEqual([]);
  });

  it("accepts a later supported Node.js 24 patch outside exact CI mode", () => {
    expect(
      evaluateRuntimeToolchain(
        { ...baseline, runtimeNodeVersion: "24.19.1" },
        { exactNode: false },
      ),
    ).toEqual([]);
  });

  it.each([
    ["stale root engine", { rootNodeEngine: ">=22" }],
    ["stale workspace engine", { workspaceNodeEngines: [{ name: "stale", value: ">=22" }] }],
    ["portable drift", { portableNodeVersion: "24.17.0" }],
    ["unsupported runtime", { runtimeNodeVersion: "26.0.0" }],
    ["npm engine drift", { rootNpmEngine: ">=11" }],
    ["package-manager drift", { packageManager: "npm@12.0.1" }],
    ["executed npm drift", { runtimeNpmVersion: "11.18.0" }],
  ])("rejects %s", (_label, change) => {
    expect(evaluateRuntimeToolchain({ ...baseline, ...change }, { exactNode: false })).not.toEqual(
      [],
    );
  });

  it("rejects a non-approved Node patch in exact CI mode", () => {
    expect(
      evaluateRuntimeToolchain({ ...baseline, runtimeNodeVersion: "24.19.1" }, { exactNode: true }),
    ).not.toEqual([]);
  });
});

describe("readNpmVersionFromPath", () => {
  it("reads the selected Unix npm package without executing it", () => {
    const fixture = npmFixture("11.16.0");
    symlinkSync(fixture.npmCli, join(fixture.root, "npm"));
    expect(readNpmVersionFromPath(fixture.root, "darwin")).toBe("11.16.0");
  });

  it("reads the selected Windows npm package beside npm.cmd", () => {
    const fixture = npmFixture("11.16.0");
    writeFileSync(join(fixture.root, "npm.cmd"), "@echo off\r\n");
    expect(readNpmVersionFromPath(fixture.root, "win32")).toBe("11.16.0");
  });

  it("fails closed for an invalid npm manifest", () => {
    const fixture = npmFixture("latest");
    symlinkSync(fixture.npmCli, join(fixture.root, "npm"));
    expect(readNpmVersionFromPath(fixture.root, "linux")).toBeUndefined();
  });

  it("skips path entries without npm and reads the first governed npm manifest", () => {
    const fixture = npmFixture("11.16.0");
    const missingEntry = mkdtempSync(join(tmpdir(), "keiko-runtime-toolchain-missing-"));
    fixtureRoots.push(missingEntry);
    symlinkSync(fixture.npmCli, join(fixture.root, "npm"));

    expect(readNpmVersionFromPath(`${missingEntry}${delimiter}${fixture.root}`, "linux")).toBe(
      "11.16.0",
    );
  });
});

describe("readWorkspaceNodeEngines", () => {
  it("reads workspace Node.js engine floors, skips non-package directories, and sorts by package name", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-runtime-workspaces-"));
    fixtureRoots.push(root);
    mkdirSync(join(root, "packages", "zeta"), { recursive: true });
    mkdirSync(join(root, "packages", "alpha"), { recursive: true });
    mkdirSync(join(root, "packages", "beta"), { recursive: true });
    mkdirSync(join(root, "packages", "fixtures-only"), { recursive: true });
    writeFileSync(
      join(root, "packages", "zeta", "package.json"),
      `${JSON.stringify({ name: "@oscharko-dev/zeta", engines: { node: ">=24.18.0 <25" } })}\n`,
    );
    writeFileSync(
      join(root, "packages", "alpha", "package.json"),
      `${JSON.stringify({ name: "@oscharko-dev/alpha", engines: { node: ">=24.18.0 <25" } })}\n`,
    );
    writeFileSync(join(root, "packages", "beta", "package.json"), "{}\n");

    expect(readWorkspaceNodeEngines(root)).toEqual([
      { name: "@oscharko-dev/alpha", value: ">=24.18.0 <25" },
      { name: "@oscharko-dev/zeta", value: ">=24.18.0 <25" },
      { name: "beta", value: undefined },
    ]);
  });
});
