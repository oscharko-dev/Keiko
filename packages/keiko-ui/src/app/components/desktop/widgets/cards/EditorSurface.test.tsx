import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EditorRuntimeStatus } from "@oscharko-dev/keiko-editor";
import EditorSurface, { type EditorSurfaceProps } from "./EditorSurface";

const ensureMonacoRuntime = vi.fn<() => EditorRuntimeStatus>();
vi.mock("./editorMonacoRuntime", () => ({
  ensureMonacoRuntime: () => ensureMonacoRuntime(),
}));

// Replace the real KeikoCodeEditor with a probe that records the load state it was driven with, so
// the surface's runtime-gating decision is observable without mounting Monaco.
vi.mock("@oscharko-dev/keiko-editor", () => ({
  KeikoCodeEditor: (props: {
    ariaLabel?: string;
    loadState: { status: string; message?: string };
  }) => (
    <div
      data-testid="code-editor"
      data-aria-label={props.ariaLabel ?? ""}
      data-load-status={props.loadState.status}
      data-load-message={props.loadState.message ?? ""}
    />
  ),
}));

function buildProps(overrides?: Partial<EditorSurfaceProps>): EditorSurfaceProps {
  return {
    buffer: {
      language: "typescript",
      readOnly: false,
      content: { relativePath: "src/a.ts", text: "x", sizeBytes: 1, truncated: false },
    },
    fileModel: {
      identity: { uri: "/repo/src/a.ts", language: "typescript", version: 0 },
      savedVersion: 0,
      dirty: false,
      readOnly: false,
      lastChangeOrigin: null,
    },
    fileLoadState: { status: "ready" },
    saveStatus: "idle",
    onContentChange: vi.fn(),
    onSaveRequested: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("EditorSurface", () => {
  it("passes the host file-load state through when the Monaco runtime is supported", () => {
    ensureMonacoRuntime.mockReturnValue({ supported: true });
    render(
      <EditorSurface
        {...buildProps({
          ariaLabel: "Editor: src/a.ts in /repo",
          fileLoadState: { status: "ready" },
        })}
      />,
    );
    const editor = screen.getByTestId("code-editor");
    expect(editor).toHaveAttribute("data-load-status", "ready");
    expect(editor).toHaveAttribute("data-aria-label", "Editor: src/a.ts in /repo");
  });

  it("forces a controlled load-error state when the Monaco runtime is unsupported", () => {
    ensureMonacoRuntime.mockReturnValue({
      supported: false,
      reason: "web-workers-unavailable",
      message: "Web Workers are unavailable.",
    });
    render(<EditorSurface {...buildProps()} />);
    const editor = screen.getByTestId("code-editor");
    expect(editor).toHaveAttribute("data-load-status", "error");
    expect(editor).toHaveAttribute("data-load-message", "Web Workers are unavailable.");
  });
});
