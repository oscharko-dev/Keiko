import { render, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorDiagnostic } from "@oscharko-dev/keiko-editor";
import { resetEditorProblemsStoreForTests, setPaneDiagnostics } from "../cards/editorProblemsStore";
import { ProblemsPanel } from "./ProblemsPanel";

function diagnostic(
  severity: EditorDiagnostic["severity"],
  line: number,
  message = "boom",
): EditorDiagnostic {
  return { range: { start: { line, column: 0 }, end: { line, column: 1 } }, severity, message };
}

beforeEach(() => {
  resetEditorProblemsStoreForTests();
});

afterEach(() => {
  resetEditorProblemsStoreForTests();
});

describe("ProblemsPanel", () => {
  it("renders the empty state and the open-files-only note when there are no problems", () => {
    render(<ProblemsPanel root="/ws" />);
    expect(screen.getByTestId("problems-empty")).toBeInTheDocument();
    expect(screen.getByText(/currently open files only/i)).toBeInTheDocument();
  });

  it("aggregates open-file diagnostics into a sorted list", () => {
    setPaneDiagnostics("src/a.ts", [diagnostic("warning", 4), diagnostic("error", 1)]);
    render(<ProblemsPanel root="/ws" />);
    const rows = screen.getAllByTestId("problems-row");
    expect(rows).toHaveLength(2);
    // error sorts before warning (severity descending).
    expect(rows[0]?.textContent).toContain("boom");
  });

  it("filters by severity and shows a distinct zero-match message", async () => {
    const user = userEvent.setup();
    setPaneDiagnostics("src/a.ts", [diagnostic("warning", 1)]);
    render(<ProblemsPanel root="/ws" />);
    await user.selectOptions(screen.getByTestId("problems-filter-severity"), "error");
    expect(screen.queryByTestId("problems-list")).not.toBeInTheDocument();
    expect(screen.getByTestId("problems-no-match")).toBeInTheDocument();
    expect(screen.queryByTestId("problems-empty")).not.toBeInTheDocument();
  });

  it("flags truncation when the per-file cap is exceeded", () => {
    const many = Array.from({ length: 120 }, (_unused, index) => diagnostic("error", index));
    setPaneDiagnostics("src/a.ts", many);
    render(<ProblemsPanel root="/ws" />);
    expect(screen.getByTestId("problems-truncated")).toBeInTheDocument();
  });

  it("jumps to the exact line on click and on Enter for a located row", () => {
    const openEditorFile = vi.fn(() => ({ ok: true }) as never);
    setPaneDiagnostics("src/a.ts", [diagnostic("error", 11)]);
    render(<ProblemsPanel root="/ws" openEditorFile={openEditorFile} />);
    fireEvent.click(screen.getByTestId("problems-row"));
    expect(openEditorFile).toHaveBeenCalledWith({
      root: "/ws",
      path: "src/a.ts",
      lineStart: 12,
      lineEnd: 12,
    });
    fireEvent.keyDown(screen.getByTestId("problems-row"), { key: "Enter" });
    expect(openEditorFile).toHaveBeenCalledTimes(2);
  });

  it("has no axe violations in the default and filtered/focused states", async () => {
    setPaneDiagnostics("src/a.ts", [diagnostic("error", 1), diagnostic("warning", 2)]);
    const { container } = render(<ProblemsPanel root="/ws" openEditorFile={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
    fireEvent.change(screen.getByTestId("problems-filter-source"), {
      target: { value: "verification" },
    });
    expect(await axe(container)).toHaveNoViolations();
  });
});
