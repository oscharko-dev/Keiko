import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { SafeMarkdownNode } from "@/lib/safe-markdown";
import { SafeMarkdown, SafeMarkdownBoundary, type SafeMarkdownRichContent } from "./SafeMarkdown";

interface StubRich extends SafeMarkdownRichContent {
  readonly renderMath: ReturnType<typeof vi.fn<(node: SafeMarkdownNode) => ReactNode>>;
  readonly renderCodeBlock: ReturnType<
    typeof vi.fn<(node: SafeMarkdownNode, standard: ReactNode) => ReactNode>
  >;
}

function stubRich(replace: boolean): StubRich {
  return {
    renderMath: vi.fn((node: SafeMarkdownNode): ReactNode => (
      <span data-testid="stub-math" data-display={String(node.display)}>
        {node.text}
      </span>
    )),
    renderCodeBlock: vi.fn((node: SafeMarkdownNode, standard: ReactNode): ReactNode =>
      replace ? <div data-testid="stub-block">{node.language}</div> : standard,
    ),
  };
}

describe("SafeMarkdown without rich content", () => {
  it("leaves dollar-delimited text and fenced blocks exactly as before", () => {
    const { container } = render(
      <SafeMarkdown source={"It is $a*b*c$ here.\n\n```diff\n-a\n+b\n```"} />,
    );
    expect(container.querySelector("em")?.textContent).toBe("b");
    expect(container.textContent).toContain("It is $a");
    expect(container.querySelector('[class~="sm-code-block-frame"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="stub-math"]')).toBeNull();
  });
});

describe("SafeMarkdown with rich content", () => {
  it("claims a math span before emphasis can split it and hands the renderer its source", () => {
    const rich = stubRich(true);
    const { container } = render(
      <SafeMarkdown source={"It is $a*b*c$ here."} richContent={rich} />,
    );
    expect(container.querySelector("em")).toBeNull();
    expect(screen.getByTestId("stub-math")).toHaveTextContent("a*b*c");
    expect(screen.getByTestId("stub-math")).toHaveAttribute("data-display", "false");
    expect(rich.renderMath).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("It is a*b*c here.");
  });

  it("marks display math", () => {
    render(<SafeMarkdown source={"$$\nx^2\n$$"} richContent={stubRich(true)} />);
    expect(screen.getByTestId("stub-math")).toHaveAttribute("data-display", "true");
  });

  it("offers a closed fence to the renderer together with its unchanged code view", () => {
    const rich = stubRich(false);
    const { container } = render(
      <SafeMarkdown source={"```diff\n-a\n+b\n```"} richContent={rich} />,
    );
    expect(rich.renderCodeBlock).toHaveBeenCalledTimes(1);
    const [node, standard] = rich.renderCodeBlock.mock.calls[0] ?? [];
    expect(node).toMatchObject({ kind: "code-block", language: "diff", text: "-a\n+b" });
    expect(standard).toBeTruthy();
    expect(container.querySelector('[class~="sm-code-block-frame"]')).not.toBeNull();
  });

  it("shows what the renderer returns instead of the code view", () => {
    const { container } = render(
      <SafeMarkdown source={"```diff\n-a\n+b\n```"} richContent={stubRich(true)} />,
    );
    expect(screen.getByTestId("stub-block")).toHaveTextContent("diff");
    expect(container.querySelector('[class~="sm-code-block-frame"]')).toBeNull();
  });

  it("keeps the plain code view of a fence the stream has not closed", () => {
    const rich = stubRich(true);
    const { container } = render(
      <SafeMarkdown source={"```diff\n-a\n+b"} richContent={rich} streaming />,
    );
    expect(rich.renderCodeBlock).not.toHaveBeenCalled();
    expect(container.querySelector('[class~="sm-code-block-frame"]')).not.toBeNull();
    expect(container.textContent).toContain("+b");
  });

  it("asks about a fence once it closes, still while streaming", () => {
    const rich = stubRich(true);
    const { rerender } = render(
      <SafeMarkdown source={"```diff\n-a\n+b"} richContent={rich} streaming />,
    );
    rerender(<SafeMarkdown source={"```diff\n-a\n+b\n```\nNext"} richContent={rich} streaming />);
    expect(rich.renderCodeBlock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("stub-block")).toBeInTheDocument();
  });

  it("treats the end of a finished answer as the end of its last fence", () => {
    const rich = stubRich(true);
    render(<SafeMarkdown source={"```diff\n-a\n+b"} richContent={rich} />);
    expect(rich.renderCodeBlock).toHaveBeenCalledTimes(1);
  });

  it("leaves a math span whose closing delimiter has not arrived as prose", () => {
    const rich = stubRich(true);
    const { container } = render(
      <SafeMarkdown source={"The bound is $x^2 + "} richContent={rich} streaming />,
    );
    expect(rich.renderMath).not.toHaveBeenCalled();
    expect(container.textContent).toBe("The bound is $x^2 + ");
  });

  it("keeps user input literal and never offers it to the renderer", () => {
    const rich = stubRich(true);
    const { container } = render(
      <SafeMarkdown
        source={"literal $x$\n\n```diff\n-a\n+b\n```"}
        richContent={rich}
        literalUserInput
      />,
    );
    expect(rich.renderMath).not.toHaveBeenCalled();
    expect(rich.renderCodeBlock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("literal $x$");
  });

  it("keeps the trailing marker after math and after a rich block", () => {
    const { container, rerender } = render(
      <SafeMarkdown source={"Done: $x$"} richContent={stubRich(true)} trailing={<i>MARK</i>} />,
    );
    expect(container.textContent).toBe("Done: xMARK");
    rerender(
      <SafeMarkdown
        source={"```diff\n-a\n+b\n```"}
        richContent={stubRich(true)}
        trailing={<i>MARK</i>}
      />,
    );
    expect(container.textContent).toBe("diffMARK");
  });

  it("passes the renderer through the per-message boundary", () => {
    const rich = stubRich(true);
    render(<SafeMarkdownBoundary source={"$x$"} richContent={rich} />);
    expect(screen.getByTestId("stub-math")).toBeInTheDocument();
  });

  it("degrades the whole message to its source if the renderer itself throws", () => {
    const failing: SafeMarkdownRichContent = {
      renderMath: () => {
        throw new Error("renderer defect");
      },
      renderCodeBlock: (_node, standard) => standard,
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { container } = render(<SafeMarkdownBoundary source={"A $x$ B"} richContent={failing} />);
    spy.mockRestore();
    expect(container.querySelector('[data-markdown-fallback="true"]')?.textContent).toBe("A $x$ B");
  });
});
