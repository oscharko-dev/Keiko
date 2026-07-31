import { describe, expect, it } from "vitest";
import {
  LANGUAGE_RENAME_CHANGESET_SCHEMA_VERSION,
  type LanguageRenameChangeset,
} from "@oscharko-dev/keiko-contracts";

import { buildRenamePreview, renameChangesetTruncation } from "./rename-preview.js";

function changeset(): LanguageRenameChangeset {
  return {
    schemaVersion: LANGUAGE_RENAME_CHANGESET_SCHEMA_VERSION,
    files: [
      {
        path: "src/a.ts",
        expectedContentHash: "a".repeat(64),
        edits: [
          {
            range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
            newText: "renamed",
          },
        ],
      },
      {
        path: "src/b.ts",
        expectedContentHash: "b".repeat(64),
        edits: [
          {
            range: { start: { line: 0, character: 7 }, end: { line: 0, character: 12 } },
            newText: "renamed",
          },
        ],
      },
    ],
    truncated: false,
    filesTruncated: false,
    returnedFileCount: 2,
    totalFileCount: 2,
    returnedEditCount: 2,
    totalEditCount: 2,
    unreadableFileCount: 0,
  };
}

/**
 * A changeset the language service capped: it found 400 files / 1_200 references and returned the
 * two it had room for. The preview must carry that, because a preview derived only from the RETURNED
 * changes is internally consistent and therefore indistinguishable from a complete rename.
 */
function cappedChangeset(): LanguageRenameChangeset {
  return {
    ...changeset(),
    truncated: true,
    filesTruncated: true,
    returnedFileCount: 2,
    totalFileCount: 400,
    returnedEditCount: 2,
    totalEditCount: 1_200,
  };
}

const twoFileSources = {
  "src/a.ts": {
    content: {
      relativePath: "src/a.ts",
      text: "const value = 1;\n",
      sizeBytes: 17,
      truncated: false,
    },
  },
  "src/b.ts": {
    content: {
      relativePath: "src/b.ts",
      text: "export { value };\n",
      sizeBytes: 17,
      truncated: false,
    },
  },
} as const;

describe("buildRenamePreview", () => {
  it("builds a multi-file PatchPreviewModel from a rename changeset", () => {
    const preview = buildRenamePreview({
      changeset: changeset(),
      sources: {
        "src/a.ts": {
          content: {
            relativePath: "src/a.ts",
            text: "const value = 1;\n",
            sizeBytes: 17,
            truncated: false,
          },
        },
        "src/b.ts": {
          content: {
            relativePath: "src/b.ts",
            text: "export { value };\n",
            sizeBytes: 17,
            truncated: false,
          },
        },
      },
    });
    expect(preview.files).toHaveLength(2);
    expect(preview.files.map((file) => file.displayPath)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(preview.files[0]?.modified).toBe("const renamed = 1;\n");
    expect(preview.modifiedCount).toBe(2);
  });

  it("reuses patch-preview file-count bounds", () => {
    const preview = buildRenamePreview({
      changeset: changeset(),
      sources: {
        "src/a.ts": {
          content: {
            relativePath: "src/a.ts",
            text: "const value = 1;\n",
            sizeBytes: 17,
            truncated: false,
          },
        },
        "src/b.ts": {
          content: {
            relativePath: "src/b.ts",
            text: "export { value };\n",
            sizeBytes: 17,
            truncated: false,
          },
        },
      },
      limits: { maxFiles: 1 },
    });
    expect(preview.fileCount).toBe(1);
    expect(preview.totalFileCount).toBe(2);
    expect(preview.omittedFileCount).toBe(1);
    expect(preview.truncated).toBe(true);
  });

  // A capped rename that renames 2 of 400 files leaves the workspace broken, so the preview may not
  // present it as the whole rename: it must carry every count the language service reported.
  it("carries a capped changeset's truncation facts instead of discarding them", () => {
    const preview = buildRenamePreview({ changeset: cappedChangeset(), sources: twoFileSources });
    expect(preview.sourceTruncation).toEqual({
      truncated: true,
      returnedFileCount: 2,
      totalFileCount: 400,
      returnedEditCount: 2,
      totalEditCount: 1_200,
      unreadableFileCount: 0,
    });
    expect(preview.truncated).toBe(true);
  });

  it("carries the dropped-unreadable-file count of an otherwise consistent changeset", () => {
    const preview = buildRenamePreview({
      changeset: { ...changeset(), totalFileCount: 3, unreadableFileCount: 1 },
      sources: twoFileSources,
    });
    expect(preview.sourceTruncation?.unreadableFileCount).toBe(1);
    expect(preview.truncated).toBe(true);
  });

  it("reports an untruncated changeset as complete, exactly as before", () => {
    const preview = buildRenamePreview({ changeset: changeset(), sources: twoFileSources });
    expect(preview.sourceTruncation).toEqual({
      truncated: false,
      returnedFileCount: 2,
      totalFileCount: 2,
      returnedEditCount: 2,
      totalEditCount: 2,
      unreadableFileCount: 0,
    });
    expect(preview.truncated).toBe(false);
    expect(preview.files).toHaveLength(2);
  });
});

describe("renameChangesetTruncation", () => {
  it("returns null for a changeset whose payload matches its own report", () => {
    expect(renameChangesetTruncation(changeset())).toBeNull();
  });

  it.each([
    ["the provider's own truncated flag", { truncated: true }],
    ["the provider's filesTruncated flag", { filesTruncated: true }],
    ["fewer files than the provider found", { totalFileCount: 400 }],
    ["fewer edits than the provider found", { totalEditCount: 1_200 }],
    ["a reference file whose content could not be read", { unreadableFileCount: 1 }],
  ])("reports a changeset incomplete by %s", (_name, overrides) => {
    expect(renameChangesetTruncation({ ...changeset(), ...overrides })).not.toBeNull();
  });

  // Fail closed on a report that disagrees with its payload: the counts a caller would show come
  // from the report, but only the payload is ever applied.
  it("reports a changeset whose reported counts disagree with its payload", () => {
    expect(renameChangesetTruncation({ ...changeset(), returnedFileCount: 9 })).not.toBeNull();
    expect(renameChangesetTruncation({ ...changeset(), returnedEditCount: 9 })).not.toBeNull();
  });

  it("names the counts a host must show before applying", () => {
    expect(renameChangesetTruncation(cappedChangeset())).toEqual({
      truncated: true,
      returnedFileCount: 2,
      totalFileCount: 400,
      returnedEditCount: 2,
      totalEditCount: 1_200,
      unreadableFileCount: 0,
    });
  });
});
