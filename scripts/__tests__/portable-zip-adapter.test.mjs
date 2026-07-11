import { describe, expect, it, vi } from "vitest";

import { createPortableZipAdapter, safeZipExtractionEntries } from "../stage-portable-runtime.mjs";

function sevenZipList(entries) {
  return entries
    .map((entry) =>
      [
        `Path = ${entry.path}`,
        `Folder = ${entry.folder ? "+" : "-"}`,
        `Attributes = ${entry.attributes ?? (entry.folder ? "D" : "A")}`,
        ...(entry.symbolicLink === undefined ? [] : [`Symbolic Link = ${entry.symbolicLink}`]),
      ].join("\n"),
    )
    .join("\n\n");
}

describe("Windows portable ZIP adapter", () => {
  it("uses preinstalled 7z for structured listing, extraction, and final ZIP creation", () => {
    const run = vi.fn((command, args) => {
      if (args[0] === "l") {
        return {
          stdout: sevenZipList([
            { path: "Keiko", folder: true },
            { path: "Keiko/runtime/node.exe", folder: false },
          ]),
        };
      }
      return { stdout: "" };
    });
    const adapter = createPortableZipAdapter("win32", run);

    expect(safeZipExtractionEntries("runtime.zip", "Keiko", adapter)).toEqual([
      "Keiko",
      "Keiko/runtime/node.exe",
    ]);
    adapter.extract("runtime.zip", "C:\\stage");
    adapter.create("C:\\payload", "Keiko", "C:\\out\\keiko.zip");

    expect(run).toHaveBeenNthCalledWith(1, "7z", ["l", "-slt", "-ba", "runtime.zip"]);
    expect(run).toHaveBeenNthCalledWith(2, "7z", ["x", "-y", "-oC:\\stage", "runtime.zip"]);
    expect(run).toHaveBeenNthCalledWith(
      3,
      "7z",
      ["a", "-tzip", "-mx=9", "C:\\out\\keiko.zip", "Keiko"],
      { cwd: "C:\\payload" },
    );
  });

  it("fails closed when 7z is missing or a command fails", () => {
    for (const message of ["spawn 7z ENOENT", "7z exited 2"]) {
      const adapter = createPortableZipAdapter("win32", () => {
        throw new Error(message);
      });

      expect(() => adapter.list("runtime.zip")).toThrow(message);
    }
  });

  it("rejects traversal entries before extraction", () => {
    const adapter = createPortableZipAdapter("win32", () => ({
      stdout: sevenZipList([
        { path: "Keiko", folder: true },
        { path: "Keiko/../../escape.exe", folder: false },
      ]),
    }));

    expect(() => safeZipExtractionEntries("runtime.zip", "Keiko", adapter)).toThrow(
      "archive entry escapes Keiko",
    );
  });

  it("rejects symbolic links and special entry types from structured 7z metadata", () => {
    for (const entry of [
      { path: "Keiko/link", folder: false, attributes: "A_ lrwxrwxrwx" },
      { path: "Keiko/link", folder: false, symbolicLink: "../../outside" },
      { path: "Keiko/device", folder: false, attributes: "A_ crw-rw-rw-" },
    ]) {
      const adapter = createPortableZipAdapter("win32", () => ({
        stdout: sevenZipList([entry]),
      }));

      expect(() => adapter.list("runtime.zip")).toThrow(
        "archive contains unsupported special-file entries",
      );
    }
  });
});
