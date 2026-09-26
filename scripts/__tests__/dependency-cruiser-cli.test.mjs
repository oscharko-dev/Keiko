import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveDependencyCruiserEntrypoint } from "../lib/dependency-cruiser-cli.mjs";

// #3607: dependency-cruiser renamed its own CLI entry point between 18.2.0 (`bin/dependency-
// cruise.mjs`) and 18.3.0 (`bin/dependency-cruiser.mjs`). These pins prove the resolver reads
// whichever filename the installed package actually declares — on EITHER shape — instead of
// hardcoding one, so the next such rename cannot silently reintroduce the "rule-not-fired" defect.
describe("resolveDependencyCruiserEntrypoint", () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  });

  function fakeRepoRoot() {
    const root = mkdtempSync(join(tmpdir(), "keiko-dependency-cruiser-cli-"));
    roots.push(root);
    return root;
  }

  function writePackageManifest(repoRoot, manifest) {
    const packageDirectory = join(repoRoot, "node_modules", "dependency-cruiser");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify(manifest), "utf8");
    return packageDirectory;
  }

  it("resolves the 18.3.0+ shape (bin/dependency-cruiser.mjs)", () => {
    const repoRoot = fakeRepoRoot();
    const packageDirectory = writePackageManifest(repoRoot, {
      name: "dependency-cruiser",
      version: "18.4.0",
      bin: {
        depcruise: "bin/dependency-cruiser.mjs",
        "dependency-cruise": "bin/dependency-cruiser.mjs",
        "dependency-cruiser": "bin/dependency-cruiser.mjs",
      },
    });

    expect(resolveDependencyCruiserEntrypoint(repoRoot)).toBe(
      join(packageDirectory, "bin/dependency-cruiser.mjs"),
    );
  });

  it("resolves the pre-18.3.0 shape (bin/dependency-cruise.mjs) just as well", () => {
    const repoRoot = fakeRepoRoot();
    const packageDirectory = writePackageManifest(repoRoot, {
      name: "dependency-cruiser",
      version: "18.2.0",
      bin: {
        depcruise: "bin/dependency-cruise.mjs",
        "dependency-cruise": "bin/dependency-cruise.mjs",
        "dependency-cruiser": "bin/dependency-cruise.mjs",
      },
    });

    expect(resolveDependencyCruiserEntrypoint(repoRoot)).toBe(
      join(packageDirectory, "bin/dependency-cruise.mjs"),
    );
  });

  it("resolves a single-string bin field", () => {
    const repoRoot = fakeRepoRoot();
    const packageDirectory = writePackageManifest(repoRoot, {
      name: "dependency-cruiser",
      version: "99.0.0",
      bin: "bin/dependency-cruiser.mjs",
    });

    expect(resolveDependencyCruiserEntrypoint(repoRoot)).toBe(
      join(packageDirectory, "bin/dependency-cruiser.mjs"),
    );
  });

  it("fails closed when the installed package declares no matching bin entry", () => {
    const repoRoot = fakeRepoRoot();
    writePackageManifest(repoRoot, {
      name: "dependency-cruiser",
      version: "0.0.0-future",
      bin: { depcruise: "bin/depcruise.mjs" },
    });

    expect(() => resolveDependencyCruiserEntrypoint(repoRoot)).toThrow(
      /declares no "dependency-cruiser" bin entry/u,
    );
  });

  it("fails closed when the package is not installed", () => {
    const repoRoot = fakeRepoRoot();

    expect(() => resolveDependencyCruiserEntrypoint(repoRoot)).toThrow();
  });
});
