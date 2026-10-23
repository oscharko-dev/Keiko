import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RIPGREP_RUNTIME_MANIFEST,
  ripgrepRuntimeApproval,
} from "../../packages/keiko-server/src/coding-runtime/ripgrepRuntime.ts";
import {
  extractApprovedFiles,
  fail,
  isTrustedProvisionedRipgrep,
  memberPath,
  provisionRipgrep,
} from "../provision-ripgrep.mjs";

const roots = [];
const POSIX = process.platform !== "win32";
const SYSTEM_TAR = "/usr/bin/tar";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function temporaryRoot(prefix = "keiko-provision-ripgrep-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(root, 0o755);
  roots.push(root);
  return root;
}

function fixture({ archiveKind = "tar.gz", binaryName = "rg" } = {}) {
  const archive = Buffer.from("approved archive bytes");
  const binary = Buffer.from("approved ripgrep executable");
  const license = Buffer.from("MIT fixture license\n");
  const approvalFor = (overrides = {}) => ({
    archiveKind,
    archiveUrl: "https://invalid.example.test/ripgrep.archive",
    archiveSha256: sha256(archive),
    archiveSizeBytes: archive.length,
    binaryMember: `ripgrep-test/${binaryName}`,
    binarySha256: sha256(binary),
    binarySizeBytes: binary.length,
    licenseMember: "ripgrep-test/LICENSE-MIT",
    licenseSha256: sha256(license),
    ...overrides,
  });
  const runtimeManifest = {
    version: "0.0.0-test",
    sourceCommit: "a".repeat(40),
    licenseExpression: "MIT",
    licenseFileName: "LICENSE-MIT",
    targets: { "linux-x64": approvalFor() },
  };
  return { archive, binary, license, root: temporaryRoot(), runtimeManifest, approvalFor };
}

function installedPaths(root, runtimeManifest = { version: "0.0.0-test" }) {
  const directory = join(root, ".ripgrep", runtimeManifest.version, "linux-x64");
  return {
    directory,
    binary: join(directory, "rg"),
    license: join(directory, "LICENSE-MIT"),
    provenance: join(directory, "PROVENANCE.txt"),
  };
}

function writeMembers(staging, approval, { binary, license }) {
  const binaryPath = memberPath(staging, approval.binaryMember);
  const licensePath = memberPath(staging, approval.licenseMember);
  mkdirSync(dirname(binaryPath), { recursive: true });
  writeFileSync(binaryPath, binary);
  writeFileSync(licensePath, license);
}

function provisionOptions(provision, overrides = {}) {
  const counters = { downloads: 0, logs: [] };
  return {
    counters,
    options: {
      downloadFile: (destination) => {
        counters.downloads += 1;
        writeFileSync(destination, provision.archive);
      },
      extractFiles: (_archive, staging, approval) => writeMembers(staging, approval, provision),
      failWith: (message) => {
        throw new Error(message);
      },
      hostArchitecture: "x64",
      hostPlatform: "linux",
      log: (message) => counters.logs.push(message),
      root: provision.root,
      runtimeManifest: provision.runtimeManifest,
      ...overrides,
    },
  };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("provision-ripgrep", () => {
  it("provisions the approved executable and license, then reuses them without a download", () => {
    const provision = fixture();
    const { options, counters } = provisionOptions(provision);

    const binaryPath = provisionRipgrep(options);
    const paths = installedPaths(provision.root);

    expect(binaryPath).toBe(paths.binary);
    expect(readFileSync(paths.binary)).toEqual(provision.binary);
    expect(readFileSync(paths.license)).toEqual(provision.license);
    expect(readFileSync(paths.provenance, "utf8")).toBe(
      [
        "version=0.0.0-test",
        `sourceCommit=${"a".repeat(40)}`,
        "target=linux-x64",
        "archiveUrl=https://invalid.example.test/ripgrep.archive",
        `archiveSha256=${sha256(provision.archive)}`,
        "",
      ].join("\n"),
    );
    expect(readdirSync(paths.directory).sort()).toEqual(["LICENSE-MIT", "PROVENANCE.txt", "rg"]);
    if (POSIX) {
      expect(statSync(paths.binary).mode & 0o777).toBe(0o755);
      expect(statSync(paths.license).mode & 0o777).toBe(0o644);
    }
    expect(counters.downloads).toBe(1);

    expect(provisionRipgrep(options)).toBe(binaryPath);
    expect(counters.downloads).toBe(1);
    expect(counters.logs).toEqual([
      `provision-ripgrep: verified and extracted to ${binaryPath}`,
      `provision-ripgrep: already verified at ${binaryPath}`,
    ]);
  });

  it("downloads the exact approved archive URL under the governed failure reporter", () => {
    const provision = fixture();
    const calls = [];
    const { options } = provisionOptions(provision, {
      downloadFile: (destination, source, adapters) => {
        calls.push({ source, hasFailWith: typeof adapters.failWith === "function" });
        writeFileSync(destination, provision.archive);
      },
    });

    provisionRipgrep(options);

    expect(calls).toEqual([
      { source: { tarballUrl: "https://invalid.example.test/ripgrep.archive" }, hasFailWith: true },
    ]);
  });

  it("skips a host without an approved runtime and writes nothing", () => {
    const provision = fixture();
    const { options, counters } = provisionOptions(provision, {
      hostPlatform: "freebsd",
    });

    expect(provisionRipgrep(options)).toBeUndefined();
    expect(counters.logs).toEqual([
      "provision-ripgrep: no approved runtime for freebsd-x64; skipping.",
    ]);
    expect(existsSync(join(provision.root, ".ripgrep"))).toBe(false);
    expect(counters.downloads).toBe(0);
  });

  it("rejects a downloaded archive whose digest is not approved and installs nothing", () => {
    const provision = fixture();
    const { options } = provisionOptions(provision, {
      downloadFile: (destination) => writeFileSync(destination, "tampered archive"),
    });

    expect(() => provisionRipgrep(options)).toThrow("archive checksum mismatch");
    expect(existsSync(join(provision.root, ".ripgrep"))).toBe(false);
  });

  it.each([
    ["executable", { binary: Buffer.from("tampered executable") }, "executable checksum mismatch"],
    ["license", { license: Buffer.from("tampered license") }, "license checksum mismatch"],
  ])("rejects a tampered %s inside a correctly digested archive", (_label, members, message) => {
    const provision = fixture();
    const { options } = provisionOptions(provision, {
      extractFiles: (_archive, staging, approval) =>
        writeMembers(staging, approval, { ...provision, ...members }),
    });

    expect(() => provisionRipgrep(options)).toThrow(message);
    expect(existsSync(join(provision.root, ".ripgrep"))).toBe(false);
  });

  it("rejects an executable whose size differs from the approval even with a matching digest", () => {
    const provision = fixture();
    provision.runtimeManifest.targets["linux-x64"] = provision.approvalFor({
      binarySizeBytes: provision.binary.length + 1,
    });
    const { options } = provisionOptions(provision);

    expect(() => provisionRipgrep(options)).toThrow("executable size does not match the approval");
  });

  it("rejects an archive that did not produce an approved member", () => {
    const provision = fixture();
    const { options } = provisionOptions(provision, { extractFiles: () => undefined });

    expect(() => provisionRipgrep(options)).toThrow("extracted executable is not a regular file");
  });

  it.skipIf(!POSIX)(
    "rejects an extracted symlink even when its target has the approved bytes",
    () => {
      const provision = fixture();
      const outside = join(temporaryRoot(), "outside-rg");
      writeFileSync(outside, provision.binary);
      const { options } = provisionOptions(provision, {
        extractFiles: (_archive, staging, approval) => {
          writeMembers(staging, approval, provision);
          const binaryPath = memberPath(staging, approval.binaryMember);
          rmSync(binaryPath);
          symlinkSync(outside, binaryPath);
        },
      });

      expect(() => provisionRipgrep(options)).toThrow("extracted executable is not a regular file");
      expect(existsSync(join(provision.root, ".ripgrep"))).toBe(false);
    },
  );

  it("replaces an installed runtime that no longer verifies", () => {
    const provision = fixture();
    const { options, counters } = provisionOptions(provision);
    provisionRipgrep(options);
    const paths = installedPaths(provision.root);
    writeFileSync(paths.binary, "tampered after install");

    expect(provisionRipgrep(options)).toBe(paths.binary);
    expect(readFileSync(paths.binary)).toEqual(provision.binary);
    expect(counters.downloads).toBe(2);
  });

  it.each([
    ["executable", [false, false]],
    ["license", [false, false]],
  ])("fails closed when the installed %s loses trust", (_label, results) => {
    const provision = fixture();
    let call = 0;
    const { options } = provisionOptions(provision, {
      trustFile: () => results[call++] ?? false,
    });

    expect(() => provisionRipgrep(options)).toThrow(
      "provisioned runtime ownership, permissions, or digest verification failed",
    );
  });

  it("accepts a runtime only when both the executable and the license verify", () => {
    const provision = fixture();
    const { options } = provisionOptions(provision);
    provisionRipgrep(options);
    const paths = installedPaths(provision.root);
    const approval = ripgrepRuntimeApproval("linux-x64", provision.runtimeManifest);

    expect(isTrustedProvisionedRipgrep(paths.binary, paths.license, approval)).toBe(true);
    writeFileSync(paths.license, "tampered license");
    expect(isTrustedProvisionedRipgrep(paths.binary, paths.license, approval)).toBe(false);
    expect(
      isTrustedProvisionedRipgrep(paths.binary, join(paths.directory, "absent"), approval),
    ).toBe(false);
  });

  it("reports a failure through the prefixed reporter and exits nonzero", () => {
    const errors = [];
    const exits = [];
    fail("fixture failure", {
      error: (message) => errors.push(message),
      exit: (code) => exits.push(code),
    });
    expect(errors).toEqual(["provision-ripgrep: fixture failure"]);
    expect(exits).toEqual([1]);
  });
});

describe("extractApprovedFiles", () => {
  const approval = (archiveKind) =>
    ripgrepRuntimeApproval(archiveKind === "zip" ? "win32-x64" : "linux-x64");

  it.each([
    ["tar.gz", "-xzf"],
    ["zip", "-xf"],
  ])("names only the two approved members for a %s archive", (archiveKind, flag) => {
    const calls = [];
    const target = approval(archiveKind);

    extractApprovedFiles("/tmp/archive", "/tmp/staging", target, {
      binaries: { tar: "/approved/tar" },
      execute: (...args) => calls.push(args),
      exists: () => true,
    });

    expect(calls).toEqual([
      [
        "/approved/tar",
        [flag, "/tmp/archive", "-C", "/tmp/staging", target.binaryMember, target.licenseMember],
        { stdio: ["ignore", "ignore", "inherit"] },
      ],
    ]);
  });

  it("fails closed when the governed tar is unavailable", () => {
    expect(() =>
      extractApprovedFiles("/tmp/archive", "/tmp/staging", approval("tar.gz"), {
        binaries: { tar: "/missing/tar" },
        exists: () => false,
      }),
    ).toThrow();
  });

  it.skipIf(!POSIX || !existsSync(SYSTEM_TAR))(
    "extracts nothing but the approved members from a real archive",
    () => {
      const provision = fixture();
      const source = temporaryRoot("keiko-ripgrep-archive-source-");
      const top = join(source, "ripgrep-test");
      mkdirSync(join(top, "doc"), { recursive: true });
      writeFileSync(join(top, "rg"), provision.binary);
      writeFileSync(join(top, "LICENSE-MIT"), provision.license);
      writeFileSync(join(top, "README.md"), "decoy");
      writeFileSync(join(top, "doc", "CHANGELOG.md"), "decoy");
      const archive = join(temporaryRoot("keiko-ripgrep-archive-"), "ripgrep.tar.gz");
      execFileSync(SYSTEM_TAR, ["-czf", archive, "-C", source, "ripgrep-test"]);
      const staging = temporaryRoot("keiko-ripgrep-staging-");
      const { options } = provisionOptions(provision, {
        downloadFile: (destination) => writeFileSync(destination, readFileSync(archive)),
        extractFiles: (file, directory, approvalValue) =>
          extractApprovedFiles(file, directory, approvalValue),
      });
      provision.runtimeManifest.targets["linux-x64"] = provision.approvalFor({
        archiveSha256: sha256(readFileSync(archive)),
      });

      extractApprovedFiles(archive, staging, provision.approvalFor());
      expect(readdirSync(join(staging, "ripgrep-test")).sort()).toEqual(["LICENSE-MIT", "rg"]);

      const installed = provisionRipgrep(options);
      expect(readFileSync(installed)).toEqual(provision.binary);
    },
  );
});

describe("the real approval table", () => {
  it("installs under the version and target of the shipped manifest", () => {
    const root = temporaryRoot();
    const approval = ripgrepRuntimeApproval("darwin-arm64");
    const logs = [];
    const result = provisionRipgrep({
      downloadFile: () => {
        throw new Error("a hermetic test must never download");
      },
      hostArchitecture: "arm64",
      hostPlatform: "darwin",
      log: (message) => logs.push(message),
      root,
      trustFile: () => true,
    });

    expect(result).toBe(
      join(root, ".ripgrep", RIPGREP_RUNTIME_MANIFEST.version, "darwin-arm64", approval.binaryName),
    );
    expect(logs).toEqual([`provision-ripgrep: already verified at ${result}`]);
  });
});
