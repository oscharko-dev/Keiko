import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPortableZipAdapter, safeZipExtractionEntries } from "../stage-portable-runtime.mjs";

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

    const start = Date.now();
    expect(() => safeZipExtractionEntries("runtime.zip", "Keiko", adapter)).toThrow(
      "archive entry escapes Keiko",
    );
    expect(Date.now() - start).toBeLessThan(300);
  });
});
