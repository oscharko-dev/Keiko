import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useRef, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildPatchPreview } from "../index.js";
import { KeikoDiffEditor } from "./KeikoDiffEditor.js";
import { baseDiffProps } from "./test-harness.js";

// ─── Monaco DiffEditor mock: renders both sides and drives onMount with a fake diff editor. ───────

interface CapturedDiff {
  goToDiff: ReturnType<typeof vi.fn>;
}
const captured: { diff: CapturedDiff | null } = { diff: null };

vi.mock("@monaco-editor/react", () => {
  interface MockProps {
    original?: string;
    modified?: string;
    options?: { ariaLabel?: string; readOnly?: boolean };
    onMount?: (editor: unknown, monaco: unknown) => void;
  }
  const fakeMonaco = { editor: { defineTheme: vi.fn() } };
  const DiffEditorMock = (props: MockProps): ReactElement => {
    const mounted = useRef(false);
    const container = useRef<HTMLDivElement | null>(null);
    if (!mounted.current) {
      mounted.current = true;
      const goToDiff = vi.fn();
      captured.diff = { goToDiff };
      queueMicrotask(() => {
        props.onMount?.(
          {
            getContainerDomNode: (): HTMLElement =>
              container.current ?? document.createElement("div"),
            goToDiff,
          },
          fakeMonaco,
        );
      });
    }
    return (
      <div
        ref={(node): void => {
          container.current = node;
        }}
        aria-label={props.options?.ariaLabel ?? "Diff"}
        data-testid="mock-diff"
      >
        <pre data-testid="mock-diff-original">{props.original ?? ""}</pre>
        <pre data-testid="mock-diff-modified">{props.modified ?? ""}</pre>
      </div>
    );
  };
  const EditorMock = (): ReactElement => <textarea />;
  return { DiffEditor: DiffEditorMock, Editor: EditorMock, default: EditorMock };
});

async function flushMount(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  captured.diff = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("KeikoDiffEditor — file list and selection", () => {
  it("lists one entry per changed file with its status label", () => {
    render(<KeikoDiffEditor {...baseDiffProps()} />);
    const list = screen.getByTestId("keiko-diff-file-list");
    expect(list).toHaveTextContent("keiko://doc/new.ts");
    expect(list).toHaveTextContent("src/mod.ts");
    expect(list).toHaveTextContent("src/del.ts");
    expect(list).toHaveTextContent("created");
    expect(list).toHaveTextContent("modified");
    expect(list).toHaveTextContent("deleted");
  });

  it("shows the first file's diff by default (AC1 — review without mutating files)", () => {
    render(<KeikoDiffEditor {...baseDiffProps()} />);
    expect(screen.getByTestId("mock-diff-original")).toHaveTextContent("");
    expect(screen.getByTestId("mock-diff-modified")).toHaveTextContent("export const a = 1;");
  });

  it("switches the diff and notifies the host when another file is selected (AC2)", async () => {
    const onSelectFile = vi.fn();
    render(<KeikoDiffEditor {...baseDiffProps({ onSelectFile })} />);
    await userEvent.click(screen.getByRole("button", { name: /src\/mod\.ts/ }));
    expect(onSelectFile).toHaveBeenCalledWith("keiko://doc/mod.ts");
    expect(screen.getByTestId("mock-diff-original")).toHaveTextContent("const a = 1;");
    expect(screen.getByTestId("mock-diff-modified")).toHaveTextContent("const a = 2;");
  });
});

describe("KeikoDiffEditor — hunk navigation (AC2)", () => {
  it("jumps to the next and previous hunk via Monaco goToDiff", async () => {
    render(<KeikoDiffEditor {...baseDiffProps()} />);
    await flushMount();
    await userEvent.click(screen.getByTestId("keiko-diff-next"));
    await userEvent.click(screen.getByTestId("keiko-diff-prev"));
    expect(captured.diff?.goToDiff).toHaveBeenCalledWith("next");
    expect(captured.diff?.goToDiff).toHaveBeenCalledWith("previous");
  });

  it("disables navigation for a file with no rendered changes", () => {
    // A modified file whose edits reproduce the original has no diff to navigate.
    const model = buildPatchPreview({
      patch: {
        patchId: "p",
        status: "previewed",
        provenance: { origin: "applied-patch" },
        changes: [
          {
            uri: "keiko://doc/same.ts",
            isNewFile: false,
            isDeletion: false,
            edits: [
              {
                range: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } },
                newText: "",
              },
            ],
          },
        ],
      },
      sources: {
        "keiko://doc/same.ts": {
          content: { relativePath: "src/same.ts", sizeBytes: 1, text: "x", truncated: false },
        },
      },
    });
    render(<KeikoDiffEditor {...baseDiffProps({ model })} />);
    expect(screen.getByTestId("keiko-diff-next")).toBeDisabled();
    expect(screen.getByTestId("keiko-diff-prev")).toBeDisabled();
  });
});

describe("KeikoDiffEditor — host-owned actions (AC3)", () => {
  it("invokes apply/reject/verify callbacks when the host permits them", async () => {
    const onApply = vi.fn();
    const onReject = vi.fn();
    const onRunVerification = vi.fn();
    render(
      <KeikoDiffEditor
        {...baseDiffProps({
          actions: { canApply: true, canReject: true, canRunVerification: true },
          onApply,
          onReject,
          onRunVerification,
        })}
      />,
    );
    await userEvent.click(screen.getByTestId("keiko-diff-apply"));
    await userEvent.click(screen.getByTestId("keiko-diff-reject"));
    await userEvent.click(screen.getByTestId("keiko-diff-verify"));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onRunVerification).toHaveBeenCalledTimes(1);
  });

  it("disables apply/reject when the host does not permit them", () => {
    render(
      <KeikoDiffEditor
        {...baseDiffProps({
          actions: { canApply: false, canReject: false, canRunVerification: false },
          onApply: vi.fn(),
          onReject: vi.fn(),
        })}
      />,
    );
    expect(screen.getByTestId("keiko-diff-apply")).toBeDisabled();
    expect(screen.getByTestId("keiko-diff-reject")).toBeDisabled();
  });

  it("disables actions when no callback is supplied even if the host permits them", () => {
    render(
      <KeikoDiffEditor
        {...baseDiffProps({
          actions: { canApply: true, canReject: true, canRunVerification: true },
        })}
      />,
    );
    expect(screen.getByTestId("keiko-diff-apply")).toBeDisabled();
    expect(screen.getByTestId("keiko-diff-verify")).toBeDisabled();
  });

  it("opens a file through the host callback", async () => {
    const onOpenFile = vi.fn();
    render(<KeikoDiffEditor {...baseDiffProps({ onOpenFile })} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Open keiko://doc/new.ts in the workspace" }),
    );
    expect(onOpenFile).toHaveBeenCalledWith("keiko://doc/new.ts");
  });
});

describe("KeikoDiffEditor — non-diffable, empty, and truncated states", () => {
  it("shows a content-free note instead of a diff for a binary file (AC4)", () => {
    const model = buildPatchPreview({
      patch: {
        patchId: "p",
        status: "previewed",
        provenance: { origin: "applied-patch" },
        changes: [{ uri: "keiko://doc/logo.png", isNewFile: false, isDeletion: false, edits: [] }],
      },
      sources: {
        "keiko://doc/logo.png": {
          content: { relativePath: "assets/logo.png", sizeBytes: 3, text: "x", truncated: false },
          binary: true,
        },
      },
    });
    render(<KeikoDiffEditor {...baseDiffProps({ model })} />);
    expect(screen.getByTestId("keiko-diff-unavailable")).toHaveTextContent(/binary/i);
    expect(screen.queryByTestId("mock-diff")).not.toBeInTheDocument();
  });

  it("reports an empty patch as no changes", () => {
    const model = buildPatchPreview({
      patch: {
        patchId: "p",
        status: "previewed",
        provenance: { origin: "applied-patch" },
        changes: [],
      },
    });
    render(<KeikoDiffEditor {...baseDiffProps({ model })} />);
    expect(screen.getByTestId("keiko-diff-summary")).toHaveTextContent("No changes to review.");
    expect(screen.getByTestId("keiko-diff-empty")).toBeInTheDocument();
  });

  it("renders a truncation notice when the patch is bounded (AC5)", () => {
    const changes = Array.from({ length: 4 }, (_unused, index) => ({
      uri: `keiko://doc/f${String(index)}.ts`,
      isNewFile: true,
      isDeletion: false,
      edits: [
        { range: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } }, newText: "x\n" },
      ],
    }));
    const model = buildPatchPreview({
      patch: {
        patchId: "p",
        status: "previewed",
        provenance: { origin: "applied-patch" },
        changes,
      },
      limits: { maxFiles: 2 },
    });
    render(<KeikoDiffEditor {...baseDiffProps({ model })} />);
    expect(screen.getByTestId("keiko-diff-truncation")).toHaveTextContent(/not shown/i);
  });

  it("exposes per-file truncation in the file row for assistive tech (AC5)", () => {
    const model = buildPatchPreview({
      patch: {
        patchId: "p",
        status: "previewed",
        provenance: { origin: "applied-patch" },
        changes: [
          {
            uri: "keiko://doc/big.ts",
            isNewFile: true,
            isDeletion: false,
            edits: [
              {
                range: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } },
                newText: "x".repeat(500),
              },
            ],
          },
        ],
      },
      limits: { maxBytesPerFile: 100 },
    });
    render(<KeikoDiffEditor {...baseDiffProps({ model })} />);
    expect(screen.getByRole("button", { name: /keiko:\/\/doc\/big\.ts/ })).toHaveTextContent(
      /truncated/i,
    );
  });

  it("remounts the diff editor when switching diffable -> binary -> diffable (AC2)", async () => {
    const model = buildPatchPreview({
      patch: {
        patchId: "p",
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
                newText: "a\n",
              },
            ],
          },
          { uri: "keiko://doc/logo.png", isNewFile: false, isDeletion: false, edits: [] },
        ],
      },
      sources: {
        "keiko://doc/logo.png": {
          content: { relativePath: "assets/logo.png", sizeBytes: 3, text: "bin", truncated: false },
          binary: true,
        },
      },
    });
    render(<KeikoDiffEditor {...baseDiffProps({ model })} />);
    expect(screen.getByTestId("mock-diff")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /assets\/logo\.png/ }));
    expect(screen.queryByTestId("mock-diff")).not.toBeInTheDocument();
    expect(screen.getByTestId("keiko-diff-unavailable")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /keiko:\/\/doc\/new\.ts/ }));
    expect(screen.getByTestId("mock-diff")).toBeInTheDocument();
  });
});

describe("KeikoDiffEditor — runtime and load state", () => {
  it("reports a non-fatal theme failure through onRuntimeError but stays mounted", async () => {
    const onRuntimeError = vi.fn();
    render(<KeikoDiffEditor {...baseDiffProps({ onRuntimeError })} />);
    await flushMount();
    expect(onRuntimeError).toHaveBeenCalled();
    expect(screen.getByTestId("mock-diff")).toBeInTheDocument();
  });

  it("shows a loading placeholder while the runtime loads", () => {
    render(<KeikoDiffEditor {...baseDiffProps({ loadState: { status: "loading" } })} />);
    expect(screen.getByTestId("keiko-diff-pane-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("mock-diff")).not.toBeInTheDocument();
  });

  it("surfaces a load failure as an assertive alert and renders no diff", () => {
    render(
      <KeikoDiffEditor
        {...baseDiffProps({ loadState: { status: "error", message: "worker boot failed" } })}
      />,
    );
    const summary = screen.getByTestId("keiko-diff-summary");
    expect(summary).toHaveAttribute("role", "alert");
    expect(summary).toHaveTextContent("worker boot failed");
    expect(screen.getByTestId("keiko-diff-load-error")).toBeInTheDocument();
  });
});
