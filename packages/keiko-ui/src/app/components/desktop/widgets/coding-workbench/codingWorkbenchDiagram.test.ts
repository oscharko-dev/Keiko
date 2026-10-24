import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DIAGRAM_MAX_CHARS,
  drawDiagram,
  inertSvgNodes,
  type MermaidRenderer,
} from "./codingWorkbenchDiagram";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><g><rect width="1" height="1"/></g></svg>';

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
