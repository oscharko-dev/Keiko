import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  STANDALONE_TARGETS,
  StandaloneBuildError,
  buildStandalonePackage,
} from "../build-standalone-package.mjs";
import { sha256File } from "../lib/digest.mjs";
import {
  extractZipArchiveEntries,
  readZipArchiveEntries,
  writeZipArchiveEntries,
} from "../lib/zip-archive.mjs";

// The nested layout carries the verified release archive itself as Keiko.zip beside the payload's
// own Node.js, a package.json/package-lock.json/.npmrc that pin it, a README and start/stop files
// (ADR-0121 D9). These tests build real packages from small real archives and read them back; on
// Windows they also run the real start and stop files.

const EXECUTABLE = 0o100755;
const NODE_SOURCE = {
  fileName: "node-v26.13.1-win-x64.zip",
  nodeVersion: "26.13.1",
  sha256: "a".repeat(64),
  source: "https://nodejs.org/dist/v26.13.1/",
  target: "win-x64",
};
const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "keiko-standalone-nested-"));
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

function payloadRecords(target, { cli = "cli", nodeSource = NODE_SOURCE } = {}) {
  const windows = target === "windows-x64";
  const resources = windows ? "Keiko" : "Keiko/Keiko.app/Contents/Resources";
  const node = windows
    ? [{ name: "Keiko/runtime/node/node.exe", data: "node" }]
    : [{ name: `${resources}/runtime/node/bin/node`, data: "node", mode: EXECUTABLE }];
  const records = [
    { name: `${resources}/.portable/setup-manifest.json`, data: setupManifest(target) },
    { name: `${resources}/app/dist/cli/index.js`, data: cli },
    { name: `${resources}/runtime/node/LICENSE`, data: "node licence" },
    ...node,
  ];
  if (nodeSource !== null) {
    records.push({
      name: `${resources}/runtime/node/NODE_RUNTIME_SOURCE.json`,
      data: `${JSON.stringify(nodeSource)}\n`,
    });
  }
  return records;
}

function build(target, { records = payloadRecords(target), options = {} } = {}) {
  const root = tempRoot();
  const archive = join(root, `keiko-${target}.zip`);
  writeZipArchiveEntries(archive, records);
  const result = buildStandalonePackage({
    target,
    archive,
    sha256: sha256File(archive),
    outDir: join(root, "out"),
    layout: "nested",
    keepFolder: false,
    ...options,
  });
  return { root, archive, result };
}

function entriesByName(archivePath) {
  return new Map(readZipArchiveEntries(archivePath).map((entry) => [entry.name, entry.data]));
}

function text(entries, name) {
  return entries.get(name).toString("utf8");
}

describe("a nested standalone package", () => {
  it.each(Object.keys(STANDALONE_TARGETS))(
    "holds node, Keiko.zip, the npm files, a README and start/stop for %s",
    (target) => {
      const { result } = build(target);
      const layout = STANDALONE_TARGETS[target];
      const names = [...entriesByName(result.outputPath).keys()]
        .filter((name) => !name.startsWith("Keiko/node/"))
        .sort();

      expect(result.outputPath.endsWith(`keiko-${target}-standalone-nested.zip`)).toBe(true);
      expect(names).toEqual(
        [
          "Keiko/.npmrc",
          "Keiko/Keiko.zip",
          "Keiko/Keiko.zip.sha256",
          "Keiko/README.md",
          "Keiko/package-lock.json",
          "Keiko/package.json",
          `Keiko/${layout.nestedStartName}`,
          `Keiko/${layout.nestedStopName}`,
        ].sort(),
      );
    },
  );

  it("carries the release archive byte for byte with its checksum", () => {
    const { archive, result } = build("windows-x64");
    const built = entriesByName(result.outputPath);

    expect(built.get("Keiko/Keiko.zip").equals(readFileSync(archive))).toBe(true);
    expect(text(built, "Keiko/Keiko.zip.sha256")).toBe(`${sha256File(archive)}  Keiko.zip\n`);
  });

  it("copies the payload's own Node.js runtime with its licence and source record", () => {
    const built = entriesByName(build("windows-x64").result.outputPath);

    expect(text(built, "Keiko/node/node.exe")).toBe("node");
    expect(text(built, "Keiko/node/LICENSE")).toBe("node licence");
    expect(JSON.parse(text(built, "Keiko/node/NODE_RUNTIME_SOURCE.json"))).toEqual(NODE_SOURCE);
  });

  // Windows has no file permissions to carry: the macOS package is built on macOS or Linux.
  it.skipIf(process.platform === "win32")(
    "keeps the macOS Node.js and the start and stop files executable",
    () => {
      const { root, result } = build("macos-arm64");
      const extracted = join(root, "extracted");
      extractZipArchiveEntries(result.outputPath, extracted);
      const executable = (path) => (statSync(join(extracted, "Keiko", path)).mode & 0o111) !== 0;

      expect(executable("node/bin/node")).toBe(true);
      expect(executable("start.sh")).toBe(true);
      expect(executable("stop.sh")).toBe(true);
      expect(executable("README.md")).toBe(false);
      expect(executable("Keiko.zip")).toBe(false);
    },
  );

  it("pins the Keiko and Node.js versions in package.json and package-lock.json", () => {
    const { archive, result } = build("windows-x64");
    const built = entriesByName(result.outputPath);
    const packageJson = JSON.parse(text(built, "Keiko/package.json"));

    expect(packageJson).toMatchObject({
      name: "keiko-standalone-windows-x64",
      version: "1.2.3",
      private: true,
      engines: { node: "26.13.1" },
      scripts: { start: "start.cmd", stop: "stop.cmd" },
      keiko: {
        packageName: "@oscharko-dev/keiko",
        packageVersion: "1.2.3",
        platformTarget: "windows-x64",
        archive: {
          name: "Keiko.zip",
          source: "keiko-windows-x64.zip",
          sha256: sha256File(archive),
        },
        nodeRuntime: { version: "26.13.1", sha256: NODE_SOURCE.sha256 },
        provisionedConfig: false,
      },
    });
    expect(packageJson.dependencies).toBeUndefined();
    expect(JSON.parse(text(built, "Keiko/package-lock.json"))).toEqual({
      name: "keiko-standalone-windows-x64",
      version: "1.2.3",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "keiko-standalone-windows-x64",
          version: "1.2.3",
          engines: { node: "26.13.1" },
        },
      },
    });
  });

  it("keeps npm offline and holds no credential in .npmrc", () => {
    const npmrc = text(entriesByName(build("macos-arm64").result.outputPath), "Keiko/.npmrc");

    expect(npmrc).toContain("offline=true\n");
    expect(npmrc).toContain("engine-strict=true\n");
    expect(npmrc).not.toMatch(/_auth|token|registry/iu);
  });

  it("names the macOS start files in package.json as shell scripts", () => {
    const built = entriesByName(build("macos-x64").result.outputPath);

    expect(JSON.parse(text(built, "Keiko/package.json")).scripts).toEqual({
      start: "sh start.sh",
      stop: "sh stop.sh",
    });
    expect(text(built, "Keiko/start.sh")).toMatch(/^#!\/bin\/sh\n/u);
    expect(text(built, "Keiko/start.sh")).toContain("/usr/bin/ditto -x -k");
    expect(text(built, "Keiko/start.sh")).toContain("portable launch --in-place");
    expect(text(built, "Keiko/start.sh")).not.toContain("\r");
  });

  it("writes the Windows start files with CRLF and without parenthesized blocks", () => {
    const built = entriesByName(build("windows-x64").result.outputPath);

    for (const name of ["start.cmd", "stop.cmd", "README.md"]) {
      const content = text(built, `Keiko/${name}`);
      expect(content).toContain("\r\n");
      expect(content.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/u);
    }
    for (const name of ["start.cmd", "stop.cmd"]) {
      // A folder named "Keiko (1)" would end a parenthesized block early; the parentheses inside
      // the quoted Node.js check are one argument, not a block.
      const code = text(built, `Keiko/${name}`)
        .replaceAll(/^rem .*$/gmu, "")
        .replaceAll(/"[^"\r\n]*"/gu, "");
      expect(code).not.toMatch(/[()]/u);
    }
    expect(text(built, "Keiko/start.cmd")).toContain("portable launch --in-place");
  });

  it("carries an administrator's configuration under its own archive name", () => {
    const root = tempRoot();
    const config = join(root, "team.config.json");
    writeFileSync(config, '{"providers":[{"modelId":"chat","baseUrl":"https://gw.example.test"}]}');
    const { result } = build("windows-x64", { options: { config } });
    const built = entriesByName(result.outputPath);

    expect(result.outputPath.endsWith("keiko-windows-x64-standalone-nested-team.zip")).toBe(true);
    expect(built.has("Keiko/keiko.config.json")).toBe(true);
    expect(JSON.parse(text(built, "Keiko/package.json")).keiko.provisionedConfig).toBe(true);
  });

  it("is reproducible: the same archive gives the same package", () => {
    const records = payloadRecords("macos-arm64");
    const first = build("macos-arm64", { records });
    const second = build("macos-arm64", { records });

    expect(second.result.outputSha256).toBe(first.result.outputSha256);
  });

  it("refuses a payload that does not record its Node.js runtime", () => {
    expect(() =>
      build("windows-x64", { records: payloadRecords("windows-x64", { nodeSource: null }) }),
    ).toThrow(StandaloneBuildError);
    expect(() =>
      build("windows-x64", {
        records: payloadRecords("windows-x64", { nodeSource: { ...NODE_SOURCE, nodeVersion: "" } }),
      }),
    ).toThrow(/names no version/u);
  });

  it("refuses an unknown layout before any work", () => {
    expect(() => build("windows-x64", { options: { layout: "flat" } })).toThrow(
      /unsupported layout flat/u,
    );
  });
});

// The fake CLI records its arguments, so the test sees exactly what the start file ran.
const RECORDING_CLI = [
  "const { writeFileSync } = require('node:fs');",
  "writeFileSync(process.env.KEIKO_TEST_ARGS_OUT, JSON.stringify(process.argv.slice(2)));",
].join("\n");

// Only the package's own two batch files, by fixed relative names resolved against `cwd`, so no
// path from the environment (the temporary directory) ever enters the command line. The explicit
// `.\` keeps working where NoDefaultCurrentDirectoryInExePath stops cmd.exe searching `cwd`.
const CMD_FILES = new Map([
  ["start.cmd", String.raw`.\start.cmd`],
  ["stop.cmd", String.raw`.\stop.cmd`],
]);

function runCmd(folder, name, env) {
  const command = CMD_FILES.get(name);
  if (command === undefined) throw new TypeError(`not a package batch file: ${name}`);
  return spawnSync("cmd.exe", ["/d", "/c", command], {
    cwd: folder,
    env: { ...process.env, ...env },
    input: "",
    encoding: "utf8",
    timeout: 120_000,
  });
}

describe.runIf(process.platform === "win32")("the nested Windows start and stop files", () => {
  function unpackedPackage() {
    const records = payloadRecords("windows-x64", { cli: RECORDING_CLI });
    const { root, result } = build("windows-x64", { records, options: { keepFolder: true } });
    // The fixture's node.exe is text; the real start file needs a real Node.js to run.
    copyFileSync(process.execPath, join(result.folder, "node", "node.exe"));
    const argsOut = join(root, "args.json");
    const env = { KEIKO_TEST_ARGS_OUT: argsOut, KEIKO_STATE_DIR: join(root, "state") };
    return { folder: result.folder, root, argsOut, env };
  }

  it("unpacks Keiko.zip once and starts in place with the bundled Node.js", () => {
    const { folder, root, argsOut, env } = unpackedPackage();

    const first = runCmd(folder, "start.cmd", env);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const payload = join(folder, "system", "Keiko");
    expect(JSON.parse(readFileSync(argsOut, "utf8"))).toEqual([
      "portable",
      "launch",
      "--in-place",
      "--portable-root",
      payload,
      "--state-dir",
      join(root, "state"),
    ]);
    expect(readFileSync(join(folder, "system", "Keiko.zip.sha256"), "utf8")).toBe(
      readFileSync(join(folder, "Keiko.zip.sha256"), "utf8"),
    );
    expect(existsSync(join(folder, "system.partial"))).toBe(false);

    // A second start uses the unpacked folder as it is.
    writeFileSync(join(folder, "system", "kept.txt"), "kept");
    const second = runCmd(folder, "start.cmd", env);
    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(second.stdout).not.toContain("unpacked");
    expect(existsSync(join(folder, "system", "kept.txt"))).toBe(true);
  });

  it("unpacks again when Keiko.zip changed", () => {
    const { folder, env } = unpackedPackage();
    expect(runCmd(folder, "start.cmd", env).status).toBe(0);
    writeFileSync(join(folder, "system", "kept.txt"), "stale");

    // A newer Keiko.zip with its own checksum replaces the unpacked folder as a whole.
    const newer = join(folder, "Keiko.zip");
    writeZipArchiveEntries(newer, payloadRecords("windows-x64", { cli: `${RECORDING_CLI}\n` }));
    writeFileSync(join(folder, "Keiko.zip.sha256"), `${sha256File(newer)}  Keiko.zip\n`);
    const replaced = runCmd(folder, "start.cmd", env);
    expect(replaced.status, replaced.stdout + replaced.stderr).toBe(0);
    expect(existsSync(join(folder, "system", "kept.txt"))).toBe(false);
  });

  it("does not carry the source archive's download mark into Keiko.zip", () => {
    const root = tempRoot();
    const archive = join(root, "keiko-windows-x64.zip");
    writeZipArchiveEntries(archive, payloadRecords("windows-x64"));
    writeFileSync(`${archive}:Zone.Identifier`, "[ZoneTransfer]\r\nZoneId=3\r\n");
    const { folder } = buildStandalonePackage({
      target: "windows-x64",
      archive,
      sha256: sha256File(archive),
      outDir: join(root, "out"),
      layout: "nested",
      keepFolder: true,
    });

    expect(existsSync(`${archive}:Zone.Identifier`)).toBe(true);
    expect(existsSync(join(folder, "Keiko.zip:Zone.Identifier"))).toBe(false);
  });

  it("refuses to unpack a damaged Keiko.zip and starts nothing", () => {
    const { folder, argsOut, env } = unpackedPackage();
    writeFileSync(join(folder, "Keiko.zip"), "damaged");

    const damaged = runCmd(folder, "start.cmd", env);
    expect(damaged.status).toBe(1);
    expect(damaged.stdout).toContain("does not match Keiko.zip.sha256");
    expect(existsSync(join(folder, "system"))).toBe(false);
    expect(existsSync(argsOut)).toBe(false);
  });

  it("stops with the bundled Node.js and reports a folder that was never started", () => {
    const { folder, argsOut, env } = unpackedPackage();

    const never = runCmd(folder, "stop.cmd", env);
    expect(never.status).toBe(0);
    expect(never.stdout).toContain("nothing to stop");

    expect(runCmd(folder, "start.cmd", env).status).toBe(0);
    expect(runCmd(folder, "stop.cmd", env).status).toBe(0);
    expect(JSON.parse(readFileSync(argsOut, "utf8"))).toEqual([
      "stop",
      "--state-dir",
      env.KEIKO_STATE_DIR,
    ]);
  });
});
