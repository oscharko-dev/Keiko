import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { StandaloneBuildError } from "../build-standalone-package.mjs";
import {
  assertLockfile,
  buildNpmPackage,
  isolatedNpmEnv,
  lockfileResolutionArgs,
  packageJsonText,
  resolveLockfile,
} from "../build-standalone-npm-package.mjs";
import { locateNpmCli } from "./support/host-npm-cli.mjs";
import { sha256File } from "../lib/digest.mjs";
import {
  extractZipArchiveEntries,
  readZipArchiveEntries,
  writeZipArchiveEntries,
} from "../lib/zip-archive.mjs";
import { portableUsearchBinaryPath } from "../../packages/keiko-local-knowledge/src/retrieval/usearch-runtime-manifest.ts";

// An npm package carries the release's Node.js runtime, a pinned lockfile and start files; Keiko
// itself arrives from the npm registry at the first start (ADR-0121 D9). These tests build real
// packages from small real archives; the lockfile resolution, which needs the registry, is replaced
// by a writer that produces the lockfile npm would.

const EXECUTABLE = 0o100755;
const REGULAR = 0o100644;
const REGISTRY = "https://registry.npmjs.org/";
const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "keiko-npm-package-"));
  tempRoots.push(root);
  return root;
}

function setupManifest(target) {
  return `${JSON.stringify({
    schemaVersion: 1,
    platformTarget: target,
    packageName: "@oscharko-dev/keiko",
    packageVersion: "1.2.3",
    stable: true,
  })}\n`;
}

// The verified USearch addon and its license, as the portable payload carries them.
function retrievalRecords(resources) {
  return [
    { name: `${resources}/runtime/native/usearch.node`, data: "usearch", mode: EXECUTABLE },
    { name: `${resources}/runtime/licenses/usearch/LICENSE`, data: "usearch license" },
  ];
}

function payloadRecords(target, { withNpm = true, withRetrieval = true } = {}) {
  if (target === "windows-x64") {
    return [
      { name: "Keiko/Keiko.exe", data: "launcher", mode: REGULAR },
      { name: "Keiko/.portable/setup-manifest.json", data: setupManifest(target) },
      { name: "Keiko/app/dist/cli/index.js", data: "cli" },
      { name: "Keiko/runtime/node/node.exe", data: "node" },
      ...(withNpm
        ? [{ name: "Keiko/runtime/node/node_modules/npm/bin/npm-cli.js", data: "npm" }]
        : []),
      ...(withRetrieval ? retrievalRecords("Keiko") : []),
    ];
  }
  const resources = "Keiko/Keiko.app/Contents/Resources";
  return [
    { name: "Keiko/Keiko.app/Contents/MacOS/Keiko", data: "launcher", mode: EXECUTABLE },
    { name: `${resources}/.portable/setup-manifest.json`, data: setupManifest(target) },
    { name: `${resources}/app/dist/cli/index.js`, data: "cli" },
    { name: `${resources}/runtime/node/bin/node`, data: "node", mode: EXECUTABLE },
    ...(withNpm
      ? [{ name: `${resources}/runtime/node/lib/node_modules/npm/bin/npm-cli.js`, data: "npm" }]
      : []),
    ...(withRetrieval ? retrievalRecords(resources) : []),
  ];
}

const RUNTIME_ARM64 = "@oscharko-dev/keiko-coding-runtime-darwin-arm64";
const RUNTIME_X64 = "@oscharko-dev/keiko-coding-runtime-darwin-x64";
const RUNTIME_WIN32 = "@oscharko-dev/keiko-coding-runtime-win32-x64";
const RUNTIME_VERSION = "1.1.5";
const RUNTIME_WIN32_VERSION = "1.1.7";

function runtimeEntry(name, version = RUNTIME_VERSION) {
  return {
    version,
    resolved: `${REGISTRY}${name}/-/${name.split("/").at(-1)}-${version}.tgz`,
    integrity: "sha512-runtime",
    optional: true,
  };
}

function lockfile(version = "1.2.3", extraPackages = {}) {
  return {
    name: "keiko-npm-package",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "keiko-npm-package", dependencies: { "@oscharko-dev/keiko": version } },
      "node_modules/@oscharko-dev/keiko": {
        version,
        resolved: `${REGISTRY}@oscharko-dev/keiko/-/keiko-${version}.tgz`,
        integrity: "sha512-keiko",
        optionalDependencies: {
          [RUNTIME_ARM64]: RUNTIME_VERSION,
          [RUNTIME_X64]: RUNTIME_VERSION,
          [RUNTIME_WIN32]: RUNTIME_WIN32_VERSION,
        },
      },
      [`node_modules/${RUNTIME_ARM64}`]: runtimeEntry(RUNTIME_ARM64),
      [`node_modules/${RUNTIME_X64}`]: runtimeEntry(RUNTIME_X64),
      [`node_modules/${RUNTIME_WIN32}`]: runtimeEntry(RUNTIME_WIN32, RUNTIME_WIN32_VERSION),
      "node_modules/@oscharko-dev/keiko/node_modules/vendored": {
        version: "1.0.0",
        inBundle: true,
      },
      ...extraPackages,
    },
  };
}

function writeLockfile(lock = lockfile()) {
  return (packageRoot) => {
    writeFileSync(join(packageRoot, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  };
}

function build(target, overrides = {}) {
  const root = tempRoot();
  const archive = join(root, `keiko-${target}.zip`);
  writeZipArchiveEntries(archive, overrides.records ?? payloadRecords(target));
  const outDir = join(root, "out");
  const result = buildNpmPackage({
    target,
    archive,
    sha256: overrides.sha256 ?? sha256File(archive),
    outDir,
    keepFolder: false,
    createLockfile: overrides.createLockfile ?? writeLockfile(),
    ...overrides.options,
  });
  return { root, archive, outDir, result };
}

function entriesByName(archivePath) {
  return new Map(
    readZipArchiveEntries(archivePath).map((entry) => [entry.name, entry.data.toString("utf8")]),
  );
}

describe("an npm package", () => {
  it("carries the release's Node.js runtime with npm, the pinned version and the start files", () => {
    const { archive, result } = build("macos-arm64");
    const built = entriesByName(result.outputPath);

    expect([...built.keys()].sort()).toEqual([
      "Keiko/LIESMICH.txt",
      "Keiko/README.txt",
      "Keiko/Start Keiko.command",
      "Keiko/Stop Keiko.command",
      "Keiko/package-lock.json",
      "Keiko/package.json",
      "Keiko/system/Zugang speichern.command",
      "Keiko/system/keiko-npm.mjs",
      "Keiko/system/licenses/usearch/LICENSE",
      "Keiko/system/native/usearch.node",
      "Keiko/system/node/bin/node",
      "Keiko/system/node/lib/node_modules/npm/bin/npm-cli.js",
      "Keiko/system/npm-package.json",
    ]);
    expect(JSON.parse(built.get("Keiko/package.json"))).toMatchObject({
      private: true,
      dependencies: { "@oscharko-dev/keiko": "1.2.3" },
    });
    expect(built.get("Keiko/Start Keiko.command")).toContain('script="$here/system/keiko-npm.mjs"');
    expect(built.get("Keiko/Start Keiko.command")).toContain('"$node" "$script" start');
    expect(JSON.parse(built.get("Keiko/system/npm-package.json"))).toEqual({
      schemaVersion: 1,
      kind: "keiko-npm-package",
      platformTarget: "macos-arm64",
      packageVersion: "1.2.3",
      sourceArchive: { name: "keiko-macos-arm64.zip", sha256: sha256File(archive) },
      lockfileSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      provisionedConfig: false,
    });
    expect(result.outputPath.endsWith("keiko-macos-arm64.npm.zip")).toBe(true);
  });

  // What Node.js and npm do not run is left out; what they run stays byte for byte. The standalone
  // folder package keeps the payload unchanged and is built elsewhere.
  describe.each([
    {
      target: "macos-arm64",
      root: "Keiko/Keiko.app/Contents/Resources/runtime/node",
      kept: [
        "bin/node",
        "bin/npm",
        "lib/node_modules/npm/bin/npm-cli.js",
        "lib/node_modules/corepack/dist/corepack.js",
        "LICENSE",
        "NOTICE",
        "NODE_RUNTIME_SOURCE.json",
      ],
      dropped: [
        "include/node/node.h",
        "include/node/v8.h",
        "share/man/man1/node.1",
        "share/doc/node/gdbinit",
        "CHANGELOG.md",
        "README.md",
      ],
      shipped: "Keiko/system/node",
    },
    {
      target: "windows-x64",
      root: "Keiko/runtime/node",
      kept: [
        "node.exe",
        "npm",
        "npm.cmd",
        "npx",
        "npx.cmd",
        "node_modules/npm/bin/npm-cli.js",
        "node_modules/corepack/dist/corepack.js",
        "corepack.cmd",
        "LICENSE",
      ],
      dropped: ["include/node/node.h", "share/doc/node/gdbinit", "CHANGELOG.md", "README.md"],
      shipped: "Keiko/system/node",
    },
  ])("the Node.js runtime of the $target package", ({ target, root, kept, dropped, shipped }) => {
    it("keeps exactly what runs and leaves out headers, documentation and release notes", () => {
      const runtime = [...kept, ...dropped].map((name) => ({
        name: `${root}/${name}`,
        data: `bytes of ${name}`,
      }));
      const { result } = build(target, {
        records: [
          ...payloadRecords(target).filter((record) => !record.name.includes("/runtime/node/")),
          ...runtime,
        ],
      });
      const built = entriesByName(result.outputPath);

      for (const name of kept) expect(built.get(`${shipped}/${name}`)).toBe(`bytes of ${name}`);
      for (const name of dropped) expect(built.has(`${shipped}/${name}`)).toBe(false);
      expect([...built.keys()].some((name) => /\/(include|share)\//u.test(name))).toBe(false);
    });
  });

  it("keeps the start files, the access step and Node.js executable after extraction", () => {
    const { root, result } = build("macos-arm64");
    const extracted = join(root, "extracted");
    extractZipArchiveEntries(result.outputPath, extracted);

    const executable = (path) => (statSync(join(extracted, "Keiko", path)).mode & 0o111) !== 0;
    expect(executable("Start Keiko.command")).toBe(true);
    expect(executable("Stop Keiko.command")).toBe(true);
    expect(executable("system/Zugang speichern.command")).toBe(true);
    expect(executable("system/node/bin/node")).toBe(true);
    expect(executable("README.txt")).toBe(false);
  });

  it("writes the Windows start files with CRLF and without parenthesized blocks", () => {
    const { result } = build("windows-x64");
    const built = entriesByName(result.outputPath);

    expect(built.has("Keiko/system/node/node_modules/npm/bin/npm-cli.js")).toBe(true);
    for (const name of ["Start Keiko.cmd", "Stop Keiko.cmd", "system/Zugang speichern.cmd"]) {
      const text = built.get(`Keiko/${name}`);
      expect(text.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/u);
      // A folder named "Keiko (1)" would end a parenthesized block early.
      expect(text.replaceAll(/^rem .*$/gmu, "")).not.toMatch(/[()]/u);
    }
    expect(built.get("Keiko/system/keiko-npm.mjs")).not.toContain("\r");
  });

  it("builds from an archive whose discarded application entry is too long for Windows (PR #4464)", () => {
    // Review finding on PR #4464: the npm form inherited the standalone path-length check on every
    // source entry, so a valid package was refused because of an application entry it never ships.
    const deep = `Keiko/app/${"segment/".repeat(24)}file.js`;
    const { result } = build("windows-x64", {
      records: [...payloadRecords("windows-x64"), { name: deep, data: "x" }],
    });
    const built = entriesByName(result.outputPath);

    expect(built.has("Keiko/system/node/node.exe")).toBe(true);
    expect([...built.keys()].some((name) => name.includes("segment/"))).toBe(false);
  });

  it("still refuses a Windows npm package whose shipped entry is too long (PR #4464)", () => {
    const deep = `Keiko/runtime/node/node_modules/${"segment/".repeat(24)}file.js`;

    expect(() =>
      build("windows-x64", {
        records: [...payloadRecords("windows-x64"), { name: deep, data: "x" }],
      }),
    ).toThrow("Windows needs 180 or fewer");
  });

  it("names a package with credentials as a team package and keeps its config private", () => {
    const root = tempRoot();
    const config = join(root, "keiko.config.json");
    writeFileSync(
      config,
      JSON.stringify({ providers: [{ modelId: "m", baseUrl: "https://gw.example", apiKey: "k" }] }),
    );
    const { result } = build("windows-x64", { options: { config } });
    const extracted = join(root, "extracted");
    extractZipArchiveEntries(result.outputPath, extracted);

    expect(result.outputPath.endsWith("keiko-windows-x64.npm-team.zip")).toBe(true);
    expect(result.provisioned).toBe(true);
    expect(statSync(join(extracted, "Keiko", "keiko.config.json")).mode & 0o777).toBe(0o600);
  });

  it.each([
    ["macos-arm64", ["system", "node", "bin", "node"], "darwin"],
    ["windows-x64", ["system", "node", "node.exe"], "win32"],
  ])(
    "keeps the release's retrieval addon on %s where Keiko looks for it beside Node.js",
    (target, node, platform) => {
      const { root, result } = build(target);
      const extracted = join(root, "extracted");
      extractZipArchiveEntries(result.outputPath, extracted);
      const folder = join(extracted, "Keiko");

      // The same function Keiko's retrieval resolves the addon with, from the package's Node.js.
      const addon = portableUsearchBinaryPath(join(folder, ...node), platform);
      expect(addon).toBe(join(folder, "system", "native", "usearch.node"));
      expect(readFileSync(addon, "utf8")).toBe("usearch");
      expect(readFileSync(join(folder, "system", "licenses", "usearch", "LICENSE"), "utf8")).toBe(
        "usearch license",
      );
    },
  );

  it("refuses an archive that carries no retrieval addon", () => {
    expect(() =>
      build("windows-x64", { records: payloadRecords("windows-x64", { withRetrieval: false }) }),
    ).toThrow(/carries no runtime\/native\/usearch\.node/u);
  });

  it("refuses an archive whose Node.js runtime carries no npm", () => {
    expect(() =>
      build("macos-arm64", { records: payloadRecords("macos-arm64", { withNpm: false }) }),
    ).toThrow(/carries no npm/u);
  });

  it("refuses an archive that does not match its checksum", () => {
    expect(() => build("windows-x64", { sha256: "0".repeat(64) })).toThrow(StandaloneBuildError);
  });

  it("refuses a resolution that wrote no lockfile and leaves no work folder behind", () => {
    const root = tempRoot();
    const archive = join(root, "keiko-windows-x64.zip");
    writeZipArchiveEntries(archive, payloadRecords("windows-x64"));
    const outDir = join(root, "out");

    expect(() =>
      buildNpmPackage({
        target: "windows-x64",
        archive,
        sha256: sha256File(archive),
        outDir,
        createLockfile: () => undefined,
      }),
    ).toThrow(/no package-lock.json/u);
    expect(readdirSync(outDir)).toEqual([]);
  });

  it("keeps the assembled folder on request", () => {
    const { result } = build("macos-arm64", { options: { keepFolder: true } });

    expect(result.folder.endsWith(join("keiko-macos-arm64-npm", "Keiko"))).toBe(true);
    expect(existsSync(join(result.folder, "system", "node", "bin", "node"))).toBe(true);
    expect(readFileSync(join(result.folder, "package.json"), "utf8")).toBe(
      packageJsonText("1.2.3"),
    );
  });
});

describe("the lockfile an npm package ships", () => {
  const text = (lock) => JSON.stringify(lock);

  it("accepts registry packages with sha512 integrity and bundled packages", () => {
    expect(() => {
      assertLockfile(text(lockfile()), "1.2.3");
    }).not.toThrow();
  });

  it("must install exactly the package's Keiko version", () => {
    expect(() => {
      assertLockfile(text(lockfile("1.2.4")), "1.2.3");
    }).toThrow(/does not install @oscharko-dev\/keiko 1.2.3/u);
  });

  it.each([
    ["no integrity", { version: "1.0.0", resolved: `${REGISTRY}a/-/a-1.0.0.tgz` }, /no sha512/u],
    [
      "a weak integrity",
      { version: "1.0.0", resolved: `${REGISTRY}a/-/a-1.0.0.tgz`, integrity: "sha1-x" },
      /no sha512/u,
    ],
    [
      "another registry",
      { version: "1.0.0", resolved: "https://mirror.example/a-1.0.0.tgz", integrity: "sha512-x" },
      /public registry/u,
    ],
    ["a link", { link: true, resolved: "../a" }, /is a link/u],
  ])("refuses a package with %s", (_case, entry, message) => {
    expect(() => {
      assertLockfile(text(lockfile("1.2.3", { "node_modules/a": entry })), "1.2.3");
    }).toThrow(message);
  });

  it.each([
    ["macos-arm64", RUNTIME_ARM64],
    ["macos-x64", RUNTIME_X64],
    ["windows-x64", RUNTIME_WIN32],
  ])("refuses a %s lockfile without its Coding runtime package (PR #4464)", (target, name) => {
    // npm can leave an unresolvable optional package out of the lock and still exit 0.
    const lock = lockfile();
    lock.packages = Object.fromEntries(
      Object.entries(lock.packages).filter(([key]) => key !== `node_modules/${name}`),
    );
    expect(() => {
      assertLockfile(text(lock), "1.2.3", target);
    }).toThrow(/does not lock .*keiko-coding-runtime/u);
    // A complete lockfile is the positive control.
    expect(() => {
      assertLockfile(text(lockfile()), "1.2.3", target);
    }).not.toThrow();
  });

  it("refuses a Coding runtime locked at another version than Keiko declares (PR #4464)", () => {
    const lock = lockfile("1.2.3", {
      [`node_modules/${RUNTIME_ARM64}`]: runtimeEntry(RUNTIME_ARM64, "1.1.4"),
    });
    expect(() => {
      assertLockfile(text(lock), "1.2.3", "macos-arm64");
    }).toThrow(/does not lock .*1\.1\.5/u);
    const undeclared = lockfile();
    delete undeclared.packages["node_modules/@oscharko-dev/keiko"].optionalDependencies;
    expect(() => {
      assertLockfile(text(undeclared), "1.2.3", "macos-arm64");
    }).toThrow(/declares no/u);
  });

  it("refuses text that is not a lockfile", () => {
    expect(() => {
      assertLockfile("{", "1.2.3");
    }).toThrow(/not valid JSON/u);
    expect(() => {
      assertLockfile("{}", "1.2.3");
    }).toThrow(/names no packages/u);
  });
});

describe("the npm of the build", () => {
  it("sees no npm configuration of the environment it runs in", () => {
    expect(
      isolatedNpmEnv({ PATH: "/bin", npm_config_registry: "x", NPM_CONFIG_USERCONFIG: "y" }),
    ).toEqual({ PATH: "/bin" });
  });

  it("resolves against the public registry with empty configurations and no install script", () => {
    const args = lockfileResolutionArgs("/n/npm-cli.js", "/p/Keiko", "/i/user", "/i/global");
    const value = (flag) => args[args.indexOf(flag) + 1];

    expect(args.slice(0, 2)).toEqual(["/n/npm-cli.js", "install"]);
    expect(value("--prefix")).toBe("/p/Keiko");
    expect(args).toContain("--workspaces=false");
    expect(args).toContain("--package-lock-only");
    expect(args).toContain("--ignore-scripts");
    expect(value("--registry")).toBe(REGISTRY);
    expect(value("--userconfig")).toBe("/i/user");
    expect(value("--globalconfig")).toBe("/i/global");
  });

  it("writes the lockfile into the package, not into an npm workspace around it", () => {
    // Review finding on PR #4464 (P2): from a work folder inside an npm workspace, npm wrote the
    // workspace's lockfile and left the package without one.
    const npmCli = locateNpmCli();
    const workspace = tempRoot();
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({ name: "enclosing", private: true, workspaces: ["work/*"] }),
    );
    const packageRoot = join(workspace, "work", "Keiko");
    mkdirSync(packageRoot, { recursive: true });
    // No dependency, so npm needs no registry to write the lockfile.
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "keiko-folder", version: "1.0.0", private: true }),
    );

    resolveLockfile(packageRoot, npmCli);

    expect(existsSync(join(packageRoot, "package-lock.json"))).toBe(true);
    expect(existsSync(join(workspace, "package-lock.json"))).toBe(false);
    expect(existsSync(join(workspace, "node_modules"))).toBe(false);
  });
});
