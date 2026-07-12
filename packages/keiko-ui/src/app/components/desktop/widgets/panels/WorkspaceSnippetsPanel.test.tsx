import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EDITOR_M7_SNIPPET_COLLECTION_VERSION,
  type EditorM7WorkspaceSnippet,
  type EditorM7WorkspaceSnippetSnapshot,
} from "@oscharko-dev/keiko-contracts";
import { I18nProvider } from "@/lib/i18n";
import { WorkspaceSnippetsPanel } from "./WorkspaceSnippetsPanel";
import type { WorkspaceSnippetsView } from "../cards/useWorkspaceSnippets";

const snippetsView = vi.hoisted(() => ({
  current: undefined as unknown as WorkspaceSnippetsView,
}));

vi.mock("../cards/useWorkspaceSnippets", () => ({
  useWorkspaceSnippets: (): WorkspaceSnippetsView => snippetsView.current,
}));

const WORKSPACE_FINGERPRINT = "abcdef1234567890";

function snippet(id: string, name: string): EditorM7WorkspaceSnippet {
  return {
    id,
    name,
    prefixes: [id],
    description: `${name} snippet`,
    languages: ["typescript"],
    include: ["src/**/*.ts"],
    body: ["console.log(${1:value});", "$0"],
    revision: 3,
    provenance: { source: "workspace", workspaceFingerprint: WORKSPACE_FINGERPRINT },
  };
}

function snapshot(snippets: readonly EditorM7WorkspaceSnippet[]): EditorM7WorkspaceSnippetSnapshot {
  return {
    schemaVersion: EDITOR_M7_SNIPPET_COLLECTION_VERSION,
    storeState: "ready",
    revision: 3,
    etag: '"edsn-3-test"',
    workspaceFingerprint: WORKSPACE_FINGERPRINT,
    snippets,
  };
}

function view(overrides: Partial<WorkspaceSnippetsView> = {}): WorkspaceSnippetsView {
  return {
    snapshot: snapshot([snippet("zeta", "Zeta"), snippet("alpha", "Alpha")]),
    loading: false,
    mutating: false,
    issue: undefined,
    refresh: vi.fn(),
    replace: vi.fn(() => Promise.resolve()),
    reset: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

function renderPanel(root?: string): void {
  render(
    <I18nProvider>
      <WorkspaceSnippetsPanel root={root} />
    </I18nProvider>,
  );
}

describe("WorkspaceSnippetsPanel", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    snippetsView.current = view();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders snippets in stable name order and deletes through the server snapshot", () => {
    renderPanel("/repo");
    const cards = screen.getAllByRole("article");

    expect(within(cards[1] ?? document.body).getByText("Alpha")).toBeInTheDocument();
    expect(within(cards[2] ?? document.body).getByText("Zeta")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0] ?? document.body);

    expect(snippetsView.current.replace).toHaveBeenCalledWith([
      expect.objectContaining({ id: "zeta", name: "Zeta" }),
    ]);
  });

  it("previews and saves a new snippet as a bounded workspace input", () => {
    renderPanel("/repo");

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "React Hook" } });
    fireEvent.change(screen.getByLabelText("Prefix"), { target: { value: "hook" } });
    fireEvent.change(screen.getByLabelText("Include glob"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    fireEvent.click(screen.getByRole("button", { name: "Save snippet" }));

    expect(screen.getByText((content) => content.includes("const ${1:name}"))).toBeInTheDocument();
    expect(snippetsView.current.replace).toHaveBeenCalledWith([
      expect.objectContaining({ id: "zeta" }),
      expect.objectContaining({ id: "alpha" }),
      {
        id: "snippet-loyw3v28",
        name: "React Hook",
        prefixes: ["hook"],
        description: "React Hook",
        languages: ["typescript"],
        include: undefined,
        body: ["const ${1:name} = ${2:value};", "$0"],
      },
    ]);
  });

  it("surfaces missing workspace, mutation issue, empty state, and reset disablement", () => {
    snippetsView.current = view({
      snapshot: snapshot([]),
      issue: "mutation",
      mutating: true,
    });
    renderPanel(undefined);

    expect(screen.getByText("Open a workspace to manage workspace snippets.")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("mutation");
    expect(screen.getByText("No workspace snippets are defined.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset snippets" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save snippet" })).toBeDisabled();
  });
});
