import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { SafeMarkdown } from "@/app/components/desktop/SafeMarkdown";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";

afterEach(resetClientDiagnosticWriter);

// The real assistant renderer must keep a source quote in its original column, not merely
// produce an apparently valid parser AST with a fourth cell hidden by the presentation.
describe("SafeMarkdown escaped pipe tables", () => {
  it("renders the three-column semantic review without an extra source column", () => {
    render(
      <SafeMarkdown
        source={[
          "| Requirement | Finding | Source |",
          "| --- | --- | --- |",
          String.raw`| MIG_012 | Compare totals | "Quelle = Ziel \| keine Differenz" [1] |`,
        ].join("\n")}
      />,
    );
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader")).toHaveLength(3);
    const cells = within(table).getAllByRole("cell");
    expect(cells).toHaveLength(3);
    expect(cells[2]?.textContent).toBe('"Quelle = Ziel | keine Differenz" [1]');
  });

  it("renders the GFM escaped code pipe as one literal code node in one cell", () => {
    render(<SafeMarkdown source={"| Code |\n| --- |\n| `\\|` |"} />);
    const cells = within(screen.getByRole("table")).getAllByRole("cell");
    expect(cells).toHaveLength(1);
    expect(cells[0]?.querySelector("code")?.textContent).toBe("|");
  });

  it("keeps HTML and unsafe links inert after the table escape is consumed", () => {
    render(
      <SafeMarkdown
        source={[
          "| Source |",
          "| --- |",
          String.raw`| <img src=x onerror=alert(1)> \| [bad](javascript:alert(1)) |`,
        ].join("\n")}
      />,
    );
    const cell = within(screen.getByRole("table")).getByRole("cell");
    expect(cell.textContent).toContain("<img src=x onerror=alert(1)> |");
    expect(cell.querySelector("img, script, iframe, a")).toBeNull();
  });

  it("reports actual table escape counts once at settled rendering without source text", () => {
    const writer = vi.fn();
    setClientDiagnosticWriter(writer);
    const source = [String.raw`| f\|oo |`, "| --- |", "| `\\|` |"].join("\n");
    const props = { source, diagnosticMessageId: "msg-1", diagnosticCorrelationId: "message-1" };
    const { rerender } = render(<SafeMarkdown {...props} streaming />);
    expect(writer).not.toHaveBeenCalled();
    rerender(<SafeMarkdown {...props} />);
    expect(writer).toHaveBeenCalledExactlyOnceWith("markdown:escaped-table-pipes", {
      kind: "markdown-layout",
      correlationId: "message-1",
      markdownLayout: { messageId: "msg-1", escapedPipeCount: 2 },
    });
    expect(JSON.stringify(writer.mock.calls)).not.toContain("f|oo");
    rerender(<SafeMarkdown {...props} />);
    expect(writer).toHaveBeenCalledOnce();
    rerender(<SafeMarkdown {...props} source={"| Ordinary |\n| --- |\n| cell |"} />);
    expect(writer).toHaveBeenCalledOnce();
  });
});
