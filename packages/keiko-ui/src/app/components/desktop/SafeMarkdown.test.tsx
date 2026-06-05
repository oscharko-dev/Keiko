import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SafeMarkdown } from "./SafeMarkdown";

// ---------------------------------------------------------------------------
// 1. Heading renders as h1
// ---------------------------------------------------------------------------
describe("SafeMarkdown — heading", () => {
  it("renders # Heading as <h1> with correct text", () => {
    render(<SafeMarkdown source="# Hello World" />);
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1).toBeDefined();
    expect(h1.textContent).toBe("Hello World");
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

    // Restore original descriptor
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
    const link = screen.getByRole("link", { name: "Docs" });
    expect(link).toBeDefined();
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("href")).toBe("https://docs.example.com");
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
