import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createStagedPublishPackage, stagedVendorDirectory } from "../stage-publish-package.mjs";

const roots = [];

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeWorkspace(root, directory, manifest) {
  const packageRoot = join(root, "packages", directory);
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  writeJson(join(packageRoot, "package.json"), manifest);
  writeFileSync(join(packageRoot, "dist", "index.js"), "export {};\n", "utf8");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "keiko-stage-publish-test-"));
  roots.push(root);
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "index.js"), "export {};\n", "utf8");
  writeFileSync(join(root, "README.md"), "fixture\n", "utf8");
  writeJson(join(root, "package.json"), {
    name: "@oscharko-dev/keiko",
    version: "1.2.3",
    files: ["dist", "README.md"],
    dependencies: {
      "@oscharko-dev/keiko-contracts": "1.2.3",
      "@oscharko-dev/keiko-server": "1.2.3",
      ws: "1.0.0",
    },
    bundleDependencies: ["@oscharko-dev/keiko-contracts", "@oscharko-dev/keiko-server"],
  });
  writeJson(join(root, "package-lock.json"), {
    name: "@oscharko-dev/keiko",
    version: "1.2.3",
    lockfileVersion: 3,
    packages: {
      "node_modules/canvas": { version: "1.0.0" },
      "node_modules/smol-toml": { version: "1.0.0" },
      "node_modules/ws": { version: "1.0.0" },
    },
  });
  writeWorkspace(root, "keiko-contracts", {
    name: "@oscharko-dev/keiko-contracts",
    version: "1.2.3",
    private: true,
    type: "module",
    files: ["dist"],
    scripts: { build: "tsc" },
  });
  writeWorkspace(root, "keiko-server", {
    name: "@oscharko-dev/keiko-server",
    version: "1.2.3",
    private: true,
    type: "module",
    files: ["dist"],
    dependencies: {
      "@oscharko-dev/keiko-contracts": "1.2.3",
      "smol-toml": "1.0.0",
      ws: "1.0.0",
    },
    optionalDependencies: { "@oscharko-dev/keiko-contracts": "1.2.3", canvas: "1.0.0" },
    scripts: { build: "tsc" },
  });
  writeWorkspace(root, "keiko-ui", {
    name: "@oscharko-dev/keiko-ui",
    version: "1.2.3",
    private: true,
  });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("staged publish package", () => {
  it("vendors private workspaces through file dependencies and peer edges", () => {
    const root = fixture();
    const staged = createStagedPublishPackage({ repoRoot: root });
    roots.push(staged.packageDir);
    const manifest = JSON.parse(readFileSync(join(staged.packageDir, "package.json"), "utf8"));
    const server = JSON.parse(
      readFileSync(join(staged.packageDir, "vendor", "keiko-server", "package.json"), "utf8"),
    );

    expect(manifest.bundleDependencies).toBeUndefined();
    expect(manifest.files).toContain("vendor");
    expect(manifest.dependencies).toMatchObject({
      "@oscharko-dev/keiko-contracts": "file:vendor/keiko-contracts",
      "@oscharko-dev/keiko-server": "file:vendor/keiko-server",
      "smol-toml": "1.0.0",
      ws: "1.0.0",
    });
    expect(manifest.optionalDependencies).toEqual({ canvas: "1.0.0" });
    expect(server.private).toBe(true);
    expect(server.scripts).toBeUndefined();
    expect(server.dependencies).toEqual({ "smol-toml": "1.0.0", ws: "1.0.0" });
    expect(server.optionalDependencies).toEqual({ canvas: "1.0.0" });
    expect(server.peerDependencies).toEqual({ "@oscharko-dev/keiko-contracts": "1.2.3" });
    expect(server.peerDependenciesMeta).toEqual({
      "@oscharko-dev/keiko-contracts": { optional: true },
    });
    expect(existsSync(join(staged.packageDir, "vendor", "keiko-server", "dist", "index.js"))).toBe(
      true,
    );
    expect(existsSync(join(staged.packageDir, "vendor", "keiko-ui"))).toBe(false);
  });

  it("rejects unsafe workspace package names", () => {
    expect(() => stagedVendorDirectory("foreign-package")).toThrow(/must use/u);
    expect(() => stagedVendorDirectory("@oscharko-dev/../escape")).toThrow(/unsafe/u);
  });

  it("rejects external dependency resolutions that cannot be flattened safely", () => {
    const root = fixture();
    const lockfilePath = join(root, "package-lock.json");
    const lockfile = JSON.parse(readFileSync(lockfilePath, "utf8"));
    lockfile.packages["packages/keiko-server/node_modules/ws"] = { version: "2.0.0" };
    writeJson(lockfilePath, lockfile);

    expect(() => createStagedPublishPackage({ repoRoot: root })).toThrow(
      /resolves ws@2\.0\.0 from 1\.0\.0, which conflicts with the promoted 1\.0\.0/u,
    );
  });
});
