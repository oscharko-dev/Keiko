import { render } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it } from "vitest";
import type { EditorDocumentSymbol } from "@oscharko-dev/keiko-editor";

import { EditorBreadcrumbBar } from "./EditorBreadcrumbBar";
import { EditorOutlinePanel } from "./EditorOutlinePanel";
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

const SYMBOLS: readonly EditorDocumentSymbol[] = [
  { name: "Greeter", kind: "class", range: range(0, 0, 5, 1) },
  { name: "run", kind: "method", range: range(2, 2, 4, 3) },
];

afterEach(() => {
  delete document.documentElement.dataset.theme;
});

describe("Editor outline and breadcrumbs accessibility", () => {
  it.each(["light", "dark"])("has no axe violations in %s theme", async (theme) => {
    document.documentElement.dataset.theme = theme;
    const tree = buildEditorOutlineTree(SYMBOLS);
    const path = findContainingOutlinePath(tree, { line: 3, column: 4 });
    const { container } = render(
      <>
        <EditorOutlinePanel
          snapshot={{
            filePath: "src/app.ts",
            symbols: SYMBOLS,
            cursor: { line: 3, column: 4 },
            enabled: true,
            loading: false,
          }}
          visible
          onToggleVisible={() => undefined}
          onReveal={() => undefined}
        />
        <EditorBreadcrumbBar filePath="src/app.ts" path={path} onReveal={() => undefined} />
      </>,
    );

    expect(await axe(container)).toHaveNoViolations();
  });
});
