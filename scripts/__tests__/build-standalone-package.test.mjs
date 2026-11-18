import { Buffer } from "node:buffer";
import {
  existsSync,
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

import {
  STANDALONE_TARGETS,
  StandaloneBuildError,
  buildStandalonePackage,
  parseStandaloneArgs,
} from "../build-standalone-package.mjs";
import { sha256File } from "../lib/digest.mjs";
import { extractZipArchiveEntries, readZipArchiveEntries } from "../lib/zip-archive.mjs";
import { payloadRecords, portableArchive } from "./support/portable-payload-fixture.mjs";

// A standalone package is the portable payload, byte for byte, plus start/stop files and a README
// (ADR-0121 D9). These tests build real packages from small real archives and read the result back.

const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "keiko-standalone-package-"));
  tempRoots.push(root);
  return root;
}

function build(target, overrides = {}) {
  const root = tempRoot();
  const archive = overrides.archive ?? portableArchive(root, target, overrides.records);
  const outDir = join(root, "out");
  const result = buildStandalonePackage({
    target,
    archive,
    sha256: overrides.sha256 ?? sha256File(archive),
    outDir,
    keepFolder: false,
    ...overrides.options,
  });
  return { root, archive, outDir, result };
}

function entriesByName(archivePath) {
  return new Map(
    readZipArchiveEntries(archivePath).map((entry) => [entry.name, entry.data.toString("utf8")]),
  );
}

describe("a standalone package", () => {
  it.each(Object.keys(STANDALONE_TARGETS))("carries the %s payload unchanged", (target) => {
    const { archive, result } = build(target);
    const built = entriesByName(result.outputPath);

    for (const original of readZipArchiveEntries(archive)) {
      expect(built.get(`Keiko/system/${original.name}`)).toBe(original.data.toString("utf8"));
    }
    expect(result.packageVersion).toBe("1.2.3");
    expect(result.provisioned).toBe(false);
  });

  it("adds the macOS start and stop files, both READMEs and the build record", () => {
    const { archive, result } = build("macos-arm64");
    const built = entriesByName(result.outputPath);

    expect(
      [...built.keys()].filter((name) => !name.startsWith("Keiko/system/Keiko/")).sort(),
    ).toEqual([
      "Keiko/LIESMICH.txt",
      "Keiko/README.txt",
      "Keiko/Start Keiko.command",
      "Keiko/Stop Keiko.command",
      "Keiko/system/standalone.json",
    ]);
    expect(built.get("Keiko/Start Keiko.command")).toMatch(/^#!\/bin\/sh\n/u);
    expect(built.get("Keiko/Start Keiko.command")).toContain("portable launch --in-place");
    expect(built.get("Keiko/Start Keiko.command")).not.toContain("\r");
    expect(JSON.parse(built.get("Keiko/system/standalone.json"))).toEqual({
      schemaVersion: 1,
      kind: "keiko-standalone-package",
      platformTarget: "macos-arm64",
      packageVersion: "1.2.3",
      sourceArchive: { name: "keiko-macos-arm64.zip", sha256: sha256File(archive) },
      provisionedConfig: false,
    });
  });

  it("keeps the start files and the bundled Node executable after extraction", () => {
    const { root, result } = build("macos-arm64");
    const extracted = join(root, "extracted");
    extractZipArchiveEntries(result.outputPath, extracted);

    const executable = (path) => (statSync(join(extracted, "Keiko", path)).mode & 0o111) !== 0;
    expect(executable("Start Keiko.command")).toBe(true);
    expect(executable("Stop Keiko.command")).toBe(true);
    expect(executable("system/Keiko/Keiko.app/Contents/Resources/runtime/node/bin/node")).toBe(
      true,
    );
    expect(executable("README.txt")).toBe(false);
  });

  it("writes the Windows start files and READMEs with CRLF line endings", () => {
    const { result } = build("windows-x64");
    const built = entriesByName(result.outputPath);

    for (const name of ["Start Keiko.cmd", "Stop Keiko.cmd", "README.txt", "LIESMICH.txt"]) {
      const text = built.get(`Keiko/${name}`);
      expect(text).toContain("\r\n");
      expect(text.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/u);
    }
    expect(built.get("Keiko/Start Keiko.cmd")).toContain("portable launch --in-place");
    // A folder named "Keiko (1)" would end a parenthesized block early.
    expect(built.get("Keiko/Start Keiko.cmd").replaceAll(/^rem .*$/gmu, "")).not.toMatch(/[()]/u);
    expect(built.get("Keiko/Stop Keiko.cmd").replaceAll(/^rem .*$/gmu, "")).not.toMatch(/[()]/u);
  });

  it("writes the checksum of the package next to it and leaves no work folder behind", () => {
    const { outDir, result } = build("windows-x64");

    expect(readFileSync(`${result.outputPath}.sha256`, "utf8")).toBe(
      `${sha256File(result.outputPath)}  keiko-windows-x64.standalone.zip\n`,
    );
    expect(readdirSync(outDir).sort()).toEqual([
      "keiko-windows-x64.standalone.zip",
      "keiko-windows-x64.standalone.zip.sha256",
    ]);
  });

  it("is reproducible: the same archive gives the same package", () => {
    const first = build("macos-arm64");
    const second = build("macos-arm64");

    expect(second.result.outputSha256).toBe(first.result.outputSha256);
  });

  it("keeps the assembled folder on request", () => {
    const { result } = build("macos-arm64", { options: { keepFolder: true } });

    expect(existsSync(join(result.folder, "Start Keiko.command"))).toBe(true);
    expect(existsSync(join(result.folder, "system", "Keiko", "Keiko.app"))).toBe(true);
  });
});

describe("an administrator's package", () => {
  function configFile(root, content) {
    const path = join(root, "team.config.json");
    writeFileSync(path, content);
    return path;
  }

  it("carries the configuration byte for byte under its own archive name", () => {
    const root = tempRoot();
    const content =
      '{"providers":[{"modelId":"chat","baseUrl":"https://gateway.example.test","apiKey":"sk-team"}]}';
    const { result } = build("macos-arm64", { options: { config: configFile(root, content) } });
    const built = entriesByName(result.outputPath);

    expect(result.outputPath.endsWith("keiko-macos-arm64.standalone-team.zip")).toBe(true);
    expect(result.provisioned).toBe(true);
    expect(built.get("Keiko/keiko.config.json")).toBe(content);
    expect(JSON.parse(built.get("Keiko/system/standalone.json")).provisionedConfig).toBe(true);
  });

  it("turns the references Gateway Setup left into the team's key", () => {
    const root = tempRoot();
    const sealed = JSON.stringify({
      schemaVersion: 2,
      providers: [
        { modelId: "chat", baseUrl: "https://gateway.example.test", apiKeySecretRef: "cred:chat" },
        {
          modelId: "embed",
          baseUrl: "https://gateway.example.test",
          apiKeySecretRef: "cred:embed",
        },
        { modelId: "own-key", baseUrl: "https://other.example.test", apiKey: "sk-kept" },
      ],
    });
    const { result } = build("windows-x64", {
      options: {
        config: configFile(root, sealed),
        apiKeyEnv: "KEIKO_TEAM_KEY",
        env: { KEIKO_TEAM_KEY: "sk-team" },
      },
    });

    expect(JSON.parse(entriesByName(result.outputPath).get("Keiko/keiko.config.json"))).toEqual({
      schemaVersion: 2,
      providers: [
        { modelId: "chat", baseUrl: "https://gateway.example.test", apiKey: "sk-team" },
        { modelId: "embed", baseUrl: "https://gateway.example.test", apiKey: "sk-team" },
        { modelId: "own-key", baseUrl: "https://other.example.test", apiKey: "sk-kept" },
      ],
    });
  });

  it("turns the reranker's sealed reference into the team's key too", () => {
    const root = tempRoot();
    const sealed = JSON.stringify({
      providers: [{ modelId: "chat", baseUrl: "https://g.example.test", apiKey: "sk-kept" }],
      reranker: { modelId: "rerank", baseUrl: "https://g.example.test", apiKeySecretRef: "cred:r" },
    });
    const options = { config: configFile(root, sealed) };

    expect(() => build("macos-arm64", { options })).toThrow("pass --api-key-env NAME");
    const { result } = build("macos-arm64", {
      options: { ...options, apiKeyEnv: "KEIKO_TEAM_KEY", env: { KEIKO_TEAM_KEY: "sk-team" } },
    });
    expect(
      JSON.parse(entriesByName(result.outputPath).get("Keiko/keiko.config.json")).reranker,
    ).toEqual({ modelId: "rerank", baseUrl: "https://g.example.test", apiKey: "sk-team" });
  });

  it("refuses a config that still refers to a key sealed on the administrator's computer", () => {
    const root = tempRoot();
    const sealed =
      '{"providers":[{"modelId":"chat","baseUrl":"https://g.example.test","apiKeySecretRef":"cred:chat"}]}';

    expect(() => build("macos-arm64", { options: { config: configFile(root, sealed) } })).toThrow(
      "pass --api-key-env NAME",
    );
  });

  it("refuses an unset key variable and a key variable without a config", () => {
    const root = tempRoot();
    const sealed =
      '{"providers":[{"modelId":"chat","baseUrl":"https://g.example.test","apiKeySecretRef":"cred:chat"}]}';

    expect(() =>
      build("macos-arm64", {
        options: { config: configFile(root, sealed), apiKeyEnv: "KEIKO_TEAM_KEY", env: {} },
      }),
    ).toThrow("the environment variable KEIKO_TEAM_KEY is not set");
    expect(() => build("macos-arm64", { options: { apiKeyEnv: "KEIKO_TEAM_KEY" } })).toThrow(
      "--api-key-env needs --config",
    );
  });

  it("ships a file saved with a byte order mark without the mark", () => {
    const root = tempRoot();
    const content =
      '{"providers":[{"modelId":"chat","baseUrl":"https://gateway.example.test","apiKey":"sk-team"}]}';
    const { result } = build("macos-arm64", {
      options: { config: configFile(root, `\uFEFF${content}`) },
    });

    expect(entriesByName(result.outputPath).get("Keiko/keiko.config.json")).toBe(content);
  });

  it.each([
    ["text that is not JSON", "not json", "is not valid JSON"],
    ["a config without providers", "{}", "names no providers"],
    ["an empty provider list", '{"providers":[]}', "names no providers"],
    ["a JSON array", "[]", "is not a JSON object"],
    ["a provider that is not an object", '{"providers":[1]}', "provider 0 is not an object"],
    [
      "a provider without a model",
      '{"providers":[{"baseUrl":"https://g.example.test"}]}',
      "names no modelId",
    ],
    [
      "a provider without a gateway address",
      '{"providers":[{"modelId":"chat"}]}',
      "names no baseUrl",
    ],
    [
      "a provider with an empty key",
      '{"providers":[{"modelId":"chat","baseUrl":"https://g.example.test","apiKey":""}]}',
      "carries an empty apiKey",
    ],
  ])("refuses %s", (_label, content, message) => {
    const root = tempRoot();

    expect(() => build("macos-arm64", { options: { config: configFile(root, content) } })).toThrow(
      message,
    );
  });
});

describe("what the builder refuses", () => {
  it("refuses an archive that does not match its checksum and writes nothing", () => {
    const root = tempRoot();
    const archive = portableArchive(root, "macos-arm64");

    expect(() =>
      buildStandalonePackage({
        target: "macos-arm64",
        archive,
        sha256: "0".repeat(64),
        outDir: join(root, "out"),
      }),
    ).toThrow("archive checksum mismatch");
    expect(existsSync(join(root, "out"))).toBe(false);
  });

  it("refuses to build without a checksum", () => {
    const root = tempRoot();

    expect(() =>
      buildStandalonePackage({
        target: "macos-arm64",
        archive: portableArchive(root, "macos-arm64"),
        outDir: join(root, "out"),
      }),
    ).toThrow("an unverified archive is not packaged");
  });

  it("reads the checksum from a SHA256SUMS file that names the archive", () => {
    const root = tempRoot();
    const archive = portableArchive(root, "windows-x64");
    const sums = join(root, "SHA256SUMS.txt");
    writeFileSync(
      sums,
      `${"1".repeat(64)}  other.zip\n${sha256File(archive)}  keiko-windows-x64.zip\n`,
    );

    const result = buildStandalonePackage({
      target: "windows-x64",
      archive,
      sha256sums: sums,
      outDir: join(root, "out"),
    });

    expect(result.packageVersion).toBe("1.2.3");
  });

  it("refuses a SHA256SUMS file that does not name the archive", () => {
    const root = tempRoot();
    const sums = join(root, "SHA256SUMS.txt");
    writeFileSync(sums, `${"1".repeat(64)}  other.zip\n`);

    expect(() =>
      buildStandalonePackage({
        target: "windows-x64",
        archive: portableArchive(root, "windows-x64"),
        sha256sums: sums,
        outDir: join(root, "out"),
      }),
    ).toThrow("does not name keiko-windows-x64.zip");
  });

  it("refuses the archive of another target", () => {
    const root = tempRoot();
    const archive = portableArchive(root, "macos-x64");

    expect(() =>
      buildStandalonePackage({
        target: "macos-arm64",
        archive,
        sha256: sha256File(archive),
        outDir: join(root, "out"),
      }),
    ).toThrow("built for macos-x64, not for macos-arm64");
  });

  it.each([
    [
      "an entry outside the payload root",
      [{ name: "other/file.txt", data: "x" }],
      "not a portable payload",
    ],
    [
      "a payload without its setup manifest",
      [{ name: "Keiko/app/dist/cli/index.js", data: "cli" }],
      "no portable setup manifest",
    ],
    [
      "a payload without the bundled Node",
      payloadRecords("windows-x64").filter((record) => !record.name.endsWith("node.exe")),
      "the payload is incomplete",
    ],
    [
      "a payload of another package",
      payloadRecords("windows-x64", { packageName: "@example/other" }),
      "not a Keiko portable payload",
    ],
  ])("refuses %s", (_label, records, message) => {
    expect(() => build("windows-x64", { records })).toThrow(message);
  });

  it("refuses a Windows package whose paths would not extract with Explorer", () => {
    const deep = `Keiko/app/${"segment/".repeat(24)}file.js`;

    expect(() =>
      build("windows-x64", {
        records: [...payloadRecords("windows-x64"), { name: deep, data: Buffer.from("x") }],
      }),
    ).toThrow("Windows needs 180 or fewer");
  });

  it.each(["linux-x64", "macos"])("refuses the unsupported target %s", (target) => {
    const root = tempRoot();

    expect(() =>
      buildStandalonePackage({ target, archive: "x.zip", sha256: "0".repeat(64), outDir: root }),
    ).toThrow(StandaloneBuildError);
  });

  it("refuses to overwrite a kept folder", () => {
    const root = tempRoot();
    const archive = portableArchive(root, "macos-arm64");
    const options = {
      target: "macos-arm64",
      archive,
      sha256: sha256File(archive),
      outDir: join(root, "out"),
      keepFolder: true,
    };
    buildStandalonePackage(options);

    expect(() => buildStandalonePackage(options)).toThrow("already exists");
  });
});

describe("the command line", () => {
  it("parses every flag", () => {
    expect(
      parseStandaloneArgs([
        "--target",
        "macos-arm64",
        "--archive",
        "a.zip",
        "--sha256",
        "abc",
        "--out-dir",
        "out",
        "--config",
        "c.json",
        "--api-key-env",
        "TEAM_KEY",
        "--keep-folder",
      ]),
    ).toEqual({
      keepFolder: true,
      target: "macos-arm64",
      archive: "a.zip",
      sha256: "abc",
      outDir: "out",
      config: "c.json",
      apiKeyEnv: "TEAM_KEY",
    });
  });

  it.each([[["--unknown"]], [["--target"]], [["--target", "--archive"]]])("refuses %j", (argv) => {
    expect(() => parseStandaloneArgs(argv)).toThrow(StandaloneBuildError);
  });
});
