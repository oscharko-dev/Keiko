import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  EditorM7WorkspaceSnippet,
  EditorM7WorkspaceSnippetSnapshot,
} from "@oscharko-dev/keiko-contracts";
import {
  EDITOR_M7_SNIPPET_BODY_MAX_UTF8_BYTES,
  EDITOR_M7_SNIPPET_COLLECTION_VERSION,
} from "@oscharko-dev/keiko-contracts/runtime/editor-snippets";
import { I18nProvider } from "@/lib/i18n";
import { WorkspaceSnippetsPanel } from "./WorkspaceSnippetsPanel";
import type { WorkspaceSnippetsView } from "../cards/useWorkspaceSnippets";

const snippetsView = vi.hoisted(() => ({
  current: undefined as unknown as WorkspaceSnippetsView,
}));

vi.mock("../cards/useWorkspaceSnippets", () => ({
  useWorkspaceSnippets: (): WorkspaceSnippetsView => snippetsView.current,
}));

// #2906 round 3: a spy that still calls through to the real compiler, so every OTHER test in this
// file keeps its real behavior — this only adds observability for the preflight-bound/memoization
// assertions below (never invoking, or not re-invoking, the full compiler).
const contractsSpies = vi.hoisted(() => ({
  compileEditorM7SnippetBody: vi.fn(),
}));

vi.mock("@oscharko-dev/keiko-contracts/runtime/editor-snippets", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@oscharko-dev/keiko-contracts/runtime/editor-snippets")>();
  contractsSpies.compileEditorM7SnippetBody.mockImplementation(actual.compileEditorM7SnippetBody);
  return { ...actual, compileEditorM7SnippetBody: contractsSpies.compileEditorM7SnippetBody };
});

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
    replace: vi.fn(() => Promise.resolve(true)),
    reset: vi.fn(() => Promise.resolve(true)),
    ...overrides,
  };
}

function renderPanel(root?: string): ReturnType<typeof render> {
  return render(
    <I18nProvider>
      <WorkspaceSnippetsPanel root={root} />
    </I18nProvider>,
  );
}

describe("WorkspaceSnippetsPanel", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    snippetsView.current = view();
    contractsSpies.compileEditorM7SnippetBody.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has no axe violations in its normal rendered state", async () => {
    const { container } = renderPanel("/repo");
    expect(await axe(container)).toHaveNoViolations();
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

  it("previews and saves a new snippet as a bounded workspace input", async () => {
    renderPanel("/repo");

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "React Hook" } });
    fireEvent.change(screen.getByLabelText("Prefix"), { target: { value: "hook" } });
    fireEvent.change(screen.getByLabelText("Include glob"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    fireEvent.click(screen.getByRole("button", { name: "Save snippet" }));

    await waitFor(() => {
      expect(
        screen.getByText((content) => content.includes("const ${1:name}")),
      ).toBeInTheDocument();
    });
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

  // KEIKO-0619: previewDraft used to collapse compileEditorM7SnippetBody's discriminated result to
  // a bare string, so a rejected body rendered its raw EditorM7ReasonCode ("UNSAFE_SNIPPET")
  // directly as preview text, and Save stayed enabled for a body already known locally to be
  // invalid.
  it("never renders the raw reasonCode token for an unsafe body and disables Save", () => {
    renderPanel("/repo");

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Unsafe" } });
    fireEvent.change(screen.getByLabelText("Prefix"), { target: { value: "unsafe" } });
    fireEvent.change(screen.getByLabelText("Body"), {
      target: { value: "javascript:alert(1)" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    expect(screen.queryByText("UNSAFE_SNIPPET")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This snippet body was rejected as unsafe or too large.",
    );
    expect(screen.getByRole("button", { name: "Save snippet" })).toBeDisabled();
  });

  it("rejects an oversized body via the cheap preflight bound without invoking the full compiler (#2906 round 3)", () => {
    renderPanel("/repo");
    contractsSpies.compileEditorM7SnippetBody.mockClear();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Huge" } });
    fireEvent.change(screen.getByLabelText("Prefix"), { target: { value: "huge" } });
    const oversized = "x".repeat(EDITOR_M7_SNIPPET_BODY_MAX_UTF8_BYTES + 1);
    fireEvent.change(screen.getByLabelText("Body"), { target: { value: oversized } });

    // Same rejection contract as a body the full compiler rejects (UNSAFE_SNIPPET), reached
    // WITHOUT ever calling split() + full snippet validation/UTF-8 accounting on the oversized
    // string.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(); // no Preview click yet
    expect(screen.getByRole("button", { name: "Save snippet" })).toBeDisabled();
    expect(contractsSpies.compileEditorM7SnippetBody).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This snippet body was rejected as unsafe or too large.",
    );
    // The click-triggered Preview path shares the same preflight helper, so it also never reaches
    // the full compiler for this oversized body.
    expect(contractsSpies.compileEditorM7SnippetBody).not.toHaveBeenCalled();
  });

  it("does not recompile the body when an unrelated field changes (memoized by draft.body, #2906 round 3)", () => {
    renderPanel("/repo");
    fireEvent.change(screen.getByLabelText("Body"), {
      target: { value: "const safe = 1;\n$0" },
    });
    contractsSpies.compileEditorM7SnippetBody.mockClear();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed" } });
    fireEvent.change(screen.getByLabelText("Prefix"), { target: { value: "renamed" } });
    fireEvent.change(screen.getByLabelText("Include glob"), { target: { value: "src/**" } });

    expect(contractsSpies.compileEditorM7SnippetBody).not.toHaveBeenCalled();
  });

  it("clears a stale preview once the body is edited again", () => {
    renderPanel("/repo");

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Unsafe" } });
    fireEvent.change(screen.getByLabelText("Prefix"), { target: { value: "unsafe" } });
    fireEvent.change(screen.getByLabelText("Body"), {
      target: { value: "javascript:alert(1)" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Body"), {
      target: { value: "const safe = 1;\n$0" },
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save snippet" })).toBeEnabled();
  });

  it("keeps Save enabled and the compiled preview visible for a safe body", () => {
    renderPanel("/repo");

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Safe" } });
    fireEvent.change(screen.getByLabelText("Prefix"), { target: { value: "safe" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // Scoped to the <pre> preview specifically — the draft <textarea> contains the same default
    // body text, so an unscoped query would match both.
    expect(
      screen.getByText(
        (content, element) =>
          element?.tagName.toLowerCase() === "pre" && content.includes("const ${1:name}"),
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save snippet" })).toBeEnabled();
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
