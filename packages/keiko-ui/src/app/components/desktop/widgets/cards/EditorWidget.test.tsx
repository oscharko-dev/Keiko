import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FilesContentResponse } from "../../../../../lib/types";
import { ApiError, fetchFilesContent, saveFilesContent } from "../../../../../lib/api";
import type { EditorSurfaceProps } from "./EditorSurface";
import { EditorWidget } from "./EditorWidget";

vi.mock("../../../../../lib/api", async () => {
  const actual =
    await vi.importActual<typeof import("../../../../../lib/api")>("../../../../../lib/api");
  return { ...actual, fetchFilesContent: vi.fn(), saveFilesContent: vi.fn() };
});

// The real surface dynamically imports `monaco-editor`, which cannot run in jsdom. Replace
// `next/dynamic` with a probe that captures the host-driven props and lets the test drive the
// editor's intent callbacks — exercising the host's load/save/conflict/dirty wiring directly.
const surface: { props: EditorSurfaceProps | null } = { props: null };
vi.mock("next/dynamic", () => ({
  default:
    () =>
    (props: EditorSurfaceProps): ReactElement => {
      surface.props = props;
      return <div data-testid="editor-surface" />;
    },
}));

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
    ...over,
  };
}

afterEach(() => {
  surface.props = null;
  delete document.documentElement.dataset.theme;
  vi.clearAllMocks();
});

async function renderLoaded(): Promise<void> {
  vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());
  render(<EditorWidget root="/repo" file="src/app.ts" />);
  await screen.findByTestId("editor-surface");
}

describe("EditorWidget — empty state", () => {
  it("renders an honest empty state and mounts no editor until a file is opened", () => {
    render(<EditorWidget />);
    expect(screen.getByRole("note")).toHaveTextContent(/choose a file from the files window/i);
    expect(screen.queryByTestId("editor-surface")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});

describe("EditorWidget — load", () => {
  it("loads the file and drives the editor surface with a ready buffer", async () => {
    await renderLoaded();
    expect(fetchFilesContent).toHaveBeenCalledWith("/repo", "src/app.ts");
    expect(surface.props?.fileLoadState.status).toBe("ready");
    expect(surface.props?.buffer.content.text).toBe("const value = 1;\n");
    expect(surface.props?.buffer.content.relativePath).toBe("src/app.ts");
    expect(surface.props?.fileModel.identity.language).toBe("typescript");
    expect(surface.props?.ariaLabel).toBe("Editor: src/app.ts in /repo");
    expect(surface.props?.modifiedAt).toBe(1);
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("aria-disabled", "true");
  });

  it("surfaces a load failure in the card", async () => {
    vi.mocked(fetchFilesContent).mockRejectedValueOnce(
      new ApiError("FILE_TOO_LARGE", "This file is too large to edit here.", 413),
    );
    render(<EditorWidget root="/repo" file="big.bin" />);
    expect(await screen.findByText(/this file is too large to edit here/i)).toBeInTheDocument();
    expect(screen.queryByTestId("editor-surface")).toBeNull();
  });
});

describe("EditorWidget — edit and save", () => {
  it("marks the buffer dirty on edit and enables Save", async () => {
    await renderLoaded();
    act(() => {
      surface.props?.onContentChange({ text: "const value = 2;\n", sizeBytes: 17 }, "human");
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    });
    expect(surface.props?.buffer.content.text).toBe("const value = 2;\n");
    expect(surface.props?.fileModel.dirty).toBe(true);
    expect(screen.getByTitle("Unsaved changes")).toBeInTheDocument();
  });

  it("saves with optimistic-concurrency token and clears dirty on success", async () => {
    await renderLoaded();
    vi.mocked(saveFilesContent).mockResolvedValueOnce(
      fileResponse({ modifiedAt: 2, content: "const value = 2;\n" }),
    );
    act(() => {
      surface.props?.onContentChange({ text: "const value = 2;\n", sizeBytes: 17 }, "human");
    });
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(saveFilesContent).toHaveBeenCalledWith({
        root: "/repo",
        path: "src/app.ts",
        content: "const value = 2;\n",
        expectedModifiedAt: 1,
      });
    });
    await waitFor(() => {
      expect(surface.props?.saveStatus).toBe("saved");
    });
    expect(surface.props?.modifiedAt).toBe(2);
    expect(surface.props?.fileModel.dirty).toBe(false);
  });

  it("ignores an editor Cmd/Ctrl+S save request when the buffer is clean", async () => {
    await renderLoaded();
    act(() => {
      surface.props?.onSaveRequested({
        identity: { uri: "/repo/src/app.ts", language: "typescript", version: 1 },
        expectedSavedVersion: 0,
        content: {
          relativePath: "src/app.ts",
          text: "const value = 1;\n",
          sizeBytes: 16,
          truncated: false,
        },
      });
    });
    expect(saveFilesContent).not.toHaveBeenCalled();
  });

  it("saves the latest text on an editor Cmd/Ctrl+S save request after an edit", async () => {
    await renderLoaded();
    vi.mocked(saveFilesContent).mockResolvedValueOnce(fileResponse({ modifiedAt: 2 }));
    act(() => {
      surface.props?.onContentChange({ text: "const value = 9;\n", sizeBytes: 17 }, "human");
    });
    act(() => {
      surface.props?.onSaveRequested({
        identity: { uri: "/repo/src/app.ts", language: "typescript", version: 1 },
        expectedSavedVersion: 0,
        content: {
          relativePath: "src/app.ts",
          text: "const value = 9;\n",
          sizeBytes: 17,
          truncated: false,
        },
      });
    });
    await waitFor(() => {
      expect(saveFilesContent).toHaveBeenCalledWith(
        expect.objectContaining({ content: "const value = 9;\n", expectedModifiedAt: 1 }),
      );
    });
  });
});

describe("EditorWidget — conflict and error", () => {
  it("surfaces a 409 as a recoverable conflict and offers Reload", async () => {
    await renderLoaded();
    vi.mocked(saveFilesContent).mockRejectedValueOnce(
      new ApiError("CONFLICT", "The file changed on disk.", 409),
    );
    act(() => {
      surface.props?.onContentChange({ text: "edited\n", sizeBytes: 7 }, "human");
    });
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(surface.props?.saveStatus).toBe("conflict");
    });
    // Conflict keeps the buffer dirty and never silently overwrites.
    expect(surface.props?.fileModel.dirty).toBe(true);
    const reload = await screen.findByRole("button", { name: "Reload" });

    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse({ modifiedAt: 5 }));
    await userEvent.click(reload);
    await waitFor(() => {
      expect(fetchFilesContent).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(surface.props?.saveStatus).toBe("idle");
    });
    // Reload must adopt the new concurrency token, or the next save would send a stale
    // expectedModifiedAt and immediately re-conflict.
    expect(surface.props?.modifiedAt).toBe(5);
  });

  it("surfaces a non-conflict save failure as an error state", async () => {
    await renderLoaded();
    vi.mocked(saveFilesContent).mockRejectedValueOnce(
      new ApiError("WRITE_FAILED", "Disk full.", 500),
    );
    act(() => {
      surface.props?.onContentChange({ text: "edited\n", sizeBytes: 7 }, "human");
    });
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(surface.props?.saveStatus).toBe("error");
    });
    expect(surface.props?.saveError).toBe("Disk full.");
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  });

  it("keeps reload failure recoverable after an editor surface has already mounted", async () => {
    await renderLoaded();
    vi.mocked(saveFilesContent).mockRejectedValueOnce(
      new ApiError("CONFLICT", "The file changed on disk.", 409),
    );
    act(() => {
      surface.props?.onContentChange({ text: "edited\n", sizeBytes: 7 }, "human");
    });
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    const reload = await screen.findByRole("button", { name: "Reload" });

    vi.mocked(fetchFilesContent).mockRejectedValueOnce(
      new ApiError("READ_FAILED", "The file could not be loaded.", 500),
    );
    await userEvent.click(reload);

    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.queryByTestId("editor-surface")).toBeNull();
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse({ modifiedAt: 5 }));
    await userEvent.click(retry);
    await screen.findByTestId("editor-surface");
    expect(surface.props?.modifiedAt).toBe(5);
  });
});

describe("EditorWidget — concurrent save safety", () => {
  const saveRequest = {
    identity: { uri: "/repo/src/app.ts", language: "typescript" as const, version: 1 },
    content: { relativePath: "src/app.ts", text: "v2\n", sizeBytes: 3, truncated: false },
  };

  it("ignores a second save request while one is already in flight", async () => {
    await renderLoaded();
    let resolveSave: (r: FilesContentResponse) => void = () => {};
    vi.mocked(saveFilesContent).mockReturnValueOnce(
      new Promise<FilesContentResponse>((resolve) => {
        resolveSave = resolve;
      }),
    );
    act(() => {
      surface.props?.onContentChange({ text: "v2\n", sizeBytes: 3 }, "human");
    });
    act(() => {
      surface.props?.onSaveRequested(saveRequest);
      surface.props?.onSaveRequested(saveRequest);
    });
    expect(saveFilesContent).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Saving…" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("button", { name: "Saving…" })).not.toBeDisabled();
    await act(async () => {
      resolveSave(fileResponse({ content: "v2\n", modifiedAt: 2 }));
    });
  });

  it("keeps mid-flight edits and stays dirty instead of clobbering them on save success", async () => {
    await renderLoaded();
    let resolveSave: (r: FilesContentResponse) => void = () => {};
    vi.mocked(saveFilesContent).mockReturnValueOnce(
      new Promise<FilesContentResponse>((resolve) => {
        resolveSave = resolve;
      }),
    );
    act(() => {
      surface.props?.onContentChange({ text: "saved-text\n", sizeBytes: 11 }, "human");
    });
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    // The editor stays editable during a save; the user keeps typing while it is in flight.
    act(() => {
      surface.props?.onContentChange({ text: "newer-text\n", sizeBytes: 11 }, "human");
    });
    await act(async () => {
      resolveSave(fileResponse({ content: "saved-text\n", modifiedAt: 2 }));
    });
    // The server echo must NOT clobber the newer buffer, which stays dirty against the new version.
    expect(surface.props?.buffer.content.text).toBe("newer-text\n");
    expect(surface.props?.fileModel.dirty).toBe(true);
    expect(surface.props?.modifiedAt).toBe(2);
  });
});

describe("EditorWidget — load-error recovery", () => {
  it("offers Retry on a load error and recovers when the file becomes readable", async () => {
    vi.mocked(fetchFilesContent).mockRejectedValueOnce(
      new ApiError("UNSUPPORTED_FILE", "This file cannot be edited.", 400),
    );
    render(<EditorWidget root="/repo" file="src/app.ts" />);
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.queryByTestId("editor-surface")).toBeNull();

    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse());
    await userEvent.click(retry);
    await screen.findByTestId("editor-surface");
    expect(surface.props?.fileLoadState.status).toBe("ready");
  });
});

describe("EditorWidget — theme coupling", () => {
  it("drives the editor surface with the live app theme variant", async () => {
    document.documentElement.dataset.theme = "light";
    await renderLoaded();
    await waitFor(() => {
      expect(surface.props?.themeVariant).toBe("light");
    });
  });
});

describe("EditorWidget — language inference", () => {
  it.each([
    ["src/app.js", "javascript"],
    ["notes/readme.md", "plaintext"],
  ])("maps %s to editor language %s", async (file, language) => {
    vi.mocked(fetchFilesContent).mockResolvedValueOnce(fileResponse({ path: file }));
    render(<EditorWidget root="/repo" file={file} />);
    await screen.findByTestId("editor-surface");
    expect(surface.props?.fileModel.identity.language).toBe(language);
    expect(surface.props?.buffer.language).toBe(language);
  });
});
