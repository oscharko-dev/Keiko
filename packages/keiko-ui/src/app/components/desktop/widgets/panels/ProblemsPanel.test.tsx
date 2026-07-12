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
    setPaneDiagnostics("/ws", "window-a", "src/a.ts", [
      diagnostic("warning", 4),
      diagnostic("error", 1),
    ]);
    render(<ProblemsPanel root="/ws" />);
    const rows = screen.getAllByTestId("problems-row");
    expect(rows).toHaveLength(2);
    // error sorts before warning (severity descending).
    expect(rows[0]?.textContent).toContain("boom");
  });

  it("filters by severity and shows a distinct zero-match message", async () => {
    const user = userEvent.setup();
    setPaneDiagnostics("/ws", "window-a", "src/a.ts", [diagnostic("warning", 1)]);
    render(<ProblemsPanel root="/ws" />);
    await user.selectOptions(screen.getByTestId("problems-filter-severity"), "error");
    expect(screen.queryByTestId("problems-list")).not.toBeInTheDocument();
    expect(screen.getByTestId("problems-no-match")).toBeInTheDocument();
    expect(screen.queryByTestId("problems-empty")).not.toBeInTheDocument();
  });

  it("flags truncation when the per-file cap is exceeded", () => {
    const many = Array.from({ length: 120 }, (_unused, index) => diagnostic("error", index));
    setPaneDiagnostics("/ws", "window-a", "src/a.ts", many);
    render(<ProblemsPanel root="/ws" />);
    expect(screen.getByTestId("problems-truncated")).toBeInTheDocument();
  });

  it("jumps to the exact line on click and on Enter for a located row", () => {
    const openEditorFile = vi.fn(() => ({ ok: true }) as never);
    setPaneDiagnostics("/ws", "window-a", "src/a.ts", [diagnostic("error", 11)]);
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

  it("has no axe violations in the default state and the zero-match filtered state", async () => {
    setPaneDiagnostics("/ws", "window-a", "src/a.ts", [
      diagnostic("error", 1),
      diagnostic("warning", 2),
    ]);
    const { container } = render(<ProblemsPanel root="/ws" openEditorFile={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
    fireEvent.change(screen.getByTestId("problems-filter-source"), {
      target: { value: "verification" },
    });
    expect(screen.getByTestId("problems-no-match")).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no axe violations with a multi-row listbox and a non-first row focused (Issue #2213 fix-up)", async () => {
    setPaneDiagnostics("/ws", "window-a", "src/a.ts", [
      diagnostic("error", 1),
      diagnostic("warning", 2),
      diagnostic("error", 3),
    ]);
    const { container } = render(<ProblemsPanel root="/ws" openEditorFile={vi.fn()} />);
    const rows = screen.getAllByTestId("problems-row");
    expect(rows).toHaveLength(3);
    // The roving-tabindex listbox starts with the first row focused.
    expect(rows[0]).toHaveAttribute("aria-selected", "true");
    expect(rows[0]).toHaveAttribute("tabindex", "0");
    // Move focus to a NON-FIRST row via the real keyboard-navigation path (ArrowDown on the listbox).
    fireEvent.keyDown(screen.getByTestId("problems-list"), { key: "ArrowDown" });
    const focusedRows = screen.getAllByTestId("problems-row");
    expect(focusedRows[0]).toHaveAttribute("aria-selected", "false");
    expect(focusedRows[0]).toHaveAttribute("tabindex", "-1");
    expect(focusedRows[1]).toHaveAttribute("aria-selected", "true");
    expect(focusedRows[1]).toHaveAttribute("tabindex", "0");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("moves DOM focus with Arrow, Home, and End and activates the focused row with Space", () => {
    const openEditorFile = vi.fn(() => ({ ok: true }) as never);
    setPaneDiagnostics("/ws", "window-a", "src/a.ts", [
      diagnostic("error", 1, "first"),
      diagnostic("error", 2, "second"),
      diagnostic("warning", 3, "third"),
    ]);
    render(<ProblemsPanel root="/ws" openEditorFile={openEditorFile} />);
    const rows = screen.getAllByTestId("problems-row");
    rows[0]?.focus();

    fireEvent.keyDown(rows[0] as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1] as HTMLElement, { key: "End" });
    expect(document.activeElement).toBe(rows[2]);
    fireEvent.keyDown(rows[2] as HTMLElement, { key: "Home" });
    expect(document.activeElement).toBe(rows[0]);
    fireEvent.keyDown(rows[0] as HTMLElement, { key: " " });

    expect(openEditorFile).toHaveBeenLastCalledWith({
      root: "/ws",
      path: "src/a.ts",
      lineStart: 2,
      lineEnd: 2,
    });
  });
});
