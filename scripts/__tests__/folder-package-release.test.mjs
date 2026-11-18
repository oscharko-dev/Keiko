import { Buffer } from "node:buffer";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sha256, sha256FileChunked } from "../lib/digest.mjs";
import {
  FIRST_CLASS_ARCHIVE_NAME,
  FOLDER_PACKAGE_MAX_BYTES,
  FOLDER_PACKAGES_DIRECTORY,
  FOLDER_PACKAGES_MANIFEST,
  FOLDER_PACKAGES_MANIFEST_MAX_BYTES,
  FOLDER_RELEASE_TARGETS,
  folderChecksumText,
  folderPackageArchiveName,
  folderPackageUploads,
  folderPackagesManifest,
} from "../lib/folder-package-release.mjs";
import { PORTABLE_TARGETS, WINDOWS_PORTABLE_SETUP_ASSET_NAME } from "../portable-runtime.mjs";
// The updater every installed Keiko runs. A release it refuses is a release nobody can update to.
import { firstClassArchiveSetComplete } from "../../packages/keiko-server/dist/update-preflight-portable-shared.js";

// The folder packages a stable release carries beside its portable archives (ADR-0121 D9).

const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const FORMS = ["standalone", "npm"];

function releaseAssets(folderNames) {
  const names = [
    ...PORTABLE_TARGETS.map((target) => target.assetName),
    WINDOWS_PORTABLE_SETUP_ASSET_NAME,
    ...PORTABLE_TARGETS.map((target) => `${target.platformTarget}-SHA256SUMS.txt`),
    ...folderNames.flatMap((name) => [name, `${name}.sha256`]),
  ];
  return names.map((name) => ({ name }));
}

function everyFolderName(nameFor) {
  return FOLDER_RELEASE_TARGETS.flatMap((target) =>
    FORMS.flatMap((form) => [nameFor(target, form, false), nameFor(target, form, true)]),
  );
}

describe("a folder package's name", () => {
  it("never looks like a portable archive to a shipped updater", () => {
    const names = everyFolderName(folderPackageArchiveName);

    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(FIRST_CLASS_ARCHIVE_NAME.test(name)).toBe(false);
    expect(firstClassArchiveSetComplete(releaseAssets(names))).toBe(true);
  });

  it("is chosen because the hyphenated spelling would stop every update", () => {
    // The spelling the builders used before the packages became release assets.
    const hyphenated = everyFolderName(
      (target, form, team) => `keiko-${target}-${form}${team ? "-team" : ""}.zip`,
    );

    expect(firstClassArchiveSetComplete(releaseAssets([]))).toBe(true);
    expect(firstClassArchiveSetComplete(releaseAssets(hyphenated))).toBe(false);
  });

  it("names its form and whether it holds access", () => {
    expect(folderPackageArchiveName("windows-x64", "standalone")).toBe(
      "keiko-windows-x64.standalone.zip",
    );
    expect(folderPackageArchiveName("macos-arm64", "npm", true)).toBe(
      "keiko-macos-arm64.npm-team.zip",
    );
    expect(() => folderPackageArchiveName("macos-arm64", "portable")).toThrow(TypeError);
  });
});

describe("the folder packages of a bundle", () => {
  function archives() {
    return new Map(
      FOLDER_RELEASE_TARGETS.map((target) => [
        target,
        { assetName: `keiko-${target}.zip`, sha256: sha256(`archive ${target}`) },
      ]),
    );
  }

  function bundle(mutate = () => undefined) {
    const root = mkdtempSync(join(tmpdir(), "keiko-folder-release-"));
    tempRoots.push(root);
    const directory = join(root, FOLDER_PACKAGES_DIRECTORY);
    mkdirSync(directory);
    const packages = [...archives()].map(([target, archive]) => {
      const assetName = folderPackageArchiveName(target, "standalone");
      const bytes = Buffer.from(`package ${target}`);
      writeFileSync(join(directory, assetName), bytes);
      writeFileSync(
        join(directory, `${assetName}.sha256`),
        folderChecksumText(sha256(bytes), assetName),
      );
      return {
        platformTarget: target,
        form: "standalone",
        assetName,
        sha256: sha256(bytes),
        sizeBytes: bytes.length,
        sourceArchive: archive,
      };
    });
    const manifest = folderPackagesManifest("1.2.3", packages);
    mutate(manifest, directory);
    writeFileSync(join(directory, FOLDER_PACKAGES_MANIFEST), JSON.stringify(manifest));
    return root;
  }

  function uploads(root, version = "1.2.3", reads = undefined) {
    return folderPackageUploads({
      bundleRoot: root,
      version,
      archives: archives(),
      ...(reads === undefined ? {} : { reads }),
    });
  }

  // The real reads, recorded, so a test can show which file the check never reached.
  function recordedReads() {
    return {
      digest: vi.fn((path, maxBytes) => sha256FileChunked(path, maxBytes)),
      text: vi.fn((path) => readFileSync(path, "utf8")),
    };
  }

  // File names, not paths: the check reads the bundle through its canonical path.
  function readNames(mock) {
    return mock.mock.calls.map(([path]) => basename(path));
  }

  it("uploads every package and its .sha256 file with the digests GitHub must report", () => {
    const result = uploads(bundle());

    expect(result.failures).toEqual([]);
    expect(result.uploads.map((upload) => upload.assetName)).toEqual(
      FOLDER_RELEASE_TARGETS.flatMap((target) => {
        const name = folderPackageArchiveName(target, "standalone");
        return [name, `${name}.sha256`];
      }),
    );
    const [zip, checksum] = result.uploads;
    // Only the package carries build provenance; its .sha256 file is derived from that digest.
    expect(
      result.uploads.filter((upload) => upload.attested).map((upload) => upload.assetName),
    ).toEqual(
      FOLDER_RELEASE_TARGETS.map((target) => folderPackageArchiveName(target, "standalone")),
    );
    expect(zip.sha256).toBe(sha256(Buffer.from("package macos-arm64")));
    expect(checksum.sha256).toBe(sha256(folderChecksumText(zip.sha256, zip.assetName)));
    expect(checksum.size).toBe(Buffer.byteLength(folderChecksumText(zip.sha256, zip.assetName)));
  });

  it.each([
    ["another Keiko version", () => undefined, "9.9.9", "folder packages must be of Keiko 9.9.9"],
    [
      "a missing target",
      (manifest) => manifest.packages.pop(),
      undefined,
      "the folder package of windows-x64 is missing",
    ],
    [
      "a repeated target",
      (manifest) => manifest.packages.push(manifest.packages[0]),
      undefined,
      "target macos-arm64 is unknown or repeated",
    ],
    [
      "a Linux package",
      (manifest) =>
        manifest.packages.push({ ...manifest.packages[0], platformTarget: "linux-x64" }),
      undefined,
      "target linux-x64 is unknown or repeated",
    ],
    [
      "an npm package",
      (manifest) => Object.assign(manifest.packages[0], { form: "npm" }),
      undefined,
      "macos-arm64 folder package must be a standalone folder package",
    ],
    [
      "a name an updater reads as an archive",
      (manifest) =>
        Object.assign(manifest.packages[1], { assetName: "keiko-macos-x64-standalone.zip" }),
      undefined,
      "macos-x64 folder package must not look like an archive",
    ],
    [
      "a package of another archive",
      (manifest) => Object.assign(manifest.packages[2].sourceArchive, { sha256: "0".repeat(64) }),
      undefined,
      "windows-x64 folder package must be built from this release's archive",
    ],
    [
      "a changed package",
      (manifest, directory) => writeFileSync(join(directory, manifest.packages[0].assetName), "x"),
      undefined,
      "keiko-macos-arm64.standalone.zip does not have the digest and size its manifest declares",
    ],
    [
      "a package of another size",
      (manifest) => Object.assign(manifest.packages[0], { sizeBytes: 1 }),
      undefined,
      "keiko-macos-arm64.standalone.zip does not have the digest and size its manifest declares",
    ],
    [
      "a checksum file with more than the binding line",
      (manifest, directory) =>
        writeFileSync(
          join(directory, `${manifest.packages[0].assetName}.sha256`),
          `${folderChecksumText(manifest.packages[0].sha256, manifest.packages[0].assetName)}x`,
        ),
      undefined,
      "keiko-macos-arm64.standalone.zip.sha256 must bind keiko-macos-arm64.standalone.zip",
    ],
    [
      "a checksum file of another package",
      (manifest, directory) =>
        writeFileSync(
          join(directory, `${manifest.packages[0].assetName}.sha256`),
          folderChecksumText("0".repeat(64), manifest.packages[0].assetName),
        ),
      undefined,
      "keiko-macos-arm64.standalone.zip.sha256 must bind keiko-macos-arm64.standalone.zip",
    ],
    [
      "a package that is a link",
      (manifest, directory) => {
        const path = join(directory, manifest.packages[0].assetName);
        rmSync(path);
        symlinkSync(join(directory, manifest.packages[1].assetName), path);
      },
      undefined,
      "keiko-macos-arm64.standalone.zip must be a regular file in folder-packages",
    ],
  ])("refuses %s", (_, mutate, version, message) => {
    const result = uploads(bundle(mutate), version);

    expect(result.failures.join("\n")).toContain(message);
  });

  it("refuses a bundle without folder packages, or whose folder is a link", () => {
    const root = bundle();
    const empty = mkdtempSync(join(tmpdir(), "keiko-folder-release-"));
    tempRoots.push(empty);
    expect(uploads(empty).failures).toEqual([
      "the portable asset bundle carries no folder packages.",
    ]);

    symlinkSync(join(root, FOLDER_PACKAGES_DIRECTORY), join(empty, FOLDER_PACKAGES_DIRECTORY));
    expect(uploads(empty).failures).toEqual([
      "the portable asset bundle carries no folder packages.",
    ]);
  });

  it.each([
    ["a package", (name) => name],
    ["a checksum file", (name) => `${name}.sha256`],
  ])("never reads %s larger than its manifest declares (PR #4464)", (_, fileOf) => {
    // Review finding on PR #4464 (P2): each file was read whole before its size was compared. A
    // sparse 3 GiB file costs no disk, and reading it whole would throw: the refusal proves the
    // size was compared first.
    let oversized = "";
    const root = bundle((manifest, directory) => {
      oversized = fileOf(manifest.packages[0].assetName);
      truncateSync(join(directory, oversized), 3 * 1024 ** 3);
    });
    const reads = recordedReads();

    expect(uploads(root, "1.2.3", reads).failures.join("\n")).toMatch(
      /keiko-macos-arm64\.standalone\.zip(\.sha256 must bind| does not have the digest)/u,
    );
    // Review finding on PR #4464: the refusal alone does not show the file was never read.
    expect([...readNames(reads.digest), ...readNames(reads.text)]).not.toContain(oversized);
    // The other packages are still checked, so the reads ran.
    expect(reads.digest).toHaveBeenCalled();
  });

  it("refuses a package GitHub would not accept before reading any of it (PR #4464)", () => {
    // Review finding on PR #4464: a 3 GiB package that declares its real size passed the size
    // comparison and was hashed to its end before anything refused it.
    let oversized = "";
    const root = bundle((manifest, directory) => {
      oversized = manifest.packages[0].assetName;
      truncateSync(join(directory, oversized), 3 * 1024 ** 3);
      manifest.packages[0].sizeBytes = 3 * 1024 ** 3;
    });
    const reads = recordedReads();

    expect(uploads(root, "1.2.3", reads).failures).toEqual([
      `macos-arm64 folder package must be smaller than the ${String(FOLDER_PACKAGE_MAX_BYTES + 1)} bytes GitHub accepts.`,
    ]);
    expect(readNames(reads.digest)).not.toContain(oversized);
  });

  it("hashes a package no further than its declared size (PR #4464)", () => {
    // Review finding on PR #4464: a package that grew after its size was compared was read to its
    // end. The check now bounds the read by the declared size.
    const reads = recordedReads();
    const result = uploads(bundle(), "1.2.3", reads);

    expect(result.failures).toEqual([]);
    expect(reads.digest.mock.calls.map(([, maxBytes]) => maxBytes)).toEqual(
      result.uploads.filter((upload) => upload.attested).map((upload) => upload.size),
    );
    const grown = join(mkdtempSync(join(tmpdir(), "keiko-folder-grown-")), "package.zip");
    tempRoots.push(dirname(grown));
    writeFileSync(grown, "0123456789");
    expect(sha256FileChunked(grown, 10)).toBe(sha256("0123456789"));
    expect(sha256FileChunked(grown, 9)).toBeUndefined();
    expect(sha256FileChunked(grown)).toBe(sha256("0123456789"));
  });

  it("refuses an oversized manifest before reading it (PR #4464)", () => {
    // Review finding on PR #4464 (P2): the manifest was read to its end whatever its size.
    const root = bundle();
    const path = join(root, FOLDER_PACKAGES_DIRECTORY, FOLDER_PACKAGES_MANIFEST);
    const manifest = JSON.stringify(folderPackagesManifest("1.2.3", []));
    writeFileSync(path, manifest.padEnd(FOLDER_PACKAGES_MANIFEST_MAX_BYTES + 1, " "));
    const reads = recordedReads();

    expect(uploads(root, "1.2.3", reads).failures).toEqual([
      `folder-packages.json is larger than ${String(FOLDER_PACKAGES_MANIFEST_MAX_BYTES)} bytes.`,
    ]);
    // Review finding on PR #4464: the size error alone does not show the read never happened.
    expect(reads.text).not.toHaveBeenCalled();
  });

  it("refuses a manifest that is not one", () => {
    const root = bundle();
    writeFileSync(join(root, FOLDER_PACKAGES_DIRECTORY, FOLDER_PACKAGES_MANIFEST), "{");

    expect(uploads(root).failures).toEqual([
      "the portable asset bundle carries no readable folder-packages.json.",
    ]);
  });
});
