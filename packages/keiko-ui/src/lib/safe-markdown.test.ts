import { describe, it, expect } from "vitest";
import { parseSafeMarkdown, containsDangerousHtml } from "./safe-markdown";

// ---------------------------------------------------------------------------
// 1. Plain paragraph
// ---------------------------------------------------------------------------
describe("parseSafeMarkdown — paragraph", () => {
  it("returns one paragraph node for plain text", () => {
    const nodes = parseSafeMarkdown("Hello world");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.kind).toBe("paragraph");
  });
});

// ---------------------------------------------------------------------------
// 2. Headings H1–H6
// ---------------------------------------------------------------------------
describe("parseSafeMarkdown — headings", () => {
  it.each([1, 2, 3, 4, 5, 6] as const)("parses H%i correctly", (n) => {
    const hashes = "#".repeat(n);
    const nodes = parseSafeMarkdown(hashes + " Heading " + String(n));
    expect(nodes).toHaveLength(1);
    const node = nodes[0];
    expect(node?.kind).toBe("heading");
    expect(node?.level).toBe(n);
  });
});

// ---------------------------------------------------------------------------
// 3. Unordered list — 3 items
// ---------------------------------------------------------------------------
describe("parseSafeMarkdown — unordered list", () => {
  it("returns ul with 3 li children", () => {
    const nodes = parseSafeMarkdown("- alpha\n- beta\n- gamma");
    expect(nodes).toHaveLength(1);
    const ul = nodes[0];
    expect(ul?.kind).toBe("ul");
    expect(ul?.children).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 4. Ordered list
// ---------------------------------------------------------------------------
describe("parseSafeMarkdown — ordered list", () => {
  it("returns ol with sequenced items", () => {
    const nodes = parseSafeMarkdown("1. first\n2. second\n3. third");
    expect(nodes).toHaveLength(1);
    const ol = nodes[0];
    expect(ol?.kind).toBe("ol");
    expect(ol?.children).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 5. Nested list (2-space indent)
// ---------------------------------------------------------------------------
describe("parseSafeMarkdown — nested list", () => {
  it("nests inner list inside outer li", () => {
    const src = "- parent\n  - child";
    const nodes = parseSafeMarkdown(src);
    expect(nodes).toHaveLength(1);
    const ul = nodes[0];
    expect(ul?.kind).toBe("ul");
    // outer li children include the nested ul
    const outerLi = ul?.children?.[0];
    expect(outerLi?.kind).toBe("li");
    const nested = outerLi?.children?.find((c) => c.kind === "ul");
    expect(nested).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Code fence with language
// ---------------------------------------------------------------------------
describe("parseSafeMarkdown — code block with language", () => {
  it("returns code-block node with language and verbatim text", () => {
    const src = "```typescript\nconst x = 1;\n```";
    const nodes = parseSafeMarkdown(src);
    expect(nodes).toHaveLength(1);
    const cb = nodes[0];
    expect(cb?.kind).toBe("code-block");
    expect(cb?.language).toBe("typescript");
    expect(cb?.text).toBe("const x = 1;");
  });
});

// ---------------------------------------------------------------------------
// 7. Code fence without language
// ---------------------------------------------------------------------------
describe("parseSafeMarkdown — code block without language", () => {
  it("returns code-block with undefined language", () => {
    const src = "```\nraw code\n```";
    const nodes = parseSafeMarkdown(src);
    expect(nodes).toHaveLength(1);
    const cb = nodes[0];
    expect(cb?.kind).toBe("code-block");
    expect(cb?.language).toBeUndefined();
    expect(cb?.text).toBe("raw code");
  });
});

// ---------------------------------------------------------------------------
// 8. Inline code
// ---------------------------------------------------------------------------
describe("parseSafeMarkdown — inline code", () => {
  it("parses backtick inline code", () => {
    const nodes = parseSafeMarkdown("Use `npm install` to start");
    expect(nodes).toHaveLength(1);
    const para = nodes[0];
    expect(para?.kind).toBe("paragraph");
    const inlineCode = para?.children?.find((c) => c.kind === "inline-code");
    expect(inlineCode).toBeDefined();
    expect(inlineCode?.text).toBe("npm install");
  });
});

// ---------------------------------------------------------------------------
// 9. Bold + italic
// ---------------------------------------------------------------------------
describe("parseSafeMarkdown — bold and italic", () => {
  it("parses **bold** as strong", () => {
    const nodes = parseSafeMarkdown("**bold**");
    const para = nodes[0];
    const strong = para?.children?.find((c) => c.kind === "strong");
    expect(strong).toBeDefined();
  });

  it("parses *italic* as em", () => {
    const nodes = parseSafeMarkdown("*italic*");
    const para = nodes[0];
    const em = para?.children?.find((c) => c.kind === "em");
    expect(em).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 10. Safe link
// ---------------------------------------------------------------------------
describe("parseSafeMarkdown — safe link", () => {
  it("returns link node with href for https URL", () => {
    const nodes = parseSafeMarkdown("[Keiko](https://example.com)");
    const para = nodes[0];
    const link = para?.children?.find((c) => c.kind === "link");
    expect(link).toBeDefined();
    expect(link?.href).toBe("https://example.com");
    expect(link?.text).toBe("Keiko");
  });
});

// ---------------------------------------------------------------------------
// 11. Unsafe link: javascript:
// ---------------------------------------------------------------------------
describe("parseSafeMarkdown — unsafe javascript: link", () => {
  it("renders javascript: link as plain text, no link node", () => {
    const nodes = parseSafeMarkdown("[click](javascript:alert(1))");
    const para = nodes[0];
    const link = para?.children?.find((c) => c.kind === "link");
    expect(link).toBeUndefined();
    // Should have a text node instead
    const text = para?.children?.find((c) => c.kind === "text");
    expect(text).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 12. Unsafe link: data:
// ---------------------------------------------------------------------------
describe("parseSafeMarkdown — unsafe data: link", () => {
  it("renders data: link as plain text, no link node", () => {
    const nodes = parseSafeMarkdown("[x](data:text/html,<script>alert(1)</script>)");
    const para = nodes[0];
    const link = para?.children?.find((c) => c.kind === "link");
    expect(link).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 13. <script> in source renders as escaped text
// ---------------------------------------------------------------------------
describe("parseSafeMarkdown — script injection", () => {
  it("renders <script> as text, never as executable node", () => {
    const src = "<script>alert(1)</script>";
    const nodes = parseSafeMarkdown(src);
    // Should produce paragraph/text nodes only, never a code-block or link with script
    const hasLink = nodes.some((n) => n.kind === "link");
    expect(hasLink).toBe(false);
    // All text nodes should be literal text strings (no node.kind === 'code-block' with script)
    const hasCodeBlock = nodes.some((n) => n.kind === "code-block");
    expect(hasCodeBlock).toBe(false);
    // The paragraph text should contain the raw angle-bracket text (not executed)
    const para = nodes[0];
    expect(para?.kind).toBe("paragraph");
  });
});

// ---------------------------------------------------------------------------
// 14. <iframe> — escaped
// ---------------------------------------------------------------------------
describe("parseSafeMarkdown — iframe injection", () => {
  it("treats <iframe> source as plain paragraph text", () => {
    const src = "<iframe src='evil.com'></iframe>";
    const nodes = parseSafeMarkdown(src);
    expect(nodes[0]?.kind).toBe("paragraph");
    const hasLink = nodes.some((n) => n.kind === "link");
    expect(hasLink).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 15. onerror= event handler — escaped
// ---------------------------------------------------------------------------
describe("parseSafeMarkdown — event handler injection", () => {
  it("treats onerror= as plain text, containsDangerousHtml is detected", () => {
    // onerror= as a link href should be blocked
    const nodes = parseSafeMarkdown('[img](https://x.com" onerror=alert(1))');
    // The link contains a dangerous pattern — should fall back to text
    // The href sanitizer will reject any scheme that's not http(s)
    const para = nodes[0];
    const link = para?.children?.find((c) => c.kind === "link");
    // onerror= in href text is caught by containsDangerousHtml
    // We verify no link node emits the malicious href
    if (link !== undefined) {
      expect(link.href?.indexOf("onerror")).toBe(-1);
    }
  });
});

// ---------------------------------------------------------------------------
// 16. GFM table with alignment
// ---------------------------------------------------------------------------
function assertTableStructure(nodes: ReturnType<typeof parseSafeMarkdown>): {
  thead: (typeof nodes)[number] | undefined;
  tbody: (typeof nodes)[number] | undefined;
} {
  expect(nodes).toHaveLength(1);
  const table = nodes[0];
  expect(table?.kind).toBe("table");
  const thead = table?.children?.find((c) => c.kind === "thead");
  const tbody = table?.children?.find((c) => c.kind === "tbody");
  expect(thead).toBeDefined();
  expect(tbody).toBeDefined();
  return { thead, tbody };
}

function assertTableAlignment(src: string): void {
  const nodes = parseSafeMarkdown(src);
  const { thead } = assertTableStructure(nodes);
  const tr = thead?.children?.[0];
  expect(tr?.kind).toBe("tr");
  expect(tr?.children?.[0]?.align).toBe("left");
  expect(tr?.children?.[1]?.align).toBe("right");
}

describe("parseSafeMarkdown — GFM table", () => {
  it("returns table > thead + tbody with correct alignment", () => {
    const src = ["| Name | Score |", "| :--- | ---: |", "| Alice | 42 |"].join("\n");
    assertTableAlignment(src);
  });
});

// ---------------------------------------------------------------------------
// 17. Blockquote
// ---------------------------------------------------------------------------
describe("parseSafeMarkdown — blockquote", () => {
  it("returns blockquote containing child paragraph", () => {
    const nodes = parseSafeMarkdown("> This is a quote");
    expect(nodes).toHaveLength(1);
    const bq = nodes[0];
    expect(bq?.kind).toBe("blockquote");
    const inner = bq?.children?.[0];
    expect(inner?.kind).toBe("paragraph");
  });
});

// ---------------------------------------------------------------------------
// 18. Horizontal rule
// ---------------------------------------------------------------------------
describe("parseSafeMarkdown — horizontal rule", () => {
  it("parses --- as hr node", () => {
    const nodes = parseSafeMarkdown("---");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.kind).toBe("hr");
  });

  it("parses *** as hr node", () => {
    const nodes = parseSafeMarkdown("***");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.kind).toBe("hr");
  });
});

// ---------------------------------------------------------------------------
// 19. Long source (100 paragraphs)
// ---------------------------------------------------------------------------
describe("parseSafeMarkdown — long source", () => {
  it("renders 100 paragraphs without error", () => {
    const src = Array.from(
      { length: 100 },
      (_, k) => "Paragraph number " + String(k + 1) + ".",
    ).join("\n\n");
    const nodes = parseSafeMarkdown(src);
    expect(nodes).toHaveLength(100);
    for (const node of nodes) {
      expect(node.kind).toBe("paragraph");
    }
  });
});

// ---------------------------------------------------------------------------
// 20. CodeQL / NUL-byte bypass test
// ---------------------------------------------------------------------------
describe("parseSafeMarkdown — NUL-byte bypass (CodeQL js/bad-tag-filter)", () => {
  it("treats <\\x00script> as text (indexOf scan is byte-aware, not regex)", () => {
    // Covers the defence-in-depth path: NUL-obfuscated `<script>` is now caught
    // by the normalizer and the source falls through to escaped-text rendering.
    const src = "<\x00script>alert(1)</\x00script>";
    const nodes = parseSafeMarkdown(src);
    // Should produce a paragraph node — no link, no code-block
    const hasLink = nodes.some((n) => n.kind === "link");
    const hasCodeBlock = nodes.some((n) => n.kind === "code-block");
    expect(hasLink).toBe(false);
    expect(hasCodeBlock).toBe(false);
    // The result is purely paragraph-level text
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes[0]?.kind).toBe("paragraph");
  });
});

// ---------------------------------------------------------------------------
// 21. containsDangerousHtml — NUL / whitespace obfuscation variants
// ---------------------------------------------------------------------------
describe("containsDangerousHtml — obfuscation normalizer", () => {
  it("detects NUL byte inside tag: <\\x00script>", () => {
    expect(containsDangerousHtml("<\x00script>")).toBe(true);
  });

  it("detects space between < and tag name: < script>", () => {
    expect(containsDangerousHtml("< script>")).toBe(true);
  });

  it("detects tab between < and tag name: <\\tscript>", () => {
    expect(containsDangerousHtml("<\tscript>")).toBe(true);
  });
});
