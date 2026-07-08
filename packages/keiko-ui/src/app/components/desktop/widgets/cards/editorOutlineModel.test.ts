import { describe, expect, it } from "vitest";
import type { EditorDocumentSymbol } from "@oscharko-dev/keiko-editor";

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

function symbol(
  name: string,
  kind: EditorDocumentSymbol["kind"],
  symbolRange: EditorDocumentSymbol["range"],
): EditorDocumentSymbol {
  return { name, kind, range: symbolRange };
}

describe("buildEditorOutlineTree", () => {
  it("reconstructs hierarchy from flat symbol ranges", () => {
    const tree = buildEditorOutlineTree([
      symbol("run", "method", range(2, 2, 4, 3)),
      symbol("Greeter", "class", range(0, 0, 5, 1)),
      symbol("helper", "function", range(7, 0, 9, 1)),
    ]);

    expect(tree.map((node) => node.symbol.name)).toEqual(["Greeter", "helper"]);
    expect(tree[0]?.children.map((node) => node.symbol.name)).toEqual(["run"]);
    expect(tree[0]?.children[0]?.depth).toBe(2);
  });
});

describe("findContainingOutlinePath", () => {
  it("returns the innermost symbol path for the cursor", () => {
    const tree = buildEditorOutlineTree([
      symbol("Greeter", "class", range(0, 0, 5, 1)),
      symbol("run", "method", range(2, 2, 4, 3)),
    ]);

    expect(
      findContainingOutlinePath(tree, { line: 3, column: 4 }).map((node) => node.symbol.name),
    ).toEqual(["Greeter", "run"]);
    expect(findContainingOutlinePath(tree, { line: 8, column: 0 })).toEqual([]);
  });
});
