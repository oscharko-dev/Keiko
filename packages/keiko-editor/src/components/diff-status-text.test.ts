import { describe, expect, it } from "vitest";

import type { PatchPreviewFile, PatchPreviewModel } from "../patch-preview.js";
import {
  deriveDiffSummary,
  deriveDiffTruncationNote,
  diffFileStatusLabel,
} from "./diff-status-text.js";

function model(overrides?: Partial<PatchPreviewModel>): PatchPreviewModel {
  return {
    patchId: "p1",
    status: "previewed",
    files: [],
    fileCount: 0,
    totalFileCount: 0,
    omittedFileCount: 0,
    createdCount: 0,
    modifiedCount: 0,
    deletedCount: 0,
    binaryCount: 0,
    unsupportedCount: 0,
    truncated: false,
    ...overrides,
  };
}

function file(overrides: Partial<PatchPreviewFile> & { uri: string }): PatchPreviewFile {
  return {
    displayPath: "src/a.ts",
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

describe("diffFileStatusLabel", () => {
  it("maps each status to a human label", () => {
    expect(diffFileStatusLabel("created")).toBe("created");
    expect(diffFileStatusLabel("modified")).toBe("modified");
    expect(diffFileStatusLabel("deleted")).toBe("deleted");
    expect(diffFileStatusLabel("binary")).toBe("binary");
    expect(diffFileStatusLabel("unsupported")).toBe("not previewable");
  });
});

describe("deriveDiffSummary", () => {
  it("is a polite loading status while the runtime loads", () => {
    const summary = deriveDiffSummary({
      model: model(),
      loadState: { status: "loading" },
      selectedDisplayPath: null,
      selectedStatus: null,
    });
    expect(summary.role).toBe("status");
    expect(summary.ariaLive).toBe("polite");
    expect(summary.message).toBe("Loading diff…");
  });

  it("is an assertive alert when the runtime failed to load", () => {
    const summary = deriveDiffSummary({
      model: model(),
      loadState: { status: "error", message: "worker boot failed" },
      selectedDisplayPath: null,
      selectedStatus: null,
    });
    expect(summary.role).toBe("alert");
    expect(summary.ariaLive).toBe("assertive");
    expect(summary.message).toContain("worker boot failed");
  });

  it("reports an empty patch as no changes", () => {
    const summary = deriveDiffSummary({
      model: model(),
      loadState: { status: "ready" },
      selectedDisplayPath: null,
      selectedStatus: null,
    });
    expect(summary.message).toBe("No changes to review.");
  });

  it("summarises counts and the selected file without exposing content (AC4)", () => {
    const summary = deriveDiffSummary({
      model: model({
        totalFileCount: 3,
        fileCount: 3,
        createdCount: 1,
        modifiedCount: 1,
        deletedCount: 1,
      }),
      loadState: { status: "ready" },
      selectedDisplayPath: "src/a.ts",
      selectedStatus: "modified",
    });
    expect(summary.role).toBe("status");
    expect(summary.message).toContain("3 changed file(s)");
    expect(summary.message).toContain("1 created, 1 modified, 1 deleted");
    expect(summary.message).toContain("Showing src/a.ts (modified)");
  });

  it("notes non-text files in the counts", () => {
    const summary = deriveDiffSummary({
      model: model({ totalFileCount: 2, fileCount: 2, binaryCount: 1, unsupportedCount: 1 }),
      loadState: { status: "ready" },
      selectedDisplayPath: null,
      selectedStatus: null,
    });
    expect(summary.message).toContain("2 not shown as text");
  });
});

describe("deriveDiffTruncationNote", () => {
  it("returns null when nothing was bounded", () => {
    expect(deriveDiffTruncationNote(model())).toBeNull();
  });

  it("reports omitted files", () => {
    const note = deriveDiffTruncationNote(model({ truncated: true, omittedFileCount: 4 }));
    expect(note).toContain("4 file(s) not shown");
  });

  it("reports clamped file content", () => {
    const note = deriveDiffTruncationNote(
      model({ truncated: true, files: [file({ uri: "u", truncated: true })] }),
    );
    expect(note).toContain("truncated to the display limit");
  });

  it("reports both omitted and clamped together", () => {
    const note = deriveDiffTruncationNote(
      model({ truncated: true, omittedFileCount: 2, files: [file({ uri: "u", truncated: true })] }),
    );
    expect(note).toContain("not shown");
    expect(note).toContain("truncated");
  });
});
