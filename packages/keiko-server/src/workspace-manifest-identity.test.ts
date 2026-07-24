import { accessSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectWorkspaceRootDescriptor } from "./workspace-manifest-identity.js";

// Detect whether the filesystem hosting `directory` is case-insensitive without relying on the
// platform default (macOS APFS/HFS+ is case-insensitive by default but volumes can be case-sensitive;
// Linux mounts CAN be case-insensitive). This lets Finding 4's regression test run wherever the
// defect is actually observable — including macOS local runs — and skip cleanly elsewhere.
function isFilesystemCaseInsensitive(directory: string): boolean {
  const probe = join(directory, "case-detect");
  try {
    writeFileSync(probe, "");
    try {
      accessSync(join(directory, "CASE-DETECT"));
      return true;
    } catch {
      return false;
    }
  } finally {
    rmSync(probe, { force: true });
  }
}

let root: string;

beforeEach((): void => {
  root = mkdtempSync(join(tmpdir(), "keiko-manifest-identity-"));
});

afterEach((): void => {
  rmSync(root, { recursive: true, force: true });
});

describe("inspectWorkspaceRootDescriptor", () => {
  it("returns the on-disk canonical casing regardless of caller casing on case-insensitive filesystems (#2615)", (): void => {
    if (!isFilesystemCaseInsensitive(dirname(root))) {
      // Case-sensitive filesystem — the caller-typed casing would not resolve at all, so there
      // is no defect to prove here. The macOS local lane and case-insensitive Linux mounts
      // exercise this row; the CI/Linux lane confirms the code path still returns a canonical
      // descriptor via the sibling tests.
      return;
    }
    const childName = "MixedCaseDir";
    const childPath = join(root, childName);
    mkdirSync(childPath);
    const typedAsUpper = join(root, childName.toUpperCase());
    const typedAsLower = join(root, childName.toLowerCase());

    const upperDescriptor = inspectWorkspaceRootDescriptor(typedAsUpper, "upper");
    const lowerDescriptor = inspectWorkspaceRootDescriptor(typedAsLower, "lower");

    expect(basename(upperDescriptor.canonicalRoot)).toBe(childName);
    expect(basename(lowerDescriptor.canonicalRoot)).toBe(childName);
    expect(upperDescriptor.canonicalRoot).toBe(lowerDescriptor.canonicalRoot);
    expect(upperDescriptor.rootRef).toBe(lowerDescriptor.rootRef);
    expect(upperDescriptor.identityDigest).toBe(lowerDescriptor.identityDigest);
  });

  it("returns a stable canonical descriptor for a plain directory", (): void => {
    // Cross-platform sanity: the caller can inspect an existing directory and receive a valid,
    // deterministic descriptor. Covers case-sensitive filesystems where the alias test above skips.
    const descriptor = inspectWorkspaceRootDescriptor(root, "fixture");
    expect(descriptor.canonicalRoot.length).toBeGreaterThan(0);
    expect(descriptor.rootRef.startsWith("root-")).toBe(true);
    expect(inspectWorkspaceRootDescriptor(root, "fixture")).toEqual(descriptor);
  });
});
