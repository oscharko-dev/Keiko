import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  EXPECTED_EXACT_TOOLCHAINS,
  EXPECTED_NODE_COMPATIBILITY_BASELINE,
  EXPECTED_NODE_ENGINE,
  EXPECTED_NPM_COMPATIBILITY_BASELINE,
  EXPECTED_NPM_ENGINE_RANGE,
  evaluateRuntimeToolchain,
  readNpmVersionFromPath,
  readWorkspaceNodeEngines,
  readWorkspaceNpmEngines,
  runtimeInput,
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
  rootNodeEngine: EXPECTED_NODE_ENGINE,
  rootNpmEngine: EXPECTED_NPM_ENGINE_RANGE,
  packageManager: "npm@11.16.0",
  portableNodeVersion: "24.18.0",
  runtimeNodeVersion: "24.18.0",
  runtimeNpmVersion: "11.16.0",
  workspaceNodeEngines: [
    { name: "@oscharko-dev/keiko-contracts", value: EXPECTED_NODE_ENGINE },
    { name: "@oscharko-dev/keiko-ui", value: EXPECTED_NODE_ENGINE },
  ],
  workspaceNpmEngines: [{ name: "@oscharko-dev/keiko-ui", value: EXPECTED_NPM_ENGINE_RANGE }],
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

  it("accepts the Node.js 26 floor with its first governed npm version", () => {
    expect(
      evaluateRuntimeToolchain({ ...baseline, runtimeNodeVersion: "26.3.0" }, { exactNode: false }),
    ).toEqual([]);
  });

  it("accepts the exact governed Node.js 26 compatibility tuple", () => {
    expect(
      evaluateRuntimeToolchain(
        {
          ...baseline,
          runtimeNodeVersion: EXPECTED_NODE_COMPATIBILITY_BASELINE,
          runtimeNpmVersion: EXPECTED_NPM_COMPATIBILITY_BASELINE,
        },
        { exactNode: true },
      ),
    ).toEqual([]);
  });

  it.each([
    ["stale root engine", { rootNodeEngine: ">=22" }],
    ["stale workspace engine", { workspaceNodeEngines: [{ name: "stale", value: ">=22" }] }],
    ["portable drift", { portableNodeVersion: "24.17.0" }],
    ["unsupported odd Node runtime", { runtimeNodeVersion: "25.9.0" }],
    ["Node runtime below the 26 floor", { runtimeNodeVersion: "26.2.0" }],
    ["future unsupported Node runtime", { runtimeNodeVersion: "27.0.0" }],
    ["npm engine drift", { rootNpmEngine: ">=11" }],
    [
      "stale workspace npm engine",
      { workspaceNpmEngines: [{ name: "@oscharko-dev/keiko-ui", value: "11.18.0" }] },
    ],
    ["package-manager drift", { packageManager: "npm@12.0.1" }],
    ["executed npm below the floor", { runtimeNpmVersion: "11.15.0" }],
    ["executed npm next major", { runtimeNpmVersion: "12.0.0" }],
  ])("rejects %s", (_label, change) => {
    expect(evaluateRuntimeToolchain({ ...baseline, ...change }, { exactNode: false })).not.toEqual(
      [],
    );
  });

  it("accepts a workspace graph where no workspace declares an npm engine", () => {
    expect(
      evaluateRuntimeToolchain({ ...baseline, workspaceNpmEngines: [] }, { exactNode: true }),
    ).toEqual([]);
  });

  it("rejects a non-approved Node patch in exact CI mode", () => {
    expect(
      evaluateRuntimeToolchain({ ...baseline, runtimeNodeVersion: "24.19.1" }, { exactNode: true }),
    ).not.toEqual([]);
  });

  it("rejects supported versions combined into an unapproved exact tuple", () => {
    expect(EXPECTED_EXACT_TOOLCHAINS).toHaveLength(2);
    expect(
      evaluateRuntimeToolchain(
        {
          ...baseline,
          runtimeNodeVersion: EXPECTED_NODE_COMPATIBILITY_BASELINE,
          runtimeNpmVersion: "11.16.0",
        },
        { exactNode: true },
      ),
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

  it("fails closed for malformed npm package metadata without probing later entries", () => {
    const fixture = npmFixture("11.16.0");
    writeFileSync(join(fixture.root, "node_modules", "npm", "package.json"), "{not json");
    symlinkSync(fixture.npmCli, join(fixture.root, "npm"));

    expect(readNpmVersionFromPath(fixture.root, "linux")).toBeUndefined();
  });

  it("returns undefined when PATH has no npm candidates", () => {
    expect(readNpmVersionFromPath("", "linux")).toBeUndefined();
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
      `${JSON.stringify({ name: "@oscharko-dev/zeta", engines: { node: ">=24.18.0 <25 || >=26.3.0 <27" } })}\n`,
    );
    writeFileSync(
      join(root, "packages", "alpha", "package.json"),
      `${JSON.stringify({ name: "@oscharko-dev/alpha", engines: { node: ">=24.18.0 <25 || >=26.3.0 <27" } })}\n`,
    );
    writeFileSync(join(root, "packages", "beta", "package.json"), "{}\n");

    expect(readWorkspaceNodeEngines(root)).toEqual([
      { name: "@oscharko-dev/alpha", value: ">=24.18.0 <25 || >=26.3.0 <27" },
      { name: "@oscharko-dev/zeta", value: ">=24.18.0 <25 || >=26.3.0 <27" },
      { name: "beta", value: undefined },
    ]);
  });
});

describe("readWorkspaceNpmEngines", () => {
  it("reports only workspaces that declare an npm engine, sorted by package name", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-runtime-npm-engines-"));
    fixtureRoots.push(root);
    for (const name of ["zeta", "alpha", "beta", "fixtures-only"]) {
      mkdirSync(join(root, "packages", name), { recursive: true });
    }
    writeFileSync(
      join(root, "packages", "zeta", "package.json"),
      `${JSON.stringify({ name: "@oscharko-dev/zeta", engines: { npm: "11.18.0" } })}\n`,
    );
    writeFileSync(
      join(root, "packages", "alpha", "package.json"),
      `${JSON.stringify({ name: "@oscharko-dev/alpha", engines: { npm: ">=11.16.0 <12" } })}\n`,
    );
    writeFileSync(
      join(root, "packages", "beta", "package.json"),
      `${JSON.stringify({ name: "@oscharko-dev/beta", engines: { node: ">=24.18.0 <25 || >=26.3.0 <27" } })}\n`,
    );

    expect(readWorkspaceNpmEngines(root)).toEqual([
      { name: "@oscharko-dev/alpha", value: ">=11.16.0 <12" },
      { name: "@oscharko-dev/zeta", value: "11.18.0" },
    ]);
  });

  it("skips a directory with no manifest, which is outside the package graph", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-runtime-no-manifest-"));
    fixtureRoots.push(root);
    mkdirSync(join(root, "packages", "fixtures-only"), { recursive: true });
    expect(readWorkspaceNpmEngines(root)).toEqual([]);
  });

  it("fails closed on a manifest that exists but cannot be parsed", () => {
    // Swallowing this would drop the workspace out of the engine policy silently, and the gate
    // would report a pass over a package it never examined — a stale engine could then sit there
    // indefinitely with nothing to report it.
    const root = mkdtempSync(join(tmpdir(), "keiko-runtime-bad-manifest-"));
    fixtureRoots.push(root);
    mkdirSync(join(root, "packages", "broken"), { recursive: true });
    writeFileSync(join(root, "packages", "broken", "package.json"), "{ not json\n");
    expect(() => readWorkspaceNpmEngines(root)).toThrow();
  });
});

describe("runtimeInput", () => {
  it("assembles declared, approved, executed, and workspace runtime metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-runtime-input-"));
    fixtureRoots.push(root);
    const npm = npmFixture("11.16.0");
    symlinkSync(npm.npmCli, join(npm.root, "npm"));
    mkdirSync(join(root, "packages", "alpha"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({
        engines: { node: ">=24.18.0 <25 || >=26.3.0 <27", npm: ">=11.16.0 <12" },
        packageManager: "npm@11.16.0",
      })}\n`,
    );
    writeFileSync(
      join(root, "portable-runtime-approvals.json"),
      `${JSON.stringify({ node: { version: "24.18.0" } })}\n`,
    );
    writeFileSync(
      join(root, "packages", "alpha", "package.json"),
      `${JSON.stringify({
        name: "@oscharko-dev/alpha",
        engines: { node: ">=24.18.0 <25 || >=26.3.0 <27" },
      })}\n`,
    );
    const previousPath = process.env.PATH;
    process.env.PATH = npm.root;
    try {
      expect(runtimeInput(root)).toEqual({
        rootNodeEngine: ">=24.18.0 <25 || >=26.3.0 <27",
        rootNpmEngine: ">=11.16.0 <12",
        packageManager: "npm@11.16.0",
        portableNodeVersion: "24.18.0",
        runtimeNodeVersion: process.versions.node,
        runtimeNpmVersion: "11.16.0",
        workspaceNodeEngines: [
          { name: "@oscharko-dev/alpha", value: ">=24.18.0 <25 || >=26.3.0 <27" },
        ],
        workspaceNpmEngines: [],
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("carries a drifted workspace npm engine through to a gate failure", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-runtime-input-npm-drift-"));
    fixtureRoots.push(root);
    const npm = npmFixture("11.16.0");
    symlinkSync(npm.npmCli, join(npm.root, "npm"));
    mkdirSync(join(root, "packages", "ui"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({
        engines: { node: ">=24.18.0 <25 || >=26.3.0 <27", npm: ">=11.16.0 <12" },
        packageManager: "npm@11.16.0",
      })}\n`,
    );
    writeFileSync(
      join(root, "portable-runtime-approvals.json"),
      `${JSON.stringify({ node: { version: "24.18.0" } })}\n`,
    );
    writeFileSync(
      join(root, "packages", "ui", "package.json"),
      `${JSON.stringify({
        name: "@oscharko-dev/keiko-ui",
        engines: { node: ">=24.18.0 <25 || >=26.3.0 <27", npm: "11.18.0" },
      })}\n`,
    );
    const previousPath = process.env.PATH;
    process.env.PATH = npm.root;
    try {
      expect(evaluateRuntimeToolchain(runtimeInput(root), { exactNode: false })).toEqual([
        "@oscharko-dev/keiko-ui: npm engine policy is stale",
      ]);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});
