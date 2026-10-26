import type { KatexOptions } from "katex";

import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { SAFE_MARKDOWN_MAX_MATH_CHARS } from "@/lib/safe-markdown-math";

// Math in a Coding Workbench answer is typeset by KaTeX (MIT), loaded on first use so the
// workbench chunk does not carry it, and only ever as MathML:
//
//  - `output: "mathml"` needs no KaTeX stylesheet and no KaTeX fonts. The browsers this product
//    supports (see the `browserslist` floor of the UI package) render MathML natively, so math
//    adds no CSS or font subsystem and no change to `globals.css`.
//  - `trust: false` keeps `\href`, `\url`, `\includegraphics` and the `\html*` family unsupported.
//  - `strict: "ignore"` never prints to the console.
//  - `maxExpand` and `maxSize` bound macro expansion and user-specified sizes.
//
// KaTeX's markup is still treated as data, not as trusted HTML. It is parsed into an inert document
// and every node must pass a MathML-only allowlist before any node reaches the page, and the nodes
// that were checked are the nodes that are inserted — never a second parse of the same string, so a
// parser differential cannot turn a checked tree into a different live one. No `innerHTML` and no
// `dangerouslySetInnerHTML` is involved.

/** The part of KaTeX this surface uses. */
export interface KatexRenderer {
  readonly renderToString: (tex: string, options?: KatexOptions) => string;
}

export type MathTypesetting =
  | { readonly status: "typeset"; readonly nodes: readonly Node[] }
  | { readonly status: "verbatim"; readonly reason: MathVerbatimReason };

type MathVerbatimReason = "empty" | "too-long" | "rejected" | "unsafe-markup";

// KaTeX paints an unsupported or unknown command in `errorColor` instead of failing. A sentinel
// nobody writes by hand lets that case be told apart from a formula that really sets a colour: it
// is shown as written, not half typeset.
const MATH_ERROR_COLOR = "#e0004d";
const MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML";
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const MAX_MARKUP_DEPTH = 128;
// Refused in any namespace, on top of the namespace allowlist below. `maction` toggles and runs
// statuslines and `annotation-xml` can embed HTML; the HTML parser files an `<svg>` inside `<math>`
// under MathML, where it is inert, but nothing KaTeX emits is any of these.
const FORBIDDEN_ELEMENTS: ReadonlySet<string> = new Set([
  "a",
  "animate",
  "annotation-xml",
  "base",
  "embed",
  "foreignobject",
  "form",
  "iframe",
  "img",
  "link",
  "maction",
  "meta",
  "object",
  "script",
  "set",
  "style",
  "svg",
  "use",
]);
const URL_ATTRIBUTES: ReadonlySet<string> = new Set([
  "href",
  "src",
  "srcset",
  "xlink:href",
  "action",
  "formaction",
  "data",
  "background",
  "poster",
]);

function katexOptions(display: boolean): KatexOptions {
  return {
    displayMode: display,
    output: "mathml",
    throwOnError: false,
    errorColor: MATH_ERROR_COLOR,
    trust: false,
    strict: "ignore",
    maxExpand: 200,
    maxSize: 20,
    // A fresh object per call: `\gdef` writes into it, and one formula must never define a macro
    // that the next one inherits.
    macros: {},
  };
}

function isKatexFailure(markup: string): boolean {
  return (
    markup.startsWith('<span class="katex-error"') ||
    markup.includes(`mathcolor="${MATH_ERROR_COLOR}"`)
  );
}

function renderMarkup(katex: KatexRenderer, source: string, display: boolean): string | null {
  try {
    const markup = katex.renderToString(source, katexOptions(display));
    return isKatexFailure(markup) ? null : markup;
  } catch (error) {
    // With `throwOnError: false` KaTeX still throws for faults that are not a TeX error, so this is
    // a defect in the typesetter rather than hostile input. Body-free: the class only, no formula.
    reportClientDiagnostic("Keiko math renderer failed on a formula.", {
      kind: "other",
      errorEvidence: clientErrorEvidence(error),
    });
    return null;
  }
}

function isAllowedElement(element: Element): boolean {
  const name = element.localName.toLowerCase();
  if (FORBIDDEN_ELEMENTS.has(name)) return false;
  if (element.namespaceURI === MATHML_NAMESPACE) return true;
  return element.namespaceURI === HTML_NAMESPACE && name === "span";
}

function isActiveStyle(value: string): boolean {
  const compact = value.toLowerCase().replaceAll(/\s+/gu, "");
  return ["url(", "expression(", "javascript:", "@import"].some((token) => compact.includes(token));
}

function hasActiveAttribute(element: Element): boolean {
  return [...element.attributes].some((attribute) => {
    const name = attribute.name.toLowerCase();
    if (name.startsWith("on") || URL_ATTRIBUTES.has(name)) return true;
    return name === "style" && isActiveStyle(attribute.value);
  });
}

function isInertNode(node: Node, depth: number): boolean {
  if (node.nodeType === Node.TEXT_NODE) return true;
  if (depth > MAX_MARKUP_DEPTH || !(node instanceof Element)) return false;
  if (!isAllowedElement(node) || hasActiveAttribute(node)) return false;
  return [...node.childNodes].every((child) => isInertNode(child, depth + 1));
}

// The nodes of an inert parse, or null when anything beyond plain MathML is present.
function inertNodes(markup: string): readonly Node[] | null {
  if (typeof DOMParser === "undefined") return null;
  const nodes = [...new DOMParser().parseFromString(markup, "text/html").body.childNodes];
  return nodes.length > 0 && nodes.every((node) => isInertNode(node, 0)) ? nodes : null;
}

/**
 * Typesets one formula. Never throws: every outcome that is not a clean typesetting reports why the
 * caller should show the formula's own source instead.
 */
export function typesetMath(katex: KatexRenderer, tex: string, display: boolean): MathTypesetting {
  const source = tex.trim();
  if (source.length === 0) return { status: "verbatim", reason: "empty" };
  if (source.length > SAFE_MARKDOWN_MAX_MATH_CHARS)
    return { status: "verbatim", reason: "too-long" };
  const markup = renderMarkup(katex, source, display);
  if (markup === null) return { status: "verbatim", reason: "rejected" };
  const nodes = inertNodes(markup);
  return nodes === null
    ? { status: "verbatim", reason: "unsafe-markup" }
    : { status: "typeset", nodes };
}

const FENCE_DELIMITERS: readonly (readonly [string, string])[] = [
  ["$$", "$$"],
  [String.raw`\[`, String.raw`\]`],
  [String.raw`\(`, String.raw`\)`],
  ["$", "$"],
];

/**
 * The TeX of a ```math / ```latex fence. Writers often wrap the body in the delimiters they would
 * use in prose; those belong to the notation around the formula, not to the formula.
 */
export function mathFenceSource(text: string): string {
  const trimmed = text.trim();
  for (const [open, close] of FENCE_DELIMITERS) {
    if (
      trimmed.length > open.length + close.length &&
      trimmed.startsWith(open) &&
      trimmed.endsWith(close)
    ) {
      return trimmed.slice(open.length, trimmed.length - close.length).trim();
    }
  }
  return trimmed;
}

let loadedKatex: KatexRenderer | undefined;
let pendingKatex: Promise<KatexRenderer> | undefined;

/** KaTeX once it has been loaded in this page, so a second formula does not wait for it again. */
export function readLoadedKatex(): KatexRenderer | undefined {
  return loadedKatex;
}

/**
 * Loads KaTeX on first use. Concurrent callers share one load; a failed load is reported once,
 * body-free, and forgotten, so the next answer with math retries a transient chunk failure.
 */
export function loadKatex(): Promise<KatexRenderer> {
  pendingKatex ??= import("katex").then(
    (module) => {
      loadedKatex = module.default;
      return module.default;
    },
    (error: unknown) => {
      pendingKatex = undefined;
      reportClientDiagnostic("Keiko math renderer unavailable.", {
        kind: "other",
        errorEvidence: clientErrorEvidence(error),
      });
      throw error;
    },
  );
  return pendingKatex;
}
