import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { planCleanTargets } from "../clean.mjs";
import { collectWorkspacePackages } from "../workspace-graph.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function makeRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeJson(root, relative, value) {
  const absolute = join(root, relative);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("collectWorkspacePackages", () => {
  let root;
  let outside;

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
    if (outside) {
      rmSync(outside, { recursive: true, force: true });
      outside = undefined;
    }
  });

  it("ignores symlinked workspace entries when discovering packages", async () => {
    root = makeRoot("build-graph-");
    outside = makeRoot("build-graph-outside-");
    writeJson(root, "package.json", {
      name: "synthetic-root",
      private: true,
      workspaces: ["packages/*"],
    });
    writeJson(root, "packages/contracts/package.json", {
      name: "@test/contracts",
      scripts: { build: "echo contracts" },
    });
    writeJson(outside, "package.json", {
      name: "@test/outside",
      scripts: { build: "echo outside" },
    });
    symlinkSync(outside, join(root, "packages", "outside"), "dir");

    const packages = await collectWorkspacePackages(root);
    expect(packages.map((pkg) => pkg.name)).toEqual(["@test/contracts"]);
  });
});

describe("planCleanTargets", () => {
  let root;
  let outside;

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
    if (outside) {
      rmSync(outside, { recursive: true, force: true });
      outside = undefined;
    }
  });

  it("ignores symlinked workspace entries so clean targets stay inside the repo", async () => {
    root = makeRoot("clean-root-");
    outside = makeRoot("clean-outside-");
    writeJson(root, "package.json", {
      name: "synthetic-root",
      private: true,
      workspaces: ["packages/*"],
    });
    writeJson(root, "packages/keiko-contracts/package.json", {
      name: "@test/contracts",
      scripts: { build: "echo contracts" },
    });
    writeJson(outside, "package.json", {
      name: "@test/escape",
      scripts: { build: "echo escape" },
    });
    mkdirSync(join(root, "packages"), { recursive: true });
    symlinkSync(outside, join(root, "packages", "keiko-escape"), "dir");

    const targets = await planCleanTargets(root);
    expect(targets).toContain(join(root, "packages", "keiko-contracts", "dist"));
    expect(targets).not.toContain(join(root, "packages", "keiko-escape", "dist"));
  });

  it("covers every live workspace package except UI with package clean targets", async () => {
    const packages = await collectWorkspacePackages(REPO_ROOT);
    const cleanTargets = await planCleanTargets(REPO_ROOT);

    for (const pkg of packages) {
      if (pkg.name === "@oscharko-dev/keiko-ui") {
        expect(cleanTargets).toContain(join(pkg.dir, ".next"));
        expect(cleanTargets).toContain(join(pkg.dir, "out"));
        continue;
      }
      expect(cleanTargets).toContain(join(pkg.dir, "dist"));
    }
  });
});
