import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EditorRuntimeStatus } from "@oscharko-dev/keiko-editor";
import EditorSurface, { type EditorSurfaceProps } from "./EditorSurface";

const ensureMonacoRuntime = vi.fn<() => EditorRuntimeStatus>();
const ensureMonacoLanguage = vi.fn<(languageId: string) => Promise<void>>();
const isMonacoLanguageReady = vi.fn<(languageId: string) => boolean>();
vi.mock("./editorMonacoRuntime", () => ({
  ensureMonacoRuntime: () => ensureMonacoRuntime(),
  ensureMonacoLanguage: (languageId: string) => ensureMonacoLanguage(languageId),
  isMonacoLanguageReady: (languageId: string) => isMonacoLanguageReady(languageId),
}));

// Replace the real KeikoCodeEditor with a probe that records the load state it was driven with, so
// the surface's runtime-gating decision is observable without mounting Monaco.
const captured: {
  provideCompletions: unknown;
  completionTriggerCharacters: readonly string[] | undefined;
  provideInlineCompletions: unknown;
  onInlineCompletionTelemetry: unknown;
  provideDiagnostics: unknown;
  provideHover: unknown;
  provideSymbols: unknown;
  provideFormatting: unknown;
  formatRequestNonce: number | undefined;
  onAskKeikoAboutSelection: unknown;
} = {
  provideCompletions: undefined,
  completionTriggerCharacters: undefined,
  provideInlineCompletions: undefined,
  onInlineCompletionTelemetry: undefined,
  provideDiagnostics: undefined,
  provideHover: undefined,
  provideSymbols: undefined,
  provideFormatting: undefined,
  formatRequestNonce: undefined,
  onAskKeikoAboutSelection: undefined,
};
vi.mock("@oscharko-dev/keiko-editor", () => ({
  KeikoCodeEditor: (props: {
    ariaLabel?: string;
    loadState: { status: string; message?: string };
    provideCompletions?: unknown;
    completionTriggerCharacters?: readonly string[];
    provideInlineCompletions?: unknown;
    onInlineCompletionTelemetry?: unknown;
    provideDiagnostics?: unknown;
    provideHover?: unknown;
    provideSymbols?: unknown;
    provideFormatting?: unknown;
    formatRequestNonce?: number;
    onAskKeikoAboutSelection?: unknown;
  }) => {
    captured.provideCompletions = props.provideCompletions;
    captured.completionTriggerCharacters = props.completionTriggerCharacters;
    captured.provideInlineCompletions = props.provideInlineCompletions;
    captured.onInlineCompletionTelemetry = props.onInlineCompletionTelemetry;
    captured.provideDiagnostics = props.provideDiagnostics;
    captured.provideHover = props.provideHover;
    captured.provideSymbols = props.provideSymbols;
    captured.provideFormatting = props.provideFormatting;
    captured.formatRequestNonce = props.formatRequestNonce;
    captured.onAskKeikoAboutSelection = props.onAskKeikoAboutSelection;
    return (
      <div
        data-testid="code-editor"
        data-aria-label={props.ariaLabel ?? ""}
        data-load-status={props.loadState.status}
        data-load-message={props.loadState.message ?? ""}
      />
    );
  },
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

beforeEach(() => {
  isMonacoLanguageReady.mockReturnValue(true);
  ensureMonacoLanguage.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  captured.provideCompletions = undefined;
  captured.completionTriggerCharacters = undefined;
  captured.provideInlineCompletions = undefined;
  captured.onInlineCompletionTelemetry = undefined;
  captured.provideDiagnostics = undefined;
  captured.provideHover = undefined;
  captured.provideSymbols = undefined;
  captured.provideFormatting = undefined;
  captured.formatRequestNonce = undefined;
  captured.onAskKeikoAboutSelection = undefined;
});

describe("EditorSurface", () => {
  it("forwards the host-owned Ask Keiko selection callback", () => {
    ensureMonacoRuntime.mockReturnValue({ supported: true });
    const onAskKeikoAboutSelection = vi.fn();
    render(<EditorSurface {...buildProps({ onAskKeikoAboutSelection })} />);

    expect(captured.onAskKeikoAboutSelection).toBe(onAskKeikoAboutSelection);
  });

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

  it("holds the editor in loading state while an optional Monaco language chunk loads", async () => {
    ensureMonacoRuntime.mockReturnValue({ supported: true });
    isMonacoLanguageReady.mockReturnValue(false);
    let resolveLanguage = (): void => undefined;
    ensureMonacoLanguage.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveLanguage = resolve;
      }),
    );

    render(
      <EditorSurface
        {...buildProps({
          buffer: {
            language: "go",
            readOnly: false,
            content: {
              relativePath: "cmd/main.go",
              text: "package main",
              sizeBytes: 12,
              truncated: false,
            },
          },
          fileModel: {
            identity: { uri: "/repo/cmd/main.go", language: "go", version: 0 },
            savedVersion: 0,
            dirty: false,
            readOnly: false,
            lastChangeOrigin: null,
          },
        })}
      />,
    );

    expect(screen.getByTestId("code-editor")).toHaveAttribute("data-load-status", "loading");
    expect(ensureMonacoLanguage).toHaveBeenCalledWith("go");
    isMonacoLanguageReady.mockReturnValue(true);
    resolveLanguage();

    await waitFor(() => {
      expect(screen.getByTestId("code-editor")).toHaveAttribute("data-load-status", "ready");
    });
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

  it("forwards the completion resolver and trigger characters to the editor (Issue #1199)", () => {
    ensureMonacoRuntime.mockReturnValue({ supported: true });
    const provideCompletions = vi.fn();
    render(
      <EditorSurface {...buildProps({ provideCompletions, completionTriggerCharacters: ["."] })} />,
    );
    expect(captured.provideCompletions).toBe(provideCompletions);
    expect(captured.completionTriggerCharacters).toEqual(["."]);
  });

  it("forwards the inline-completion resolver and telemetry observer to the editor (Issue #1200)", () => {
    ensureMonacoRuntime.mockReturnValue({ supported: true });
    const provideInlineCompletions = vi.fn();
    const onInlineCompletionTelemetry = vi.fn();
    render(
      <EditorSurface {...buildProps({ provideInlineCompletions, onInlineCompletionTelemetry })} />,
    );
    expect(captured.provideInlineCompletions).toBe(provideInlineCompletions);
    expect(captured.onInlineCompletionTelemetry).toBe(onInlineCompletionTelemetry);
  });

  it("forwards the diagnostics, hover, symbols, and formatting resolvers to the editor (Issue #1201)", () => {
    ensureMonacoRuntime.mockReturnValue({ supported: true });
    const provideDiagnostics = vi.fn();
    const provideHover = vi.fn();
    const provideSymbols = vi.fn();
    const provideFormatting = vi.fn();
    render(
      <EditorSurface
        {...buildProps({ provideDiagnostics, provideHover, provideSymbols, provideFormatting })}
      />,
    );
    expect(captured.provideDiagnostics).toBe(provideDiagnostics);
    expect(captured.provideHover).toBe(provideHover);
    expect(captured.provideSymbols).toBe(provideSymbols);
    expect(captured.provideFormatting).toBe(provideFormatting);
  });

  it("forwards format request nonces to the editor", () => {
    ensureMonacoRuntime.mockReturnValue({ supported: true });
    render(<EditorSurface {...buildProps({ formatRequestNonce: 3 })} />);
    expect(captured.formatRequestNonce).toBe(3);
  });
});
