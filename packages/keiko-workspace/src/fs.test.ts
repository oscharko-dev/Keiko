import { execFileSync } from "node:child_process";
import fs, {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { nodeWorkspaceFs, WorkspaceDescriptorReadError } from "./fs.js";

const roots: string[] = [];

function workspaceFixture(): { readonly root: string; readonly file: string } {
  const root = mkdtempSync(join(tmpdir(), "keiko-workspace-fs-"));
  roots.push(root);
  const nested = join(root, "nested");
  mkdirSync(nested, { recursive: true, mode: 0o700 });
  const file = join(nested, "fixture.txt");
  writeFileSync(file, "alpha🙂omega", { encoding: "utf8", mode: 0o600 });
  return { root, file };
}

async function withBeforeOpen<T>(
  beforeOpen: (absolutePath: string) => void,
  operation: () => Promise<T>,
): Promise<T> {
  const originalOpen = fs.promises.open;
  const openSpy = vi.spyOn(fs.promises, "open").mockImplementation(async (path, flags, mode) => {
    beforeOpen(String(path));
    return await originalOpen(path, flags, mode);
  });
  syncBuiltinESMExports();
  try {
    return await operation();
  } finally {
    openSpy.mockRestore();
    syncBuiltinESMExports();
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("nodeWorkspaceFs", () => {
  it("implements the synchronous contained filesystem surface", () => {
    const { root, file } = workspaceFixture();

    expect(nodeWorkspaceFs.readFileUtf8(file)).toBe("alpha🙂omega");
    expect(nodeWorkspaceFs.stat(file)).toMatchObject({ isFile: true, isDirectory: false });
    expect(nodeWorkspaceFs.readDir(root)).toContainEqual(
      expect.objectContaining({ name: "nested", isDirectory: true }),
    );
    expect(nodeWorkspaceFs.realPath(file)).toBe(realpathSync.native(file));
    expect(nodeWorkspaceFs.exists(file)).toBe(true);
    expect(nodeWorkspaceFs.exists(join(root, "missing"))).toBe(false);
  });

  it("caps byte, prefix, and range reads without over-reading", async () => {
    const { file } = workspaceFixture();

    await expect(nodeWorkspaceFs.readFileBytes?.(file, 0, "reject")).resolves.toEqual(
      new Uint8Array(),
    );
    await expect(nodeWorkspaceFs.readFileBytes?.(file, 5, "reject")).resolves.toEqual(
      new TextEncoder().encode("alpha"),
    );
    expect(nodeWorkspaceFs.readFileUtf8Prefix?.(file, 0, "reject")).toBe("");
    expect(nodeWorkspaceFs.readFileUtf8Prefix?.(file, 5, "reject")).toBe("alpha");
    await expect(nodeWorkspaceFs.readFileRange?.(file, 5, 0, "reject")).resolves.toEqual(
      new Uint8Array(),
    );
    await expect(nodeWorkspaceFs.readFileRange?.(file, 5, 4, "reject")).resolves.toEqual(
      new TextEncoder().encode("🙂"),
    );
  });

  it("rejects symlink aliases on every bounded production read", async () => {
    const { root, file } = workspaceFixture();
    const symlink = join(root, "alias.txt");
    symlinkSync(file, symlink);

    await expect(nodeWorkspaceFs.readFileBytes?.(symlink, 5, "reject")).rejects.toMatchObject({
      reason: "symbolic-link",
    });
    expect(() => nodeWorkspaceFs.readFileUtf8Prefix?.(symlink, 5, "reject")).toThrow(
      WorkspaceDescriptorReadError,
    );
    await expect(nodeWorkspaceFs.readFileRange?.(symlink, 0, 5, "reject")).rejects.toMatchObject({
      reason: "symbolic-link",
    });
    await expect(nodeWorkspaceFs.openFileReader?.(symlink, "reject")).rejects.toMatchObject({
      reason: "symbolic-link",
    });
  });

  it("leaves hard-link authority decisions to the verified owning read lane", async () => {
    const { root, file } = workspaceFixture();
    const hardLink = join(root, "hard.txt");
    linkSync(file, hardLink);

    await expect(nodeWorkspaceFs.readFileBytes?.(hardLink, 5, "allow")).resolves.toEqual(
      new TextEncoder().encode("alpha"),
    );
    expect(nodeWorkspaceFs.readFileUtf8Prefix?.(hardLink, 5, "allow")).toBe("alpha");
    await expect(nodeWorkspaceFs.readFileRange?.(hardLink, 0, 5, "allow")).resolves.toEqual(
      new TextEncoder().encode("alpha"),
    );
    const reader = await nodeWorkspaceFs.openFileReader?.(hardLink, "allow");
    expect(reader).toBeDefined();
    if (reader === undefined) return;
    try {
      await expect(reader.readRange(0, 5)).resolves.toEqual(new TextEncoder().encode("alpha"));
    } finally {
      await reader.close();
    }
    expect(nodeWorkspaceFs.stat(hardLink).hardLinkCount).toBe(2);
  });

  it("rejects stable hard links when the owning read lane denies them", async () => {
    const { root, file } = workspaceFixture();
    const hardLink = join(root, "hard.txt");
    linkSync(file, hardLink);

    await expect(nodeWorkspaceFs.readFileBytes?.(hardLink, 5, "reject")).rejects.toMatchObject({
      reason: "hard-link",
    });
    expect(() => nodeWorkspaceFs.readFileUtf8Prefix?.(hardLink, 5, "reject")).toThrow(
      WorkspaceDescriptorReadError,
    );
    await expect(nodeWorkspaceFs.readFileRange?.(hardLink, 0, 5, "reject")).rejects.toMatchObject({
      reason: "hard-link",
    });
    await expect(nodeWorkspaceFs.openFileReader?.(hardLink, "reject")).rejects.toMatchObject({
      reason: "hard-link",
    });
  });

  it("rejects a denied-file hardlink replacement between pathname check and descriptor open", async () => {
    const { root, file } = workspaceFixture();
    const denied = join(root, ".env");
    writeFileSync(denied, "PRIVATE_DESCRIPTOR_BYTES", "utf8");
    let swapped = false;

    await withBeforeOpen(
      (absolutePath) => {
        if (absolutePath !== file || swapped) return;
        swapped = true;
        unlinkSync(file);
        linkSync(denied, file);
      },
      async () => {
        await expect(nodeWorkspaceFs.readFileBytes?.(file, 64, "reject")).rejects.toMatchObject({
          reason: "hard-link",
        });
      },
    );

    expect(swapped).toBe(true);
  });

  it("rejects a hard link introduced while a strict reusable reader is open", async () => {
    const { root, file } = workspaceFixture();
    const reader = await nodeWorkspaceFs.openFileReader?.(file, "reject");
    if (reader === undefined) throw new TypeError("missing production reader");
    linkSync(file, join(root, "late-hardlink.txt"));

    await expect(reader.readRange(0, 5)).rejects.toMatchObject({ reason: "hard-link" });
    await expect(reader.close()).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "rejects a FIFO without blocking a bounded production read",
    async () => {
      const { root } = workspaceFixture();
      const fifo = join(root, "pipe");
      execFileSync("mkfifo", [fifo]);

      await expect(nodeWorkspaceFs.readFileBytes?.(fifo, 5, "reject")).rejects.toMatchObject({
        reason: "not-regular",
      });
      expect(() => nodeWorkspaceFs.readFileUtf8Prefix?.(fifo, 5, "reject")).toThrow(
        WorkspaceDescriptorReadError,
      );
      await expect(nodeWorkspaceFs.readFileRange?.(fifo, 0, 5, "reject")).rejects.toMatchObject({
        reason: "not-regular",
      });
      await expect(nodeWorkspaceFs.openFileReader?.(fifo, "reject")).rejects.toMatchObject({
        reason: "not-regular",
      });
    },
  );

  it("rejects an outside symlink replacement between lstat and range open", async () => {
    const { file } = workspaceFixture();
    const outside = mkdtempSync(join(tmpdir(), "keiko-workspace-range-outside-"));
    roots.push(outside);
    const privateFile = join(outside, "private.txt");
    writeFileSync(privateFile, "OUTSIDE_PRIVATE_BYTES", "utf8");
    let swapped = false;

    await withBeforeOpen(
      (absolutePath) => {
        if (absolutePath !== file || swapped) return;
        swapped = true;
        unlinkSync(file);
        symlinkSync(privateFile, file);
      },
      async () => {
        await expect(nodeWorkspaceFs.readFileRange?.(file, 0, 64, "reject")).rejects.toMatchObject({
          reason: "symbolic-link",
        });
      },
    );

    expect(swapped).toBe(true);
  });

  it("rejects a regular-file replacement between lstat and range open", async () => {
    const { root, file } = workspaceFixture();
    const replacement = join(root, "replacement.txt");
    writeFileSync(replacement, "replacement", "utf8");
    let swapped = false;

    await withBeforeOpen(
      (absolutePath) => {
        if (absolutePath !== file || swapped) return;
        swapped = true;
        unlinkSync(file);
        renameSync(replacement, file);
      },
      async () => {
        await expect(nodeWorkspaceFs.readFileRange?.(file, 0, 64, "reject")).rejects.toMatchObject({
          reason: "changed",
        });
      },
    );

    expect(swapped).toBe(true);
  });

  it("bounds and identity-checks production directory enumeration", () => {
    const { root } = workspaceFixture();
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(join(root, `entry-${index.toString().padStart(2, "0")}`), "x");
    }
    const alias = join(root, "directory-alias");
    symlinkSync(root, alias);

    expect(nodeWorkspaceFs.readDir(root, 3)).toHaveLength(3);
    expect(() => nodeWorkspaceFs.readDir(alias, 3)).toThrow(WorkspaceDescriptorReadError);
  });

  it("reuses one bounded reader and closes it idempotently", async () => {
    const { file } = workspaceFixture();
    const reader = await nodeWorkspaceFs.openFileReader?.(file, "reject");

    expect(reader).toBeDefined();
    await expect(reader?.readRange(0, 0)).resolves.toEqual(new Uint8Array());
    await expect(reader?.readRange(5, 4)).resolves.toEqual(new TextEncoder().encode("🙂"));
    await reader?.close();
    await expect(reader?.close()).resolves.toBeUndefined();
  });

  it("rejects a pathname retarget after opening a reusable reader and still closes safely", async () => {
    const { file } = workspaceFixture();
    const outside = mkdtempSync(join(tmpdir(), "keiko-workspace-reader-outside-"));
    roots.push(outside);
    const privateFile = join(outside, "private.txt");
    writeFileSync(privateFile, "OUTSIDE_PRIVATE_BYTES", "utf8");
    const reader = await nodeWorkspaceFs.openFileReader?.(file, "reject");
    if (reader === undefined) throw new TypeError("missing production reader");
    unlinkSync(file);
    symlinkSync(privateFile, file);

    await expect(reader.readRange(0, 64)).rejects.toMatchObject({ reason: "changed" });
    await expect(reader.close()).resolves.toBeUndefined();
    await expect(reader.close()).resolves.toBeUndefined();
  });
});
