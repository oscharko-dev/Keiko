import type { MermaidConfig } from "mermaid";

import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";

// Mermaid diagrams in a Coding Workbench answer (parity row S19, #3906). Mermaid (MIT) is loaded on
// first use as its own chunk, and its output is treated as data, the way KaTeX's is:
//
//  - `securityLevel: "strict"` and no HTML labels, so Mermaid itself emits plain SVG text and no
//    `foreignObject`; a diagram's own `%%{init}%%` directive cannot change a key named in `secure`
//    (the theme, its CSS and variables, labels, fonts and every limit below).
//  - The SVG is parsed into an inert document and every node must pass an SVG-only allowlist: no
//    script, no event handler, no link or URL-bearing attribute, no `foreignObject`, no style that
//    loads anything. The nodes that were checked are the nodes inserted; nothing reaches `innerHTML`.
//  - The checked nodes go into a shadow root, so the diagram's own stylesheet styles that diagram
//    and nothing else on the page.
//
// A source that is empty, too long or not a diagram Mermaid can draw is shown as written.

/** The part of Mermaid this surface uses. */
export interface MermaidRenderer {
  readonly initialize: (config: MermaidConfig) => void;
  readonly render: (id: string, text: string) => Promise<{ readonly svg: string }>;
}

export type DiagramDrawing =
  | { readonly status: "drawn"; readonly nodes: readonly Node[] }
  | { readonly status: "verbatim"; readonly reason: DiagramVerbatimReason };

type DiagramVerbatimReason = "empty" | "too-long" | "rejected" | "unsafe-markup";

export const DIAGRAM_MAX_CHARS = 20_000;
const DIAGRAM_MAX_EDGES = 500;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const MAX_MARKUP_DEPTH = 256;
// What Mermaid draws with. Anything else (a `foreignObject`, `script`, `a`, `use`, `image`,
// animation or `iframe`) refuses the whole diagram.
const SVG_ELEMENTS: ReadonlySet<string> = new Set([
  "circle",
  "clippath",
  "defs",
  "desc",
  "ellipse",
  "g",
  "line",
  "lineargradient",
  "marker",
  "path",
  "polygon",
  "polyline",
  "radialgradient",
  "rect",
  "stop",
  "style",
  "svg",
  "symbol",
  "text",
  "title",
  "tspan",
]);
const URL_ATTRIBUTES: ReadonlySet<string> = new Set([
  "href",
  "xlink:href",
  "src",
  "action",
  "formaction",
  "data",
  "background",
]);
const ACTIVE_TOKENS: readonly string[] = [
  "url(",
  "expression(",
  "javascript:",
  "@import",
  "@font-face",
  "behavior:",
  "-moz-binding",
];
// The configuration keys a diagram's own directive may never change.
const SECURE_KEYS: readonly string[] = [
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "maxEdges",
  "suppressErrorRendering",
  "deterministicIds",
  "deterministicIDSeed",
  "dompurifyConfig",
  "htmlLabels",
  "flowchart",
  "theme",
  "themeCSS",
  "themeVariables",
  "darkMode",
  "fontFamily",
  "altFontFamily",
  "fontSize",
  "look",
  "layout",
];

function mermaidConfig(dark: boolean): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    secure: [...SECURE_KEYS],
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    maxTextSize: DIAGRAM_MAX_CHARS,
    maxEdges: DIAGRAM_MAX_EDGES,
    suppressErrorRendering: true,
    deterministicIds: true,
    theme: dark ? "dark" : "neutral",
  };
}

function hasActiveToken(value: string): boolean {
  const compact = value.toLowerCase().replaceAll(/\s+/gu, "");
  return ACTIVE_TOKENS.some((token) => compact.includes(token));
}

function hasActiveAttribute(element: Element): boolean {
  return [...element.attributes].some((attribute) => {
    const name = attribute.name.toLowerCase();
    if (name.startsWith("on") || URL_ATTRIBUTES.has(name)) return true;
    return hasActiveToken(attribute.value);
  });
}

function isAllowedSvgElement(element: Element): boolean {
  const name = element.localName.toLowerCase();
  if (element.namespaceURI !== SVG_NAMESPACE || !SVG_ELEMENTS.has(name)) return false;
  if (hasActiveAttribute(element)) return false;
  return name !== "style" || !hasActiveToken(element.textContent ?? "");
}

function isInertNode(node: Node, depth: number): boolean {
  if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.COMMENT_NODE) return true;
  if (depth > MAX_MARKUP_DEPTH || !(node instanceof Element)) return false;
  if (!isAllowedSvgElement(node)) return false;
  return [...node.childNodes].every((child) => isInertNode(child, depth + 1));
}

/** The checked root of an SVG document, or null when anything beyond plain SVG is present. */
export function inertSvgNodes(markup: string): readonly Node[] | null {
  if (typeof DOMParser === "undefined") return null;
  const document = new DOMParser().parseFromString(markup, "image/svg+xml");
  const root = document.documentElement;
  if (root.getElementsByTagName("parsererror").length > 0) return null;
  if (root.localName !== "svg" || !isInertNode(root, 0)) return null;
  return [root];
}

function prefersDark(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.theme !== "light";
}

let renderedDiagrams = 0;
// Mermaid keeps global state while it renders; one diagram at a time keeps two answers apart.
let renderQueue: Promise<unknown> = Promise.resolve();

async function renderSvg(mermaid: MermaidRenderer, source: string): Promise<string | null> {
  renderedDiagrams += 1;
  const id = `keiko-diagram-${String(renderedDiagrams)}`;
  mermaid.initialize(mermaidConfig(prefersDark()));
  try {
    return (await mermaid.render(id, source)).svg;
  } catch {
    // A syntax error, an unknown diagram type or a limit is an expected outcome for model-written
    // text, not a defect: the source is shown as written.
    return null;
  } finally {
    document.getElementById(`d${id}`)?.remove();
  }
}

/**
 * Draws one diagram. Never throws: every outcome that is not a clean drawing says why the caller
 * should show the diagram's own source instead.
 */
export function drawDiagram(mermaid: MermaidRenderer, text: string): Promise<DiagramDrawing> {
  const source = text.trim();
  if (source.length === 0) return Promise.resolve({ status: "verbatim", reason: "empty" });
  if (source.length > DIAGRAM_MAX_CHARS)
    return Promise.resolve({ status: "verbatim", reason: "too-long" });
  const drawing = renderQueue.then(async (): Promise<DiagramDrawing> => {
    const svg = await renderSvg(mermaid, source);
    if (svg === null) return { status: "verbatim", reason: "rejected" };
    const nodes = inertSvgNodes(svg);
    return nodes === null
      ? { status: "verbatim", reason: "unsafe-markup" }
      : { status: "drawn", nodes };
  });
  renderQueue = drawing;
  return drawing;
}

let loadedMermaid: MermaidRenderer | undefined;
let pendingMermaid: Promise<MermaidRenderer> | undefined;

/** Mermaid once it has been loaded in this page, so a second diagram does not wait for it again. */
export function readLoadedMermaid(): MermaidRenderer | undefined {
  return loadedMermaid;
}

/**
 * Loads Mermaid on first use. Concurrent callers share one load; a failed load is reported once,
 * body-free, and forgotten, so the next answer with a diagram retries a transient chunk failure.
 */
export function loadMermaid(): Promise<MermaidRenderer> {
  pendingMermaid ??= import("mermaid").then(
    (module) => {
      loadedMermaid = module.default;
      return module.default;
    },
    (error: unknown) => {
      pendingMermaid = undefined;
      reportClientDiagnostic("Keiko diagram renderer unavailable.", {
        kind: "other",
        errorEvidence: clientErrorEvidence(error),
      });
      throw error;
    },
  );
  return pendingMermaid;
}
