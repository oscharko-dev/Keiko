import { describe, expect, it } from "vitest";
import { buildPatchPreview, type PatchPreviewSource } from "@oscharko-dev/keiko-editor";

import type { EditorAgentAction } from "../../../../../lib/types";
import { buildEditorAgentChangesetPatch } from "./editorAgentChangeset";

type PreparedChangeset = NonNullable<NonNullable<EditorAgentAction["changeset"]>["prepared"]>;

function source(path: string, text: string): PatchPreviewSource {
  return {
    content: {
      relativePath: path,
      text,
      sizeBytes: new TextEncoder().encode(text).length,
      truncated: false,
    },
  };
}

describe("buildEditorAgentChangesetPatch", () => {
  it("projects a prepared create, modify, and delete changeset into the existing diff model", () => {
    const prepared: PreparedChangeset = {
      files: [
        {
          file: "src/created.ts",
          kind: "create",
          textEdits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: "export const created = true;\n",
            },
          ],
        },
        {
          file: "src/modified.ts",
          kind: "modify",
          textEdits: [
            {
              range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } },
              newText: "after",
            },
          ],
        },
        {
          file: "src/deleted.ts",
          kind: "delete",
          textEdits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
              newText: "",
            },
          ],
        },
      ],
    };
    const patch = buildEditorAgentChangesetPatch({
      actionId: "action-2117",
      prepared,
    });
    const model = buildPatchPreview({
      patch,
      sources: {
        "src/created.ts": source("src/created.ts", ""),
        "src/modified.ts": source("src/modified.ts", "const before = 1;\n"),
        "src/deleted.ts": source("src/deleted.ts", "export const removed = true;\n"),
      },
    });

    expect(model).toMatchObject({
      patchId: "agent-changeset:action-2117",
      status: "previewed",
      fileCount: 3,
      totalFileCount: 3,
      createdCount: 1,
      modifiedCount: 1,
      deletedCount: 1,
      omittedFileCount: 0,
      truncated: false,
    });
    expect(model.files).toEqual([
      expect.objectContaining({
        uri: "src/created.ts",
        status: "created",
        original: "",
        modified: "export const created = true;\n",
      }),
      expect.objectContaining({
        uri: "src/modified.ts",
        status: "modified",
        original: "const before = 1;\n",
        modified: "const after = 1;\n",
      }),
      expect.objectContaining({
        uri: "src/deleted.ts",
        status: "deleted",
        original: "export const removed = true;\n",
        modified: "",
      }),
    ]);
  });
});
