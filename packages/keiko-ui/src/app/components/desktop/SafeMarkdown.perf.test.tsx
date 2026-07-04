// GEN-PERF-CHAT-010 — render-stability regression for SafeMarkdown.
//
// SafeMarkdown was hardened for security (AST-only) but its highlight output and Markdown parse
// were recomputed on every parent re-render. A settled assistant bubble re-renders whenever an
// unrelated parent (draft/streaming) changes; without memoization each such render re-tokenised
// every code block. These tests pin:
//   1. highlightLines runs exactly once per code block across N identical-prop re-renders.
//   2. parseSafeMarkdown runs exactly once across N identical-prop re-renders.
// Both fail on the pre-fix (unmemoized) SafeMarkdown and pass after the memo + useMemo landed.

import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

// Spy on the highlighter while preserving its real behaviour so rendered output is unchanged.
vi.mock("./widgets/cards/shared/syntaxHighlight", async () => {
  const actual = await vi.importActual<typeof import("./widgets/cards/shared/syntaxHighlight")>(
    "./widgets/cards/shared/syntaxHighlight",
  );
  return {
    ...actual,
    highlightLines: vi.fn(actual.highlightLines),
  };
});

// Spy on the Markdown parser the same way.
vi.mock("@/lib/safe-markdown", async () => {
  const actual = await vi.importActual<typeof import("@/lib/safe-markdown")>("@/lib/safe-markdown");
  return {
    ...actual,
    parseSafeMarkdown: vi.fn(actual.parseSafeMarkdown),
  };
});

import { SafeMarkdown } from "./SafeMarkdown";
import { highlightLines } from "./widgets/cards/shared/syntaxHighlight";
import { parseSafeMarkdown } from "@/lib/safe-markdown";

const CODE_SOURCE = "Here is code:\n\n```ts\nconst a = 1;\nconst b = 2;\nconst c = a + b;\n```\n";

describe("SafeMarkdown — render stability (GEN-PERF-CHAT-010)", () => {
  it("highlights each code block exactly once across identical-prop re-renders", () => {
    const highlightSpy = vi.mocked(highlightLines);
    highlightSpy.mockClear();

    const { rerender } = render(<SafeMarkdown source={CODE_SOURCE} />);
    const afterFirst = highlightSpy.mock.calls.length;
    expect(afterFirst).toBe(1);

    // 10 identical-prop parent re-renders must NOT re-run the highlighter.
    for (let i = 0; i < 10; i += 1) {
      rerender(<SafeMarkdown source={CODE_SOURCE} />);
    }
    expect(highlightSpy.mock.calls.length).toBe(afterFirst);
  });

  it("parses the Markdown source exactly once across identical-prop re-renders", () => {
    const parseSpy = vi.mocked(parseSafeMarkdown);
    parseSpy.mockClear();

    const { rerender } = render(<SafeMarkdown source={CODE_SOURCE} />);
    expect(parseSpy.mock.calls.length).toBe(1);

    for (let i = 0; i < 10; i += 1) {
      rerender(<SafeMarkdown source={CODE_SOURCE} />);
    }
    expect(parseSpy.mock.calls.length).toBe(1);
  });

  it("re-highlights when the source text actually changes", () => {
    const highlightSpy = vi.mocked(highlightLines);
    highlightSpy.mockClear();

    const { rerender } = render(<SafeMarkdown source={CODE_SOURCE} />);
    expect(highlightSpy.mock.calls.length).toBe(1);

    rerender(<SafeMarkdown source={"```ts\nconst z = 9;\n```\n"} />);
    expect(highlightSpy.mock.calls.length).toBe(2);
  });
});
