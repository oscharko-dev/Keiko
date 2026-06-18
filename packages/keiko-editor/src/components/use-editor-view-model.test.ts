import { describe, expect, it, vi } from "vitest";

import type { EditorBuffer } from "../host-port.js";
import { createFileModel } from "../index.js";
import type { KeikoCodeEditorProps } from "./types.js";
import { computeEditorViewModel } from "./use-editor-view-model.js";

function buildBuffer(overrides?: Partial<EditorBuffer>): EditorBuffer {
  return {
    language: "typescript",
    readOnly: false,
    content: {
      relativePath: "src/a.ts",
      sizeBytes: 12,
      text: "const a = 1;",
      truncated: false,
    },
    ...overrides,
  };
}

function buildProps(overrides?: Partial<KeikoCodeEditorProps>): KeikoCodeEditorProps {
  return {
    buffer: buildBuffer(),
    fileModel: createFileModel({ uri: "keiko://doc/a", language: "typescript", version: 1 }),
    loadState: { status: "ready" },
    saveStatus: "idle",
    onContentChange: vi.fn(),
    onSaveRequested: vi.fn(),
    ...overrides,
  };
}

describe("computeEditorViewModel", () => {
  it("treats a host read-only buffer as read-only", () => {
    const view = computeEditorViewModel(buildProps({ buffer: buildBuffer({ readOnly: true }) }));
    expect(view.readOnly).toBe(true);
    expect(view.overLimit).toBe(false);
  });

  it("forces read-only when content exceeds the configured editable-size limit", () => {
    const view = computeEditorViewModel(
      buildProps({
        buffer: buildBuffer({
          content: {
            relativePath: "src/large.ts",
            sizeBytes: 999,
            text: "const large = true;",
            truncated: false,
          },
        }),
        maxSizeBytes: 128,
      }),
    );
    expect(view.readOnly).toBe(true);
    expect(view.overLimit).toBe(true);
  });

  it("keeps ready editable buffers writable when they are under the limit", () => {
    const view = computeEditorViewModel(buildProps());
    expect(view.readOnly).toBe(false);
    expect(view.overLimit).toBe(false);
    expect(view.status.message).toBe("Ready");
  });
});
