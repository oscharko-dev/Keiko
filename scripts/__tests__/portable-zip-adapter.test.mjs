import { Buffer } from "node:buffer";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPortableZipAdapter, safeZipExtractionEntries } from "../stage-portable-runtime.mjs";
import { writeZipArchiveEntries } from "../lib/zip-archive.mjs";

const tempRoots = [];

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "keiko-portable-zip-"));
  tempRoots.push(root);
  return root;
}

function fakeAdapter(entries) {
  return {
    list: () => entries,
    extract: () => undefined,
    create: () => undefined,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Windows portable ZIP adapter", () => {
  it("uses the Node ZIP reader and writer without a 7z process dependency", () => {
    const root = tempRoot();
    const source = join(root, "payload");
    const archivePath = join(root, "out", "keiko.zip");
    const extractRoot = join(root, "extract");
    mkdirSync(join(source, "Keiko", "runtime"), { recursive: true });
    writeFileSync(join(source, "Keiko", "runtime", "node.exe"), "fixture node\n");
    const run = vi.fn();
    const adapter = createPortableZipAdapter("win32", run);

    adapter.create(source, "Keiko", archivePath);
    expect(safeZipExtractionEntries(archivePath, "Keiko", adapter)).toEqual([
      "Keiko/runtime/node.exe",
    ]);
    adapter.extract(archivePath, extractRoot);

    expect(run).not.toHaveBeenCalled();
    expect(existsSync(join(extractRoot, "Keiko", "runtime", "node.exe"))).toBe(true);
    expect(readFileSync(join(extractRoot, "Keiko", "runtime", "node.exe"), "utf8")).toBe(
      "fixture node\n",
    );
  });

  it("fails closed when the ZIP cannot be parsed", () => {
    const root = tempRoot();
    const archivePath = join(root, "broken.zip");
    writeFileSync(archivePath, "not a zip");
    const adapter = createPortableZipAdapter("win32", vi.fn());

    expect(() => adapter.list(archivePath)).toThrow("ZIP archive has no end-of-central-directory");
  });

  it("rejects traversal entries before extraction", () => {
    const adapter = fakeAdapter(["Keiko/runtime/node.exe", "Keiko/../../escape.exe"]);

    expect(() => safeZipExtractionEntries("runtime.zip", "Keiko", adapter)).toThrow(
      "archive entry escapes Keiko",
    );
  });

  // Regression coverage for the S8786 backtracking fix in `normalizeArchiveEntry`'s trailing-slash
  // strip: the previous `/\/+$/u` regex is unanchored at the front, so an entry name with a long
  // run of `/` not at the very end forced an O(n) backtrack retry at every position in that run.
  it("rejects an entry with a pathologically long slash run without catastrophic backtracking", () => {
    const adversarialPath = `Keiko/${"/".repeat(20000)}x`;
    const adapter = fakeAdapter(["Keiko/runtime/node.exe", adversarialPath]);
    expect(() => safeZipExtractionEntries("runtime.zip", "Keiko", adapter)).toThrow(
      "archive entry escapes Keiko",
    );
  });

  // Successor to the retired 7z adapter's entry-type pin: a Windows runtime archive may contain
  // only regular files. A symlink entry (Unix S_IFLNK in the central-directory external
  // attributes) must refuse the archive on BOTH list and extract — materializing a link's
  // target text as a plain file would silently change its meaning.
  it("fails closed on a ZIP symlink entry instead of materializing it as a file", () => {
    const root = tempRoot();
    const archivePath = join(root, "with-symlink.zip");
    writeZipArchiveEntries(archivePath, [
      { name: "Keiko/runtime/node.exe", data: Buffer.from("regular"), mode: 0o100644 },
      { name: "Keiko/runtime/link", data: Buffer.from("../target"), mode: 0o120777 },
    ]);
    const adapter = createPortableZipAdapter("win32", vi.fn());

    expect(() => adapter.list(archivePath)).toThrow("unsupported special entry type");
    expect(() => adapter.extract(archivePath, join(root, "out"))).toThrow(
      "unsupported special entry type",
    );
    expect(existsSync(join(root, "out", "Keiko", "runtime", "link"))).toBe(false);
  });

  // A trailing-slash marker is skipped, not materialized — but a `dir/` entry whose Unix type
  // bits say SYMLINK is a contradiction only a hostile archive produces. The skip branch must
  // still validate the type instead of stepping over it (the retired 7z checker refused these).
  it("fails closed on a directory marker carrying symlink type bits", () => {
    const root = tempRoot();
    const archivePath = join(root, "typed-dir.zip");
    // The writer itself refuses trailing-slash names; the hostile fixture needs the explicit
    // unsafe-name escape hatch to exist at all.
    writeZipArchiveEntries(
      archivePath,
      [
        { name: "Keiko/runtime/node.exe", data: Buffer.from("regular"), mode: 0o100644 },
        { name: "Keiko/link/", data: Buffer.alloc(0), mode: 0o120777 },
      ],
      { allowUnsafeEntryNames: true },
    );
    const adapter = createPortableZipAdapter("win32", vi.fn());

    expect(() => adapter.list(archivePath)).toThrow("unsupported special entry type");
    expect(() => adapter.extract(archivePath, join(root, "out"))).toThrow(
      "unsupported special entry type",
    );
  });

  // `name:stream` in a ZIP entry carries regular-file Unix type bits, but on NTFS it
  // materializes an ALTERNATE DATA STREAM of `name` — payload bytes hidden from every plain
  // directory listing. The retired 7z pipeline rejected these via its metadata checker; the
  // Node adapter must refuse the name itself, on read, extract, and create alike.
  it("fails closed on an NTFS alternate-stream entry name instead of materializing a stream", () => {
    const root = tempRoot();
    const archivePath = join(root, "with-ads.zip");
    writeZipArchiveEntries(archivePath, [
      { name: "Keiko/runtime/node.exe", data: Buffer.from("regular"), mode: 0o100644 },
      { name: "Keiko/runtime/node.exe:payload", data: Buffer.from("hidden"), mode: 0o100644 },
    ]);
    const adapter = createPortableZipAdapter("win32", vi.fn());

    expect(() => adapter.list(archivePath)).toThrow("alternate-stream separator");
    expect(() => adapter.extract(archivePath, join(root, "out"))).toThrow(
      "alternate-stream separator",
    );
  });

  it("refuses to archive a source file whose name would become an alternate stream", () => {
    const root = tempRoot();
    const treeRoot = join(root, "Keiko");
    mkdirSync(join(treeRoot, "runtime"), { recursive: true });
    writeFileSync(join(treeRoot, "runtime", "node.exe"), "regular");
    writeFileSync(join(treeRoot, "runtime", "evil:stream"), "hidden");
    const adapter = createPortableZipAdapter("win32", vi.fn());

    expect(() => adapter.create(root, "Keiko", join(root, "keiko.zip"))).toThrow(
      "alternate-stream separator",
    );
  });

  it("treats an alternate-stream name as escaping the expected root", () => {
    const adapter = fakeAdapter(["Keiko/runtime/node.exe", "Keiko/runtime/node.exe:payload"]);
    expect(() => safeZipExtractionEntries("runtime.zip", "Keiko", adapter)).toThrow(
      "archive entry escapes Keiko",
    );
  });

  // A followed symlink whose target resolves OUTSIDE the staged tree must refuse archive
  // creation — otherwise a staged link could embed arbitrary workspace bytes into a release ZIP.
  it("refuses to archive a symlink that escapes the staged tree", () => {
    const root = tempRoot();
    const treeRoot = join(root, "Keiko");
    mkdirSync(join(treeRoot, "runtime"), { recursive: true });
    writeFileSync(join(treeRoot, "runtime", "node.exe"), "regular");
    writeFileSync(join(root, "outside-secret.txt"), "workspace bytes");
    try {
      symlinkSync(join(root, "outside-secret.txt"), join(treeRoot, "runtime", "escape"));
    } catch (error) {
      // An unprivileged Windows host cannot create symlinks; the containment guard is
      // exercised by the POSIX CI lanes, so skip rather than fail here.
      if (error?.code === "EPERM") return;
      throw error;
    }
    const adapter = createPortableZipAdapter("win32", vi.fn());

    expect(() => adapter.create(root, "Keiko", join(root, "keiko.zip"))).toThrow(
      "escapes the archive root",
    );
  });
});
