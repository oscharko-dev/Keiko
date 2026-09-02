import { execFileSync } from "node:child_process";
import fs, {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  classifyCreationTimeProbe,
  isWorkspacePathSnapshotCurrent,
  nodeWorkspaceFs,
  probeCreationTimeSupport,
  type WorkspaceDescriptorReadCompleteness,
  WorkspaceDescriptorReadError,
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

  // Every term of the admission-time snapshot comparison, proven ONE AT A TIME.
  //
  // The consumer-level pin for this guard (files.test.ts, "rejects a same-size, same-mtime
  // substitute swapped in between admission and the content read") cannot carry it. A substitute
  // file has to be created, and creating it moves `ctime`, which userland cannot set back — so that
  // test is refused on the ctime term no matter what the inode term does. Verified by deleting
  // `expected.fileIdentity === observed.fileIdentity` from the comparator: the consumer pin stayed
  // green while the binding it is named after was gone.
  //
  // Mutating exactly one field of `expected` is the only way to hold each term individually
  // falsifiable, and it goes through the production read rather than reaching for the private
  // comparator, so the pin cannot drift away from the code path callers actually use.
  it.each([
    { term: "file identity (device:inode)", change: { fileIdentity: "0:0" } },
    { term: "size", change: { size: 1 } },
    { term: "hard link count", change: { hardLinkCount: 99 } },
    { term: "modification time", change: { mtimeNs: "1" } },
    { term: "change time", change: { ctimeNs: "1" } },
    { term: "regular-file kind", change: { isFile: false } },
    { term: "directory kind", change: { isDirectory: true } },
    { term: "symbolic-link kind", change: { isSymbolicLink: true } },
  ])("refuses a bounded read whose admitted $term no longer matches", async ({ change }) => {
    const { file } = workspaceFixture();
    const admitted = nodeWorkspaceFs.stat(file);

    await expect(
      nodeWorkspaceFs.readFileBytes?.(file, 64, "reject", { ...admitted, ...change }),
    ).rejects.toThrow(WorkspaceDescriptorReadError);
    // The unmutated snapshot still reads, so each rejection above is the mutated term and not a
    // fixture that could never be admitted in the first place.
    await expect(
      nodeWorkspaceFs.readFileBytes?.(file, 64, "reject", admitted),
    ).resolves.toBeInstanceOf(Uint8Array);
  });

  // The PRODUCER, not just the comparator. The cases above prove the comparison consumes whatever
  // `workspaceStat` calls `fileIdentity`; they do not prove that value is still device+inode.
  // Review demonstrated the gap by replacing the producer with `String(stats.ctimeNs)` — every
  // comparator case, the consumer substitution test, and the whole workspace suite stayed green
  // while the independent identity signal had collapsed onto a timestamp.
  //
  // These three hold the producer to inode semantics without restating its formula: an identity that
  // followed any timestamp fails the second, and one that followed the path fails the first.
  it("gives two names for one inode the same identity, and a copy a different one", () => {
    const { root, file } = workspaceFixture();
    const hardLink = join(root, "same-inode.txt");
    const copy = join(root, "copied.txt");
    linkSync(file, hardLink);
    writeFileSync(copy, readFileSync(file));

    expect(nodeWorkspaceFs.stat(hardLink).fileIdentity).toBe(
      nodeWorkspaceFs.stat(file).fileIdentity,
    );
    expect(nodeWorkspaceFs.stat(copy).fileIdentity).not.toBe(
      nodeWorkspaceFs.stat(file).fileIdentity,
    );
  });

  it("does not move when the file's content and every timestamp move", () => {
    const { file } = workspaceFixture();
    const before = nodeWorkspaceFs.stat(file);

    writeFileSync(file, "rewritten with a different length", "utf8");
    utimesSync(file, new Date(0), new Date(0));
    const after = nodeWorkspaceFs.stat(file);

    // The rewrite has to have actually moved the fields an identity must not be built from,
    // otherwise this passes for the wrong reason.
    expect(after.size).not.toBe(before.size);
    expect(after.mtimeNs).not.toBe(before.mtimeNs);
    expect(after.ctimeNs).not.toBe(before.ctimeNs);
    expect(after.fileIdentity).toBe(before.fileIdentity);
  });

  // `birthtimeNs` is the field the managed-worktree identity is built on, and this is the only place
  // it is produced from a real stat; every consumer test hands it in as a string literal. Pin the
  // producer's two load-bearing properties on a real file: it survives an in-place rewrite that
  // moves every other timestamp, and it does not survive the file being recreated.
  it("keeps birthtimeNs across an in-place rewrite and drops it across a recreate", () => {
    const { file } = workspaceFixture();
    const before = nodeWorkspaceFs.stat(file);
    // Where the platform reports no creation time the field is absent by contract, and there is
    // nothing further to prove on this host.
    if (before.birthtimeNs === undefined) return;

    writeFileSync(file, "rewritten in place", "utf8");
    // A LATER timestamp on purpose: on macOS (APFS keeps the creation time at or before the
    // modification time) a utimes to a time before the file was created moves the creation time
    // back with it — to the epoch here, which the producer then reports as absent. Measured in
    // review; the guard under test is the in-place rewrite, not that platform rule.
    utimesSync(file, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    const rewritten = nodeWorkspaceFs.stat(file);
    expect(rewritten.ctimeNs).not.toBe(before.ctimeNs);
    expect(rewritten.birthtimeNs).toBe(before.birthtimeNs);

    rmSync(file);
    writeFileSync(file, "recreated", "utf8");
    expect(nodeWorkspaceFs.stat(file).birthtimeNs).not.toBe(before.birthtimeNs);
  });

  it("distinguishes two files that exist at the same moment", () => {
    const { root, file } = workspaceFixture();
    const sibling = join(root, "sibling.txt");
    writeFileSync(sibling, "alpha🙂omega", { encoding: "utf8", mode: 0o600 });

    expect(nodeWorkspaceFs.stat(sibling).fileIdentity).not.toBe(
      nodeWorkspaceFs.stat(file).fileIdentity,
    );
  });

  // An admission that never captured an identity cannot be re-proved against one. Fails closed
  // rather than treating "nothing to compare" as "nothing changed".
  it("refuses a bounded read admitted without a file identity", async () => {
    const { file } = workspaceFixture();
    const withoutIdentity: WorkspaceStat = {
      ...nodeWorkspaceFs.stat(file),
      fileIdentity: undefined,
    };

    await expect(
      nodeWorkspaceFs.readFileBytes?.(file, 64, "reject", withoutIdentity),
    ).rejects.toThrow(WorkspaceDescriptorReadError);
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

// A nonzero birthtime is not proof of a kept creation time: Node may report the ctime under that name
// where the filesystem has none (libuv's non-statx stat fallback), and an identity minted from it
// would read as a replaced worktree after the first metadata write (#3376 review P2). The pure
// classifier is pinned on every verdict; the real probe is pinned against this host's own capability.
describe("creation-time durability probe", () => {
  it("classifies absent, durable, aliased and inconclusive observations", () => {
    expect(
      classifyCreationTimeProbe(
        { birthtimeNs: 0n, ctimeNs: 10n },
        { birthtimeNs: 0n, ctimeNs: 20n },
      ),
    ).toBe("absent");
    expect(
      classifyCreationTimeProbe(
        { birthtimeNs: 5n, ctimeNs: 10n },
        { birthtimeNs: -1n, ctimeNs: 20n },
      ),
    ).toBe("absent");
    expect(
      classifyCreationTimeProbe(
        { birthtimeNs: 5n, ctimeNs: 10n },
        { birthtimeNs: 5n, ctimeNs: 20n },
      ),
    ).toBe("durable");
    // The "creation time" moved with the ctime: it is the ctime under another name.
    expect(
      classifyCreationTimeProbe(
        { birthtimeNs: 10n, ctimeNs: 10n },
        { birthtimeNs: 20n, ctimeNs: 20n },
      ),
    ).toBe("aliased");
    // The ctime did not move (same timestamp granule), so nothing can be told yet.
    expect(
      classifyCreationTimeProbe(
        { birthtimeNs: 10n, ctimeNs: 10n },
        { birthtimeNs: 10n, ctimeNs: 10n },
      ),
    ).toBe("inconclusive");
  });

  it("proves this host's managed-root capability and leaves nothing behind", () => {
    const { root } = workspaceFixture();
    const expected = nodeWorkspaceFs.stat(root).birthtimeNs === undefined ? "absent" : "durable";

    expect(probeCreationTimeSupport(root)).toBe(expected);
    expect(
      fs.readdirSync(root).filter((name) => name.startsWith(".keiko-creation-time-probe-")),
    ).toEqual([]);
  });
});
