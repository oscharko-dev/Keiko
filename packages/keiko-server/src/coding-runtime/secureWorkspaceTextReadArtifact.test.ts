import { describe, expect, it, vi } from "vitest";

import {
  resolveSecureWorkspaceReadArtifact,
  secureWorkspaceReadTargetFor,
  type SecureWorkspaceTextReadArtifact,
} from "./secureWorkspaceTextReadArtifact.js";

const SHA256 = "a".repeat(64);
const SOURCE_COMMIT = "b".repeat(40);
const SOURCE_TREE_SHA256 = "c".repeat(64);

function artifact(
  overrides: Partial<SecureWorkspaceTextReadArtifact> = {},
): SecureWorkspaceTextReadArtifact {
  return {
    target: "darwin-arm64",
    installRelativePath: "runtime/native/keiko-secure-workspace-read",
    sha256: SHA256,
    protocol: "KSR1/KSS1",
    sourceCommit: SOURCE_COMMIT,
    sourceTreeSha256: SOURCE_TREE_SHA256,
    signed: true,
    ...overrides,
  };
}

describe("secure workspace text-read artifact proof", () => {
  it.each([
    [{ os: "win32", arch: "x64" }, "win32-x64"],
    [{ os: "darwin", arch: "arm64" }, "darwin-arm64"],
    [{ os: "darwin", arch: "x64" }, "darwin-x64"],
    [{ os: "linux", arch: "x64" }, undefined],
    [{ os: "freebsd", arch: "x64" }, undefined],
    [{ os: "win32", arch: "arm64" }, undefined],
  ] as const)("resolves only signed portable target %o", (platform, target) => {
    expect(secureWorkspaceReadTargetFor(platform)).toBe(target);
  });

  it("passes the exact fixed helper identity to point-of-use verification", async () => {
    const candidate = artifact();
    const verify = vi.fn(() => true);

    await expect(
      resolveSecureWorkspaceReadArtifact(candidate, { os: "darwin", arch: "arm64" }, { verify }),
    ).resolves.toBe(candidate);
    expect(verify).toHaveBeenCalledExactlyOnceWith({
      target: "darwin-arm64",
      installRelativePath: "runtime/native/keiko-secure-workspace-read",
      sha256: SHA256,
      protocol: "KSR1/KSS1",
      sourceCommit: SOURCE_COMMIT,
      sourceTreeSha256: SOURCE_TREE_SHA256,
      signed: true,
    });
  });

  it("rejects unsupported Linux and unknown targets before any artifact lookup or verifier call", async () => {
    const verify = vi.fn(() => true);

    await expect(
      resolveSecureWorkspaceReadArtifact(artifact(), { os: "linux", arch: "x64" }, { verify }),
    ).resolves.toBeUndefined();
    await expect(
      resolveSecureWorkspaceReadArtifact(artifact(), { os: "haiku", arch: "riscv64" }, { verify }),
    ).resolves.toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong target", { target: "darwin-x64" }],
    ["wrong fixed path", { installRelativePath: "runtime/native/other-helper" }],
    ["wrong protocol", { protocol: "KSR2/KSS2" }],
    ["unsigned", { signed: false }],
    ["non-hex digest", { sha256: "g".repeat(64) }],
    ["short source commit", { sourceCommit: "b".repeat(39) }],
    ["short source tree", { sourceTreeSha256: "c".repeat(63) }],
  ] as const)("fails closed for %s without verifier invocation", async (_label, overrides) => {
    const verify = vi.fn(() => true);
    const malformed = { ...artifact(), ...overrides };

    await expect(
      resolveSecureWorkspaceReadArtifact(malformed, { os: "darwin", arch: "arm64" }, { verify }),
    ).resolves.toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
  });

  it("requires the point-of-use signature and digest proof to succeed", async () => {
    const verify = vi.fn(() => false);

    await expect(
      resolveSecureWorkspaceReadArtifact(artifact(), { os: "darwin", arch: "arm64" }, { verify }),
    ).resolves.toBeUndefined();
    expect(verify).toHaveBeenCalledOnce();
  });
});
