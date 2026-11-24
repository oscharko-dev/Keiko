// #4437: opening a folder that holds AppData shows the plain-language sensitive-data notice above
// the tree. The folder stays browsable; the notice neither blocks nor asks for approval.
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18N_STORAGE_KEY, I18nProvider } from "@/lib/i18n";
import { fetchFilesTree, fetchGitStatus } from "../../../../../lib/api";
import type { FilesTreeEntry } from "../../../../../lib/types";
import { FilesWidget } from "./FilesWidget";

vi.mock("../../../../../lib/api", async () => {
  const actual =
    await vi.importActual<typeof import("../../../../../lib/api")>("../../../../../lib/api");
  return { ...actual, fetchFilesTree: vi.fn(), fetchGitStatus: vi.fn() };
});

const ROOT = "C:\\Users\\person";

function listing(names: readonly string[]): void {
  vi.mocked(fetchFilesTree).mockResolvedValue({
    root: ROOT,
    path: "",
    truncated: false,
    entries: names.map((name): FilesTreeEntry => ({
      name,
      path: name,
      kind: "directory",
      extension: null,
      readable: true,
    })),
  });
  vi.mocked(fetchGitStatus).mockRejectedValue(new Error("not a repository"));
}

afterEach(() => {
  vi.clearAllMocks();
  window.localStorage.removeItem(I18N_STORAGE_KEY);
});

describe("FilesWidget AppData notice", () => {
  it("shows the notice in English and keeps AppData in the tree", async () => {
    listing(["AppData", "Documents"]);
    render(<FilesWidget root={ROOT} />);
    expect(await screen.findByRole("note")).toHaveTextContent(/This folder contains AppData/u);
    expect(screen.getByRole("treeitem", { name: /AppData/u })).toBeInTheDocument();
  });

  it("shows the notice in German", async () => {
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    listing(["AppData", "Documents"]);
    render(
      <I18nProvider>
        <FilesWidget root={ROOT} />
      </I18nProvider>,
    );
    expect(await screen.findByText(/Dieser Ordner enthält AppData/u)).toBeInTheDocument();
  });

  it("shows no notice for a folder without AppData", async () => {
    listing(["Documents"]);
    render(<FilesWidget root={ROOT} />);
    expect(await screen.findByRole("treeitem", { name: /Documents/u })).toBeInTheDocument();
    expect(screen.queryByTestId("app-data-notice")).toBeNull();
  });
});
