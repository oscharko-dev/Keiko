import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SafeMarkdown } from "./SafeMarkdown";

// ---------------------------------------------------------------------------
// 1. Heading renders demoted (h1 → h3) so model output stays out of the app's
//    top-level document outline (audit C315); visual classes are unchanged.
// ---------------------------------------------------------------------------
describe("SafeMarkdown — heading", () => {
  it("renders # Heading demoted to <h3> with correct text", () => {
    render(<SafeMarkdown source="# Hello World" />);
    const heading = screen.getByRole("heading", { level: 3 });
    expect(heading).toBeDefined();
    expect(heading.textContent).toBe("Hello World");
    expect(heading.className).toContain("sm-h1");
  });
});

// ---------------------------------------------------------------------------
// 2. Code block with language
// ---------------------------------------------------------------------------
describe("SafeMarkdown — code block", () => {
  it("renders <pre>, language badge, and copy button", () => {
    render(<SafeMarkdown source={"```typescript\nconst x = 1;\n```"} />);
    const pre = document.querySelector("pre");
    expect(pre).not.toBeNull();
    const copyBtn = screen.getByRole("button", { name: "Copy code block" });
    expect(copyBtn).toBeDefined();
    const langBadge = document.querySelector(".sm-code-lang");
    expect(langBadge?.textContent).toBe("typescript");
  });

  it("renders highlighted token spans and non-selectable line numbers", () => {
    render(<SafeMarkdown source={"```typescript\nconst answer = 42;\n```"} />);

    expect(document.querySelector(".hl-key")?.textContent).toBe("const");
    expect(document.querySelector(".hl-num")?.textContent).toBe("42");
    expect(document.querySelector(".sm-code-line-no")?.textContent).toBe("1");
    expect(document.querySelector(".sm-code-line-src")?.textContent).toContain("answer");
  });

  it("marks long code blocks as internally scrollable", () => {
    const longCode = Array.from(
      { length: 32 },
      (_, index) => `const line${String(index)} = ${String(index)};`,
    ).join("\n");
    render(<SafeMarkdown source={`\`\`\`typescript\n${longCode}\n\`\`\``} />);

    expect(document.querySelector(".sm-code-block-frame")).toHaveAttribute("data-long", "true");
    expect(document.querySelector(".sm-pre")).toHaveAttribute("data-long", "true");
    expect(document.querySelector(".sm-code-line-src")?.textContent).toContain("line0");
  });
});

// ---------------------------------------------------------------------------
// 3. Copy button calls navigator.clipboard.writeText
// ---------------------------------------------------------------------------
describe("SafeMarkdown — copy button interaction", () => {
  it("calls clipboard.writeText with verbatim code block text", async () => {
    // jsdom does not implement navigator.clipboard. Define it via property descriptor
    // before rendering so the component's useCallback closure sees it at click time.
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<SafeMarkdown source={"```js\nconsole.log('hi');\n```"} />);
    const copyBtn = screen.getByRole("button", { name: "Copy code block" });
    fireEvent.click(copyBtn);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("console.log('hi');");
    });
    expect(await screen.findByText("Code copied")).toBeInTheDocument();

    // Restore original descriptor
    if (clipboardDescriptor !== undefined) {
      Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    }
  });
});

// ---------------------------------------------------------------------------
// 3a. Copy button is a safe no-op when navigator.clipboard is undefined
// ---------------------------------------------------------------------------
describe("SafeMarkdown — copy button without clipboard API", () => {
  it("does not throw when navigator.clipboard is undefined (non-secure context)", () => {
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });

    render(<SafeMarkdown source={"```js\nconsole.log('hi');\n```"} />);
    const copyBtn = screen.getByRole("button", { name: "Copy code block" });
    expect(() => fireEvent.click(copyBtn)).not.toThrow();
    expect(
      screen.getByText("Clipboard unavailable. Select the code manually and copy it."),
    ).toBeInTheDocument();

    // Restore original descriptor
    if (clipboardDescriptor !== undefined) {
      Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    }
  });

  it("surfaces clipboard write failures", async () => {
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockRejectedValue(new Error("denied"));
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<SafeMarkdown source={"```js\nconsole.log('hi');\n```"} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy code block" }));

    expect(
      await screen.findByText("Clipboard access failed. Select the code manually and copy it."),
    ).toBeInTheDocument();

    if (clipboardDescriptor !== undefined) {
      Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Safe link renders with rel and target
// ---------------------------------------------------------------------------
describe("SafeMarkdown — safe link", () => {
  it("renders <a> with rel=noopener noreferrer and target=_blank", () => {
    render(<SafeMarkdown source="[Docs](https://docs.example.com)" />);
    // accessible name includes the sr-only new-tab hint (audit C316); regex because
    // jsdom's accname computation drops the boundary space that browsers keep
    const link = screen.getByRole("link", { name: /Docs.*opens in new tab/ });
    expect(link).toBeDefined();
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("href")).toBe("https://docs.example.com");
  });
});

describe("SafeMarkdown — repository references", () => {
  it("renders conservative repository references as editor-open controls", () => {
    const openReference = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    render(
      <SafeMarkdown
        source="See packages/keiko-harness/src/context.ts:50-57 for the boundary test."
        repositoryRoots={[{ root: "/repo", label: "Keiko" }]}
        openRepositoryReference={openReference}
      />,
    );

    const reference = screen.getByRole("button", {
      name: "Open packages/keiko-harness/src/context.ts at lines 50-57 in editor",
    });
    expect(reference.querySelector(".fi-img")).toHaveAttribute(
      "src",
      "/assets/icons/typescript.svg",
    );
    fireEvent.click(reference);

    expect(openReference).toHaveBeenCalledWith({
      root: "/repo",
      path: "packages/keiko-harness/src/context.ts",
      lineStart: 50,
      lineEnd: 57,
    });
  });

  it("uses the shared file-type icons for repository references", () => {
    const openReference = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    render(
      <SafeMarkdown
        source="Compare packages/keiko-harness/src/context.ts and packages/keiko-ui/package.json for config."
        repositoryRoots={[{ root: "/repo", label: "Keiko" }]}
        openRepositoryReference={openReference}
      />,
    );

    const tsReference = screen.getByRole("button", {
      name: "Open packages/keiko-harness/src/context.ts in editor",
    });
    const jsonReference = screen.getByRole("button", {
      name: "Open packages/keiko-ui/package.json in editor",
    });

    expect(tsReference.querySelector(".fi-img")).toHaveAttribute(
      "src",
      "/assets/icons/typescript.svg",
    );
    expect(jsonReference.querySelector(".fi-img")).toHaveAttribute("src", "/assets/icons/json.svg");
  });

  it("renders root-level repository files and bracket citations as editor-open controls", () => {
    const openReference = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    render(
      <SafeMarkdown
        source="TypeScript is resolved in [package-lock.json:1-48]. Scripts are in [package.json]."
        repositoryRoots={[{ root: "/repo", label: "Keiko" }]}
        openRepositoryReference={openReference}
      />,
    );

    const lockReference = screen.getByRole("button", {
      name: "Open package-lock.json at lines 1-48 in editor",
    });
    const packageReference = screen.getByRole("button", {
      name: "Open package.json in editor",
    });

    expect(lockReference).toHaveTextContent("package-lock.json:1-48");
    expect(packageReference).toHaveTextContent("package.json");
    expect(lockReference.querySelector(".fi-img")).toHaveAttribute("src", "/assets/icons/json.svg");
    expect(packageReference.querySelector(".fi-img")).toHaveAttribute(
      "src",
      "/assets/icons/json.svg",
    );

    fireEvent.click(lockReference);
    expect(openReference).toHaveBeenCalledWith({
      root: "/repo",
      path: "package-lock.json",
      lineStart: 1,
      lineEnd: 48,
    });
  });

  it("keeps sentence punctuation outside repository reference controls", () => {
    const openReference = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    render(
      <SafeMarkdown
        source="Review packages/keiko-harness/src/context.ts."
        repositoryRoots={[{ root: "/repo", label: "Keiko" }]}
        openRepositoryReference={openReference}
      />,
    );

    const reference = screen.getByRole("button", {
      name: "Open packages/keiko-harness/src/context.ts in editor",
    });
    expect(reference).toHaveTextContent("packages/keiko-harness/src/context.ts");
    expect(document.querySelector(".sm-p")?.textContent).toBe(
      "Review packages/keiko-harness/src/context.ts.",
    );
  });

  it("collapses grounded source metadata and duplicate repository references", () => {
    const openReference = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    render(
      <SafeMarkdown
        source="1. Assertion [packages/keiko-harness/src/context.ts:49-58] [source: api] packages/keiko-harness/src/context.ts:49-58."
        repositoryRoots={[{ root: "/repo", label: "Keiko" }]}
        openRepositoryReference={openReference}
      />,
    );

    const references = screen.getAllByRole("button", {
      name: "Open packages/keiko-harness/src/context.ts at lines 49-58 in editor",
    });
    expect(references).toHaveLength(1);
    expect(document.body.textContent).not.toContain("source: api");
    expect(document.body.textContent).not.toContain("[packages/keiko-harness");
    expect(document.body.textContent).toContain(
      "Assertion packages/keiko-harness/src/context.ts:49-58.",
    );
  });

  it("renders repository-looking text as selectable text when no repository root is connected", () => {
    const openReference = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    render(
      <SafeMarkdown
        source="See packages/keiko-harness/src/context.ts:50."
        openRepositoryReference={openReference}
      />,
    );

    expect(screen.queryByRole("button", { name: /Open packages\/keiko-harness/ })).toBeNull();
    expect(screen.getByText(/packages\/keiko-harness\/src\/context\.ts:50/)).toBeInTheDocument();
    expect(openReference).not.toHaveBeenCalled();
  });

  it("rejects absolute paths, parent traversal, URLs, and code-block content", () => {
    const openReference = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    render(
      <SafeMarkdown
        source={[
          "No links: /repo/src/a.ts ../src/a.ts https://example.com/src/a.ts",
          "",
          "```ts",
          "import x from 'packages/keiko-harness/src/context.ts';",
          "```",
        ].join("\n")}
        repositoryRoots={[{ root: "/repo", label: "Keiko" }]}
        openRepositoryReference={openReference}
      />,
    );

    expect(screen.queryByRole("button", { name: /Open .*src\/a\.ts/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Open packages\/keiko-harness/ })).toBeNull();
    expect(openReference).not.toHaveBeenCalled();
  });

  it("does not linkify ordinary domains when root-level file references are enabled", () => {
    const openReference = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    render(
      <SafeMarkdown
        source="No repository link for docs.example.com or [docs.example.com], but package.json is local."
        repositoryRoots={[{ root: "/repo", label: "Keiko" }]}
        openRepositoryReference={openReference}
      />,
    );

    expect(screen.queryByRole("button", { name: /docs\.example\.com/ })).toBeNull();
    expect(document.body.textContent).toContain("[docs.example.com]");
    expect(screen.getByRole("button", { name: "Open package.json in editor" })).toBeInTheDocument();
  });

  it("linkifies inline code only when the entire inline code is a repository reference", () => {
    const openReference = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    render(
      <SafeMarkdown
        source="Open `@packages/keiko-harness/src/context.ts:12`, not `see packages/keiko-harness/src/context.ts`."
        repositoryRoots={[{ root: "/repo", label: "Keiko" }]}
        openRepositoryReference={openReference}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Open packages/keiko-harness/src/context.ts at line 12 in editor",
      }),
    );

    expect(openReference).toHaveBeenCalledWith({
      root: "/repo",
      path: "packages/keiko-harness/src/context.ts",
      lineStart: 12,
      lineEnd: 12,
    });
    expect(screen.getByText("see packages/keiko-harness/src/context.ts")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 5. Unsafe javascript: link renders as plain text (no <a>)
// ---------------------------------------------------------------------------
describe("SafeMarkdown — unsafe javascript: link", () => {
  it("renders as plain text with no <a> element", () => {
    render(<SafeMarkdown source="[click me](javascript:alert(1))" />);
    const links = document.querySelectorAll("a");
    expect(links).toHaveLength(0);
    // The text content should include the markdown source literally
    expect(document.body.textContent).toContain("click me");
  });
});

// ---------------------------------------------------------------------------
// 6. Raw <script> source renders as escaped text, no <script> DOM element
// ---------------------------------------------------------------------------
describe("SafeMarkdown — script injection", () => {
  it("renders <script> source as escaped text, not an executable element", () => {
    render(<SafeMarkdown source="<script>alert(1)</script>" />);
    // No actual <script> element in the DOM
    const scripts = document.querySelectorAll("script");
    // There will be 0 script elements injected by this component
    // (React test renderer may have its own scripts from test harness, but
    // the injected content must not create a new one with our text)
    const injectedScript = Array.from(scripts).find((s) =>
      (s.textContent ?? "").includes("alert(1)"),
    );
    expect(injectedScript).toBeUndefined();
    // The text content should show the literal characters (angle brackets visible as text)
    expect(document.body.textContent).toContain("script");
  });
});

// ---------------------------------------------------------------------------
// 7. Long content renders without errors
// ---------------------------------------------------------------------------
describe("SafeMarkdown — long content", () => {
  it("renders 50 paragraphs without errors", () => {
    const source = Array.from({ length: 50 }, (_, k) => "Paragraph " + String(k + 1) + ".").join(
      "\n\n",
    );
    expect(() => render(<SafeMarkdown source={source} />)).not.toThrow();
    // Spot-check: first and last paragraph text is present
    expect(document.body.textContent).toContain("Paragraph 1.");
    expect(document.body.textContent).toContain("Paragraph 50.");
  });
});

// ---------------------------------------------------------------------------
// 8. data: and vbscript: schemes are both rejected
// ---------------------------------------------------------------------------
describe("SafeMarkdown — scheme rejection", () => {
  it("rejects data: scheme link", () => {
    render(<SafeMarkdown source="[bad](data:text/html,<h1>x</h1>)" />);
    const links = document.querySelectorAll("a");
    expect(links).toHaveLength(0);
  });

  it("rejects vbscript: scheme link", () => {
    render(<SafeMarkdown source="[bad](vbscript:msgbox(1))" />);
    const links = document.querySelectorAll("a");
    expect(links).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 9. Table renders with <table> <thead> <tbody>
// ---------------------------------------------------------------------------
describe("SafeMarkdown — table", () => {
  it("renders with correct table structure", () => {
    const src = ["| Name | Age |", "| --- | --- |", "| Alice | 30 |"].join("\n");
    render(<SafeMarkdown source={src} />);
    expect(document.querySelector("table")).not.toBeNull();
    expect(document.querySelector("thead")).not.toBeNull();
    expect(document.querySelector("tbody")).not.toBeNull();
    expect(document.body.textContent).toContain("Alice");
    expect(document.body.textContent).toContain("30");
  });
});

// ---------------------------------------------------------------------------
// SM-1 — per-message error boundary. A render/parse defect in one assistant
// message must degrade THAT message to plain text, not crash the conversation.
// We make the parser throw for a sentinel source and assert SafeMarkdownBoundary
// renders the raw source as plain text (React-escaped, no dangerouslySetInnerHTML)
// instead of propagating the error. Reverting the boundary makes render() throw.
// ---------------------------------------------------------------------------
describe("SafeMarkdownBoundary — SM-1 plain-text fallback", () => {
  it("renders the raw source as a plain-text fallback when the renderer throws", async () => {
    vi.resetModules();
    const THROWING_SOURCE = "::sm-boundary-throws::";
    vi.doMock("@/lib/safe-markdown", async () => {
      const actual =
        await vi.importActual<typeof import("@/lib/safe-markdown")>("@/lib/safe-markdown");
      return {
        ...actual,
        parseSafeMarkdown: (source: string) => {
          if (source === THROWING_SOURCE) {
            throw new Error("forced parser defect");
          }
          return actual.parseSafeMarkdown(source);
        },
      };
    });

    const { SafeMarkdownBoundary } = await import("./SafeMarkdown");
    // Silence React's expected error-boundary console noise for this render.
    const onError = (event: ErrorEvent): void => {
      const message = event.error instanceof Error ? event.error.message : event.message;
      if (message.includes("forced parser defect")) event.preventDefault();
    };
    window.addEventListener("error", onError);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      render(<SafeMarkdownBoundary source={THROWING_SOURCE} />);

      const fallback = document.querySelector('[data-markdown-fallback="true"]');
      expect(fallback).not.toBeNull();
      expect(fallback?.textContent).toBe(THROWING_SOURCE);
    } finally {
      errorSpy.mockRestore();
      window.removeEventListener("error", onError);
      vi.doUnmock("@/lib/safe-markdown");
      vi.resetModules();
    }
  });

  it("renders parsed markdown normally when the renderer does not throw", async () => {
    const { SafeMarkdownBoundary } = await import("./SafeMarkdown");
    render(<SafeMarkdownBoundary source="# Boundary Heading" />);
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Boundary Heading");
    expect(document.querySelector('[data-markdown-fallback="true"]')).toBeNull();
  });
});
