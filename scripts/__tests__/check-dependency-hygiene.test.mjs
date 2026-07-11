import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { findTrackedNextBuildPaths } from "../check-dependency-hygiene.mjs";

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

  it("fails closed with a fixed diagnostic outside a Git repository", () => {
    const root = makeRepository();
    rmSync(resolve(root, ".git"), { recursive: true, force: true });

    const result = spawnSync(process.execPath, [gatePath, `--root=${root}`], {
      encoding: "utf8",
    });
    const diagnostic = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(diagnostic).toContain("Git index inspection did not complete successfully");
    expect(diagnostic).not.toContain("fatal:");
  });
});
