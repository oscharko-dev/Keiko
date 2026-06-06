import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { checkWorkspacePackageGraph } from "../check-package-graph.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function makeRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeJson(root, relative, value) {
  const absolute = join(root, relative);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writePackage(root, name, dependencyNames = []) {
  writeJson(root, `packages/${name}/package.json`, {
    name: `@oscharko-dev/${name}`,
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
    },
    dependencies: Object.fromEntries(dependencyNames.map((dependencyName) => [dependencyName, "*"])),
  });
  writeJson(root, `packages/${name}/tsconfig.json`, {
    compilerOptions: { rootDir: "src" },
    include: ["src"],
    references: dependencyNames.map((dependencyName) => ({ path: `../${dependencyName.slice("@oscharko-dev/".length)}` })),
  });
}

function writeCleanRoot(root) {
  writeJson(root, "package.json", {
    name: "synthetic-root",
    private: true,
      workspaces: ["packages/*"],
      scripts: {
        "build:packages": "tsc -b tsconfig.packages.json",
        typecheck: "npm run build:packages && npm run check:package-graph && tsc -p tsconfig.json --noEmit",
      },
    });
  writeJson(root, "tsconfig.packages.json", {
    files: [],
    references: [{ path: "./packages/keiko-a" }, { path: "./packages/keiko-b" }],
  });
  writePackage(root, "keiko-a", ["@oscharko-dev/keiko-b"]);
  writePackage(root, "keiko-b");
}

function writeDriftedRoot(root) {
  writeCleanRoot(root);
  writeJson(root, "tsconfig.packages.json", {
    files: [],
    references: [{ path: "./packages/keiko-a" }],
  });
  writeJson(root, "packages/keiko-a/package.json", {
    name: "@oscharko-dev/keiko-a",
    main: "./dist/packages/keiko-a/src/index.js",
    types: "./dist/packages/keiko-a/src/index.d.ts",
    exports: {
      ".": {
        types: "./dist/packages/keiko-a/src/index.d.ts",
        import: "./dist/packages/keiko-a/src/index.js",
      },
    },
    dependencies: {
      "@oscharko-dev/keiko-b": "*",
    },
  });
  writeJson(root, "packages/keiko-a/tsconfig.json", {
    compilerOptions: { rootDir: "../.." },
    include: ["src", "../../src/sdk/**/*.ts"],
    references: [],
  });
}

describe("checkWorkspacePackageGraph", () => {
  let root;

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("passes on the live repository", async () => {
    await expect(checkWorkspacePackageGraph(REPO_ROOT)).resolves.toEqual([]);
  });

  it("detects drift in solution refs, package refs, and dist/packages exports", async () => {
    root = makeRoot("pkg-graph-");
    writeDriftedRoot(root);

    const failures = await checkWorkspacePackageGraph(root);
    expect(failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining("tsconfig.packages.json references"),
        expect.stringContaining("@oscharko-dev/keiko-a: tsconfig references"),
        expect.stringContaining('@oscharko-dev/keiko-a: compilerOptions.rootDir must be "src"'),
        expect.stringContaining("@oscharko-dev/keiko-a: tsconfig include still contains a root-relative path"),
        expect.stringContaining("@oscharko-dev/keiko-a: manifest still points at dist/packages/... output"),
      ]),
    );
  });
});
