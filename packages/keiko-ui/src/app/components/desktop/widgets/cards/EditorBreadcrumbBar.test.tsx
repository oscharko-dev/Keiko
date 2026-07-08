import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { EditorDocumentSymbol } from "@oscharko-dev/keiko-editor";

import { EditorBreadcrumbBar } from "./EditorBreadcrumbBar";
import { buildEditorOutlineTree, findContainingOutlinePath } from "./editorOutlineModel";

function range(
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn: number,
): EditorDocumentSymbol["range"] {
  return {
    start: { line: startLine, column: startColumn },
    end: { line: endLine, column: endColumn },
  };
}

describe("EditorBreadcrumbBar", () => {
  it("shows the containing symbol path and reveals clicked segments", async () => {
    const symbols: readonly EditorDocumentSymbol[] = [
      { name: "Greeter", kind: "class", range: range(0, 0, 5, 1) },
      { name: "run", kind: "method", range: range(2, 2, 4, 3) },
    ];
    const tree = buildEditorOutlineTree(symbols);
    const path = findContainingOutlinePath(tree, { line: 3, column: 4 });
    const onReveal = vi.fn();

    render(<EditorBreadcrumbBar filePath="src/app.ts" path={path} onReveal={onReveal} />);
    expect(screen.getByText("app.ts")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Greeter" }));

    expect(onReveal).toHaveBeenCalledWith(symbols[0]);
  });
});
