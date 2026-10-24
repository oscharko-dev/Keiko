import { render, screen, waitFor, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";

import { SAFE_MARKDOWN_MAX_MATH_CHARS } from "@/lib/safe-markdown-math";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { SafeMarkdownBoundary } from "../../SafeMarkdown";
import { CODING_WORKBENCH_RICH_CONTENT } from "./CodingWorkbenchRichContent";

const MATHML = "http://www.w3.org/1998/Math/MathML";

// Mermaid needs a layout engine jsdom does not have; the module boundary is the diagram's input.
const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn((_id: string, _text: string) =>
    Promise.resolve({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>.node{fill:#eee}</style><g class="node"><rect width="4" height="4"/><text>A</text></g></svg>',
    }),
  ),
}));
vi.mock("mermaid", () => ({ default: mermaidMock }));

function renderAnswer(source: string, streaming = false): HTMLElement {
  return render(
    <SafeMarkdownBoundary
      source={source}
      streaming={streaming}
      richContent={CODING_WORKBENCH_RICH_CONTENT}
    />,
  ).container;
}

async function typeset(container: HTMLElement): Promise<void> {
  await waitFor(() => {
    expect(container.querySelector('[data-math-state="typeset"]')).not.toBeNull();
  });
}

function hasLiveAttribute(container: HTMLElement): boolean {
  return [...container.querySelectorAll("*")].some((element) =>
    [...element.attributes].some(
      (attribute) => attribute.name.startsWith("on") || /javascript:/iu.test(attribute.value),
    ),
  );
}

describe("math in a model answer", () => {
  it("typesets inline $...$ as MathML instead of showing the notation (lab finding F3)", async () => {
    const container = renderAnswer("The next step is $\\rightarrow$ done.");
    await typeset(container);
    const math = container.querySelector("math");
    expect(math?.namespaceURI).toBe(MATHML);
    expect(math?.querySelector("mo")?.textContent).toBe("→");
    expect(container.textContent).not.toContain("$");
    expect(container.textContent).toContain("The next step is");
    expect(container.textContent).toContain("done.");
  });

  it("typesets \\( \\) inline math and keeps the TeX as an annotation", async () => {
    const container = renderAnswer("Let \\(x_1 * y_2\\) be the cost.");
    await typeset(container);
    expect(container.querySelector('annotation[encoding="application/x-tex"]')?.textContent).toBe(
      "x_1 * y_2",
    );
    expect(container.querySelector("em")).toBeNull();
  });

  it.each([["$$\n\\int_0^1 x^2\\,dx\n$$"], ["\\[\\int_0^1 x^2\\,dx\\]"]])(
    "typesets display math %j as a named block",
    async (source) => {
      const container = renderAnswer(`Area:\n${source}\nDone.`);
      await typeset(container);
      const frame = within(container).getByRole("group", { name: "Formula" });
      expect(frame).toHaveAttribute("tabindex", "0");
      expect(frame.querySelector("math")?.getAttribute("display")).toBe("block");
    },
  );

  it.each([["math"], ["latex"], ["tex"], ["katex"]])(
    "typesets a ```%s fence and drops the delimiters written around it",
    async (language) => {
      const container = renderAnswer(`\`\`\`${language}\n$$\n\\frac{a}{b}\n$$\n\`\`\``);
      await typeset(container);
      expect(container.querySelector("mfrac")).not.toBeNull();
      expect(container.querySelector('annotation[encoding="application/x-tex"]')?.textContent).toBe(
        "\\frac{a}{b}",
      );
      expect(container.querySelector("pre")).toBeNull();
    },
  );

  it("shows malformed math exactly as written, without typesetting or a red error", async () => {
    const container = renderAnswer("Broken $\\frac{1$ here and \\(\\notacommand{x}\\) there.");
    await waitFor(() => {
      expect(container.querySelectorAll('[data-math-state="verbatim"]')).toHaveLength(2);
    });
    expect(container.querySelector("math")).toBeNull();
    expect(container.querySelector(".katex-error")).toBeNull();
    expect(container.textContent).toBe("Broken $\\frac{1$ here and \\(\\notacommand{x}\\) there.");
  });

  it("keeps a malformed fence as its code view", async () => {
    const container = renderAnswer("```math\n\\frac{1\n```");
    await waitFor(() => {
      expect(container.querySelector("pre")).not.toBeNull();
    });
    // Give the lazy typesetter time to answer; the code view must still be there.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container.querySelector("math")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toContain("\\frac{1");
  });

  it("does not turn prices or shell variables into math", () => {
    const container = renderAnswer("It costs $5 and $6 total; set $HOME or $PATH.");
    expect(container.textContent).toBe("It costs $5 and $6 total; set $HOME or $PATH.");
    expect(container.querySelector("[data-math-state]")).toBeNull();
  });

  it("writes a literal dollar for an escaped one", () => {
    const container = renderAnswer("It costs \\$5.");
    expect(container.textContent).toBe("It costs $5.");
  });

  describe("hostile input", () => {
    it("escapes a script typed inside a formula", async () => {
      const container = renderAnswer("Run $<script>alert(1)</script>$ now.");
      await typeset(container);
      expect(container.querySelector("script")).toBeNull();
      expect(hasLiveAttribute(container)).toBe(false);
      expect(container.querySelector("math")?.textContent).toContain("<script>alert(1)</script>");
    });

    it.each([
      ["a javascript link", "$\\href{javascript:alert(1)}{click}$"],
      ["a url", "$\\url{javascript:alert(1)}$"],
      ["an image", "$\\includegraphics{https://example.invalid/x.png}$"],
      ["an html attribute", "$\\htmlData{onclick=alert(1)}{y}$"],
    ])("never links or loads through %s", async (_name, source) => {
      const container = renderAnswer(`Look: ${source} end`);
      await waitFor(() => {
        expect(container.querySelector('[data-math-state="verbatim"]')).not.toBeNull();
      });
      expect(container.querySelector("a")).toBeNull();
      expect(container.querySelector("img")).toBeNull();
      expect(container.querySelector("math")).toBeNull();
      expect(hasLiveAttribute(container.ownerDocument.body)).toBe(false);
      expect(container.textContent).toContain(source);
    });

    it("renders markup typed inside \\text as text", async () => {
      const container = renderAnswer("A $\\text{<img src=x onerror=alert(1)>}$ B");
      await typeset(container);
      expect(container.querySelector("img")).toBeNull();
      expect(hasLiveAttribute(container)).toBe(false);
      expect(container.querySelector("math")?.textContent).toContain(
        "<img src=x onerror=alert(1)>",
      );
    });

    it("leaves a span past the length bound as prose and a fence past it as code", async () => {
      const long = "x".repeat(SAFE_MARKDOWN_MAX_MATH_CHARS + 10);
      const container = renderAnswer(`Big $$${long}$$ and\n\n\`\`\`math\n${long}\n\`\`\``);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(container.querySelector("math")).toBeNull();
      expect(container.querySelector("[data-math-state='typeset']")).toBeNull();
      expect(container.querySelector("pre")?.textContent).toContain(long);
      expect(container.textContent).toContain(`$$${long}$$`);
    });

    it("stays responsive on a long run of unmatched delimiters", () => {
      const started = performance.now();
      const container = renderAnswer(`${"\\( ".repeat(500)}end ${"$ ".repeat(500)}`);
      expect(performance.now() - started).toBeLessThan(3000);
      expect(container.querySelector("math")).toBeNull();
    });
  });
});

describe("streaming", () => {
  it("does not typeset a formula or a fence before it is complete", async () => {
    const { container, rerender } = render(
      <SafeMarkdownBoundary
        source={"Compute $x^2 + "}
        streaming
        richContent={CODING_WORKBENCH_RICH_CONTENT}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(container.querySelector("[data-math-state]")).toBeNull();
    expect(container.textContent).toBe("Compute $x^2 + ");

    rerender(
      <SafeMarkdownBoundary
        source={"Compute $x^2 + 1$.\n\n```math\n\\frac{a}"}
        streaming
        richContent={CODING_WORKBENCH_RICH_CONTENT}
      />,
    );
    await typeset(container);
    // The inline formula is complete; the fence is still open and keeps its plain code view.
    expect(container.querySelectorAll("math")).toHaveLength(1);
    expect(container.querySelector("pre")?.textContent).toContain("\\frac{a}");
    expect(container.querySelector(".sm-code-block-header")).toBeNull();

    rerender(
      <SafeMarkdownBoundary
        source={"Compute $x^2 + 1$.\n\n```math\n\\frac{a}{b}\n```"}
        streaming
        richContent={CODING_WORKBENCH_RICH_CONTENT}
      />,
    );
    await waitFor(() => {
      expect(container.querySelectorAll("math")).toHaveLength(2);
    });
    expect(container.querySelector("pre")).toBeNull();
  });

  it("does not typeset a complete formula again for every further token", async () => {
    const katex = await import("katex");
    const spy = vi.spyOn(katex.default, "renderToString");
    const { container, rerender } = render(
      <SafeMarkdownBoundary
        source={"Done $x^2$ so"}
        streaming
        richContent={CODING_WORKBENCH_RICH_CONTENT}
      />,
    );
    await typeset(container);
    const calls = spy.mock.calls.length;
    for (const tail of [" so far", " so far and", " so far and more", " so far and more text"]) {
      rerender(
        <SafeMarkdownBoundary
          source={`Done $x^2$${tail}`}
          streaming
          richContent={CODING_WORKBENCH_RICH_CONTENT}
        />,
      );
    }
    expect(container.textContent).toContain("so far and more text");
    expect(spy.mock.calls).toHaveLength(calls);
    spy.mockRestore();
  });
});

describe("diffs in a model answer", () => {
  const GIT_DIFF = [
    "```diff",
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,3 @@",
    " keep",
    "-const old = 1;",
    "+const next = 2;",
    " tail",
    "```",
  ].join("\n");

  it("renders added and removed lines with the Changes panel's own diff classes", () => {
    const container = renderAnswer(GIT_DIFF);
    const region = screen.getByRole("region", { name: "Diff shown in the model answer" });
    expect(region.className).toContain("review");
    expect(region.querySelector(".rv-line.rv-add .rv-src")?.textContent).toBe("const next = 2;");
    expect(region.querySelector(".rv-line.rv-del .rv-src")?.textContent).toBe("const old = 1;");
    expect(region.querySelector(".rv-path")?.textContent).toBe("src/a.ts");
    expect(region.querySelector(".rv-stat.add")?.textContent).toBe("+1");
    expect(region.querySelector(".rv-stat.del")?.textContent).toBe("−1");
    // A sign column besides colour, and a screen-reader label per line.
    expect(region.querySelector(".rv-add .rv-gutter")?.textContent).toBe("+");
    expect(within(region).getByText("Added line")).toBeInTheDocument();
    expect(container.querySelector("pre")).toBeNull();
  });

  it("renders the diff of every file in the fence", () => {
    const second = ["--- a/b.ts", "+++ b/b.ts", "@@ -1 +1 @@", "-x", "+y"].join("\n");
    renderAnswer(`\`\`\`patch\n${GIT_DIFF.split("\n").slice(1, -1).join("\n")}\n${second}\n\`\`\``);
    expect(document.querySelectorAll(".rv-file")).toHaveLength(2);
  });

  it("names a diff that has hunks but no file header", () => {
    renderAnswer("```diff\n@@ -1 +1 @@\n-a\n+b\n```");
    expect(document.querySelector(".rv-path")?.textContent).toBe("Diff");
    expect(document.body.textContent).not.toContain("(unknown)");
  });

  it("styles a bare -old/+new diff without any header", () => {
    renderAnswer("```diff\n context\n-removed\n+added\n```");
    expect(document.querySelectorAll(".rv-line.rv-del")).toHaveLength(1);
    expect(document.querySelectorAll(".rv-line.rv-add")).toHaveLength(1);
    expect(document.querySelector(".rv-add .rv-src")?.textContent).toBe("added");
    expect(document.querySelector(".rv-path")?.textContent).toBe("Diff");
  });

  it("keeps the code view for a fence that is not a diff", () => {
    const container = renderAnswer("```diff\njust a note\nwith two lines\n```");
    expect(container.querySelector(".rv-line")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toContain("just a note");
  });

  it("keeps the code view for headers that carry no hunk", () => {
    const container = renderAnswer(
      "```diff\ndiff --git a/a.ts b/a.ts\nold mode 100644\nnew mode 100755\n```",
    );
    expect(container.querySelector(".rv-line")).toBeNull();
    expect(container.querySelector("pre")).not.toBeNull();
  });

  it("escapes markup inside the diff text", () => {
    const container = renderAnswer(
      "```diff\n-<script>alert(1)</script>\n+<img src=x onerror=alert(1)>\n```",
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(hasLiveAttribute(container)).toBe(false);
    expect(container.querySelector(".rv-add .rv-src")?.textContent).toBe(
      "<img src=x onerror=alert(1)>",
    );
  });

  it("keeps an unfinished fence as plain streamed code and styles it once it closes", () => {
    const { container, rerender } = render(
      <SafeMarkdownBoundary
        source={"```diff\n-a\n+b"}
        streaming
        richContent={CODING_WORKBENCH_RICH_CONTENT}
      />,
    );
    expect(container.querySelector(".rv-line")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toContain("+b");
    rerender(
      <SafeMarkdownBoundary
        source={"```diff\n-a\n+b\n```"}
        streaming
        richContent={CODING_WORKBENCH_RICH_CONTENT}
      />,
    );
    expect(container.querySelectorAll(".rv-line.rv-add")).toHaveLength(1);
    expect(container.querySelector("pre")).toBeNull();
  });

  it("gives two diffs in one answer distinct element ids", () => {
    renderAnswer(`${GIT_DIFF}\n\nAnd again:\n\n${GIT_DIFF}`);
    const ids = [...document.querySelectorAll("section[id]")].map((element) => element.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("truncates a very long bare diff and says so", () => {
    const lines = Array.from({ length: 2500 }, (_, index) => `+line ${String(index)}`);
    renderAnswer(`\`\`\`diff\n${lines.join("\n")}\n\`\`\``);
    expect(document.querySelectorAll(".rv-line.rv-add")).toHaveLength(2000);
    expect(document.querySelector(".rv-truncated")).not.toBeNull();
  });
});

describe("Mermaid fences", () => {
  async function drawn(container: HTMLElement): Promise<HTMLElement> {
    await waitFor(() => {
      expect(container.querySelector('[data-diagram-state="drawn"]')).not.toBeNull();
    });
    return container.querySelector('[data-diagram-state="drawn"]') as HTMLElement;
  }

  async function verbatim(container: HTMLElement): Promise<HTMLElement> {
    await waitFor(() => {
      expect(container.querySelector('[data-diagram-state="verbatim"]')).not.toBeNull();
    });
    return container.querySelector('[data-diagram-state="verbatim"]') as HTMLElement;
  }

  it("draws a diagram as checked SVG inside a shadow root, as a named image", async () => {
    const container = renderAnswer("```mermaid\ngraph TD\n  A-->B\n```");
    const host = await drawn(container);

    expect(host).toHaveAttribute("role", "img");
    expect(host).toHaveAccessibleName("Diagram");
    expect(host.shadowRoot?.querySelector("svg rect")).not.toBeNull();
    // The diagram's stylesheet lives in the shadow root, never in the page.
    expect(container.querySelector("style")).toBeNull();
    expect(mermaidMock.render).toHaveBeenLastCalledWith(
      expect.stringMatching(/^keiko-diagram-\d+$/u),
      "graph TD\n  A-->B",
    );
    expect(mermaidMock.initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({
        securityLevel: "strict",
        htmlLabels: false,
        flowchart: { htmlLabels: false },
        secure: expect.arrayContaining(["themeCSS", "themeVariables", "htmlLabels", "theme"]),
      }),
    );
  });

  it("shows the source under its caption when Mermaid cannot draw the diagram", async () => {
    mermaidMock.render.mockRejectedValueOnce(new Error("Parse error on line 2"));
    const container = renderAnswer("```mermaid\ngraph TD\n  A-->\n```");
    const figure = await verbatim(container);

    expect(within(figure).getByText("Diagram source")).toBeInTheDocument();
    expect(figure.textContent).toContain("could not be drawn");
    expect(figure.querySelector("pre")?.textContent).toContain("graph TD");
  });

  it.each([
    ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ['<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>x</div></foreignObject></svg>'],
    ['<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><g/></svg>'],
    [
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="https://example.invalid"><text>x</text></a></svg>',
    ],
    ['<svg xmlns="http://www.w3.org/2000/svg"><use href="#x"/></svg>'],
    [
      '<svg xmlns="http://www.w3.org/2000/svg"><style>.n{background:url(https://example.invalid)}</style></svg>',
    ],
    ['<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(javascript:alert(1))"/></svg>'],
    ['<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,AA=="/></svg>'],
    ["<div>not svg</div>"],
  ])("shows the source instead of anything beyond plain SVG: %s", async (svg) => {
    mermaidMock.render.mockResolvedValueOnce({ svg });
    const container = renderAnswer("```mermaid\ngraph TD\n  A-->B\n```");
    await verbatim(container);

    expect(container.querySelector('[data-diagram-state="drawn"]')).toBeNull();
    expect(hasLiveAttribute(container)).toBe(false);
    expect(container.querySelector("script, foreignObject, image, use")).toBeNull();
  });

  it("does not caption an unfinished diagram fence while it streams", () => {
    const container = renderAnswer("```mermaid\ngraph TD\n  A-->", true);
    expect(container.querySelector("figure")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toContain("A-->");
  });
});

describe("other fences", () => {
  it("leaves every other language to the standard code view", () => {
    const container = renderAnswer("```ts\nconst x = 1;\n```\n\n```\nplain\n```");
    expect(container.querySelectorAll("pre")).toHaveLength(2);
    expect(container.querySelector("figure")).toBeNull();
    expect(container.querySelector(".rv-line")).toBeNull();
  });
});

describe("accessibility and localization", () => {
  it("passes axe with math, a diff and diagram source in one answer", async () => {
    const container = renderAnswer(
      [
        "Inline $x^2$ and display:",
        "",
        "$$\\int_0^1 x\\,dx$$",
        "",
        "```diff",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "```",
        "",
        "```mermaid",
        "graph TD",
        "```",
        "",
        "```math",
        "\\frac{a}{b}",
        "```",
      ].join("\n"),
    );
    await waitFor(() => {
      expect(container.querySelectorAll('[data-math-state="typeset"]')).toHaveLength(3);
    });
    expect(await axe(container)).toHaveNoViolations();
  });

  it("names regions in German", async () => {
    await loadLocaleMessages("de");
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    const container = render(
      <I18nProvider>
        <SafeMarkdownBoundary
          source={"$$x^2$$\n\n```mermaid\ngraph TD\n```"}
          richContent={CODING_WORKBENCH_RICH_CONTENT}
        />
      </I18nProvider>,
    ).container;
    await waitFor(() => {
      expect(within(container).getByRole("group", { name: "Formel" })).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(within(container).getByRole("img", { name: "Diagramm" })).toBeInTheDocument();
    });
  });
});
