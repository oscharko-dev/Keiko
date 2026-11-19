import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FolderReleaseBuildError,
  buildFolderReleaseAssets,
  parseFolderReleaseArgs,
  runFolderReleaseCli,
} from "../build-folder-release-assets.mjs";
import { StandaloneBuildError } from "../build-standalone-package.mjs";
import { sha256File } from "../lib/digest.mjs";
import {
  FOLDER_PACKAGES_DIRECTORY,
  FOLDER_PACKAGES_MANIFEST,
  FOLDER_RELEASE_TARGETS,
  folderPackageUploads,
} from "../lib/folder-package-release.mjs";
import { readZipArchiveEntries } from "../lib/zip-archive.mjs";
import { portableArchive } from "./support/portable-payload-fixture.mjs";

// The stable-tag build turns each desktop archive of the portable asset bundle into its standalone
// folder package (ADR-0121 D9). These tests build from a small real bundle and hand the result to
// the publisher's own check.

const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// The layout scripts/assemble-portable-release-assets.mjs writes: artifacts/<target>/ with the
// archive, its manifest and its checksum evidence, and portable-assets.json naming them.
function portableBundle({ evidenceSha256 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "keiko-folder-bundle-"));
  tempRoots.push(root);
  const artifacts = ["linux-x64", ...FOLDER_RELEASE_TARGETS].map((target) => {
    const targetRoot = join(root, "artifacts", target);
    mkdirSync(join(targetRoot, "manifest"), { recursive: true });
    mkdirSync(join(targetRoot, "evidence"));
    const archive = portableArchive(targetRoot, target);
    const sha256 = sha256File(archive);
    const manifest = {
      artifact: { assetName: `keiko-${target}.zip`, sha256 },
      evidence: { checksumsPath: "evidence/SHA256SUMS.txt" },
    };
    writeFileSync(join(targetRoot, "manifest", "portable-manifest.json"), JSON.stringify(manifest));
    writeFileSync(
      join(targetRoot, "evidence", "SHA256SUMS.txt"),
      `${evidenceSha256 ?? sha256}  keiko-${target}.zip\n`,
    );
    return {
      platformTarget: target,
      archivePath: `artifacts/${target}/keiko-${target}.zip`,
      manifestPath: `artifacts/${target}/manifest/portable-manifest.json`,
      sha256,
    };
  });
  writeFileSync(
    join(root, "portable-assets.json"),
    JSON.stringify({ schemaVersion: 1, artifacts }),
  );
  return { root, artifacts };
}

describe("the folder packages of a release", () => {
  it.skipIf(process.platform === "win32")(
    "publishes the set in an ordinary directory, not the private staging mode (PR #4464)",
    () => {
      const { root } = portableBundle();

      buildFolderReleaseAssets({ bundleRoot: root, version: "1.2.3" });

      expect(statSync(join(root, FOLDER_PACKAGES_DIRECTORY)).mode & 0o777).toBe(0o755);
    },
  );

  it("are built from the bundle's archives and pass the publisher's check", () => {
    const { root, artifacts } = portableBundle();

    const manifest = buildFolderReleaseAssets({ bundleRoot: root, version: "1.2.3" });

    expect(manifest.packages.map((entry) => entry.assetName)).toEqual([
      "keiko-macos-arm64.standalone.zip",
      "keiko-macos-x64.standalone.zip",
      "keiko-windows-x64.standalone.zip",
    ]);
    const archives = new Map(
      artifacts.map((artifact) => [
        artifact.platformTarget,
        { assetName: `keiko-${artifact.platformTarget}.zip`, sha256: artifact.sha256 },
      ]),
    );
    const checked = folderPackageUploads({ bundleRoot: root, version: "1.2.3", archives });
    expect(checked.failures).toEqual([]);
    expect(checked.uploads).toHaveLength(6);
    // A generic package: the payload and the start files, never an access file.
    const windows = join(root, FOLDER_PACKAGES_DIRECTORY, "keiko-windows-x64.standalone.zip");
    const names = readZipArchiveEntries(windows).map((entry) => entry.name);
    expect(names).toContain("Keiko/Start Keiko.cmd");
    expect(names).toContain("Keiko/system/Keiko/Keiko.exe");
    expect(names.some((name) => name.endsWith("keiko.config.json"))).toBe(false);
  });

  it("are built once: an existing folder is never replaced", () => {
    const { root } = portableBundle();
    mkdirSync(join(root, FOLDER_PACKAGES_DIRECTORY));

    expect(() => buildFolderReleaseAssets({ bundleRoot: root, version: "1.2.3" })).toThrow(
      FolderReleaseBuildError,
    );
  });

  it("leaves no part of the set when a target fails, so the repaired bundle builds", () => {
    // Review finding on PR #4464 (P2): the set's folder was created before the targets were built,
    // so a failure on the last target left two packages and no manifest, and a retry was refused.
    const { root } = portableBundle();
    const archive = join(root, "artifacts", "windows-x64", "keiko-windows-x64.zip");
    const original = readFileSync(archive);
    writeFileSync(archive, "not the archive");

    expect(() => buildFolderReleaseAssets({ bundleRoot: root, version: "1.2.3" })).toThrow(
      StandaloneBuildError,
    );
    expect(existsSync(join(root, FOLDER_PACKAGES_DIRECTORY))).toBe(false);
    // Nothing of the attempt remains beside the bundle's own entries.
    expect(readdirSync(root).sort()).toEqual(["artifacts", "portable-assets.json"]);

    writeFileSync(archive, original);
    const manifest = buildFolderReleaseAssets({ bundleRoot: root, version: "1.2.3" });
    expect(manifest.packages).toHaveLength(3);
    expect(readdirSync(join(root, FOLDER_PACKAGES_DIRECTORY))).toHaveLength(7);
  });

  it("refuses an archive its checksum evidence does not bind", () => {
    const { root } = portableBundle({ evidenceSha256: "0".repeat(64) });

    expect(() => buildFolderReleaseAssets({ bundleRoot: root, version: "1.2.3" })).toThrow(
      /checksum evidence of macos-arm64 does not match its manifest/u,
    );
  });

  it("refuses archives of another Keiko version", () => {
    const { root } = portableBundle();

    expect(() => buildFolderReleaseAssets({ bundleRoot: root, version: "9.9.9" })).toThrow(
      /holds Keiko 1\.2\.3, not 9\.9\.9/u,
    );
  });

  it("refuses an archive outside the bundle", () => {
    const { root } = portableBundle();
    const bundlePath = join(root, "portable-assets.json");
    const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
    bundle.artifacts[1].archivePath = "../keiko-macos-arm64.zip";
    writeFileSync(bundlePath, JSON.stringify(bundle));

    expect(() => buildFolderReleaseAssets({ bundleRoot: root, version: "1.2.3" })).toThrow(
      /macos-arm64 archivePath must stay inside the bundle/u,
    );
  });

  it("refuses an entry that names no archive", () => {
    const { root } = portableBundle();
    const bundlePath = join(root, "portable-assets.json");
    const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
    delete bundle.artifacts[1].archivePath;
    writeFileSync(bundlePath, JSON.stringify(bundle));

    expect(() => buildFolderReleaseAssets({ bundleRoot: root, version: "1.2.3" })).toThrow(
      /macos-arm64 archivePath is missing/u,
    );
  });

  // The digest binds the bytes either way; the bundle is still read only as regular files, like
  // the publisher reads the packages.
  it("refuses an archive that is a link", () => {
    const { root } = portableBundle();
    const archive = join(root, "artifacts", "macos-x64", "keiko-macos-x64.zip");
    renameSync(archive, join(root, "keiko-macos-x64.zip"));
    symlinkSync(join(root, "keiko-macos-x64.zip"), archive);

    expect(() => buildFolderReleaseAssets({ bundleRoot: root, version: "1.2.3" })).toThrow(
      /macos-x64 archivePath must name a regular file in the bundle/u,
    );
  });

  // A linked directory on the way passes a lexical prefix check, and the file itself is regular:
  // only the canonical path shows that the read would leave the bundle.
  it("refuses a target directory that links out of the bundle", () => {
    const { root } = portableBundle();
    const outside = mkdtempSync(join(tmpdir(), "keiko-folder-outside-"));
    tempRoots.push(outside);
    const targetRoot = join(root, "artifacts", "macos-arm64");
    renameSync(targetRoot, join(outside, "macos-arm64"));
    symlinkSync(join(outside, "macos-arm64"), targetRoot, "junction");

    expect(() => buildFolderReleaseAssets({ bundleRoot: root, version: "1.2.3" })).toThrow(
      /macos-arm64 archivePath must stay inside the bundle/u,
    );
  });

  it("refuses an archive that is not the one its digest names", () => {
    const { root } = portableBundle();
    const archive = join(root, "artifacts", "macos-x64", "keiko-macos-x64.zip");
    writeFileSync(archive, "not the archive");

    expect(() => buildFolderReleaseAssets({ bundleRoot: root, version: "1.2.3" })).toThrow(
      StandaloneBuildError,
    );
  });

  it("reads exactly a bundle root and a version", () => {
    expect(parseFolderReleaseArgs(["--bundle-root", "b", "--version", "1.2.3"])).toEqual({
      bundleRoot: "b",
      version: "1.2.3",
    });
    expect(() => parseFolderReleaseArgs(["--bundle-root", "b"])).toThrow(/--version is required/u);
    expect(() => parseFolderReleaseArgs(["--other", "x"])).toThrow(/unknown argument --other/u);
    expect(() => parseFolderReleaseArgs(["--version"])).toThrow(/--version needs a value/u);
  });
});

describe("the folder package command line", () => {
  function captured() {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    return {
      out: () => log.mock.calls.map((call) => call.join(" ")),
      err: () => error.mock.calls.map((call) => call.join(" ")),
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints its usage on --help and builds nothing", () => {
    const output = captured();

    expect(runFolderReleaseCli(["--help"])).toBe(0);
    expect(output.out().join("\n")).toContain("--bundle-root");
    expect(output.err()).toEqual([]);
  });

  it("names every package it built with its digest", () => {
    const { root } = portableBundle();
    const output = captured();

    expect(runFolderReleaseCli(["--bundle-root", root, "--version", "1.2.3"])).toBe(0);
    const manifest = JSON.parse(
      readFileSync(join(root, FOLDER_PACKAGES_DIRECTORY, FOLDER_PACKAGES_MANIFEST), "utf8"),
    );
    expect(output.out()).toEqual(
      manifest.packages.map(
        (entry) => `PASS folder package ${entry.assetName} sha256 ${entry.sha256}`,
      ),
    );
  });

  it.each([
    ["an argument it does not know", () => ["--other", "x"], /unknown argument --other/u],
    [
      "an archive that is not the one the bundle names",
      () => {
        const { root } = portableBundle();
        writeFileSync(join(root, "artifacts", "macos-x64", "keiko-macos-x64.zip"), "not it");
        return ["--bundle-root", root, "--version", "1.2.3"];
      },
      /^FAIL build-folder-release-assets: /u,
    ],
  ])("refuses %s on one FAIL line and exits 1", (_, argv, message) => {
    const args = argv();
    const output = captured();

    expect(runFolderReleaseCli(args)).toBe(1);
    expect(output.err()).toHaveLength(1);
    expect(output.err()[0]).toMatch(/^FAIL build-folder-release-assets: /u);
    expect(output.err()[0]).toMatch(message);
    expect(output.out()).toEqual([]);
  });
});
