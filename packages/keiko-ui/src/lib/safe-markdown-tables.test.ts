import { describe, expect, it } from "vitest";
import { parseSafeMarkdown, type SafeMarkdownNode } from "./safe-markdown";

function tableRows(source: string): readonly (readonly SafeMarkdownNode[])[] {
  const nodes = parseSafeMarkdown(source);
  expect(nodes).toHaveLength(1);
  const table = nodes[0];
  expect(table?.kind).toBe("table");
  const header = table?.children?.find((node) => node.kind === "thead")?.children ?? [];
  const body = table?.children?.find((node) => node.kind === "tbody")?.children ?? [];
  return [...header, ...body].map((row) => row.children ?? []);
}

function textOf(node: SafeMarkdownNode): string {
  return node.text ?? (node.children ?? []).map(textOf).join("");
}

describe("GFM table escaped pipe boundaries", () => {
  it("keeps the quoted source in the third column of a semantic review", () => {
    const source = [
      "| Requirement | Finding | Source |",
      "| --- | --- | --- |",
      String.raw`| MIG_012 | Compare totals | "Quelle = Ziel \| keine Differenz" [1] |`,
    ].join("\n");
    const rows = tableRows(source);
    expect(rows.map((row) => row.length)).toEqual([3, 3]);
    expect(rows[1]?.map(textOf)).toEqual([
      "MIG_012",
      "Compare totals",
      '"Quelle = Ziel | keine Differenz" [1]',
    ]);
  });

  // https://github.github.io/gfm/#example-200 — the table owns this escape even in code spans.
  it("renders GFM example 200 in header, inline code and strong emphasis", () => {
    const source = [
      String.raw`| f\|oo |`,
      "| ------ |",
      "| b `\\|` az |",
      String.raw`| b **\|** im |`,
    ].join("\n");
    const rows = tableRows(source);
    expect(parseSafeMarkdown(source)[0]?.escapedPipeCount).toBe(3);
    expect(rows.map((row) => row.map(textOf))).toEqual([["f|oo"], ["b | az"], ["b | im"]]);
    expect(rows[1]?.[0]?.children).toContainEqual({ kind: "inline-code", text: "|" });
    expect(rows[2]?.[0]?.children).toContainEqual({
      kind: "strong",
      children: [{ kind: "text", text: "|" }],
    });
  });

  it.each([1, 2, 3, 4])("distinguishes a run of %i backslashes before a pipe", (count) => {
    const slashes = "\\".repeat(count);
    const escaped = count % 2 === 1;
    const source = [
      escaped ? "left | right" : "left | middle | right",
      escaped ? "--- | ---" : "--- | --- | ---",
      `a${slashes}|b | c`,
    ].join("\n");
    const rows = tableRows(source);
    // Consume only the table's escape, preserving the other backslashes as before.
    const expected = escaped ? [`a${slashes.slice(1)}|b`, "c"] : [`a${slashes}`, "b", "c"];
    expect(rows[1]?.map(textOf)).toEqual(expected);
    expect(rows[1]).toHaveLength(escaped ? 2 : 3);
  });

  it("preserves escaped leading and trailing content pipes without optional border pipes", () => {
    const rows = tableRows(
      [String.raw`\|left | right\|`, "--- | ---", String.raw`\|first | last\|`].join("\n"),
    );
    expect(rows.map((row) => row.map(textOf))).toEqual([
      ["|left", "right|"],
      ["|first", "last|"],
    ]);
  });

  it("keeps empty cells and ordinary leading and trailing table borders", () => {
    const rows = tableRows("| | middle | |\n| --- | --- | --- |\n| | body | |");
    expect(rows.map((row) => row.map(textOf))).toEqual([
      ["", "middle", ""],
      ["", "body", ""],
    ]);
  });

  it("still treats an unescaped pipe inside backticks as a cell boundary", () => {
    const rows = tableRows("| left | right |\n| --- | --- |\n| `one | two` |");
    expect(rows[1]?.map(textOf)).toEqual(["`one", "two`"]);
    expect(
      rows[1]?.flatMap((node) => node.children ?? []).some((node) => node.kind === "inline-code"),
    ).toBe(false);
  });

  it("leaves escapes in inline and fenced code outside tables untouched", () => {
    const inline = parseSafeMarkdown("`\\|`");
    expect(inline[0]?.children).toEqual([{ kind: "inline-code", text: "\\|" }]);
    const fenced = parseSafeMarkdown("```\n| a \\| b |\n```");
    expect(fenced[0]).toMatchObject({ kind: "code-block", text: "| a \\| b |" });
  });
});
