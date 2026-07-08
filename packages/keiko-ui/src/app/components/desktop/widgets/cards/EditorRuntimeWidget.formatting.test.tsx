/**
 * Registry-gated Format availability tests for EditorRuntimeWidget (Issue #1380, ADR-0068 D3/D4).
 *
 * Proves the single registry-derived `formattingAvailable` value drives, in agreement:
 *   - the Format button's `aria-disabled`, and
 *   - the status bar's `formatting` field ("Format ready" / "Format unavailable"),
 * for rich-worker languages now classified as `"none"` (json/css), a `keiko-language-service`
 * language (typescript), and other `"none"` languages (markdown/yaml) — and that large-file
 * degraded mode disables a formattable language.
 *
 * The harness mirrors EditorWidget.test.tsx: the heavy browser-only surface and the IndexedDB-backed
 * hot-exit store are mocked, and the Monaco runtime never loads in jsdom.
 */
import { render, screen } from "@testing-library/react";
import { useEffect, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilesContentResponse, LanguageServiceCapabilities } from "../../../../../lib/types";
import {
  fetchEditorLanguageCapabilities,
  fetchFilesContent,
  postEditorAgentSessionSnapshot,
} from "../../../../../lib/api";
import type { EditorSurfaceProps } from "./EditorSurface";
import type { EditorDiffSurfaceProps } from "./EditorDiffSurface";
import EditorRuntimeWidget from "./EditorRuntimeWidget";

vi.mock("../../../../../lib/api", async () => {
  const actual =
    await vi.importActual<typeof import("../../../../../lib/api")>("../../../../../lib/api");
  return {
    ...actual,
    fetchEditorLanguageCapabilities: vi.fn(),
    fetchFilesContent: vi.fn(),
    postEditorAgentActionResult: vi.fn(),
    postEditorAgentSessionSnapshot: vi.fn(),
    saveFilesContent: vi.fn(),
    requestEditorCompletion: vi.fn(),
    requestEditorInlineCompletion: vi.fn(),
    reportEditorInlineCompletionTelemetry: vi.fn(() => Promise.resolve()),
    requestEditorDiagnostics: vi.fn(),
    requestEditorHover: vi.fn(),
    requestEditorSymbols: vi.fn(),
    requestEditorFormatting: vi.fn(),
    requestEditorDefinition: vi.fn(),
    requestEditorReferences: vi.fn(),
    requestEditorRenamePrepare: vi.fn(),
    requestEditorRenameApply: vi.fn(),
    requestEditorCodeActions: vi.fn(),
    requestEditorSignatureHelp: vi.fn(),
    requestEditorTestGeneration: vi.fn(),
  };
});

vi.mock("./editorHotExitStore", () => ({
  readEditorHotExitSnapshot: vi.fn(() => Promise.resolve(null)),
  writeEditorHotExitSnapshot: vi.fn(() => Promise.resolve()),
  deleteEditorHotExitSnapshot: vi.fn(() => Promise.resolve()),
}));

const surface: { props: EditorSurfaceProps | null } = { props: null };

vi.mock("next/dynamic", () => {
  let dynamicComponentIndex = 0;
  return {
    default: () => {
      const index = dynamicComponentIndex++;
      if (index > 0) {
        function EditorDiffSurfaceProbe(props: EditorDiffSurfaceProps): ReactElement {
          void props;
          return <div data-testid="editor-diff-surface" />;
        }
        return EditorDiffSurfaceProbe;
      }
      function EditorSurfaceProbe(props: EditorSurfaceProps): ReactElement {
        useEffect(() => {}, []);
        surface.props = props;
        return <div data-testid="editor-surface" />;
      }
      return EditorSurfaceProbe;
    },
  };
});

const BASE_VERSION = { sizeBytes: 12, modifiedAt: 1, contentHash: "a".repeat(64) };

// The server advertises a TS/JS formatting provider only. JSON/CSS/HTML rich Monaco workers are not
// shipped in the release artifact, so json/css are intentionally absent from the capability set.
const LANGUAGE_CAPABILITIES: LanguageServiceCapabilities = {
  schemaVersion: "1",
  providers: [
    {
      id: "typescript",
      languages: ["typescript", "javascript"],
      operations: ["diagnostics", "completion", "hover", "symbols", "formatting"],
      availability: "available",
    },
  ],
};

function fileResponse(over?: Partial<FilesContentResponse>): FilesContentResponse {
  return {
    root: "/repo",
    path: "src/app.ts",
    name: "app.ts",
    sizeBytes: 12,
    modifiedAt: 1,
    extension: "ts",
    mime: "text/plain",
    symlink: false,
    content: "const value = 1;\n",
    maxBytes: 1_000_000,
    session: { schemaVersion: "1", version: BASE_VERSION },
    ...over,
  };
}

function formatButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Format" });
}

function statusField(id: string): Element | null {
  return screen.getByTestId("editor-status-bar").querySelector(`[data-field="${id}"]`);
}

async function renderFile(file: string, over?: Partial<FilesContentResponse>): Promise<void> {
  vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse(over));
  render(<EditorRuntimeWidget windowId="format-test" root="/repo" file={file} />);
  await screen.findByTestId("editor-surface");
}

beforeEach(() => {
  vi.mocked(fetchEditorLanguageCapabilities).mockResolvedValue(LANGUAGE_CAPABILITIES);
  vi.mocked(postEditorAgentSessionSnapshot).mockResolvedValue({ snapshot: null });
});

afterEach(() => {
  surface.props = null;
  vi.clearAllMocks();
});

describe("EditorRuntimeWidget — registry-gated Format availability (ADR-0068 D3/D4)", () => {
  it('marks Format unavailable for a "none" language (markdown)', async () => {
    await renderFile("notes.md", { path: "notes.md", name: "notes.md", extension: "md" });

    expect(formatButton()).toHaveAttribute("aria-disabled", "true");
    expect(statusField("formatting")).toHaveTextContent("Format unavailable");
  });

  it('marks Format unavailable for a "none" language (yaml)', async () => {
    await renderFile("conf.yaml", { path: "conf.yaml", name: "conf.yaml", extension: "yaml" });

    expect(formatButton()).toHaveAttribute("aria-disabled", "true");
    expect(statusField("formatting")).toHaveTextContent("Format unavailable");
  });

  it("marks Format unavailable for json without a server provider or Monaco worker", async () => {
    await renderFile("data.json", { path: "data.json", name: "data.json", extension: "json" });

    expect(formatButton()).toHaveAttribute("aria-disabled", "true");
    expect(statusField("formatting")).toHaveTextContent("Format unavailable");
  });

  it("marks Format unavailable for css without a server provider or Monaco worker", async () => {
    await renderFile("styles.css", { path: "styles.css", name: "styles.css", extension: "css" });

    expect(formatButton()).toHaveAttribute("aria-disabled", "true");
    expect(statusField("formatting")).toHaveTextContent("Format unavailable");
  });

  it("marks Format available for a keiko-language-service language (typescript) when the server is up", async () => {
    await renderFile("src/app.ts");

    expect(formatButton()).toHaveAttribute("aria-disabled", "false");
    expect(statusField("formatting")).toHaveTextContent("Format ready");
  });

  it("marks Format unavailable for a keiko-language-service language when the server provider is down", async () => {
    vi.mocked(fetchEditorLanguageCapabilities).mockResolvedValue({
      schemaVersion: "1",
      providers: [
        {
          id: "typescript",
          languages: ["typescript", "javascript"],
          operations: ["diagnostics", "completion", "hover", "symbols", "formatting"],
          availability: "unavailable",
          unavailableReason: "starting",
        },
      ],
    });
    await renderFile("src/app.ts");

    expect(formatButton()).toHaveAttribute("aria-disabled", "true");
    expect(statusField("formatting")).toHaveTextContent("Format unavailable");
  });

  it("disables the Format button in large-file degraded mode even for a formattable language (typescript)", async () => {
    const oversizedTs = `${"const value = 1;\n".repeat(10_001)}const tail = 2;\n`;
    await renderFile("src/app.ts", {
      content: oversizedTs,
      sizeBytes: oversizedTs.length,
    });

    // largeFileDegraded gates the button (canFormat) even though the language is provider-formattable;
    // the status field reads the same effective availability, so the two agree (ADR-0068 D4).
    expect(formatButton()).toHaveAttribute("aria-disabled", "true");
    expect(statusField("formatting")).toHaveTextContent("Format unavailable");
  });
});
