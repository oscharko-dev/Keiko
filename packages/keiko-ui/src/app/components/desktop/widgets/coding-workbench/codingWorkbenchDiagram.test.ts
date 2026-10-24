import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DIAGRAM_MAX_CHARS,
  drawDiagram,
  inertSvgNodes,
  type MermaidRenderer,
} from "./codingWorkbenchDiagram";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><g><rect width="1" height="1"/></g></svg>';
const here = dirname(fileURLToPath(import.meta.url));
// What Mermaid really draws with this surface's configuration (see mermaid-fixtures/README.md).
const MERMAID_VERSION = "11.17.2";
const FIXTURES = join(here, "mermaid-fixtures", MERMAID_VERSION);

function realDrawing(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.svg`), "utf8");
}

function drawnSvg(markup: string): Element {
  const nodes = inertSvgNodes(markup);
  if (nodes === null) throw new Error("expected the diagram to be drawn");
  return nodes[0] as Element;
}

interface RecordingRenderer extends MermaidRenderer {
  readonly initialize: ReturnType<typeof vi.fn<MermaidRenderer["initialize"]>>;
  readonly parse: ReturnType<typeof vi.fn<MermaidRenderer["parse"]>>;
  readonly render: ReturnType<typeof vi.fn<MermaidRenderer["render"]>>;
}

function renderer(
  render: MermaidRenderer["render"] = () => Promise.resolve({ svg: SVG }),
): RecordingRenderer {
  return {
    initialize: vi.fn<MermaidRenderer["initialize"]>(),
    parse: vi.fn<MermaidRenderer["parse"]>(() => Promise.resolve({})),
    render: vi.fn<MermaidRenderer["render"]>(render),
  };
}

afterEach(() => {
  delete document.documentElement.dataset.theme;
});

describe("drawing a Mermaid diagram (#3906)", () => {
  it("shows an empty or oversized source as written without asking Mermaid", async () => {
    const mermaid = renderer();
    await expect(drawDiagram(mermaid, "  \n ")).resolves.toEqual({
      status: "verbatim",
      reason: "empty",
    });
    await expect(drawDiagram(mermaid, "x".repeat(DIAGRAM_MAX_CHARS + 1))).resolves.toEqual({
      status: "verbatim",
      reason: "too-long",
    });
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it("draws one diagram at a time, because Mermaid keeps global state while it renders", async () => {
    let active = 0;
    let overlapped = false;
    const mermaid = renderer(async () => {
      active += 1;
      overlapped ||= active > 1;
      await Promise.resolve();
      active -= 1;
      return { svg: SVG };
    });
    const drawings = await Promise.all([
      drawDiagram(mermaid, "graph TD\n A-->B"),
      drawDiagram(mermaid, "graph TD\n C-->D"),
    ]);
    expect(drawings.map(({ status }) => status)).toEqual(["drawn", "drawn"]);
    expect(overlapped).toBe(false);
  });

  it("shows a source Mermaid cannot read as written, without drawing or reporting it", async () => {
    const mermaid = renderer();
    mermaid.parse.mockResolvedValueOnce(false);
    await expect(drawDiagram(mermaid, "graph ??")).resolves.toEqual({
      status: "verbatim",
      reason: "rejected",
    });
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it("removes Mermaid's scratch element even when drawing a read diagram fails", async () => {
    const mermaid = renderer((id) => {
      const scratch = document.createElement("div");
      scratch.id = `d${id}`;
      document.body.append(scratch);
      return Promise.reject(new Error("layout failed"));
    });
    await expect(drawDiagram(mermaid, "graph TD\n A-->B")).resolves.toEqual({
      status: "verbatim",
      reason: "rejected",
    });
    expect(document.querySelector('[id^="dkeiko-diagram-"]')).toBeNull();
  });

  it("follows the page theme: dark unless the page is light", async () => {
    const mermaid = renderer();
    await drawDiagram(mermaid, "graph TD\n A-->B");
    expect(mermaid.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "dark" }));
    document.documentElement.dataset.theme = "light";
    await drawDiagram(mermaid, "graph TD\n A-->B");
    expect(mermaid.initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: "neutral" }),
    );
  });
});

describe("the SVG allowlist", () => {
  it("admits the plain SVG Mermaid draws, with its scoped stylesheet", () => {
    const nodes = inertSvgNodes(
      '<svg xmlns="http://www.w3.org/2000/svg"><defs><marker id="m"><path d="M0 0"/></marker></defs><style>.edge{stroke:#333}</style><g class="edge"><path d="M0 0L1 1"/><text><tspan>A</tspan></text></g></svg>',
    );
    expect(nodes).toHaveLength(1);
    expect((nodes?.[0] as Element).localName).toBe("svg");
  });

  it("draws what Mermaid really draws, for the version the UI pins", () => {
    const uiPackage = JSON.parse(
      readFileSync(join(here, "../../../../../../package.json"), "utf8"),
    ) as {
      readonly dependencies: Readonly<Record<string, string>>;
    };
    expect(uiPackage.dependencies.mermaid).toBe(MERMAID_VERSION);
    const names = readdirSync(FIXTURES)
      .filter((file) => file.endsWith(".svg"))
      .map((file) => file.slice(0, -".svg".length));
    expect(names.sort()).toEqual(["flowchart", "journey", "pie", "sankey", "sequence", "treemap"]);
    for (const name of names) expect(inertSvgNodes(realDrawing(name)), name).not.toBeNull();
  });

  it("keeps the references Mermaid ties markers, gradients and clip paths with", () => {
    const flowchart = drawnSvg(realDrawing("flowchart"));
    expect(flowchart.querySelector("[marker-end]")?.getAttribute("marker-end")).toMatch(
      /^url\(#keiko-diagram-1_/u,
    );
    expect(flowchart.querySelector("filter feDropShadow")).not.toBeNull();
    expect(drawnSvg(realDrawing("treemap")).querySelector("clipPath")).not.toBeNull();
  });

  it("draws a switch's plain SVG alternative and never its HTML one", () => {
    const journey = drawnSvg(realDrawing("journey"));
    expect(journey.getElementsByTagName("foreignObject")).toHaveLength(0);
    const fallback = journey.querySelector("switch > text");
    expect(fallback?.textContent).toBe("Go");
    // The section's class fills it with the section's background; the label is drawn in text colour.
    expect(fallback?.getAttribute("style")).toMatch(/; fill: currentColor;$/u);
  });

  it.each([
    [
      "an external marker",
      'marker-end="url(#keiko-diagram-1_flowchart-v2-pointEnd)"',
      'marker-end="url(https://example.invalid/m.svg#e)"',
    ],
    [
      "a local reference followed by a load",
      'marker-end="url(#keiko-diagram-1_flowchart-v2-pointEnd)"',
      'marker-end="url(#a) url(//example.invalid/m)"',
    ],
    [
      "a quoted external reference",
      'marker-end="url(#keiko-diagram-1_flowchart-v2-pointEnd)"',
      "marker-end=\"url('https://example.invalid/m')\"",
    ],
    [
      "a stylesheet image",
      "<style>",
      '<style>.node{fill:image-set("https://example.invalid/x.png" 1x)}',
    ],
    [
      "a stylesheet cross-fade",
      "<style>",
      '<style>.node{fill:cross-fade("https://example.invalid/x.png", red 50%)}',
    ],
    ["a CSS escape", "<style>", "<style>.node{fill:\\75 rl(https://example.invalid/x)}"],
    [
      "a foreignObject outside a switch",
      "</svg>",
      '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject></svg>',
    ],
    [
      "a filter that loads an image",
      "</defs>",
      '<filter id="f"><feImage href="https://example.invalid/x.png"/></filter></defs>',
    ],
  ])("refuses a real drawing with %s", (_label, original, replacement) => {
    const markup = realDrawing("flowchart");
    expect(markup).toContain(original);
    expect(inertSvgNodes(markup.replace(original, replacement))).toBeNull();
  });

  it.each([
    "<svg>missing namespace</svg>",
    '<svg xmlns="http://www.w3.org/2000/svg"><g>',
    '<svg xmlns="http://www.w3.org/2000/svg"><animate attributeName="x"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><g xlink:href="#x" xmlns:xlink="http://www.w3.org/1999/xlink"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://example.invalid/x.css";</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><g style="behavior: url(x.htc)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><g onclick="x()"/></svg>',
  ])("refuses %s", (markup) => {
    expect(inertSvgNodes(markup)).toBeNull();
  });
});
