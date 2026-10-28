import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type * as FsModule from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RIPGREP_PORTABLE_LICENSE_PATH,
  RIPGREP_RUNTIME_MANIFEST,
  RIPGREP_VERIFICATION_REASONS,
  ripgrepBinaryName,
  ripgrepPortableExecutablePath,
  ripgrepProvisionedBinaryPath,
  ripgrepProvisionedDirectory,
  ripgrepRuntimeApproval,
  ripgrepRuntimeTargetKey,
  resolveVerifiedRipgrep,
  ripgrepActivationDigest,
  verifyPinnedRuntimeFile,
  verifyRipgrepExecutable,
  type RipgrepRuntimeManifest,
} from "./ripgrepRuntime.js";

// A read hook lets one test change the file between the identity check and the post-read recheck,
// which is the only way to reach the changed-during-verification refusal hermetically.
const readHook = vi.hoisted(() => ({ onRead: undefined as (() => void) | undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return {
    ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      const hook = readHook.onRead;
      readHook.onRead = undefined;
      hook?.();
      return actual.readFileSync(...args);
    }) as typeof actual.readFileSync,
  };
});

const HEX_64 = /^[0-9a-f]{64}$/u;
const POSIX = process.platform !== "win32";
const NOT_ROOT = POSIX && process.getuid?.() !== 0;
const roots: string[] = [];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-ripgrep-runtime-"));
  chmodSync(root, 0o755);
  roots.push(root);
  return root;
}

function fixtureManifest(binarySha256: string): RipgrepRuntimeManifest {
  return {
    version: "0.0.0-test",
    sourceCommit: "a".repeat(40),
    licenseExpression: "MIT",
    licenseFileName: "LICENSE-MIT",
    targets: {
      "linux-x64": {
        archiveKind: "tar.gz",
        archiveUrl: "https://example.test/ripgrep.tar.gz",
        archiveSha256: "b".repeat(64),
        archiveSizeBytes: 10,
        binaryMember: "ripgrep/rg",
        binarySha256,
        binarySizeBytes: 5,
        licenseMember: "ripgrep/LICENSE-MIT",
        licenseSha256: "c".repeat(64),
      },
    },
  };
}

function writeExecutable(path: string, content: string): string {
  for (let directory = dirname(path); !roots.includes(directory); directory = dirname(directory)) {
    mkdirSync(directory, { recursive: true });
    chmodSync(directory, 0o755);
  }
  writeFileSync(path, content);
  chmodSync(path, 0o755);
  return path;
}

function portableFixture(content = "fixture ripgrep"): {
  readonly root: string;
  readonly path: string;
  readonly manifest: RipgrepRuntimeManifest;
} {
  const root = temporaryRoot();
  const path = writeExecutable(join(root, "runtime", "native", "rg"), content);
  return { root, path, manifest: fixtureManifest(sha256(content)) };
}

afterEach(() => {
  readHook.onRead = undefined;
  while (roots.length > 0) rmSync(roots.pop() ?? "", { recursive: true, force: true });
});

describe("ripgrep runtime manifest", () => {
  const targets = Object.entries(RIPGREP_RUNTIME_MANIFEST.targets);

  it("pins the six approved targets of the one ripgrep release OpenCode would download", () => {
    expect(RIPGREP_RUNTIME_MANIFEST.version).toBe("15.1.0");
    expect(Object.keys(RIPGREP_RUNTIME_MANIFEST.targets).sort()).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win32-arm64",
      "win32-x64",
    ]);
    expect(RIPGREP_RUNTIME_MANIFEST.sourceCommit).toMatch(/^[0-9a-f]{40}$/u);
  });

  it.each(targets)(
    "binds %s to an exact upstream archive, member and digest set",
    (key, target) => {
      const release = `ripgrep-${RIPGREP_RUNTIME_MANIFEST.version}`;
      const triple = target.archiveUrl.slice(
        target.archiveUrl.indexOf(`${release}-`) + release.length + 1,
        -`.${target.archiveKind}`.length,
      );
      expect(target.archiveUrl).toBe(
        `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_RUNTIME_MANIFEST.version}/${release}-${triple}.${target.archiveKind}`,
      );
      expect(target.binaryMember).toBe(`${release}-${triple}/${ripgrepBinaryName(key)}`);
      expect(target.licenseMember).toBe(`${release}-${triple}/LICENSE-MIT`);
      expect(target.archiveKind).toBe(key.startsWith("win32-") ? "zip" : "tar.gz");
      for (const digest of [target.archiveSha256, target.binarySha256, target.licenseSha256]) {
        expect(digest).toMatch(HEX_64);
      }
      for (const size of [target.archiveSizeBytes, target.binarySizeBytes]) {
        expect(Number.isSafeInteger(size)).toBe(true);
        expect(size).toBeGreaterThan(0);
      }
      expect(Object.isFrozen(target)).toBe(true);
    },
  );

  it("pins the statically linked musl build on linux-x64 and the glibc build on linux-arm64", () => {
    expect(RIPGREP_RUNTIME_MANIFEST.targets["linux-x64"].archiveUrl).toContain(
      "x86_64-unknown-linux-musl",
    );
    expect(RIPGREP_RUNTIME_MANIFEST.targets["linux-arm64"].archiveUrl).toContain(
      "aarch64-unknown-linux-gnu",
    );
  });

  it("pins distinct executables per target and the shared LF license for POSIX targets", () => {
    const binaries = targets.map(([, target]) => target.binarySha256);
    expect(new Set(binaries).size).toBe(binaries.length);
    const posixLicenses = targets
      .filter(([key]) => !key.startsWith("win32-"))
      .map(([, target]) => target.licenseSha256);
    expect(new Set(posixLicenses).size).toBe(1);
  });

  it("is deeply frozen so no caller can retarget an approval at run time", () => {
    expect(Object.isFrozen(RIPGREP_RUNTIME_MANIFEST)).toBe(true);
    expect(Object.isFrozen(RIPGREP_RUNTIME_MANIFEST.targets)).toBe(true);
  });
});

describe("ripgrep runtime target resolution", () => {
  it.each([
    ["darwin", "arm64", "darwin-arm64"],
    ["darwin", "x64", "darwin-x64"],
    ["linux", "arm64", "linux-arm64"],
    ["linux", "x64", "linux-x64"],
    ["win32", "x64", "win32-x64"],
    ["win32", "arm64", "win32-arm64"],
  ])("maps %s %s to %s", (platform, architecture, expected) => {
    expect(ripgrepRuntimeTargetKey(platform, architecture)).toBe(expected);
    expect(ripgrepRuntimeApproval(expected)).toMatchObject({
      targetKey: expected,
      version: "15.1.0",
      binaryName: platform === "win32" ? "rg.exe" : "rg",
      licenseFileName: "LICENSE-MIT",
      licenseExpression: "Unlicense OR MIT",
    });
  });

  it("returns no approval for an unsupported host or an inherited object key", () => {
    expect(ripgrepRuntimeTargetKey("freebsd", "x64")).toBeUndefined();
    expect(ripgrepRuntimeTargetKey("linux", "ia32")).toBeUndefined();
    expect(ripgrepRuntimeTargetKey("__proto__", "x64")).toBeUndefined();
    expect(ripgrepRuntimeApproval(undefined)).toBeUndefined();
    expect(ripgrepRuntimeApproval("freebsd-x64")).toBeUndefined();
    expect(ripgrepRuntimeApproval("constructor")).toBeUndefined();
    expect(ripgrepRuntimeApproval("toString")).toBeUndefined();
  });

  it("names the portable and provisioned locations from one definition", () => {
    expect(ripgrepPortableExecutablePath("darwin-arm64")).toBe("runtime/native/rg");
    expect(ripgrepPortableExecutablePath("win32-x64")).toBe("runtime/native/rg.exe");
    expect(RIPGREP_PORTABLE_LICENSE_PATH).toBe("runtime/licenses/ripgrep/LICENSE-MIT");
    expect(ripgrepProvisionedDirectory("/repo", "linux-x64")).toBe(
      join("/repo", ".ripgrep", "15.1.0", "linux-x64"),
    );
    expect(ripgrepProvisionedBinaryPath("/repo", "win32-x64")).toBe(
      join("/repo", ".ripgrep", "15.1.0", "win32-x64", "rg.exe"),
    );
  });
});

describe("resolveVerifiedRipgrep", () => {
  it("verifies the staged portable executable by its pinned digest", () => {
    const fixture = portableFixture();
    expect(
      resolveVerifiedRipgrep(fixture.root, "linux-x64", { manifest: fixture.manifest }),
    ).toEqual({
      ok: true,
      path: fixture.path,
      sha256: sha256("fixture ripgrep"),
      version: "0.0.0-test",
    });
  });

  it("verifies the provisioned development layout", () => {
    const root = temporaryRoot();
    const manifest = fixtureManifest(sha256("provisioned"));
    const path = writeExecutable(
      join(root, ".ripgrep", "0.0.0-test", "linux-x64", "rg"),
      "provisioned",
    );
    expect(resolveVerifiedRipgrep(root, "linux-x64", { layout: "provisioned", manifest })).toEqual({
      ok: true,
      path,
      sha256: sha256("provisioned"),
      version: "0.0.0-test",
    });
    expect(resolveVerifiedRipgrep(root, "linux-x64", { manifest })).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("refuses bytes that do not match the pinned digest", () => {
    const fixture = portableFixture();
    writeFileSync(fixture.path, "tampered ripgrep");
    expect(
      resolveVerifiedRipgrep(fixture.root, "linux-x64", { manifest: fixture.manifest }),
    ).toEqual({ ok: false, reason: "digest-mismatch" });
  });

  it("refuses every byte that is not the shipped upstream release", () => {
    const root = temporaryRoot();
    writeExecutable(join(root, "runtime", "native", "rg"), "any other build");
    expect(resolveVerifiedRipgrep(root, "linux-x64")).toEqual({
      ok: false,
      reason: "digest-mismatch",
    });
  });

  it("refuses a missing executable and a missing directory", () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "runtime", "native"), { recursive: true });
    chmodSync(join(root, "runtime", "native"), 0o755);
    const manifest = fixtureManifest(sha256("x"));
    expect(resolveVerifiedRipgrep(root, "linux-x64", { manifest })).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(resolveVerifiedRipgrep(join(root, "absent"), "linux-x64", { manifest })).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("refuses an unsupported target without touching the filesystem", () => {
    const root = temporaryRoot();
    expect(resolveVerifiedRipgrep(root, "freebsd-x64")).toEqual({
      ok: false,
      reason: "unsupported-target",
    });
    expect(resolveVerifiedRipgrep(root, "constructor")).toEqual({
      ok: false,
      reason: "unsupported-target",
    });
  });

  it("refuses a directory in place of the executable", () => {
    const root = temporaryRoot();
    const manifest = fixtureManifest(sha256("x"));
    mkdirSync(join(root, "runtime", "native", "rg"), { recursive: true });
    chmodSync(join(root, "runtime", "native"), 0o755);
    expect(resolveVerifiedRipgrep(root, "linux-x64", { manifest })).toEqual({
      ok: false,
      reason: "not-regular-file",
    });
  });

  it.skipIf(!POSIX)("refuses a symlink even when its target carries the approved bytes", () => {
    const fixture = portableFixture();
    const elsewhere = writeExecutable(join(temporaryRoot(), "real-rg"), "fixture ripgrep");
    rmSync(fixture.path);
    symlinkSync(elsewhere, fixture.path);
    expect(
      resolveVerifiedRipgrep(fixture.root, "linux-x64", { manifest: fixture.manifest }),
    ).toEqual({ ok: false, reason: "not-regular-file" });
  });

  it.skipIf(!POSIX)("refuses a directory reached through a symlink", () => {
    const fixture = portableFixture();
    const real = join(fixture.root, "runtime", "real-native");
    mkdirSync(real);
    chmodSync(real, 0o755);
    writeExecutable(join(real, "rg"), "fixture ripgrep");
    rmSync(join(fixture.root, "runtime", "native"), { recursive: true });
    symlinkSync(real, join(fixture.root, "runtime", "native"));
    expect(
      resolveVerifiedRipgrep(fixture.root, "linux-x64", { manifest: fixture.manifest }),
    ).toEqual({ ok: false, reason: "untrusted-parent" });
  });

  it.skipIf(!NOT_ROOT)("refuses a group- or world-writable executable", () => {
    const fixture = portableFixture();
    for (const mode of [0o775, 0o757, 0o777]) {
      chmodSync(fixture.path, mode);
      expect(
        resolveVerifiedRipgrep(fixture.root, "linux-x64", { manifest: fixture.manifest }),
      ).toEqual({ ok: false, reason: "untrusted-owner-or-mode" });
    }
  });

  it.skipIf(!NOT_ROOT)("refuses a group- or world-writable directory", () => {
    const fixture = portableFixture();
    chmodSync(dirname(fixture.path), 0o775);
    expect(
      resolveVerifiedRipgrep(fixture.root, "linux-x64", { manifest: fixture.manifest }),
    ).toEqual({ ok: false, reason: "untrusted-parent" });
  });

  it.skipIf(!NOT_ROOT)("refuses a tree owned by neither the current user nor root", () => {
    const fixture = portableFixture();
    const stranger = (process.getuid?.() ?? 1) + 1;
    expect(
      resolveVerifiedRipgrep(fixture.root, "linux-x64", {
        manifest: fixture.manifest,
        currentUid: stranger,
      }),
    ).toEqual({ ok: false, reason: "untrusted-parent" });
  });

  it("refuses an executable larger than the bound before reading it", () => {
    const fixture = portableFixture();
    expect(
      resolveVerifiedRipgrep(fixture.root, "linux-x64", {
        manifest: fixture.manifest,
        maxBytes: 4,
      }),
    ).toEqual({ ok: false, reason: "oversized" });
  });

  it("accepts the platform-signed digest only when the caller binds it explicitly", () => {
    const fixture = portableFixture("signed ripgrep bytes");
    const signed = sha256("signed ripgrep bytes");
    expect(
      resolveVerifiedRipgrep(fixture.root, "linux-x64", {
        manifest: fixtureManifest(sha256("unsigned ripgrep bytes")),
      }),
    ).toEqual({ ok: false, reason: "digest-mismatch" });
    expect(
      resolveVerifiedRipgrep(fixture.root, "linux-x64", {
        manifest: fixtureManifest(sha256("unsigned ripgrep bytes")),
        acceptedSha256: [signed],
      }),
    ).toMatchObject({ ok: true, sha256: signed });
  });

  it("refuses a file that changes while it is being verified", () => {
    const fixture = portableFixture();
    readHook.onRead = (): void => {
      appendFileSync(fixture.path, "late write");
    };
    expect(
      resolveVerifiedRipgrep(fixture.root, "linux-x64", { manifest: fixture.manifest }),
    ).toEqual({ ok: false, reason: "changed-during-verification" });
  });

  it("rethrows a defect instead of converting it into a verdict about the file", () => {
    const fixture = portableFixture();
    expect(() => verifyPinnedRuntimeFile(fixture.path, {} as unknown as string[])).toThrow(
      TypeError,
    );
  });

  it("verifies an explicitly supplied path by what the file is, not by where it lives", () => {
    const fixture = portableFixture();
    const elsewhere = writeExecutable(join(temporaryRoot(), "any", "name"), "fixture ripgrep");
    expect(verifyRipgrepExecutable(elsewhere, "linux-x64", { manifest: fixture.manifest })).toEqual(
      {
        ok: true,
        path: elsewhere,
        sha256: sha256("fixture ripgrep"),
        version: "0.0.0-test",
      },
    );
    writeFileSync(elsewhere, "tampered");
    expect(verifyRipgrepExecutable(elsewhere, "linux-x64", { manifest: fixture.manifest })).toEqual(
      {
        ok: false,
        reason: "digest-mismatch",
      },
    );
    expect(verifyRipgrepExecutable(elsewhere, "freebsd-x64")).toEqual({
      ok: false,
      reason: "unsupported-target",
    });
  });

  it("only ever returns a reason from the closed vocabulary", () => {
    const fixture = portableFixture();
    const results = [
      resolveVerifiedRipgrep(fixture.root, "freebsd-x64"),
      resolveVerifiedRipgrep(fixture.root, "linux-x64"),
      resolveVerifiedRipgrep(join(fixture.root, "absent"), "linux-x64"),
    ];
    const verdicts = results.map((result) => (result.ok ? "ok" : result.reason));
    expect(verdicts).toEqual(["unsupported-target", "digest-mismatch", "missing"]);
    for (const verdict of verdicts) {
      expect(RIPGREP_VERIFICATION_REASONS as readonly string[]).toContain(verdict);
    }
  });
});

describe("ripgrepActivationDigest", () => {
  const approval = ripgrepRuntimeApproval("win32-x64");
  const SIGNED = "a".repeat(64);
  const activation = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    nativeTools: [
      {
        name: "ripgrep",
        executablePath: "runtime/native/rg.exe",
        unsignedSha256: approval?.binarySha256,
        shippedSha256: SIGNED,
        ...overrides,
      },
    ],
  });

  it("returns the signed digest of exactly the pinned tool for the target", () => {
    expect(ripgrepActivationDigest(activation(), "win32-x64")).toBe(SIGNED);
  });

  it.each([
    ["another name", { name: "grep" }],
    ["another executable path", { executablePath: "runtime/native/rg" }],
    ["a relabelled upstream digest", { unsignedSha256: "b".repeat(64) }],
    ["a malformed shipped digest", { shippedSha256: "not-a-digest" }],
    ["an upper-case shipped digest", { shippedSha256: "A".repeat(64) }],
    ["a missing shipped digest", { shippedSha256: undefined }],
  ])("refuses an entry with %s", (_label, overrides) => {
    expect(ripgrepActivationDigest(activation(overrides), "win32-x64")).toBeUndefined();
  });

  it("refuses anything but exactly one tool in a record, for a supported target", () => {
    expect(ripgrepActivationDigest({ nativeTools: [] }, "win32-x64")).toBeUndefined();
    expect(ripgrepActivationDigest({}, "win32-x64")).toBeUndefined();
    expect(ripgrepActivationDigest({ nativeTools: "ripgrep" }, "win32-x64")).toBeUndefined();
    expect(ripgrepActivationDigest({ nativeTools: [null] }, "win32-x64")).toBeUndefined();
    expect(ripgrepActivationDigest({ nativeTools: [1, 2] }, "win32-x64")).toBeUndefined();
    expect(ripgrepActivationDigest(null, "win32-x64")).toBeUndefined();
    expect(ripgrepActivationDigest([], "win32-x64")).toBeUndefined();
    expect(ripgrepActivationDigest(activation(), "freebsd-x64")).toBeUndefined();
    expect(ripgrepActivationDigest(activation(), "linux-x64")).toBeUndefined();
  });

  it("feeds the verifier so a signed executable passes only through the bound digest", () => {
    const fixture = portableFixture("platform signed ripgrep");
    const manifest = fixtureManifest(sha256("the unsigned upstream bytes"));
    const bound = ripgrepActivationDigest(
      {
        nativeTools: [
          {
            name: "ripgrep",
            executablePath: "runtime/native/rg",
            unsignedSha256: sha256("the unsigned upstream bytes"),
            shippedSha256: sha256("platform signed ripgrep"),
          },
        ],
      },
      "linux-x64",
      manifest,
    );

    expect(bound).toBe(sha256("platform signed ripgrep"));
    expect(resolveVerifiedRipgrep(fixture.root, "linux-x64", { manifest })).toEqual({
      ok: false,
      reason: "digest-mismatch",
    });
    expect(
      resolveVerifiedRipgrep(fixture.root, "linux-x64", {
        manifest,
        acceptedSha256: bound === undefined ? [] : [bound],
      }),
    ).toMatchObject({ ok: true });
  });
});
