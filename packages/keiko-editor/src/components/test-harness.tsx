import { vi } from "vitest";

import type {
  EditorBuffer,
  EditorFileModel,
  EditorPreviewedPatch,
  PatchPreviewModel,
} from "../index.js";
import { buildPatchPreview, createFileModel, editorFileModelReducer } from "../index.js";
import type { KeikoDiffEditorProps } from "./diff-types.js";
import type { KeikoCodeEditorProps } from "./types.js";

export function buildBuffer(overrides?: Partial<EditorBuffer["content"]>): EditorBuffer {
  const text = overrides?.text ?? "const a = 1;\n";
  return {
    language: "typescript",
    readOnly: false,
    content: {
      relativePath: overrides?.relativePath ?? "src/a.ts",
      sizeBytes: overrides?.sizeBytes ?? new TextEncoder().encode(text).length,
      text,
      truncated: overrides?.truncated ?? false,
    },
  };
}

export function buildFileModel(readOnly = false): EditorFileModel {
  return createFileModel(
    { uri: "keiko://doc/a", language: "typescript", version: 1 },
    { readOnly },
  );
}

export function dirtyFileModel(): EditorFileModel {
  return editorFileModelReducer(buildFileModel(), { type: "edited", origin: "human" });
}

export function baseProps(overrides?: Partial<KeikoCodeEditorProps>): KeikoCodeEditorProps {
  return {
    buffer: buildBuffer(),
    fileModel: buildFileModel(),
    loadState: { status: "ready" },
    saveStatus: "idle",
    onContentChange: vi.fn(),
    onSaveRequested: vi.fn(),
    ...overrides,
  };
}

// ─── KeikoDiffEditor fixtures (#1195) ─────────────────────────────────────────────

/** A mixed previewed patch: one created, one modified, one deleted file. */
function buildPreviewedPatch(): EditorPreviewedPatch {
  return {
    patchId: "patch-1",
    status: "previewed",
    provenance: { origin: "applied-patch" },
    changes: [
      {
        uri: "keiko://doc/new.ts",
        isNewFile: true,
        isDeletion: false,
        edits: [
          {
            range: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } },
            newText: "export const a = 1;\n",
          },
        ],
      },
      {
        uri: "keiko://doc/mod.ts",
        isNewFile: false,
        isDeletion: false,
        edits: [
          {
            range: { start: { line: 0, column: 10 }, end: { line: 0, column: 11 } },
            newText: "2",
          },
        ],
      },
      { uri: "keiko://doc/del.ts", isNewFile: false, isDeletion: true, edits: [] },
    ],
  };
}

/** The rendered preview model for {@link buildPreviewedPatch}, with original sources supplied. */
function buildDiffModel(): PatchPreviewModel {
  return buildPatchPreview({
    patch: buildPreviewedPatch(),
    sources: {
      "keiko://doc/mod.ts": {
        content: {
          relativePath: "src/mod.ts",
          sizeBytes: 12,
          text: "const a = 1;",
          truncated: false,
        },
      },
      "keiko://doc/del.ts": {
        content: { relativePath: "src/del.ts", sizeBytes: 4, text: "old\n", truncated: false },
      },
    },
  });
}

export function baseDiffProps(overrides?: Partial<KeikoDiffEditorProps>): KeikoDiffEditorProps {
  return {
    model: buildDiffModel(),
    loadState: { status: "ready" },
    ...overrides,
  };
}
