import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  download,
  extractApprovedFiles,
  fail,
  isTrustedProvisionedUsearchFile,
  provisionedUsearchBinaryPath,
  provisionUsearch,
  systemBinariesFor,
  systemBinary,
  trustedPosixOwnerAndMode,
} from "../provision-usearch.mjs";
import {
  USEARCH_RUNTIME_MANIFEST,
  usearchRuntimeApproval,
} from "../../packages/keiko-local-knowledge/src/retrieval/usearch-runtime-manifest.ts";

const roots = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "keiko-provision-usearch-"));
  roots.push(root);
  const path = join(root, "usearch.node");
  writeFileSync(path, "verified runtime", { mode: 0o644 });
  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  return { path, root, sha256 };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function provisionFixture() {
  const root = mkdtempSync(join(tmpdir(), "keiko-provision-usearch-flow-"));
  roots.push(root);
  const archive = Buffer.from("approved archive");
  const binary = Buffer.from("approved native runtime");
  const license = Buffer.from("Apache-2.0 fixture license");
  const runtimeManifest = {
    version: "1.2.3-test",
    sourceCommit: "0123456789abcdef",
    tarballUrl: "https://invalid.example.test/usearch.tgz",
    tarballSha256: sha256(archive),
    licenseSha256: sha256(license),
    targets: {
      "linux-x64": {
        archivePath: "package/prebuilds/linux-x64/usearch.node",
        binarySha256: sha256(binary),
      },
    },
  };
  return { archive, binary, license, root, runtimeManifest };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("provisioned USearch runtime trust", () => {
  it("accepts a regular digest-bound file in an owner-controlled directory", () => {
    const runtime = fixture();
    expect(isTrustedProvisionedUsearchFile(runtime.path, runtime.sha256)).toBe(true);
  });

  it.skipIf(process.getuid === undefined || process.getuid() === 0)(
    "rejects group/world-writable runtime files and directories on POSIX",
    () => {
      const writableFile = fixture();
      chmodSync(writableFile.path, 0o666);
      expect(isTrustedProvisionedUsearchFile(writableFile.path, writableFile.sha256)).toBe(false);

      const writableDirectory = fixture();
      chmodSync(writableDirectory.root, 0o777);
      expect(
        isTrustedProvisionedUsearchFile(writableDirectory.path, writableDirectory.sha256),
      ).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a symlink even when its target has the approved digest",
    () => {
      const runtime = fixture();
      const linked = join(runtime.root, "linked.node");
      symlinkSync(runtime.path, linked);
      expect(isTrustedProvisionedUsearchFile(linked, runtime.sha256)).toBe(false);
    },
  );

  it.skipIf(process.getuid === undefined || process.getuid() === 0)(
    "rejects a file outside the supplied POSIX ownership boundary",
    () => {
      const runtime = fixture();
      const actualUid = process.getuid?.() ?? 1;
      const untrustedUid = actualUid === 1 ? 2 : 1;
      expect(
        isTrustedProvisionedUsearchFile(runtime.path, runtime.sha256, {
          currentUid: untrustedUid,
        }),
      ).toBe(false);
    },
  );

  it("rejects missing files and digest mismatches without leaking an exception", () => {
    const runtime = fixture();
    expect(
      isTrustedProvisionedUsearchFile(join(runtime.root, "missing.node"), runtime.sha256),
    ).toBe(false);
    expect(isTrustedProvisionedUsearchFile(runtime.path, sha256("different bytes"))).toBe(false);
    expect(
      isTrustedProvisionedUsearchFile(runtime.path, runtime.sha256, { currentUid: undefined }),
    ).toBe(true);
    expect(isTrustedProvisionedUsearchFile(runtime.root, runtime.sha256)).toBe(false);
  });

  it("resolves only approved host targets under the requested root", () => {
    const root = "/workspace";
    expect(provisionedUsearchBinaryPath(root, "linux", "x64")).toContain("/workspace/.usearch/");
    expect(provisionedUsearchBinaryPath(root, "freebsd", "x64")).toBeUndefined();
  });

  it("pins the compatible Intel macOS source without changing other platform approvals", () => {
    expect(usearchRuntimeApproval("darwin-x64", USEARCH_RUNTIME_MANIFEST)).toMatchObject({
      version: "2.21.4",
      sourceCommit: "a2f17599101729d667dc0260dd278852d9098183",
      tarballSha256: "f04ffee2386bb21d2ba3841d7ce3203530138772f408e9de767cb249fe5ccfda",
      binarySha256: "c006e4774917d8bc1efc0382e7f31dcdb08c1f625091dbe7eeafd43ae7a660e6",
    });
    expect(usearchRuntimeApproval("darwin-arm64", USEARCH_RUNTIME_MANIFEST)?.version).toBe(
      "2.26.0",
    );
    expect(usearchRuntimeApproval("win32-x64", USEARCH_RUNTIME_MANIFEST)?.version).toBe("2.26.0");
  });

  it("provisions a target-specific source approval and records its provenance", () => {
    const provision = provisionFixture();
    const targetSource = {
      version: "1.2.2-compatible",
      sourceCommit: "fedcba9876543210",
      tarballUrl: "https://invalid.example.test/usearch-compatible.tgz",
      tarballSha256: provision.runtimeManifest.tarballSha256,
      licenseSha256: provision.runtimeManifest.licenseSha256,
    };
    provision.runtimeManifest.targets["linux-x64"].source = targetSource;
    let downloadedApproval;

    const binaryPath = provisionUsearch({
      downloadFile: (destination, approval) => {
        downloadedApproval = approval;
        writeFileSync(destination, provision.archive);
      },
      extractFiles: (_tarball, staging, archivePath) => {
        const extractedBinary = join(staging, archivePath);
        const extractedLicense = join(staging, "package", "LICENSE");
        mkdirSync(dirname(extractedBinary), { recursive: true });
        mkdirSync(dirname(extractedLicense), { recursive: true });
        writeFileSync(extractedBinary, provision.binary);
        writeFileSync(extractedLicense, provision.license);
      },
      hostArchitecture: "x64",
      hostPlatform: "linux",
      root: provision.root,
      runtimeManifest: provision.runtimeManifest,
    });

    expect(binaryPath).toBe(
      join(provision.root, ".usearch", targetSource.version, "linux-x64", "usearch.node"),
    );
    expect(downloadedApproval).toMatchObject(targetSource);
    expect(readFileSync(join(dirname(binaryPath), "PROVENANCE.txt"), "utf8")).toContain(
      `version=${targetSource.version}`,
    );
  });

  it("selects governed system binaries and fails closed when one is unavailable", () => {
    expect(systemBinariesFor("linux")).toEqual({ curl: "/usr/bin/curl", tar: "/usr/bin/tar" });
    expect(systemBinariesFor("win32", String.raw`D:\Windows`)).toEqual({
      curl: join(String.raw`D:\Windows`, "System32", "curl.exe"),
      tar: join(String.raw`D:\Windows`, "System32", "tar.exe"),
    });
    expect(systemBinariesFor("win32").curl).toContain("Windows");
    expect(() =>
      systemBinary(
        "curl",
        { curl: "/missing/curl" },
        {
          exists: () => false,
          failWith: (message) => {
            throw new Error(message);
          },
        },
      ),
    ).toThrow("required system binary not found");
    expect(systemBinary("curl", { curl: "/approved/curl" }, { exists: () => true })).toBe(
      "/approved/curl",
    );
  });

  it("routes system archive operations through the governed binary paths", () => {
    const calls = [];
    const execute = (...args) => calls.push(args);
    const options = {
      binaries: { curl: "/approved/curl", tar: "/approved/tar" },
      execute,
      exists: () => true,
      inspect: () => ({ isFile: () => true, size: 1024 }),
    };

    download("/tmp/runtime.tgz", { tarballUrl: "https://example.test/runtime.tgz" }, options);
    extractApprovedFiles(
      "/tmp/runtime.tgz",
      "/tmp/staging",
      "package/prebuilds/linux-x64/usearch.node",
      options,
    );

    expect(calls.map(([binary]) => binary)).toEqual(["/approved/curl", "/approved/tar"]);
    expect(calls[0]?.[1]).toEqual([
      "--proto",
      "=https",
      "--connect-timeout",
      "10",
      "--max-time",
      "300",
      "--max-filesize",
      "67108864",
      "-sSfL",
      "-o",
      "/tmp/runtime.tgz",
      "https://example.test/runtime.tgz",
    ]);
  });

  it("deletes and rejects a downloaded archive that exceeds the hard byte limit", () => {
    const removed = [];
    const failures = [];
    download(
      "/tmp/oversized-runtime.tgz",
      { tarballUrl: "https://example.test/runtime.tgz" },
      {
        binaries: { curl: "/approved/curl" },
        execute: () => undefined,
        exists: () => true,
        failWith: (message) => failures.push(message),
        inspect: () => ({ isFile: () => true, size: 64 * 1024 * 1024 + 1 }),
        remove: (...args) => removed.push(args),
      },
    );

    expect(removed).toEqual([["/tmp/oversized-runtime.tgz", { force: true }]]);
    expect(failures).toEqual(["downloaded archive exceeds the 67108864 byte limit"]);
  });

  it("keeps platform-neutral trust and failure adapters deterministic", () => {
    expect(trustedPosixOwnerAndMode({ uid: 123, mode: 0o666 }, undefined)).toBe(true);
    const errors = [];
    const exits = [];
    fail("fixture failure", {
      error: (message) => errors.push(message),
      exit: (code) => exits.push(code),
    });
    expect(errors).toEqual(["provision-usearch: fixture failure"]);
    expect(exits).toEqual([1]);
  });

  it("provisions and then reuses a hermetic digest-bound runtime", () => {
    const provision = provisionFixture();
    const logs = [];
    let downloads = 0;
    const downloadFile = (destination) => {
      downloads += 1;
      writeFileSync(destination, provision.archive);
    };
    const extractFiles = (_tarball, staging, archivePath) => {
      const binaryPath = join(staging, archivePath);
      const licensePath = join(staging, "package", "LICENSE");
      mkdirSync(dirname(binaryPath), { recursive: true });
      mkdirSync(dirname(licensePath), { recursive: true });
      writeFileSync(binaryPath, provision.binary);
      writeFileSync(licensePath, provision.license);
    };
    const options = {
      downloadFile,
      extractFiles,
      hostArchitecture: "x64",
      hostPlatform: "linux",
      log: (message) => logs.push(message),
      root: provision.root,
      runtimeManifest: provision.runtimeManifest,
    };

    const binaryPath = provisionUsearch(options);
    expect(binaryPath).toBe(
      join(
        provision.root,
        ".usearch",
        provision.runtimeManifest.version,
        "linux-x64",
        "usearch.node",
      ),
    );
    expect(readFileSync(binaryPath)).toEqual(provision.binary);
    expect(readFileSync(join(dirname(binaryPath), "PROVENANCE.txt"), "utf8")).toContain(
      "target=linux-x64",
    );
    expect(downloads).toBe(1);
    expect(provisionUsearch(options)).toBe(binaryPath);
    expect(downloads).toBe(1);
    expect(logs).toEqual([
      `provision-usearch: verified and extracted to ${binaryPath}`,
      `provision-usearch: already verified at ${binaryPath}`,
    ]);
  });

  it("skips hosts without an approved runtime without creating state", () => {
    const provision = provisionFixture();
    const logs = [];
    expect(
      provisionUsearch({
        hostArchitecture: "x64",
        hostPlatform: "freebsd",
        log: (message) => logs.push(message),
        root: provision.root,
        runtimeManifest: provision.runtimeManifest,
      }),
    ).toBeUndefined();
    expect(logs).toEqual(["provision-usearch: no approved runtime for freebsd-x64; skipping."]);
  });

  it("rejects a downloaded archive whose digest is not approved", () => {
    const provision = provisionFixture();
    expect(() =>
      provisionUsearch({
        downloadFile: (destination) => writeFileSync(destination, "tampered archive"),
        failWith: (message) => {
          throw new Error(message);
        },
        hostArchitecture: "x64",
        hostPlatform: "linux",
        root: provision.root,
        runtimeManifest: provision.runtimeManifest,
      }),
    ).toThrow("checksum mismatch");
  });

  it.each([
    ["binary", [false, false]],
    ["license", [true, false, true, false]],
  ])("fails closed when the installed %s loses trust", (_kind, trustResults) => {
    const provision = provisionFixture();
    let trustCall = 0;
    expect(() =>
      provisionUsearch({
        downloadFile: (destination) => writeFileSync(destination, provision.archive),
        extractFiles: (_tarball, staging, archivePath) => {
          const binaryPath = join(staging, archivePath);
          const licensePath = join(staging, "package", "LICENSE");
          mkdirSync(dirname(binaryPath), { recursive: true });
          mkdirSync(dirname(licensePath), { recursive: true });
          writeFileSync(binaryPath, provision.binary);
          writeFileSync(licensePath, provision.license);
        },
        failWith: (message) => {
          throw new Error(message);
        },
        hostArchitecture: "x64",
        hostPlatform: "linux",
        root: provision.root,
        runtimeManifest: provision.runtimeManifest,
        trustFile: () => trustResults[trustCall++] ?? false,
      }),
    ).toThrow("provisioned runtime ownership, permissions, or digest verification failed");
  });
});
