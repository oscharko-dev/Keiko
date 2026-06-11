import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { fetchFilesContent, saveFilesContent } from "../../../../../lib/api";
import { EditorWidget } from "./EditorWidget";

vi.mock("../../../../../lib/api", async () => {
  const actual =
    await vi.importActual<typeof import("../../../../../lib/api")>("../../../../../lib/api");
  return {
    ...actual,
    fetchFilesContent: vi.fn(),
    saveFilesContent: vi.fn(),
  };
});

describe("EditorWidget", () => {
  it("renders an honest empty state until a file is opened", () => {
    render(<EditorWidget />);
    expect(screen.getByRole("note")).toHaveTextContent(/choose a file from the files window/i);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("loads an editable text file and saves changes", async () => {
    vi.mocked(fetchFilesContent).mockResolvedValueOnce({
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
    });
    vi.mocked(saveFilesContent).mockResolvedValueOnce({
      root: "/repo",
      path: "src/app.ts",
      name: "app.ts",
      sizeBytes: 12,
      modifiedAt: 2,
      extension: "ts",
      mime: "text/plain",
      symlink: false,
      content: "const value = 2;\n",
      maxBytes: 1_000_000,
    });

    render(<EditorWidget root="/repo" file="src/app.ts" />);

    const textbox = await screen.findByRole("textbox", { name: "Editor: src/app.ts" });
    expect(fetchFilesContent).toHaveBeenCalledWith("/repo", "src/app.ts");
    await userEvent.clear(textbox);
    await userEvent.type(textbox, "const value = 2;{enter}");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(saveFilesContent).toHaveBeenCalledWith({
        root: "/repo",
        path: "src/app.ts",
        content: "const value = 2;\n",
        expectedModifiedAt: 1,
      });
    });
    expect(await screen.findByText(/saved/i)).toBeInTheDocument();
  });
});
