import { describe, expect, it } from "vitest";
import {
  LANGUAGE_RENAME_CHANGESET_SCHEMA_VERSION,
  type LanguageRenameChangeset,
} from "@oscharko-dev/keiko-contracts";

import { buildRenamePreview } from "./rename-preview.js";

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
  };
}

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
});
