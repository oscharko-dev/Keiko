import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertWorkspacePack,
  createStagedPublishPackage,
  stagedVendorDirectory,
} from "../stage-publish-package.mjs";

const roots = [];

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function updateJson(path, update) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  update(value);
  writeJson(path, value);
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
    peerDependencies: {
      "@oscharko-dev/keiko-contracts": "1.2.3",
      react: "^19.0.0",
      "react-dom": "^19.0.0",
    },
    peerDependenciesMeta: { react: { optional: true } },
    scripts: { build: "tsc" },
  });
  mkdirSync(join(root, "packages", "keiko-server", "assets"), { recursive: true });
  writeFileSync(join(root, "packages", "keiko-server", "assets", "schema.json"), "{}\n", "utf8");
  const serverManifestPath = join(root, "packages", "keiko-server", "package.json");
  const serverManifest = JSON.parse(readFileSync(serverManifestPath, "utf8"));
  serverManifest.files = ["dist", "assets"];
  serverManifest.exports = { ".": "./dist/index.js", "./schema": "./assets/schema.json" };
  writeJson(serverManifestPath, serverManifest);
  const lockfilePath = join(root, "package-lock.json");
  const lockfile = JSON.parse(readFileSync(lockfilePath, "utf8"));
  lockfile.packages["node_modules/react"] = { version: "19.2.7" };
  lockfile.packages["node_modules/react-dom"] = { version: "19.2.7" };
  writeJson(lockfilePath, lockfile);
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
  it("vendors private workspaces through archive dependencies and peer edges", () => {
    const root = fixture();
    const staged = createStagedPublishPackage({ repoRoot: root });
    roots.push(staged.packageDir);
    const manifest = JSON.parse(readFileSync(join(staged.packageDir, "package.json"), "utf8"));
    const serverPackage = staged.vendorPackages.find(
      (vendorPackage) => vendorPackage.name === "@oscharko-dev/keiko-server",
    );
    const server = serverPackage?.manifest;

    expect(manifest.bundleDependencies).toEqual([
      "@oscharko-dev/keiko-contracts",
      "@oscharko-dev/keiko-server",
    ]);
    expect(manifest.files).toContain("vendor");
    expect(manifest.dependencies).toMatchObject({
      "@oscharko-dev/keiko-contracts": "file:vendor/oscharko-dev-keiko-contracts-1.2.3.tgz",
      "@oscharko-dev/keiko-server": "file:vendor/oscharko-dev-keiko-server-1.2.3.tgz",
      "smol-toml": "1.0.0",
      ws: "1.0.0",
      "react-dom": "19.2.7",
    });
    expect(manifest.optionalDependencies).toEqual({ canvas: "1.0.0", react: "19.2.7" });
    expect(server.private).toBe(true);
    expect(server.scripts).toBeUndefined();
    expect(server.dependencies).toEqual({ "smol-toml": "1.0.0", ws: "1.0.0" });
    expect(server.optionalDependencies).toEqual({ canvas: "1.0.0" });
    expect(server.peerDependencies).toEqual({
      "@oscharko-dev/keiko-contracts": "1.2.3",
      react: "^19.0.0",
      "react-dom": "^19.0.0",
    });
    expect(server.peerDependenciesMeta).toEqual({
      "@oscharko-dev/keiko-contracts": { optional: true },
      react: { optional: true },
    });
    expect(serverPackage?.files).toContain("dist/index.js");
    expect(serverPackage?.files).toContain("assets/schema.json");
    expect(existsSync(join(staged.packageDir, serverPackage?.archivePath ?? "missing"))).toBe(true);
    expect(
      existsSync(
        join(
          staged.packageDir,
          "node_modules",
          "@oscharko-dev",
          "keiko-server",
          "dist",
          "index.js",
        ),
      ),
    ).toBe(true);
    expect(staged.vendorPackages.some((entry) => entry.name === "@oscharko-dev/keiko-ui")).toBe(
      false,
    );
    staged.cleanup();
    expect(existsSync(staged.packageDir)).toBe(false);
  });

  it("rejects unsafe workspace package names", () => {
    expect(() => stagedVendorDirectory("foreign-package")).toThrow(/must use/u);
    expect(() => stagedVendorDirectory("@oscharko-dev/../escape")).toThrow(/unsafe/u);
  });

  it("rejects every invalid workspace archive packer outcome", () => {
    const root = fixture();
    const archivePath = join(root, "missing.tgz");
    const record = { manifest: { name: "@oscharko-dev/keiko-contracts" } };

    expect(() =>
      assertWorkspacePack({ error: new Error("spawn failed"), status: null }, record, archivePath),
    ).toThrow(/archive packer could not spawn/u);
    expect(() => assertWorkspacePack({ status: 7 }, record, archivePath)).toThrow(
      /archive packer failed with status 7/u,
    );
    expect(() => assertWorkspacePack({ status: 0 }, record, archivePath)).toThrow(
      /archive packer produced no archive/u,
    );
    writeFileSync(archivePath, "archive\n", "utf8");
    expect(() => assertWorkspacePack({ status: 0 }, record, archivePath)).not.toThrow();
  });

  it("requires an explicit runtime workspace inventory", () => {
    const root = fixture();
    updateJson(join(root, "package.json"), (manifest) => {
      delete manifest.bundleDependencies;
    });

    expect(() => createStagedPublishPackage({ repoRoot: root })).toThrow(
      /must declare the runtime workspace bundle list/u,
    );
  });

  it("ignores non-package directories while discovering workspaces", () => {
    const root = fixture();
    mkdirSync(join(root, "packages", "notes"));

    const staged = createStagedPublishPackage({ repoRoot: root });
    roots.push(staged.packageDir);
    expect(staged.vendorPackages).toHaveLength(2);
  });

  it("rejects missing root publish files and ignores a predeclared vendor directory", () => {
    const root = fixture();
    updateJson(join(root, "package.json"), (manifest) => {
      manifest.files = ["vendor", "missing.txt"];
    });

    expect(() => createStagedPublishPackage({ repoRoot: root })).toThrow(
      /root publish file is missing or unsafe/u,
    );
  });

  it.each([
    ["dependencies", null],
    ["optionalDependencies", []],
    ["peerDependencies", "react"],
  ])("rejects a non-object %s manifest field", (field, value) => {
    const root = fixture();
    updateJson(join(root, "packages", "keiko-server", "package.json"), (manifest) => {
      manifest[field] = value;
    });

    expect(() => createStagedPublishPackage({ repoRoot: root })).toThrow(
      new RegExp(`keiko-server\\.${field} must be an object`, "u"),
    );
  });

  it("rejects internal workspace dependencies outside the runtime inventory", () => {
    const root = fixture();
    updateJson(join(root, "packages", "keiko-server", "package.json"), (manifest) => {
      manifest.dependencies["@oscharko-dev/keiko-ui"] = "1.2.3";
    });

    expect(() => createStagedPublishPackage({ repoRoot: root })).toThrow(
      /keiko-ui is not a vendored runtime workspace/u,
    );
  });

  it("collects string and object bin targets while ignoring non-path exports", () => {
    const root = fixture();
    const contractsRoot = join(root, "packages", "keiko-contracts");
    const serverRoot = join(root, "packages", "keiko-server");
    writeFileSync(join(contractsRoot, "cli.js"), "#!/usr/bin/env node\n", "utf8");
    writeFileSync(join(serverRoot, "server.js"), "#!/usr/bin/env node\n", "utf8");
    updateJson(join(contractsRoot, "package.json"), (manifest) => {
      manifest.bin = "./cli.js";
      manifest.exports = {
        ".": { default: "./dist/index.js", browser: false },
        external: "react",
      };
    });
    updateJson(join(serverRoot, "package.json"), (manifest) => {
      manifest.bin = { keikoServer: "./server.js" };
    });

    const staged = createStagedPublishPackage({ repoRoot: root });
    roots.push(staged.packageDir);
    const contracts = staged.vendorPackages.find(
      (entry) => entry.name === "@oscharko-dev/keiko-contracts",
    );
    const server = staged.vendorPackages.find(
      (entry) => entry.name === "@oscharko-dev/keiko-server",
    );
    expect(contracts?.files).toContain("cli.js");
    expect(server?.files).toContain("server.js");
  });

  it("supports a root manifest without publish files", () => {
    const root = fixture();
    updateJson(join(root, "package.json"), (manifest) => {
      delete manifest.files;
    });

    const staged = createStagedPublishPackage({ repoRoot: root });
    roots.push(staged.packageDir);
    const manifest = JSON.parse(readFileSync(join(staged.packageDir, "package.json"), "utf8"));
    expect(manifest.files).toEqual(["vendor"]);
  });

  it("rejects unsafe workspace archive versions", () => {
    const root = fixture();
    updateJson(join(root, "packages", "keiko-contracts", "package.json"), (manifest) => {
      manifest.version = "1.2.3/escape";
    });

    expect(() => createStagedPublishPackage({ repoRoot: root })).toThrow(
      /has an unsafe archive version/u,
    );
  });

  it("rejects a runtime inventory entry without a workspace package", () => {
    const root = fixture();
    updateJson(join(root, "package.json"), (manifest) => {
      manifest.bundleDependencies.push("@oscharko-dev/keiko-missing");
    });

    expect(() => createStagedPublishPackage({ repoRoot: root })).toThrow(
      /keiko-missing does not map to a workspace package/u,
    );
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

  it("rejects a required range that conflicts with the promoted optional version", () => {
    const root = fixture();
    updateJson(join(root, "package.json"), (manifest) => {
      manifest.dependencies.canvas = "^1.0.0";
    });

    expect(() => createStagedPublishPackage({ repoRoot: root })).toThrow(
      /required canvas@\^1\.0\.0 conflicts with promoted optional 1\.0\.0/u,
    );
  });

  it("rejects a runtime workspace without built output", () => {
    const root = fixture();
    rmSync(join(root, "packages", "keiko-server", "dist"), { recursive: true, force: true });

    expect(() => createStagedPublishPackage({ repoRoot: root })).toThrow(
      /keiko-server has no built dist directory/u,
    );
  });

  it.each([undefined, []])("rejects a runtime workspace without bounded files: %j", (files) => {
    const root = fixture();
    const manifestPath = join(root, "packages", "keiko-contracts", "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (files === undefined) delete manifest.files;
    else manifest.files = files;
    writeJson(manifestPath, manifest);

    expect(() => createStagedPublishPackage({ repoRoot: root })).toThrow(
      /must declare a bounded publish surface/u,
    );
  });

  it.each([
    ["/etc/passwd", /declares an invalid publish path/u],
    ["../../secrets", /unsafe or unsupported publish path/u],
    ["dist/*.js", /unsafe or unsupported publish path/u],
  ])("rejects the hostile publish path %s", (hostile, expected) => {
    const root = fixture();
    const manifestPath = join(root, "packages", "keiko-contracts", "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files = ["dist", hostile];
    writeJson(manifestPath, manifest);

    expect(() => createStagedPublishPackage({ repoRoot: root })).toThrow(expected);
  });

  it("rejects an export target that is absent from the workspace", () => {
    const root = fixture();
    const manifestPath = join(root, "packages", "keiko-server", "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.exports["./missing"] = "./assets/absent.json";
    writeJson(manifestPath, manifest);

    expect(() => createStagedPublishPackage({ repoRoot: root })).toThrow(
      /publish path is missing or unsafe/u,
    );
  });

  it("rejects symlinks in a workspace publish surface", () => {
    const root = fixture();
    symlinkSync("index.js", join(root, "packages", "keiko-contracts", "dist", "linked.js"));

    expect(() => createStagedPublishPackage({ repoRoot: root })).toThrow(
      /publish path contains a symlink/u,
    );
  });

  it("creates byte-reproducible vendored workspace archives", () => {
    const root = fixture();
    const first = createStagedPublishPackage({ repoRoot: root });
    roots.push(first.packageDir);
    const second = createStagedPublishPackage({ repoRoot: root });
    roots.push(second.packageDir);
    const hashes = (staged) =>
      staged.vendorPackages.map(({ archivePath }) =>
        createHash("sha256")
          .update(readFileSync(join(staged.packageDir, archivePath)))
          .digest("hex"),
      );

    expect(hashes(first)).toEqual(hashes(second));
  });

  it("rejects a build-time-only workspace in the runtime inventory", () => {
    const root = fixture();
    const manifestPath = join(root, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.bundleDependencies.push("@oscharko-dev/keiko-ui");
    manifest.dependencies["@oscharko-dev/keiko-ui"] = "1.2.3";
    writeJson(manifestPath, manifest);

    expect(() => createStagedPublishPackage({ repoRoot: root })).toThrow(
      /keiko-ui is build-time-only and cannot be vendored/u,
    );
  });

  it("rejects an external dependency without a lockfile resolution", () => {
    const root = fixture();
    const lockfilePath = join(root, "package-lock.json");
    const lockfile = JSON.parse(readFileSync(lockfilePath, "utf8"));
    delete lockfile.packages["node_modules/smol-toml"];
    writeJson(lockfilePath, lockfile);

    expect(() => createStagedPublishPackage({ repoRoot: root })).toThrow(
      /smol-toml has no resolved runtime version in package-lock\.json/u,
    );
  });
});
