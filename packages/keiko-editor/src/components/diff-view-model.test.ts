import { describe, expect, it } from "vitest";

import type { PatchPreviewFile, PatchPreviewModel } from "../patch-preview.js";
import { canNavigateDiffs, resolveSelectedFile } from "./diff-view-model.js";

function file(uri: string, overrides?: Partial<PatchPreviewFile>): PatchPreviewFile {
  return {
    uri,
    displayPath: uri,
    status: "modified",
    diffable: true,
    original: "a",
    modified: "b",
    language: "typescript",
    hasChanges: true,
    truncated: false,
    ...overrides,
  };
}

function model(files: readonly PatchPreviewFile[]): PatchPreviewModel {
  return {
    patchId: "p1",
    status: "previewed",
    files,
    fileCount: files.length,
    totalFileCount: files.length,
    omittedFileCount: 0,
    createdCount: 0,
    modifiedCount: 0,
    deletedCount: 0,
    binaryCount: 0,
    unsupportedCount: 0,
    truncated: false,
  };
}

describe("resolveSelectedFile", () => {
  it("returns no selection for an empty patch", () => {
    expect(resolveSelectedFile(model([]), null)).toEqual({ file: null, index: -1 });
  });

  it("falls back to the first file when no URI is selected", () => {
    const m = model([file("a"), file("b")]);
    const resolved = resolveSelectedFile(m, null);
    expect(resolved.index).toBe(0);
    expect(resolved.file?.uri).toBe("a");
  });

  it("resolves a selected URI that still exists", () => {
    const m = model([file("a"), file("b")]);
    const resolved = resolveSelectedFile(m, "b");
    expect(resolved.index).toBe(1);
    expect(resolved.file?.uri).toBe("b");
  });

  it("falls back to the first file when the selected URI is stale", () => {
    const m = model([file("a"), file("b")]);
    const resolved = resolveSelectedFile(m, "gone");
    expect(resolved.index).toBe(0);
    expect(resolved.file?.uri).toBe("a");
  });
});

describe("canNavigateDiffs", () => {
  it("is false when there is no file", () => {
    expect(canNavigateDiffs(null)).toBe(false);
  });

  it("is false for a non-diffable file", () => {
    expect(canNavigateDiffs(file("a", { diffable: false, hasChanges: false }))).toBe(false);
  });

  it("is false for a diffable file with no changes", () => {
    expect(canNavigateDiffs(file("a", { hasChanges: false }))).toBe(false);
  });

  it("is true for a diffable file with changes", () => {
    expect(canNavigateDiffs(file("a"))).toBe(true);
  });
});
