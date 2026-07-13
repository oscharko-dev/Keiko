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
