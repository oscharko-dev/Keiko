import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import yauzl from "yauzl";

import {
  extractZipArchiveEntries,
  readZipArchiveEntries,
  writeZipArchiveEntries,
  writeZipArchiveFromDirectory,
} from "../lib/zip-archive.mjs";

const temporaryRoots = [];

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "keiko-zip-archive-test-"));
  temporaryRoots.push(root);
  return root;
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readEntries(path) {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (openError, zip) => {
      if (openError !== null || zip === undefined) return reject(openError);
      const entries = [];
      zip.on("error", reject);
      zip.on("entry", (entry) => {
        entries.push(entry);
        zip.readEntry();
      });
      zip.on("end", () => resolve(entries));
      zip.readEntry();
    });
  });
}

function readEntryData(path, expectedName) {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (openError, zip) => {
      if (openError !== null || zip === undefined) return reject(openError);
      zip.on("error", reject);
      zip.on("entry", (entry) => {
        if (entry.fileName !== expectedName) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError !== null || stream === undefined) {
            zip.close();
            reject(streamError);
            return;
          }
          const chunks = [];
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("error", reject);
          stream.on("end", () => {
            zip.close();
            resolve(Buffer.concat(chunks));
          });
        });
      });
      zip.on("end", () => reject(new Error(`ZIP entry not found: ${expectedName}`)));
      zip.readEntry();
    });
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("portable ZIP archive writer", () => {
  it("writes deterministic, directory-entry-free archives with POSIX entry names", async () => {
    const root = temporaryRoot();
    const source = join(root, "payload");
    mkdirSync(join(source, "nested"), { recursive: true });
    writeFileSync(join(source, "package.json"), '{"name":"fixture"}\n');
    writeFileSync(join(source, "nested", "app.js"), "export default 1;\n");
    const first = join(root, "first.zip");
    const second = join(root, "second.zip");

    writeZipArchiveFromDirectory(source, first, { rootName: "Keiko" });
    writeZipArchiveFromDirectory(source, second, { rootName: "Keiko" });

    expect(digest(first)).toBe(digest(second));
    expect((await readEntries(first)).map((entry) => entry.fileName)).toEqual([
      "Keiko/nested/app.js",
      "Keiko/package.json",
    ]);
  });

  it("rejects traversal entry names by default", () => {
    const archive = join(temporaryRoot(), "unsafe.zip");

    expect(() => writeZipArchiveEntries(archive, [{ name: "../escape", data: "x" }])).toThrow(
      "ZIP entry name is unsafe",
    );
  });

  it("rejects empty path segments by default", () => {
    const archive = join(temporaryRoot(), "unsafe-empty-segment.zip");

    expect(() => writeZipArchiveEntries(archive, [{ name: "safe//entry.txt", data: "x" }])).toThrow(
      "ZIP entry name is unsafe",
    );
  });

  it("preserves the archive replacement error after closing the temporary file", () => {
    const archive = join(temporaryRoot(), "existing-directory");
    mkdirSync(archive);
    let failure;

    try {
      writeZipArchiveEntries(archive, [{ name: "entry.txt", data: "content" }]);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toMatchObject({ code: "EBADF" });
  });

  it("orders directory entries by locale-independent UTF-16 code units", async () => {
    const root = temporaryRoot();
    const source = join(root, "payload");
    mkdirSync(source);
    writeFileSync(join(source, "a.txt"), "lowercase\n");
    writeFileSync(join(source, "B.txt"), "uppercase\n");
    const archive = join(root, "ordered.zip");

    writeZipArchiveFromDirectory(source, archive, { rootName: "Keiko" });

    expect((await readEntries(archive)).map((entry) => entry.fileName)).toEqual([
      "Keiko/B.txt",
      "Keiko/a.txt",
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "preserves symlink metadata when explicitly requested",
    async () => {
      const root = temporaryRoot();
      const source = join(root, "payload");
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, "target"), "target\n");
      symlinkSync("target", join(source, "link"));
      const archive = join(root, "symlink.zip");

      writeZipArchiveFromDirectory(source, archive, { rootName: "Keiko", preserveSymlinks: true });

      const link = (await readEntries(archive)).find((entry) => entry.fileName === "Keiko/link");
      expect(((link?.externalFileAttributes ?? 0) >>> 16) & 0o170000).toBe(0o120000);
    },
  );

  it.skipIf(process.platform === "win32")(
    "dereferences file symlinks when followSymlinks is explicitly requested",
    async () => {
      const root = temporaryRoot();
      const source = join(root, "payload");
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, "target"), "target content\n");
      symlinkSync("target", join(source, "link"));
      const archive = join(root, "follow-symlink.zip");

      writeZipArchiveFromDirectory(source, archive, { rootName: "Keiko", followSymlinks: true });

      const link = (await readEntries(archive)).find((entry) => entry.fileName === "Keiko/link");
      expect(((link?.externalFileAttributes ?? 0) >>> 16) & 0o170000).toBe(0o100000);
      expect((await readEntryData(archive, "Keiko/link")).toString("utf8")).toBe(
        "target content\n",
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "allows non-cyclic symlink diamonds when following directory symlinks",
    async () => {
      const root = temporaryRoot();
      const source = join(root, "payload");
      mkdirSync(join(source, "shared"), { recursive: true });
      writeFileSync(join(source, "shared", "runtime.dll"), "shared runtime\n");
      symlinkSync("shared", join(source, "link-a"), "dir");
      symlinkSync("shared", join(source, "link-b"), "dir");
      const archive = join(root, "diamond.zip");

      writeZipArchiveFromDirectory(source, archive, { rootName: "Keiko", followSymlinks: true });

      expect((await readEntries(archive)).map((entry) => entry.fileName)).toEqual([
        "Keiko/link-a/runtime.dll",
        "Keiko/link-b/runtime.dll",
        "Keiko/shared/runtime.dll",
      ]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects recursive directory symlinks when following symlinks",
    () => {
      const root = temporaryRoot();
      const source = join(root, "payload");
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, "runtime.dll"), "runtime\n");
      symlinkSync(".", join(source, "loop"), "dir");

      expect(() =>
        writeZipArchiveFromDirectory(source, join(root, "loop.zip"), {
          rootName: "Keiko",
          followSymlinks: true,
        }),
      ).toThrow("ZIP source contains a recursive symlinked directory");
    },
  );

  it.skipIf(process.platform === "win32")("keeps symlink rejection as the safe default", () => {
    const root = temporaryRoot();
    const source = join(root, "payload");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "target"), "target\n");
    symlinkSync("target", join(source, "link"));

    expect(() =>
      writeZipArchiveFromDirectory(source, join(root, "default.zip"), { rootName: "Keiko" }),
    ).toThrow("ZIP source contains an unsupported entry");
  });
});

describe("readZipArchiveEntries", () => {
  it("round-trips what the writer produced, nested names and binary bytes included", () => {
    const root = temporaryRoot();
    const archivePath = join(root, "round-trip.zip");
    const records = [
      { name: "flat.txt", data: "flat bytes" },
      { name: "inner/nested.bin", data: Buffer.from([0, 1, 2, 250, 251, 255]) },
    ];
    writeZipArchiveEntries(archivePath, records);

    const entries = readZipArchiveEntries(archivePath);

    expect(entries.map((entry) => entry.name)).toEqual(["flat.txt", "inner/nested.bin"]);
    expect(entries[0].data.toString("utf8")).toBe("flat bytes");
    expect([...entries[1].data]).toEqual([0, 1, 2, 250, 251, 255]);
  });

  it("refuses bytes that are not a ZIP archive", () => {
    const root = temporaryRoot();
    const archivePath = join(root, "not-a-zip.zip");
    writeFileSync(archivePath, "just some text");

    expect(() => readZipArchiveEntries(archivePath)).toThrow(/no end-of-central-directory/u);
  });

  it("refuses an entry whose bytes were tampered after writing", () => {
    // The declared CRC and size are load-bearing: a flipped byte in the compressed stream must
    // refuse, never answer with silently different content.
    const root = temporaryRoot();
    const archivePath = join(root, "tampered.zip");
    writeZipArchiveEntries(archivePath, [{ name: "file.txt", data: "original content bytes" }]);
    const bytes = readFileSync(archivePath);
    // The compressed stream begins after the 30-byte local header plus the 8-byte entry name.
    bytes[30 + "file.txt".length + 2] ^= 0xff;
    writeFileSync(archivePath, bytes);

    expect(() => readZipArchiveEntries(archivePath)).toThrow(
      /does not match its declared size or checksum/u,
    );
  });

  it("reads a stored (uncompressed) entry the way GitHub's artifact endpoint may pack one", () => {
    // The writer always deflates, so the stored branch is exercised through hand-built bytes:
    // method 0 with the raw data in place of the compressed stream, sizes and CRC adjusted.
    const root = temporaryRoot();
    const archivePath = join(root, "stored.zip");
    writeZipArchiveEntries(archivePath, [{ name: "file.txt", data: "stored bytes" }]);
    const bytes = readFileSync(archivePath);
    const data = Buffer.from("stored bytes");
    const nameLength = "file.txt".length;
    const localData = 30 + nameLength;
    const compressed = bytes.subarray(localData, bytes.length - 22 - 46 - nameLength);
    const stored = Buffer.concat([
      bytes.subarray(0, localData),
      data,
      bytes.subarray(localData + compressed.byteLength),
    ]);
    const centralOffset = stored.length - 22 - 46 - nameLength;
    stored.writeUInt16LE(0, 8); // local method: store
    stored.writeUInt32LE(data.byteLength, 18); // local compressed size
    stored.writeUInt16LE(0, centralOffset + 10); // central method: store
    stored.writeUInt32LE(data.byteLength, centralOffset + 20); // central compressed size
    stored.writeUInt32LE(centralOffset, stored.length - 22 + 16); // EOCD central offset
    writeFileSync(archivePath, stored);

    const entries = readZipArchiveEntries(archivePath);

    expect(entries).toHaveLength(1);
    expect(entries[0].data.toString("utf8")).toBe("stored bytes");
  });

  it("refuses an entry using an unsupported compression method", () => {
    const root = temporaryRoot();
    const archivePath = join(root, "unsupported.zip");
    writeZipArchiveEntries(archivePath, [{ name: "file.txt", data: "bytes" }]);
    const bytes = readFileSync(archivePath);
    const centralOffset = bytes.length - 22 - 46 - "file.txt".length;
    bytes.writeUInt16LE(12, centralOffset + 10); // bzip2: valid ZIP, unsupported here
    writeFileSync(archivePath, bytes);

    expect(() => readZipArchiveEntries(archivePath)).toThrow(/unsupported compression method/u);
  });

  it("refuses an archive whose entry names escape the extraction root", () => {
    // The writer's own traversal rule guards the reader too: a hostile archive must not be able
    // to name a path outside where it is being extracted.
    const root = temporaryRoot();
    const archivePath = join(root, "hostile.zip");
    writeZipArchiveEntries(archivePath, [{ name: "../evil.txt", data: "escape" }], {
      allowUnsafeEntryNames: true,
    });

    expect(() => readZipArchiveEntries(archivePath)).toThrow(/unsafe/u);
  });
});

describe("extractZipArchiveEntries", () => {
  it("extracts nested entries to disk through windowed reads", () => {
    const root = temporaryRoot();
    const archivePath = join(root, "extract.zip");
    writeZipArchiveEntries(archivePath, [
      { name: "top.txt", data: "top bytes" },
      { name: "inner/deep/nested.bin", data: Buffer.from([7, 0, 255]) },
    ]);
    const target = join(root, "out");

    extractZipArchiveEntries(archivePath, target);

    expect(readFileSync(join(target, "top.txt"), "utf8")).toBe("top bytes");
    expect([...readFileSync(join(target, "inner", "deep", "nested.bin"))]).toEqual([7, 0, 255]);
  });

  it("refuses a truncated archive through the descriptor path", () => {
    // The extractor has its own read path (readAt windows); a short file must refuse, never
    // yield partial entries.
    const root = temporaryRoot();
    const archivePath = join(root, "truncated-extract.zip");
    writeZipArchiveEntries(archivePath, [{ name: "file.txt", data: "0123456789".repeat(50) }]);
    const bytes = readFileSync(archivePath);
    writeFileSync(archivePath, bytes.subarray(0, bytes.length - 30));

    expect(() => extractZipArchiveEntries(archivePath, join(root, "out"))).toThrow();
  });

  it("refuses ZIP64 sentinel values in both readers", () => {
    // 0xffff entries / 0xffffffff directory offset announce ZIP64 records neither reader
    // understands; using them as literal values would misread the directory.
    const root = temporaryRoot();
    const archivePath = join(root, "zip64.zip");
    writeZipArchiveEntries(archivePath, [{ name: "file.txt", data: "bytes" }]);
    const bytes = readFileSync(archivePath);
    bytes.writeUInt16LE(0xffff, bytes.length - 22 + 10);
    writeFileSync(archivePath, bytes);

    expect(() => readZipArchiveEntries(archivePath)).toThrow(/ZIP64/u);
    expect(() => extractZipArchiveEntries(archivePath, join(root, "out"))).toThrow(/ZIP64/u);
  });

  it("caps inflation at the declared entry size", () => {
    // A hostile header may declare a small size for a stream that inflates far larger; the
    // declared size is the memory ceiling and the mismatch refuses.
    const root = temporaryRoot();
    const archivePath = join(root, "overflow.zip");
    writeZipArchiveEntries(archivePath, [{ name: "file.txt", data: "A".repeat(4096) }]);
    const bytes = readFileSync(archivePath);
    const centralOffset = bytes.length - 22 - 46 - "file.txt".length;
    bytes.writeUInt32LE(16, centralOffset + 24); // declared uncompressed size far below reality
    writeFileSync(archivePath, bytes);

    expect(() => readZipArchiveEntries(archivePath)).toThrow();
  });

  it("refuses an oversized declared compressed size before allocating", () => {
    // The directory's compressedSize is untrusted; a value beyond the file must refuse as
    // truncation instead of allocating the declared amount first.
    const root = temporaryRoot();
    const archivePath = join(root, "oversized.zip");
    writeZipArchiveEntries(archivePath, [{ name: "file.txt", data: "bytes" }]);
    const bytes = readFileSync(archivePath);
    const centralOffset = bytes.length - 22 - 46 - "file.txt".length;
    bytes.writeUInt32LE(0xfffffff0, centralOffset + 20);
    writeFileSync(archivePath, bytes);

    expect(() => extractZipArchiveEntries(archivePath, join(root, "out"))).toThrow(/truncated/u);
  });

  it("refuses an entry that declares a size beyond the supported ceiling", () => {
    // maxOutputLength alone would still admit a 4 GiB allocation from a hostile uint32 size.
    const root = temporaryRoot();
    const archivePath = join(root, "giant.zip");
    writeZipArchiveEntries(archivePath, [{ name: "file.txt", data: "bytes" }]);
    const bytes = readFileSync(archivePath);
    const centralOffset = bytes.length - 22 - 46 - "file.txt".length;
    bytes.writeUInt32LE(0xfffffff0, centralOffset + 24); // declared uncompressed size ~4 GiB
    writeFileSync(archivePath, bytes);

    expect(() => readZipArchiveEntries(archivePath)).toThrow(/beyond the supported ceiling/u);
  });

  it("refuses a hostile entry name before writing anything", () => {
    const root = temporaryRoot();
    const archivePath = join(root, "hostile-extract.zip");
    writeZipArchiveEntries(archivePath, [{ name: "../escape.txt", data: "escape" }], {
      allowUnsafeEntryNames: true,
    });

    expect(() => extractZipArchiveEntries(archivePath, join(root, "out"))).toThrow(/unsafe/u);
  });
});
