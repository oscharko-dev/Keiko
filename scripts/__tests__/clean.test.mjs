import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CLEAN_RM_OPTIONS, lstatIfExists, rmIfExistsSafe } from "../clean.mjs";

function makeRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("rmIfExistsSafe", () => {
  let root;
  let outside;

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
    if (outside) {
      rmSync(outside, { recursive: true, force: true });
      outside = undefined;
    }
  });

  it("configures native recursive removal with bounded transient-error retries", async () => {
    root = makeRoot("clean-retry-");
    const rootReal = await realpath(root);
    const target = join(rootReal, "coverage");
    mkdirSync(target);
    const remove = vi.fn().mockResolvedValue(undefined);

    await expect(rmIfExistsSafe(rootReal, target, remove)).resolves.toBe(true);

    expect(remove).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith(target, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
    expect(Object.isFrozen(CLEAN_RM_OPTIONS)).toBe(true);
  });

  it("propagates persistent removal failures after the native retry budget", async () => {
    root = makeRoot("clean-persistent-");
    const rootReal = await realpath(root);
    const target = join(rootReal, "coverage");
    mkdirSync(target);
    const failure = Object.assign(new Error("directory stayed busy"), { code: "ENOTEMPTY" });
    const remove = vi.fn().mockRejectedValue(failure);

    await expect(rmIfExistsSafe(rootReal, target, remove)).rejects.toBe(failure);
  });

  it("treats only ENOENT lookup failures as an absent target", async () => {
    const absent = Object.assign(new Error("not found"), { code: "ENOENT" });
    const inaccessible = Object.assign(new Error("permission denied"), { code: "EACCES" });

    await expect(lstatIfExists("missing", vi.fn().mockRejectedValue(absent))).resolves.toBeNull();
    await expect(
      lstatIfExists("inaccessible", vi.fn().mockRejectedValue(inaccessible)),
    ).rejects.toBe(inaccessible);
  });

  it("retains the fail-closed symlink escape boundary", async () => {
    root = makeRoot("clean-root-");
    outside = makeRoot("clean-outside-");
    const rootReal = await realpath(root);
    const outsideFile = join(outside, "retain.txt");
    writeFileSync(outsideFile, "retain", "utf8");
    const target = join(rootReal, "coverage");
    symlinkSync(outside, target, "dir");
    const remove = vi.fn();

    await expect(rmIfExistsSafe(rootReal, target, remove)).rejects.toThrow(
      "refusing to delete symbolic-link target",
    );

    expect(remove).not.toHaveBeenCalled();
    await expect(realpath(outsideFile)).resolves.toBeTruthy();
  });

  it("rejects an external escape through an intermediate symbolic link", async () => {
    root = makeRoot("clean-ancestor-root-");
    outside = makeRoot("clean-ancestor-outside-");
    const rootReal = await realpath(root);
    const outsideDist = join(outside, "dist");
    mkdirSync(outsideDist);
    const outsideFile = join(outsideDist, "retain.txt");
    writeFileSync(outsideFile, "retain", "utf8");
    const packages = join(rootReal, "packages");
    mkdirSync(packages);
    symlinkSync(outside, join(packages, "linked"), "dir");
    const target = join(packages, "linked", "dist");
    const remove = vi.fn();

    await expect(rmIfExistsSafe(rootReal, target, remove)).rejects.toThrow(
      "refusing to delete path outside repository",
    );

    expect(remove).not.toHaveBeenCalled();
    await expect(realpath(outsideFile)).resolves.toBeTruthy();
  });

  it("removes through a canonical in-repository parent without following the final target", async () => {
    root = makeRoot("clean-canonical-root-");
    const rootReal = await realpath(root);
    const actualPackage = join(rootReal, "actual-package");
    const actualDist = join(actualPackage, "dist");
    mkdirSync(actualDist, { recursive: true });
    const packages = join(rootReal, "packages");
    mkdirSync(packages);
    symlinkSync(actualPackage, join(packages, "linked"), "dir");
    const target = join(packages, "linked", "dist");
    const remove = vi.fn().mockResolvedValue(undefined);

    await expect(rmIfExistsSafe(rootReal, target, remove)).resolves.toBe(true);

    expect(remove).toHaveBeenCalledWith(actualDist, CLEAN_RM_OPTIONS);
  });

  it("cannot follow a final-component swap to the repository root", async () => {
    root = makeRoot("clean-swap-root-");
    const rootReal = await realpath(root);
    const marker = join(rootReal, "retain.txt");
    writeFileSync(marker, "retain", "utf8");
    const target = join(rootReal, "coverage");
    mkdirSync(target);
    const removeAfterSwap = vi.fn(async (candidate, options) => {
      rmSync(target, { recursive: true, force: true });
      symlinkSync(rootReal, target, "dir");
      expect(candidate).toBe(target);
      await rm(candidate, options);
    });

    await expect(rmIfExistsSafe(rootReal, target, removeAfterSwap)).resolves.toBe(true);

    await expect(realpath(marker)).resolves.toBeTruthy();
    expect(removeAfterSwap).toHaveBeenCalledOnce();
  });
});
