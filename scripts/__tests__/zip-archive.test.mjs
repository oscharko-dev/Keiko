import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import yauzl from "yauzl";

import { writeZipArchiveEntries, writeZipArchiveFromDirectory } from "../lib/zip-archive.mjs";

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
