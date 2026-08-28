import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkDependencyHygiene,
  findTrackedNextBuildPaths,
  gitExecutableCandidates,
  resolveGitExecutable,
} from "../check-dependency-hygiene.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const gatePath = resolve(here, "..", "check-dependency-hygiene.mjs");
const repositoryRoot = resolve(here, "..", "..");
const temporaryRoots = [];

function makeRepository() {
  const root = mkdtempSync(resolve(tmpdir(), "keiko-dependency-hygiene-"));
  temporaryRoots.push(root);
  mkdirSync(resolve(root, "packages"));
  mkdirSync(resolve(root, "scripts"));
  writeFileSync(
    resolve(root, "package.json"),
    `${JSON.stringify({ engines: { node: ">=22" } }, null, 2)}\n`,
  );
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

function trackGeneratedOutput(root, path, body) {
  const absolutePath = resolve(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, body);
  execFileSync("git", ["add", "-f", "--", path], { cwd: root });
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function trackAll(root) {
  execFileSync("git", ["add", "-A", "--"], { cwd: root });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("tracked Next.js output hygiene", () => {
  it.each([
    ".next",
    ".next/server/app.js",
    "ui/.next/server/app.js",
    "packages/keiko-ui/.next/static/chunk.js",
    "packages/future-ui/.next/BUILD_ID",
    "apps/admin/.next/cache/compiler.bin",
  ])("rejects an exact .next segment at %s", (path) => {
    expect(findTrackedNextBuildPaths([path])).toEqual([path]);
  });

  it("sorts every violation and allows similarly named source paths", () => {
    expect(
      findTrackedNextBuildPaths([
        "packages/z/.next/server.js",
        ".next-cache/fixture.json",
        "packages/x/.nextish/file",
        "src/index.ts",
        "ui/.next/build-manifest.json",
      ]),
    ).toEqual(["packages/z/.next/server.js", "ui/.next/build-manifest.json"]);
  });

  it.each([
    ".next/BUILD_ID",
    "ui/.next/server/app.js",
    "packages/keiko-ui/.next/static/chunk.js",
    "packages/future-ui/.next/BUILD_ID",
    "apps/admin/.next/cache/compiler.bin",
  ])("ignores current, legacy, and future Next.js output at %s", (path) => {
    const result = spawnSync("git", ["check-ignore", "--quiet", "--no-index", "--", path], {
      cwd: repositoryRoot,
    });
    expect(result.status).toBe(0);
  });

  it("parses NUL-delimited tracked paths without leaking file contents", () => {
    const root = makeRepository();
    const bodySecret = "BODY_SECRET_MARKER_MUST_NOT_APPEAR";
    const trackedPath = "apps/admin/.next/server\nchunk.js";
    trackGeneratedOutput(root, trackedPath, bodySecret);

    const result = spawnSync(process.execPath, [gatePath, `--root=${root}`], {
      encoding: "utf8",
    });
    const diagnostic = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(diagnostic).toContain("1 tracked .next path");
    expect(diagnostic).toContain(JSON.stringify(trackedPath));
    expect(diagnostic).not.toContain(bodySecret);
  });

  it("passes clean manifests, declared script imports, and ordinary tracked source paths", () => {
    const root = makeRepository();
    writeJson(resolve(root, "package.json"), {
      engines: { node: ">=22" },
      devDependencies: { "@playwright/test": "*", typescript: "*" },
    });
    writeJson(resolve(root, "packages", "clean", "package.json"), {
      name: "@oscharko-dev/clean",
      engines: { node: ">=22" },
      dependencies: { "@oscharko-dev/keiko-contracts": "*" },
    });
    writeFileSync(
      resolve(root, "scripts", "clean.mjs"),
      [
        'import { join } from "node:path";',
        'import ts from "typescript";',
        'import { test } from "@playwright/test/fixtures";',
        'import "./local-helper.mjs";',
        'import "@oscharko-dev/keiko-contracts";',
        "void join;",
        "void ts;",
        "void test;",
      ].join("\n"),
    );
    writeFileSync(resolve(root, "scripts", "local-helper.mjs"), "export const value = 1;\n");
    writeFileSync(resolve(root, "README.md"), "tracked source only\n");
    trackAll(root);

    expect(checkDependencyHygiene(root)).toEqual({
      manifestCount: 2,
      problems: [],
      trackedPathCount: 5,
      trackedNextViolationCount: 0,
    });
  });

  it("reports runtime type packages, missing package engines, undeclared script imports, and tracked generated output", () => {
    const root = makeRepository();
    writeJson(resolve(root, "packages", "bad", "package.json"), {
      name: "@oscharko-dev/bad",
      dependencies: { "@types/node": "*" },
    });
    writeFileSync(resolve(root, "scripts", "bad.mjs"), 'import leftPad from "left-pad";\n');
    trackGeneratedOutput(root, "packages/bad/.next/server/app.js", "generated body");
    trackAll(root);

    const result = checkDependencyHygiene(root);

    expect(result.manifestCount).toBe(2);
    expect(result.trackedNextViolationCount).toBe(1);
    expect(result.problems).toEqual(
      expect.arrayContaining([
        'bad: "@types/node" is a type-only package in "dependencies" — move it to "devDependencies" (it would ship in the tarball).',
        'bad: missing an "engines.node" floor (align with the root).',
        'scripts/bad.mjs: imports "left-pad" which is not declared in the root package.json (relies on transitive resolution — declare it in devDependencies).',
        'tracked .next output path: "packages/bad/.next/server/app.js"',
      ]),
    );
  });

  // Issue #2777: PR #3290 bumped the root to "^10.8.1" (resolved 10.9.1) and keiko-ui to "10.8.1",
  // which installed a second ESLint under packages/keiko-ui/node_modules that the workspace lint
  // script — it executes ../../node_modules/eslint/bin/eslint.js — never runs. The two ranges can
  // then drift a whole major apart with every gate still green, so the drift itself is the finding.
  it("rejects a workspace lint toolchain range that has drifted off the root's single lane", () => {
    const root = makeRepository();
    writeJson(resolve(root, "package.json"), {
      engines: { node: ">=22" },
      devDependencies: { eslint: "^10.8.1" },
    });
    writeJson(resolve(root, "packages", "ui", "package.json"), {
      name: "@oscharko-dev/ui",
      engines: { node: ">=22" },
      devDependencies: { eslint: "10.8.1" },
    });
    trackAll(root);

    expect(checkDependencyHygiene(root).problems).toEqual([
      'ui: declares "eslint": "10.8.1" but the root declares "^10.8.1" — the workspace executes the root\'s installed eslint, so a diverging range installs a second copy that never runs.',
    ]);
  });

  it("rejects a workspace lint toolchain the root does not declare at all", () => {
    const root = makeRepository();
    writeJson(resolve(root, "packages", "ui", "package.json"), {
      name: "@oscharko-dev/ui",
      engines: { node: ">=22" },
      devDependencies: { eslint: "^10.8.1" },
    });
    trackAll(root);

    expect(checkDependencyHygiene(root).problems).toEqual([
      'ui: declares "eslint": "^10.8.1" while the root declares none — the workspace executes the root\'s installed eslint, so declare it at the root instead.',
    ]);
  });

  it("reads the lint toolchain range from either dependency section", () => {
    const root = makeRepository();
    writeJson(resolve(root, "package.json"), {
      engines: { node: ">=22" },
      dependencies: { eslint: "^10.8.1" },
    });
    writeJson(resolve(root, "packages", "ui", "package.json"), {
      name: "@oscharko-dev/ui",
      engines: { node: ">=22" },
      dependencies: { eslint: "^9.39.5" },
    });
    trackAll(root);

    expect(checkDependencyHygiene(root).problems).toEqual([
      'ui: declares "eslint": "^9.39.5" but the root declares "^10.8.1" — the workspace executes the root\'s installed eslint, so a diverging range installs a second copy that never runs.',
    ]);
  });

  // The manifest rule above cannot see a duplicate whose declared ranges already agree, and npm
  // cannot either: `npm ls` raises a problem only for a missing, invalid, or extraneous edge, so a
  // second copy that satisfies its workspace's own range prints in the tree and exits 0. This is
  // the only check that fails on it.
  it("rejects a second lint toolchain installed under a workspace", () => {
    const root = makeRepository();
    writeJson(resolve(root, "package.json"), {
      engines: { node: ">=22" },
      devDependencies: { eslint: "^10.8.1" },
    });
    writeJson(resolve(root, "packages", "ui", "package.json"), {
      name: "@oscharko-dev/ui",
      engines: { node: ">=22" },
      devDependencies: { eslint: "^10.8.1" },
    });
    writeJson(resolve(root, "node_modules", "eslint", "package.json"), {
      name: "eslint",
      version: "10.9.1",
    });
    writeJson(resolve(root, "packages", "ui", "node_modules", "eslint", "package.json"), {
      name: "eslint",
      version: "10.8.1",
    });
    writeFileSync(resolve(root, ".gitignore"), "node_modules\n");
    trackAll(root);

    expect(checkDependencyHygiene(root).problems).toEqual([
      'ui: a second "eslint" is installed at packages/ui/node_modules/eslint — the workspace executes the root\'s copy, so this one never runs and the two can drift apart.',
    ]);
  });

  it("does not report a duplicate install before anything is installed", () => {
    const root = makeRepository();
    writeJson(resolve(root, "package.json"), {
      engines: { node: ">=22" },
      devDependencies: { eslint: "^10.8.1" },
    });
    writeJson(resolve(root, "packages", "ui", "package.json"), {
      name: "@oscharko-dev/ui",
      engines: { node: ">=22" },
      devDependencies: { eslint: "^10.8.1" },
    });
    writeJson(resolve(root, "packages", "ui", "node_modules", "eslint", "package.json"), {
      name: "eslint",
      version: "10.8.1",
    });
    writeFileSync(resolve(root, ".gitignore"), "node_modules\n");
    trackAll(root);

    expect(checkDependencyHygiene(root).problems).toEqual([]);
  });

  // The defect that actually silenced rules: PR #3290 moved eslint to a new major and left
  // @eslint/js a major behind, so the ESLint 10 engine ran ESLint 9's recommended set. npm cannot
  // see this — @eslint/js@9 declared no peer on eslint, and @eslint/js@10's peer is optional.
  it("rejects a rule-set package left a major behind the engine it ships rules for", () => {
    const root = makeRepository();
    writeJson(resolve(root, "package.json"), {
      engines: { node: ">=22" },
      devDependencies: { eslint: "^10.8.1", "@eslint/js": "^9.39.5" },
    });
    trackAll(root);

    expect(checkDependencyHygiene(root).problems).toEqual([
      '<root>: "@eslint/js": "^9.39.5" is on major 9 while "eslint": "^10.8.1" is on major 10 — @eslint/js ships the rule set eslint runs, so a major apart silently changes which rules are enabled.',
    ]);
  });

  it("accepts a rule-set package on the engine's major, and stays quiet when either is absent", () => {
    const paired = makeRepository();
    writeJson(resolve(paired, "package.json"), {
      engines: { node: ">=22" },
      devDependencies: { eslint: "^10.8.1", "@eslint/js": "^10.0.1" },
    });
    trackAll(paired);
    expect(checkDependencyHygiene(paired).problems).toEqual([]);

    const unpaired = makeRepository();
    writeJson(resolve(unpaired, "package.json"), {
      engines: { node: ">=22" },
      devDependencies: { eslint: "^10.8.1" },
    });
    trackAll(unpaired);
    expect(checkDependencyHygiene(unpaired).problems).toEqual([]);
  });

  it("accepts a workspace that shares the root's declared lint toolchain range", () => {
    const root = makeRepository();
    writeJson(resolve(root, "package.json"), {
      engines: { node: ">=22" },
      devDependencies: { eslint: "^10.8.1" },
    });
    writeJson(resolve(root, "packages", "ui", "package.json"), {
      name: "@oscharko-dev/ui",
      engines: { node: ">=22" },
      devDependencies: { eslint: "^10.8.1" },
    });
    trackAll(root);

    expect(checkDependencyHygiene(root).problems).toEqual([]);
  });

  it("fails closed with a fixed diagnostic outside a Git repository", () => {
    const root = makeRepository();
    rmSync(resolve(root, ".git"), { recursive: true, force: true });

    const result = spawnSync(process.execPath, [gatePath, `--root=${root}`], {
      encoding: "utf8",
    });
    const diagnostic = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(diagnostic).toContain(
      "Git index inspection did not complete successfully: git ls-files exited with status",
    );
    expect(diagnostic).not.toContain("fatal:");
  });

  it("resolves a governed override before falling back to fixed git paths", () => {
    const root = mkdtempSync(resolve(tmpdir(), "keiko-dependency-hygiene-git-"));
    temporaryRoots.push(root);
    const gitPath = resolve(root, process.platform === "win32" ? "git.exe" : "git");
    writeFileSync(gitPath, "#!/bin/sh\n");

    expect(resolveGitExecutable({ KEIKO_GIT_EXECUTABLE: gitPath, PATH: "" })).toBe(
      realpathSync(gitPath),
    );
  });

  it("includes git from an absolute PATH entry for non-standard installations", () => {
    const root = mkdtempSync(resolve(tmpdir(), "keiko-dependency-hygiene-path-git-"));
    temporaryRoots.push(root);
    const bin = resolve(root, "nix-store-bin");
    mkdirSync(bin);
    const gitPath = resolve(bin, process.platform === "win32" ? "git.exe" : "git");
    writeFileSync(gitPath, "#!/bin/sh\n");

    expect(gitExecutableCandidates({ PATH: bin, PATHEXT: ".EXE" })).toContain(gitPath);
  });
});
