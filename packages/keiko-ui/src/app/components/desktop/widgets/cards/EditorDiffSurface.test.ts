import { describe, expect, it, vi } from "vitest";
import type { PatchPreviewSource } from "@oscharko-dev/keiko-editor";
import type {
  WorkspaceReplacePreviewFileEdit,
  WorkspaceReplacePreviewResponse,
} from "@oscharko-dev/keiko-contracts";

import { buildWorkspaceReplacePatchModel } from "./EditorDiffSurface";

// `EditorDiffSurface.tsx` imports `./editorMonacoRuntime` for its side-effecting, browser-only Monaco
// bootstrap (real `monaco-editor` value imports, documented as reachable only via a client-only
// dynamic import — never usable under jsdom). Only the default-exported component uses it; the pure
// `buildWorkspaceReplacePatchModel` under test does not. Mock it out so the module loads without it.
vi.mock("./editorMonacoRuntime", () => ({
  areMonacoLanguagesReady: () => true,
  ensureMonacoLanguages: () => Promise.resolve(),
  ensureMonacoRuntime: () => ({ supported: false, message: "unsupported in tests" }),
}));

function source(relativePath: string, text: string): PatchPreviewSource {
  return {
    content: {
      relativePath,
      sizeBytes: new TextEncoder().encode(text).length,
      text,
      truncated: false,
    },
  };
}

function fileEdit(
  overrides: Partial<WorkspaceReplacePreviewFileEdit> & { readonly path: string },
): WorkspaceReplacePreviewFileEdit {
  return {
    baseContentHash: "a".repeat(64),
    edits: [],
    ...overrides,
  };
}

function response(
  overrides: Partial<WorkspaceReplacePreviewResponse> & {
    readonly files: readonly WorkspaceReplacePreviewFileEdit[];
  },
): WorkspaceReplacePreviewResponse {
  return {
    fileCount: overrides.files.length,
    editCount: overrides.files.reduce((count, file) => count + file.edits.length, 0),
    truncated: false,
    omittedFileCount: 0,
    ...overrides,
  };
}

describe("buildWorkspaceReplacePatchModel — range conversion", () => {
  it("converts a mid-file, multi-line/column 1-indexed edit range to the correct 0-indexed edit", () => {
    const original = "const x = 1;\n    parseConfig(cfg);\nconst y = 2;";
    const model = buildWorkspaceReplacePatchModel(
      response({
        files: [
          fileEdit({
            path: "src/app.ts",
            edits: [
              {
                range: { startLine: 2, startColumn: 5, endLine: 2, endColumn: 16 },
                originalText: "parseConfig",
                newText: "readConfig",
              },
            ],
          }),
        ],
      }),
      { "src/app.ts": source("src/app.ts", original) },
    );

    expect(model.files[0]?.original).toBe(original);
    expect(model.files[0]?.modified).toBe("const x = 1;\n    readConfig(cfg);\nconst y = 2;");
  });

  it("converts a match at the very start of a file's content (line 1, column 1)", () => {
    const original = "foo(bar);\nbaz();";
    const model = buildWorkspaceReplacePatchModel(
      response({
        files: [
          fileEdit({
            path: "src/start.ts",
            edits: [
              {
                range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 },
                originalText: "foo",
                newText: "qux",
              },
            ],
          }),
        ],
      }),
      { "src/start.ts": source("src/start.ts", original) },
    );

    expect(model.files[0]?.original).toBe(original);
    expect(model.files[0]?.modified).toBe("qux(bar);\nbaz();");
  });

  it("converts a match at the very end of a file's last line", () => {
    const original = "alpha\nbeta";
    const model = buildWorkspaceReplacePatchModel(
      response({
        files: [
          fileEdit({
            path: "src/end.ts",
            edits: [
              {
                range: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 5 },
                originalText: "beta",
                newText: "gamma",
              },
            ],
          }),
        ],
      }),
      { "src/end.ts": source("src/end.ts", original) },
    );

    expect(model.files[0]?.original).toBe(original);
    expect(model.files[0]?.modified).toBe("alpha\ngamma");
  });
});

describe("buildWorkspaceReplacePatchModel — omitted file count merge", () => {
  it("folds the response's omittedFileCount into the model's omittedFileCount/totalFileCount/truncated", () => {
    const original = "const a = 1;";
    const model = buildWorkspaceReplacePatchModel(
      response({
        files: [
          fileEdit({
            path: "src/only.ts",
            edits: [
              {
                range: { startLine: 1, startColumn: 11, endLine: 1, endColumn: 12 },
                originalText: "1",
                newText: "2",
              },
            ],
          }),
        ],
        omittedFileCount: 2,
      }),
      { "src/only.ts": source("src/only.ts", original) },
    );

    expect(model.omittedFileCount).toBe(2);
    expect(model.totalFileCount).toBe(3);
    expect(model.truncated).toBe(true);
  });

  it("leaves omittedFileCount/truncated unaffected when the response omits no files", () => {
    const original = "const a = 1;";
    const model = buildWorkspaceReplacePatchModel(
      response({
        files: [fileEdit({ path: "src/only.ts", edits: [] })],
      }),
      { "src/only.ts": source("src/only.ts", original) },
    );

    expect(model.omittedFileCount).toBe(0);
    expect(model.totalFileCount).toBe(1);
    expect(model.truncated).toBe(false);
  });
});
