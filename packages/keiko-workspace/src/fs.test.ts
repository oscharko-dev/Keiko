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
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  isWorkspacePathSnapshotCurrent,
  nodeWorkspaceFs,
  WorkspaceDescriptorReadError,
  type WorkspaceDescriptorReadCompleteness,
  type WorkspaceFs,
  type WorkspaceHardLinkPolicy,
  type WorkspaceStat,
} from "./fs.js";

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
  it.skipIf(process.platform === "win32")(
    "does not alias a literal POSIX backslash to a path separator during snapshot validation",
    () => {
      const expected = {
        size: 1,
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        fileIdentity: "fixture:1",
      };
      const fs = {
        readFileUtf8: (): string => "x",
        stat: (): typeof expected => expected,
        readDir: (): readonly [] => [],
        realPath: (): string => "/workspace/a\\b",
        exists: (): boolean => true,
      } satisfies WorkspaceFs;

      expect(
        isWorkspacePathSnapshotCurrent(fs, "/workspace/input", "/workspace/a/b", expected),
      ).toBe(false);
    },
  );

  it("requires every bounded read lane to declare its hard-link policy", () => {
    type ByteReader = NonNullable<WorkspaceFs["readFileBytes"]>;
    type ContainedReader = NonNullable<WorkspaceFs["readFileUtf8WithinRootSameDescriptor"]>;
    type PrefixReader = NonNullable<WorkspaceFs["readFileUtf8Prefix"]>;
    type RangeReader = NonNullable<WorkspaceFs["readFileRange"]>;
    type ReusableReader = NonNullable<WorkspaceFs["openFileReader"]>;

    expectTypeOf<Parameters<ByteReader>>().toEqualTypeOf<
      [string, number, WorkspaceHardLinkPolicy, WorkspaceStat]
    >();
    expectTypeOf<Parameters<ContainedReader>>().toEqualTypeOf<
      [string, string, number, WorkspaceHardLinkPolicy, WorkspaceDescriptorReadCompleteness]
    >();
    expectTypeOf<Parameters<PrefixReader>>().toEqualTypeOf<
      [string, number, WorkspaceHardLinkPolicy, WorkspaceStat]
    >();
    expectTypeOf<Parameters<RangeReader>>().toEqualTypeOf<
      [string, number, number, WorkspaceHardLinkPolicy, WorkspaceStat]
    >();
    expectTypeOf<Parameters<ReusableReader>>().toEqualTypeOf<
      [string, WorkspaceHardLinkPolicy, WorkspaceStat]
    >();
  });

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

  it("does not follow symlinks for metadata or existence probes", () => {
    const { root, file } = workspaceFixture();
    const validLink = join(root, "valid-link.txt");
    const brokenLink = join(root, "broken-link.txt");
    symlinkSync(file, validLink);
    symlinkSync(join(root, "missing-target.txt"), brokenLink);

    expect(nodeWorkspaceFs.stat(validLink)).toMatchObject({
      isFile: false,
      isDirectory: false,
      isSymbolicLink: true,
    });
    expect(nodeWorkspaceFs.stat(brokenLink)).toMatchObject({ isSymbolicLink: true });
    expect(nodeWorkspaceFs.exists(validLink)).toBe(true);
    expect(nodeWorkspaceFs.exists(brokenLink)).toBe(true);
  });

  it("rejects a parent substitution between canonical authorization and descriptor open", () => {
    const { root } = workspaceFixture();
    const nested = join(root, "nested");
    const retained = join(root, "retained-nested");
    const outside = mkdtempSync(join(tmpdir(), "keiko-workspace-contained-outside-"));
    roots.push(outside);
    writeFileSync(join(outside, "fixture.txt"), "OUTSIDE_PRIVATE_BYTES", "utf8");
    const canonicalRoot = nodeWorkspaceFs.realPath(root);
    const canonicalFile = join(canonicalRoot, "nested", "fixture.txt");
    expect(nodeWorkspaceFs.realPath(canonicalFile)).toBe(canonicalFile);
    renameSync(nested, retained);
    symlinkSync(outside, nested, "dir");

    expect(
      nodeWorkspaceFs.readFileUtf8SameDescriptor?.(
        canonicalFile,
        64,
        "reject",
        nodeWorkspaceFs.stat(canonicalFile),
      ).rawText,
    ).toBe("OUTSIDE_PRIVATE_BYTES");
    expect(() =>
      nodeWorkspaceFs.readFileUtf8WithinRootSameDescriptor?.(
        canonicalRoot,
        canonicalFile,
        64,
        "reject",
        "complete",
      ),
    ).toThrow(WorkspaceDescriptorReadError);
  });

  it("caps byte, prefix, and range reads without over-reading", async () => {
    const { file } = workspaceFixture();
    const expected = nodeWorkspaceFs.stat(file);

    await expect(nodeWorkspaceFs.readFileBytes?.(file, 0, "reject", expected)).resolves.toEqual(
      new Uint8Array(),
    );
    await expect(nodeWorkspaceFs.readFileBytes?.(file, 5, "reject", expected)).resolves.toEqual(
      new TextEncoder().encode("alpha"),
    );
    expect(nodeWorkspaceFs.readFileUtf8Prefix?.(file, 0, "reject", expected)).toBe("");
    expect(nodeWorkspaceFs.readFileUtf8Prefix?.(file, 5, "reject", expected)).toBe("alpha");
    await expect(nodeWorkspaceFs.readFileRange?.(file, 5, 0, "reject", expected)).resolves.toEqual(
      new Uint8Array(),
    );
    await expect(nodeWorkspaceFs.readFileRange?.(file, 5, 4, "reject", expected)).resolves.toEqual(
      new TextEncoder().encode("🙂"),
    );
  });

  it("rejects symlink aliases on every bounded production read", async () => {
    const { root, file } = workspaceFixture();
    const symlink = join(root, "alias.txt");
    symlinkSync(file, symlink);
    const expected = nodeWorkspaceFs.stat(symlink);

    await expect(
      nodeWorkspaceFs.readFileBytes?.(symlink, 5, "reject", expected),
    ).rejects.toMatchObject({ reason: "symbolic-link" });
    expect(() => nodeWorkspaceFs.readFileUtf8Prefix?.(symlink, 5, "reject", expected)).toThrow(
      WorkspaceDescriptorReadError,
    );
    await expect(
      nodeWorkspaceFs.readFileRange?.(symlink, 0, 5, "reject", expected),
    ).rejects.toMatchObject({ reason: "symbolic-link" });
    await expect(
      nodeWorkspaceFs.openFileReader?.(symlink, "reject", expected),
    ).rejects.toMatchObject({ reason: "symbolic-link" });
  });

  it("leaves hard-link authority decisions to the verified owning read lane", async () => {
    const { root, file } = workspaceFixture();
    const hardLink = join(root, "hard.txt");
    linkSync(file, hardLink);
    const expected = nodeWorkspaceFs.stat(hardLink);

    await expect(nodeWorkspaceFs.readFileBytes?.(hardLink, 5, "allow", expected)).resolves.toEqual(
      new TextEncoder().encode("alpha"),
    );
    expect(nodeWorkspaceFs.readFileUtf8Prefix?.(hardLink, 5, "allow", expected)).toBe("alpha");
    await expect(
      nodeWorkspaceFs.readFileRange?.(hardLink, 0, 5, "allow", expected),
    ).resolves.toEqual(new TextEncoder().encode("alpha"));
    const reader = await nodeWorkspaceFs.openFileReader?.(hardLink, "allow", expected);
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
    const expected = nodeWorkspaceFs.stat(hardLink);

    await expect(
      nodeWorkspaceFs.readFileBytes?.(hardLink, 5, "reject", expected),
    ).rejects.toMatchObject({ reason: "hard-link" });
    expect(() => nodeWorkspaceFs.readFileUtf8Prefix?.(hardLink, 5, "reject", expected)).toThrow(
      WorkspaceDescriptorReadError,
    );
    await expect(
      nodeWorkspaceFs.readFileRange?.(hardLink, 0, 5, "reject", expected),
    ).rejects.toMatchObject({ reason: "hard-link" });
    await expect(
      nodeWorkspaceFs.openFileReader?.(hardLink, "reject", expected),
    ).rejects.toMatchObject({ reason: "hard-link" });
  });

  it("rejects a denied-file hardlink replacement between pathname check and descriptor open", async () => {
    const { root, file } = workspaceFixture();
    const denied = join(root, ".env");
    writeFileSync(denied, "PRIVATE_DESCRIPTOR_BYTES", "utf8");
    let swapped = false;
    const expected = nodeWorkspaceFs.stat(file);

    await withBeforeOpen(
      (absolutePath) => {
        if (absolutePath !== file || swapped) return;
        swapped = true;
        unlinkSync(file);
        linkSync(denied, file);
      },
      async () => {
        await expect(
          nodeWorkspaceFs.readFileBytes?.(file, 64, "reject", expected),
        ).rejects.toMatchObject({ reason: "hard-link" });
      },
    );

    expect(swapped).toBe(true);
  });

  it("binds a bounded read to the caller's preflight file identity", async () => {
    const { root, file } = workspaceFixture();
    const expected = nodeWorkspaceFs.stat(file);
    const replacement = join(root, "same-size-replacement.txt");
    writeFileSync(replacement, "bravo🙂delta", "utf8");
    unlinkSync(file);
    renameSync(replacement, file);

    await expect(
      nodeWorkspaceFs.readFileBytes?.(file, 64, "reject", expected),
    ).rejects.toMatchObject({ reason: "changed" });
  });

  it("rejects a hard link introduced while a strict reusable reader is open", async () => {
    const { root, file } = workspaceFixture();
    const reader = await nodeWorkspaceFs.openFileReader?.(
      file,
      "reject",
      nodeWorkspaceFs.stat(file),
    );
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
      const expected = nodeWorkspaceFs.stat(fifo);

      await expect(
        nodeWorkspaceFs.readFileBytes?.(fifo, 5, "reject", expected),
      ).rejects.toMatchObject({ reason: "not-regular" });
      expect(() => nodeWorkspaceFs.readFileUtf8Prefix?.(fifo, 5, "reject", expected)).toThrow(
        WorkspaceDescriptorReadError,
      );
      await expect(
        nodeWorkspaceFs.readFileRange?.(fifo, 0, 5, "reject", expected),
      ).rejects.toMatchObject({ reason: "not-regular" });
      await expect(
        nodeWorkspaceFs.openFileReader?.(fifo, "reject", expected),
      ).rejects.toMatchObject({ reason: "not-regular" });
    },
  );

  it("rejects an outside symlink replacement between lstat and range open", async () => {
    const { file } = workspaceFixture();
    const outside = mkdtempSync(join(tmpdir(), "keiko-workspace-range-outside-"));
    roots.push(outside);
    const privateFile = join(outside, "private.txt");
    writeFileSync(privateFile, "OUTSIDE_PRIVATE_BYTES", "utf8");
    let swapped = false;
    const expected = nodeWorkspaceFs.stat(file);

    await withBeforeOpen(
      (absolutePath) => {
        if (absolutePath !== file || swapped) return;
        swapped = true;
        unlinkSync(file);
        symlinkSync(privateFile, file);
      },
      async () => {
        await expect(
          nodeWorkspaceFs.readFileRange?.(file, 0, 64, "reject", expected),
        ).rejects.toMatchObject({ reason: "symbolic-link" });
      },
    );

    expect(swapped).toBe(true);
  });

  it("rejects a regular-file replacement between lstat and range open", async () => {
    const { root, file } = workspaceFixture();
    const replacement = join(root, "replacement.txt");
    writeFileSync(replacement, "replacement", "utf8");
    let swapped = false;
    const expected = nodeWorkspaceFs.stat(file);

    await withBeforeOpen(
      (absolutePath) => {
        if (absolutePath !== file || swapped) return;
        swapped = true;
        unlinkSync(file);
        renameSync(replacement, file);
      },
      async () => {
        await expect(
          nodeWorkspaceFs.readFileRange?.(file, 0, 64, "reject", expected),
        ).rejects.toMatchObject({ reason: "changed" });
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
    const reader = await nodeWorkspaceFs.openFileReader?.(
      file,
      "reject",
      nodeWorkspaceFs.stat(file),
    );

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
    const reader = await nodeWorkspaceFs.openFileReader?.(
      file,
      "reject",
      nodeWorkspaceFs.stat(file),
    );
    if (reader === undefined) throw new TypeError("missing production reader");
    unlinkSync(file);
    symlinkSync(privateFile, file);

    await expect(reader.readRange(0, 64)).rejects.toMatchObject({ reason: "changed" });
    await expect(reader.close()).resolves.toBeUndefined();
    await expect(reader.close()).resolves.toBeUndefined();
  });
});
