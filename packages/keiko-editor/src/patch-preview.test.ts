import { describe, expect, it } from "vitest";

import { buildPatchPreview, type PatchPreviewSource } from "./patch-preview.js";
import type { EditorPatchFileChange, EditorPreviewedPatch, EditorTextEdit } from "./types.js";

function replaceWholeFile(text: string): readonly EditorTextEdit[] {
  // A single edit covering a large span; positions past the end clamp to the end, so this overwrites
  // whatever the original is with `text`.
  return [
    {
      range: { start: { line: 0, column: 0 }, end: { line: 1_000_000, column: 0 } },
      newText: text,
    },
  ];
}

function change(
  overrides: Partial<EditorPatchFileChange> & { uri: string },
): EditorPatchFileChange {
  return {
    edits: [],
    isNewFile: false,
    isDeletion: false,
    ...overrides,
  };
}

function source(
  relativePath: string,
  text: string,
  extra?: Partial<PatchPreviewSource>,
): PatchPreviewSource {
  return {
    content: {
      relativePath,
      sizeBytes: new TextEncoder().encode(text).length,
      text,
      truncated: false,
    },
    ...extra,
  };
}

function patch(changes: readonly EditorPatchFileChange[]): EditorPreviewedPatch {
  return {
    patchId: "patch-1",
    changes,
    status: "previewed",
    provenance: { origin: "applied-patch" },
  };
}

describe("buildPatchPreview — file classification", () => {
  it("classifies a created file (new file, empty original, edits build the modified side)", () => {
    const model = buildPatchPreview({
      patch: patch([
        change({
          uri: "keiko://doc/new.ts",
          isNewFile: true,
          edits: replaceWholeFile("export const a = 1;\n"),
        }),
      ]),
    });
    const file = model.files[0];
    expect(file?.status).toBe("created");
    expect(file?.diffable).toBe(true);
    expect(file?.original).toBe("");
    expect(file?.modified).toBe("export const a = 1;\n");
    expect(file?.hasChanges).toBe(true);
    expect(model.createdCount).toBe(1);
  });

  it("classifies a modified file by applying edits to the provided original", () => {
    const model = buildPatchPreview({
      patch: patch([
        change({
          uri: "keiko://doc/a.ts",
          edits: [
            {
              range: { start: { line: 0, column: 10 }, end: { line: 0, column: 11 } },
              newText: "2",
            },
          ],
        }),
      ]),
      sources: { "keiko://doc/a.ts": source("src/a.ts", "const a = 1;") },
    });
    const file = model.files[0];
    expect(file?.status).toBe("modified");
    expect(file?.displayPath).toBe("src/a.ts");
    expect(file?.original).toBe("const a = 1;");
    expect(file?.modified).toBe("const a = 2;");
    expect(file?.language).toBe("typescript");
    expect(model.modifiedCount).toBe(1);
  });

  it("classifies a deleted file (original shown, modified empty)", () => {
    const model = buildPatchPreview({
      patch: patch([change({ uri: "keiko://doc/gone.ts", isDeletion: true })]),
      sources: { "keiko://doc/gone.ts": source("src/gone.ts", "old\ncontent\n") },
    });
    const file = model.files[0];
    expect(file?.status).toBe("deleted");
    expect(file?.original).toBe("old\ncontent\n");
    expect(file?.modified).toBe("");
    expect(model.deletedCount).toBe(1);
  });

  it("handles a deleted file with no original source supplied", () => {
    const model = buildPatchPreview({
      patch: patch([change({ uri: "keiko://doc/gone.ts", isDeletion: true })]),
    });
    const file = model.files[0];
    expect(file?.status).toBe("deleted");
    expect(file?.original).toBe("");
    expect(file?.modified).toBe("");
    expect(file?.hasChanges).toBe(false);
    expect(model.deletedCount).toBe(1);
  });

  it.each(["__proto__", "constructor", "toString", "hasOwnProperty"])(
    "does not crash on the prototype-chain URI key %s (treats it as no source)",
    (key) => {
      const model = buildPatchPreview({
        patch: patch([
          change({
            uri: key,
            edits: [
              {
                range: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } },
                newText: "x",
              },
            ],
          }),
        ]),
      });
      // A modified change with no own-property source resolves to "unsupported", never an inherited
      // Object.prototype member that would throw on `source.content.text`.
      expect(model.files[0]?.status).toBe("unsupported");
    },
  );

  it("classifies a host-flagged binary file as non-diffable with a content-free note", () => {
    const model = buildPatchPreview({
      patch: patch([change({ uri: "keiko://doc/logo.png" })]),
      sources: { "keiko://doc/logo.png": source("assets/logo.png", "ignored", { binary: true }) },
    });
    const file = model.files[0];
    expect(file?.status).toBe("binary");
    expect(file?.diffable).toBe(false);
    expect(file?.original).toBe("");
    expect(file?.modified).toBe("");
    expect(file?.note).toMatch(/binary/i);
    expect(model.binaryCount).toBe(1);
  });

  it("classifies content with NUL bytes as binary even without the host flag", () => {
    const model = buildPatchPreview({
      patch: patch([change({ uri: "keiko://doc/blob" })]),
      sources: { "keiko://doc/blob": source("data/blob", "a\u0000b") },
    });
    expect(model.files[0]?.status).toBe("binary");
  });

  it("marks a modified file unsupported when no original content is available", () => {
    const model = buildPatchPreview({
      patch: patch([
        change({
          uri: "keiko://doc/missing.ts",
          edits: [
            { range: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } }, newText: "x" },
          ],
        }),
      ]),
    });
    const file = model.files[0];
    expect(file?.status).toBe("unsupported");
    expect(file?.diffable).toBe(false);
    expect(file?.note).toMatch(/unavailable/i);
    expect(model.unsupportedCount).toBe(1);
  });

  it("marks a modified file unsupported when the original is truncated", () => {
    const truncatedSource: PatchPreviewSource = {
      content: { relativePath: "src/big.ts", sizeBytes: 999, text: "partial", truncated: true },
    };
    const model = buildPatchPreview({
      patch: patch([change({ uri: "keiko://doc/big.ts", edits: replaceWholeFile("x") })]),
      sources: { "keiko://doc/big.ts": truncatedSource },
    });
    expect(model.files[0]?.status).toBe("unsupported");
    expect(model.files[0]?.note).toMatch(/truncated/i);
  });

  it("marks a file unsupported when its edits overlap", () => {
    const model = buildPatchPreview({
      patch: patch([
        change({
          uri: "keiko://doc/a.ts",
          edits: [
            { range: { start: { line: 0, column: 0 }, end: { line: 0, column: 3 } }, newText: "X" },
            { range: { start: { line: 0, column: 2 }, end: { line: 0, column: 5 } }, newText: "Y" },
          ],
        }),
      ]),
      sources: { "keiko://doc/a.ts": source("src/a.ts", "abcdef") },
    });
    expect(model.files[0]?.status).toBe("unsupported");
  });

  it("concatenates multiple edits when building a created file", () => {
    const model = buildPatchPreview({
      patch: patch([
        change({
          uri: "keiko://doc/new.ts",
          isNewFile: true,
          edits: [
            {
              range: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } },
              newText: "ab",
            },
            {
              range: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } },
              newText: "cd",
            },
          ],
        }),
      ]),
    });
    expect(model.files[0]?.status).toBe("created");
    expect(model.files[0]?.modified).toBe("abcd");
  });

  it("falls back to the URI as the display path when no source is present", () => {
    const model = buildPatchPreview({
      patch: patch([
        change({ uri: "keiko://doc/new.ts", isNewFile: true, edits: replaceWholeFile("x") }),
      ]),
    });
    expect(model.files[0]?.displayPath).toBe("keiko://doc/new.ts");
  });
});

describe("buildPatchPreview — empty and aggregate state", () => {
  it("returns an empty model for a patch with no changes", () => {
    const model = buildPatchPreview({ patch: patch([]) });
    expect(model.files).toEqual([]);
    expect(model.fileCount).toBe(0);
    expect(model.totalFileCount).toBe(0);
    expect(model.truncated).toBe(false);
  });

  it("carries the patch id and status through to the model", () => {
    const model = buildPatchPreview({ patch: patch([]) });
    expect(model.patchId).toBe("patch-1");
    expect(model.status).toBe("previewed");
  });

  it("aggregates per-status counts across a mixed patch", () => {
    const model = buildPatchPreview({
      patch: patch([
        change({ uri: "keiko://doc/new.ts", isNewFile: true, edits: replaceWholeFile("a\n") }),
        change({ uri: "keiko://doc/mod.ts", edits: replaceWholeFile("b\n") }),
        change({ uri: "keiko://doc/del.ts", isDeletion: true }),
      ]),
      sources: {
        "keiko://doc/mod.ts": source("src/mod.ts", "old\n"),
        "keiko://doc/del.ts": source("src/del.ts", "gone\n"),
      },
    });
    expect(model.createdCount).toBe(1);
    expect(model.modifiedCount).toBe(1);
    expect(model.deletedCount).toBe(1);
    expect(model.fileCount).toBe(3);
  });
});

describe("buildPatchPreview — bounding and truncation (AC5)", () => {
  it("omits files beyond maxFiles and reports the omission", () => {
    const changes = Array.from({ length: 5 }, (_unused, index) =>
      change({
        uri: `keiko://doc/f${String(index)}.ts`,
        isNewFile: true,
        edits: replaceWholeFile("x\n"),
      }),
    );
    const model = buildPatchPreview({ patch: patch(changes), limits: { maxFiles: 2 } });
    expect(model.fileCount).toBe(2);
    expect(model.totalFileCount).toBe(5);
    expect(model.omittedFileCount).toBe(3);
    expect(model.truncated).toBe(true);
  });

  it("clamps a file larger than maxBytesPerFile and flags it truncated", () => {
    const big = "x".repeat(1000);
    const model = buildPatchPreview({
      patch: patch([
        change({ uri: "keiko://doc/big.ts", isNewFile: true, edits: replaceWholeFile(big) }),
      ]),
      limits: { maxBytesPerFile: 100 },
    });
    const file = model.files[0];
    expect(file?.truncated).toBe(true);
    expect(file?.modified.length).toBe(100);
    expect(file?.note).toMatch(/truncated/i);
    expect(model.truncated).toBe(true);
  });

  it("does not flag a file whose content is exactly maxBytesPerFile, but does at one byte over", () => {
    const exact = buildPatchPreview({
      patch: patch([
        change({
          uri: "keiko://doc/x.ts",
          isNewFile: true,
          edits: replaceWholeFile("x".repeat(100)),
        }),
      ]),
      limits: { maxBytesPerFile: 100 },
    });
    expect(exact.files[0]?.truncated).toBe(false);
    expect(exact.truncated).toBe(false);

    const over = buildPatchPreview({
      patch: patch([
        change({
          uri: "keiko://doc/x.ts",
          isNewFile: true,
          edits: replaceWholeFile("x".repeat(101)),
        }),
      ]),
      limits: { maxBytesPerFile: 100 },
    });
    expect(over.files[0]?.truncated).toBe(true);
  });

  it("clamps multi-byte content on the byte budget without splitting a code point", () => {
    // 20 × "中" = 60 UTF-8 bytes (3 bytes each). A code-unit slice would overrun; a byte clamp must
    // stay within the budget and cut on a code-point boundary (no replacement characters).
    const model = buildPatchPreview({
      patch: patch([
        change({
          uri: "keiko://doc/cjk.ts",
          isNewFile: true,
          edits: replaceWholeFile("中".repeat(20)),
        }),
      ]),
      limits: { maxBytesPerFile: 10 },
    });
    const file = model.files[0];
    expect(file?.truncated).toBe(true);
    expect(new TextEncoder().encode(file?.modified ?? "").length).toBeLessThanOrEqual(10);
    expect(file?.modified).toBe("中".repeat(3));
  });

  it("always renders the first file even when it alone exceeds the total byte budget", () => {
    const model = buildPatchPreview({
      patch: patch([
        change({
          uri: "keiko://doc/huge.ts",
          isNewFile: true,
          edits: replaceWholeFile("x".repeat(500)),
        }),
      ]),
      limits: { maxTotalBytes: 100, maxBytesPerFile: 1000 },
    });
    expect(model.fileCount).toBe(1);
    expect(model.files[0]?.uri).toBe("keiko://doc/huge.ts");
  });

  it("stops including files once the total byte budget is exceeded but always keeps the first", () => {
    const big = "x".repeat(400);
    const changes = Array.from({ length: 4 }, (_unused, index) =>
      change({
        uri: `keiko://doc/b${String(index)}.ts`,
        isNewFile: true,
        edits: replaceWholeFile(big),
      }),
    );
    const model = buildPatchPreview({
      patch: patch(changes),
      limits: { maxTotalBytes: 900, maxBytesPerFile: 1000 },
    });
    expect(model.fileCount).toBeGreaterThanOrEqual(1);
    expect(model.fileCount).toBeLessThan(4);
    expect(model.omittedFileCount).toBeGreaterThan(0);
    expect(model.truncated).toBe(true);
  });
});
