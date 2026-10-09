import { afterEach, describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SafeMarkdown } from "./SafeMarkdown";
import { setClientDiagnosticWriter, resetClientDiagnosticWriter } from "@/lib/client-diagnostics";
import type { CitationPreviewController } from "./hooks/usePdfCitationPreview";
import type { LocalKnowledgeEvidenceCitation } from "@/lib/types";

describe("prose evidence links", () => {
  it.each([
    ["src/cited.ts", "cited", "Cited evidence"],
    ["src/read.ts", "read-uncited", "Read, not cited"],
    ["src/unread.ts", "unread", "Not read"],
  ])("distinguishes %s with a title, class and accessible name", (path, state, label) => {
    const writer = vi.fn();
    setClientDiagnosticWriter(writer);
    const openReference = vi.fn(() => ({ ok: true as const, windowId: "file" }));
    render(
      <SafeMarkdown
        source={`Inspect ${path}.`}
        repositoryRoots={[{ root: "/repo", label: "repo" }]}
        openRepositoryReference={openReference}
        repositoryEvidence={{
          citations: [
            { scopePath: "src/cited.ts", stableId: "atom", score: 1, lineRange: undefined },
          ],
          readPaths: ["src/read.ts"],
        }}
      />,
    );
    const link = screen.getByRole("button", { name: new RegExp(label) });
    expect(link).toHaveAttribute("data-evidence-state", state);
    expect(link).toHaveAttribute("title", expect.stringContaining(label));
    expect(link.className).toContain(state === "read-uncited" ? "readUncited" : state);
    expect({
      state: link.dataset["evidenceState"],
      title: link.title,
      accessibleName: link.getAttribute("aria-label"),
    }).toMatchSnapshot();
    fireEvent.click(link);
    expect(openReference).toHaveBeenCalledWith({ root: "/repo", path });
    expect(writer).toHaveBeenCalledWith(
      "[keiko] citation activation settled",
      expect.objectContaining({
        citationActivation: { reason: "absent", outcome: "opened", rootCount: 1, matchCount: 0 },
      }),
    );
  });
});

const PDF_CITATION: LocalKnowledgeEvidenceCitation = {
  stableId: "lk-1",
  marker: "[1]",
  label: "policy.pdf",
  score: 0.91,
  lineage: {
    capsuleId: "cap-1" as LocalKnowledgeEvidenceCitation["lineage"]["capsuleId"],
    sourceId: "src-1" as LocalKnowledgeEvidenceCitation["lineage"]["sourceId"],
    documentId: "doc-1" as LocalKnowledgeEvidenceCitation["lineage"]["documentId"],
    chunkId: "chunk-1" as LocalKnowledgeEvidenceCitation["lineage"]["chunkId"],
  },
};

function citationPreviewController(
  state: "available" | "recoverable" | "blocked" | undefined,
): CitationPreviewController {
  const openCitation = vi.fn<() => Promise<string | null>>().mockResolvedValue("pdf-window-1");
  return {
    forCitation: vi.fn(() => (state === undefined ? undefined : { citation: PDF_CITATION, state })),
    forMarker: vi.fn((marker) =>
      marker === "[1]" && state !== undefined ? { citation: PDF_CITATION, state } : undefined,
    ),
    isOpening: vi.fn(() => false),
    openCitation,
  };
}

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
    expect(screen.queryByRole("button", { name: "Apply to editor" })).toBeNull();
  });

  it("renders highlighted token spans and non-selectable line numbers", () => {
    render(<SafeMarkdown source={"```typescript\nconst answer = 42;\n```"} />);

    expect(document.querySelector(".hl-key")?.textContent).toBe("const");
    expect(document.querySelector(".hl-num")?.textContent).toBe("42");
    expect(document.querySelector(".sm-code-line-no")?.textContent).toBe("1");
    expect(document.querySelector(".sm-code-line-src")?.textContent).toContain("answer");
  });

  it("keeps code operators literal for rendering and copy", async () => {
    const source = "const f = (x) => x !== null ? x => x : x;";
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<SafeMarkdown source={`\`\`\`typescript\n${source}\n\`\`\``} />);

    expect(document.querySelector(".sm-code-line-src")?.textContent).toBe(source);
    fireEvent.click(screen.getByRole("button", { name: "Copy code block" }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(source);
    });

    if (clipboardDescriptor !== undefined) {
      Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    }
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

describe("SafeMarkdown — manual code actions", () => {
  it("keeps canonical code and diff fences copyable without an editor action", () => {
    render(<SafeMarkdown source={"```ts\nconst answer = 42;\n```\n\n```diff\n-old\n+new\n```"} />);
    const headers = document.querySelectorAll<HTMLElement>(".sm-code-block-header");
    expect(headers).toHaveLength(2);
    for (const header of headers) {
      expect(within(header).getByRole("button", { name: "Copy code block" })).toBeInTheDocument();
      expect(within(header).queryByRole("button", { name: "Apply to editor" })).toBeNull();
    }
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
  it("opens a native model's non-breaking-hyphen range at the exact cited lines", () => {
    const openReference = vi.fn(() => ({ ok: true as const, windowId: "editor-unicode-range" }));
    render(
      <SafeMarkdown
        source={"Price [src/domain/shipping.ts:1\u20116]."}
        repositoryRoots={[{ root: "/repo", label: "Fixture" }]}
        openRepositoryReference={openReference}
      />,
    );
    const reference = screen.getByRole("button", {
      name: "Open src/domain/shipping.ts at lines 1-6 in editor",
    });
    fireEvent.click(reference);
    expect(openReference).toHaveBeenCalledWith({
      root: "/repo",
      path: "src/domain/shipping.ts",
      lineStart: 1,
      lineEnd: 6,
    });
  });
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

  it("disambiguates all 96 same-basename references across Markdown table cells", () => {
    const paths = Array.from(
      { length: 96 },
      (_, index) =>
        `packages/entry-${String(index + 1).padStart(3, "0")}/src/LateDefinitionProbe.ts`,
    );
    const source =
      "| Source |\n| --- |\n" + paths.map((path) => `| [${path}:301-302] |`).join("\n");
    const openReference = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    render(
      <SafeMarkdown
        source={source}
        repositoryRoots={[{ root: "/repo", label: "Keiko" }]}
        openRepositoryReference={openReference}
      />,
    );
    const references = screen.getAllByRole("button", { name: /^Open / });
    expect(references.map((button) => button.textContent)).toEqual(
      paths.map((path) => `${path.split("/").slice(-3).join("/")}:301-302`),
    );
    const last = references[95];
    if (last === undefined) throw new Error("last citation missing");
    fireEvent.click(last);
    expect(openReference).toHaveBeenCalledWith({
      root: "/repo",
      path: paths[95],
      lineStart: 301,
      lineEnd: 302,
    });
  });

  it("uses one path set across prose and inline code without lengthening repeated file references", () => {
    render(
      <SafeMarkdown
        source="[alpha/src/foo.ts:1] and `beta/src/foo.ts:2`, then [alpha/src/foo.ts:3]."
        repositoryRoots={[{ root: "/repo", label: "Keiko" }]}
        openRepositoryReference={() => ({ ok: true, windowId: "editor-1" })}
      />,
    );
    expect(
      screen.getAllByRole("button", { name: /^Open / }).map((button) => button.textContent),
    ).toEqual(["alpha/src/foo.ts:1", "beta/src/foo.ts:2", "alpha/src/foo.ts:3"]);
  });

  it.each([
    "src/überprüfung/status.ts",
    "src/u\u0308berpru\u0308fung/status.ts",
    "Handbücher/Service Anleitung.html",
    "Handbücher/Service  Anleitung.html",
    "Handbücher/🔧.html",
  ])("opens the exact complete citation path %s", (path) => {
    const openReference = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    render(
      <SafeMarkdown
        source={`Grüße [${path}:1-2].`}
        repositoryRoots={[{ root: "/repo", label: "Manuals" }]}
        openRepositoryReference={openReference}
      />,
    );
    const reference = screen.getByRole("button", {
      name: `Open ${path.replace(/ +/gu, " ")} at lines 1-2 in editor`,
    });
    expect(reference).toHaveAttribute("aria-label", `Open ${path} at lines 1-2 in editor`);
    fireEvent.click(reference);
    expect(openReference).toHaveBeenCalledWith({ root: "/repo", path, lineStart: 1, lineEnd: 2 });
    expect(screen.getAllByRole("button", { name: /^Open / })).toHaveLength(1);
    expect(document.body.textContent).not.toContain("[src/überprü");
  });

  it.each([
    "/private/status.ts",
    "../private/status.ts",
    "src/\u0001private/status.ts",
    "src/\u202eprivate/status.ts",
    "src/\t\tprivate/status.ts",
    "src/\nprivate/status.ts",
  ])("keeps an invalid citation path as text without clickable suffixes: %s", (path) => {
    const openReference = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    render(
      <SafeMarkdown
        source={`Evidence [${path}:1-2].`}
        repositoryRoots={[{ root: "/repo", label: "Manuals" }]}
        openRepositoryReference={openReference}
      />,
    );
    expect(screen.queryByRole("button", { name: /^Open / })).toBeNull();
    expect(openReference).not.toHaveBeenCalled();
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
    expect(reference).toHaveTextContent("context.ts");
    expect(reference).toHaveAttribute("title", "packages/keiko-harness/src/context.ts");
    expect(document.querySelector(".sm-p")?.textContent).toBe("Review context.ts.");
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
    expect(document.body.textContent).toContain("Assertion context.ts:49-58.");
  });

  it("renders repository-looking text as a health-checked reference when no repository root is connected", () => {
    const openReference = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    render(
      <SafeMarkdown
        source="See packages/keiko-harness/src/context.ts:50."
        openRepositoryReference={openReference}
      />,
    );

    const reference = screen.getByRole("button", {
      name: "Open packages/keiko-harness/src/context.ts at line 50 in editor",
    });
    expect(reference).toHaveTextContent("context.ts:50");
    fireEvent.click(reference);
    expect(
      screen.getByText("Connect a Files window to open repository references."),
    ).toHaveAttribute("role", "alert");
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

  it("keeps hostile partial and completed streamed links inert across rerenders", () => {
    const { container, rerender } = render(<SafeMarkdown source="[portal](java" />);
    rerender(<SafeMarkdown source={'<svg onload="pwned()">[portal](javascript:alert(1))</svg>'} />);

    expect(container.querySelector("a, svg, script, [onload]")).toBeNull();

    rerender(<SafeMarkdown source="[portal](https://example.com)" />);
    const link = screen.getByRole("link", { name: /portal/u });
    expect(link).toHaveAttribute("href", "https://example.com");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
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

describe("SafeMarkdown — PDF citation markers", () => {
  it("opens an inline marker only through a structured citation affordance", () => {
    const citationPreview = citationPreviewController("available");
    render(<SafeMarkdown source="See [1] and [2]." citationPreview={citationPreview} />);

    fireEvent.click(screen.getByRole("button", { name: "Open PDF preview for citation [1]" }));

    expect(citationPreview.openCitation).toHaveBeenCalledWith(PDF_CITATION, "inline-marker");
    expect(screen.queryByRole("button", { name: "Open PDF preview for citation [2]" })).toBeNull();
    expect(document.body.textContent).toContain("[2]");
  });

  it("keeps rendered citation-looking text plain when structured metadata is absent", () => {
    const citationPreview = citationPreviewController(undefined);
    render(
      <SafeMarkdown source="A markdown answer mentions [1]." citationPreview={citationPreview} />,
    );

    expect(screen.queryByRole("button", { name: /PDF preview/ })).toBeNull();
    expect(document.body.textContent).toContain("[1]");
    expect(citationPreview.openCitation).not.toHaveBeenCalled();
  });

  it("renders recoverable inline markers with a recovery affordance", () => {
    const citationPreview = citationPreviewController("recoverable");
    render(<SafeMarkdown source="See [1]." citationPreview={citationPreview} />);

    const marker = screen.getByRole("button", { name: "Open PDF recovery for citation [1]" });
    expect(marker).toHaveAttribute("data-tip", "Open PDF recovery");
    expect(marker).not.toHaveAttribute("aria-disabled");

    fireEvent.click(marker);

    expect(citationPreview.openCitation).toHaveBeenCalledWith(PDF_CITATION, "inline-marker");
  });

  it("renders blocked inline markers as non-activatable explained affordances", () => {
    const citationPreview = citationPreviewController("blocked");
    render(<SafeMarkdown source="See [1]." citationPreview={citationPreview} />);

    const marker = screen.getByRole("button", {
      name: "Citation [1]. PDF preview unavailable.",
    });
    expect(marker).toHaveAttribute("aria-disabled", "true");
    expect(marker).toHaveAttribute("data-tip", "PDF preview unavailable");

    fireEvent.click(marker);

    expect(citationPreview.openCitation).not.toHaveBeenCalled();
  });
});

// Models cite with grouped markers ("[1, 7, 8]"). The renderer used to match one integer per bracket
// pair, so a whole group was dead text: no link for any index in it.
describe("SafeMarkdown — grouped citation markers", () => {
  const SECOND_CITATION: LocalKnowledgeEvidenceCitation = {
    ...PDF_CITATION,
    stableId: "lk-3",
    marker: "[3]",
    label: "handbook.pdf",
  };

  function groupedPreviewController(): CitationPreviewController {
    // The real controller normalizes any bracket glyph to its index; key on the digits the same way.
    const affordances = new Map([
      ["1", { citation: PDF_CITATION, state: "available" as const }],
      ["3", { citation: SECOND_CITATION, state: "available" as const }],
    ]);
    return {
      forCitation: vi.fn(() => undefined),
      forMarker: vi.fn((marker) => affordances.get(String(marker).replace(/\D/gu, ""))),
      isOpening: vi.fn(() => false),
      openCitation: vi.fn<() => Promise<string | null>>().mockResolvedValue("pdf-window-1"),
    };
  }

  it("links every index of a grouped marker that has structured metadata", () => {
    const citationPreview = groupedPreviewController();
    render(
      <SafeMarkdown source="Java 17 wird verwendet [1, 2, 3]." citationPreview={citationPreview} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open PDF preview for citation [1]" }));
    fireEvent.click(screen.getByRole("button", { name: "Open PDF preview for citation [3]" }));

    expect(citationPreview.openCitation).toHaveBeenNthCalledWith(1, PDF_CITATION, "inline-marker");
    expect(citationPreview.openCitation).toHaveBeenNthCalledWith(
      2,
      SECOND_CITATION,
      "inline-marker",
    );
    expect(screen.queryByRole("button", { name: /citation \[2\]/ })).toBeNull();
    expect(document.body.textContent).toContain("[2]");
  });

  it("keeps a grouped marker without any linkable index exactly as written", () => {
    render(<SafeMarkdown source="Java 17 [7, 8]." citationPreview={groupedPreviewController()} />);

    expect(screen.queryByRole("button", { name: /PDF preview/ })).toBeNull();
    expect(document.body.textContent).toContain("Java 17 [7, 8].");
  });

  it("links a marker written with CJK glyphs inside a group", () => {
    const citationPreview = groupedPreviewController();
    render(<SafeMarkdown source="Siehe 【1, 3】." citationPreview={citationPreview} />);

    expect(
      screen.getByRole("button", { name: "Open PDF preview for citation 【1】" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Open PDF preview for citation 【3】" }),
    ).toBeDefined();
  });
});

describe("SafeMarkdown — streaming trailing content", () => {
  it("keeps trailing content inside plain streaming code fences", (): void => {
    render(
      <SafeMarkdown
        source={"```ts\nconst answer = 42;\n```"}
        streaming
        trailing={<span className="ai-stream-cursor" data-testid="stream-cursor" />}
      />,
    );

    const pre = document.querySelector(".sm-pre");
    expect(pre).not.toBeNull();
    expect(document.querySelector(".sm-code-block-header")).toBeNull();
    expect(pre?.textContent).toContain("const answer = 42;");
    expect(within(pre as HTMLElement).getByTestId("stream-cursor")).toBeDefined();
  });

  it("keeps trailing content inside an empty list item", (): void => {
    render(
      <SafeMarkdown
        source="- "
        trailing={<span className="ai-stream-cursor" data-testid="stream-cursor" />}
      />,
    );

    const item = document.querySelector(".sm-li");
    expect(item).not.toBeNull();
    expect(item?.textContent).toBe("");
    expect(within(item as HTMLElement).getByTestId("stream-cursor")).toBeDefined();
  });

  it("keeps trailing content inside blockquotes", (): void => {
    render(
      <SafeMarkdown
        source="> quoted"
        trailing={<span className="ai-stream-cursor" data-testid="stream-cursor" />}
      />,
    );

    const blockquote = document.querySelector(".sm-blockquote");
    expect(blockquote?.textContent).toBe("quoted");
    expect(within(blockquote as HTMLElement).getByTestId("stream-cursor")).toBeDefined();
  });

  it("keeps trailing content after horizontal rules", (): void => {
    render(
      <SafeMarkdown
        source="---"
        trailing={<span className="ai-stream-cursor" data-testid="stream-cursor" />}
      />,
    );

    expect(document.querySelector(".sm-hr")).not.toBeNull();
    expect(screen.getByTestId("stream-cursor")).toBeDefined();
  });

  it("keeps trailing content inside citation-rendered text fragments", (): void => {
    const citationPreview = citationPreviewController("available");
    render(
      <SafeMarkdown
        source="See [1]"
        citationPreview={citationPreview}
        trailing={<span className="ai-stream-cursor" data-testid="stream-cursor" />}
      />,
    );

    expect(screen.getByRole("button", { name: "Open PDF preview for citation [1]" })).toBeDefined();
    expect(screen.getByTestId("stream-cursor")).toBeDefined();
  });

  it("keeps trailing content inside emphasis text", (): void => {
    render(
      <SafeMarkdown
        source="*tail*"
        trailing={<span className="ai-stream-cursor" data-testid="stream-cursor" />}
      />,
    );

    const emphasis = document.querySelector("em");
    expect(emphasis?.textContent).toBe("tail");
    expect(within(emphasis as HTMLElement).getByTestId("stream-cursor")).toBeDefined();
  });

  it("renders trailing content for an empty markdown tree", (): void => {
    render(
      <SafeMarkdown
        source=""
        trailing={<span className="ai-stream-cursor" data-testid="stream-cursor" />}
      />,
    );

    expect(document.querySelector(".sm-root .ai-stream-cursor")).not.toBeNull();
    expect(screen.getByTestId("stream-cursor")).toBeDefined();
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

describe("SafeMarkdown — ordered list continuation", () => {
  afterEach(() => resetClientDiagnosticWriter());

  it("reports a settled continuation once without response content", () => {
    const writer = vi.fn();
    resetClientDiagnosticWriter();
    setClientDiagnosticWriter(writer);
    const source = "2. Private response";
    const { rerender } = render(<SafeMarkdown source={source} streaming />);
    expect(writer).not.toHaveBeenCalled();
    rerender(<SafeMarkdown source={source} />);
    expect(writer).toHaveBeenCalledExactlyOnceWith("markdown:ordered-list-source-start", {
      kind: "markdown-layout",
      correlationId: undefined,
      markdownLayout: { listStart: 2, listIndex: 0, depth: 0 },
    });
    rerender(<SafeMarkdown source={source} />);
    expect(writer).toHaveBeenCalledOnce();
  });
  it("records nested continuation coordinates under the rendered message identity", () => {
    const writer = vi.fn();
    resetClientDiagnosticWriter();
    setClientDiagnosticWriter(writer);
    render(
      <SafeMarkdown
        source={"1. Parent\n  7. Private child"}
        diagnosticCorrelationId="message-1234"
      />,
    );
    expect(writer).toHaveBeenCalledWith("markdown:ordered-list-source-start", {
      kind: "markdown-layout",
      correlationId: "message-1234",
      markdownLayout: { listStart: 7, listIndex: 1, depth: 2 },
    });
  });
  it("preserves list numbering across explanatory paragraphs", () => {
    render(
      <SafeMarkdown
        source={
          "1. **First**\n\nFirst explanation.\n\n2. **Second**\n\nSecond explanation.\n\n3. **Third**"
        }
      />,
    );
    expect(screen.getAllByRole("list").map((list) => list.getAttribute("start"))).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("uses only the starting marker and retains nested list starts", () => {
    render(
      <SafeMarkdown source={"3. Third\n9. Fourth\n  7. Nested seventh\n  9. Nested eighth"} />,
    );
    expect(screen.getAllByRole("list").map((list) => list.getAttribute("start"))).toEqual([
      "3",
      "7",
    ]);
  });
});

describe("SafeMarkdown spaced source table", () => {
  it("preserves ordinary table text and code boundaries without a reference opener", () => {
    const path = "文書/運転 手順.html";
    render(
      <SafeMarkdown
        source={`| Source |\n|---|\n| ${path}\u202f:\u202f182 |\n| \`${path}\`\u202f:\u202f182 |`}
      />,
    );
    const cells = screen.getAllByRole("cell");
    expect(cells[0]?.querySelector("code")).toBeNull();
    expect(cells[0]?.textContent).toBe(`${path}\u202f:\u202f182`);
    expect(cells[1]?.querySelector("code")?.textContent).toBe(path);
    expect(cells[1]?.textContent).toBe(`${path}\u202f:\u202f182`);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("preserves a CJK filename containing a space in a complete code-wrapped location", () => {
    const path = "文書/運転 手順.html";
    const opened = vi.fn(() => ({ ok: true as const, windowId: "preview" }));
    render(
      <SafeMarkdown
        source={`| Source |\n|---|\n| \`${path}\u202f:\u202f182\` |`}
        repositoryRoots={[{ root: "/synthetic/handbook", label: "Handbook" }]}
        openRepositoryReference={opened}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(opened).toHaveBeenCalledWith(
      expect.objectContaining({ path, lineStart: 182, lineEnd: 182 }),
    );
  });

  it("opens an explicitly adjacent outside-code line with its unchanged CJK path", () => {
    const path = "文書/運転 手順.html";
    const opened = vi.fn(() => ({ ok: true as const, windowId: "preview" }));
    render(
      <SafeMarkdown
        source={`| Source |\n|---|\n| \`${path}\`\u202f:\u202f182 |`}
        repositoryRoots={[{ root: "/synthetic/handbook", label: "Handbook" }]}
        openRepositoryReference={opened}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(opened).toHaveBeenCalledWith(
      expect.objectContaining({ path, lineStart: 182, lineEnd: 182 }),
    );
  });

  it("keeps an entire space-bearing path in a bare table source cell", () => {
    const path = "文書/運転 手順.html";
    const opened = vi.fn(() => ({ ok: true as const, windowId: "preview" }));
    render(
      <SafeMarkdown
        source={`| Source |\n|---|\n| ${path}\u202f:\u202f182 |`}
        repositoryRoots={[{ root: "/synthetic/handbook", label: "Handbook" }]}
        openRepositoryReference={opened}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(opened).toHaveBeenCalledWith(
      expect.objectContaining({ path, lineStart: 182, lineEnd: 182 }),
    );
  });

  it("opens the actual source line182 rather than only the bare path", () => {
    const path = "handbooks/material/service/archive/current/chapters/conveyor.html";
    const opened = vi.fn(() => ({ ok: true as const, windowId: "preview" }));
    render(
      <SafeMarkdown
        source={`| Machine | Interval | Source |\n|---|---|---|\n| Conveyor | 1193 hours | ${path}\u202f:\u202f182 |`}
        repositoryRoots={[{ root: "/synthetic/handbook", label: "Handbook" }]}
        openRepositoryReference={opened}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(opened).toHaveBeenCalledWith(
      expect.objectContaining({
        root: "/synthetic/handbook",
        path,
        lineStart: 182,
        lineEnd: 182,
      }),
    );
  });
});
