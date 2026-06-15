// Framework-agnostic HTML/CSS CodeTargetAdapter — the first-slice code target (Epic #750, Issue #755).
//
// Renders the target-neutral emission plan (emissionPlan.ts) to clean, semantic HTML plus a CSS
// custom-property stylesheet built from the design tokens (#752). No framework, router, or component
// library: each element role maps to a semantic HTML tag, each design token to a CSS variable, and
// each screen's routing hints (#811) to a `<nav>` of plain anchors carrying the trigger as a data
// attribute. The adapter consumes token VARIABLES — it never re-derives or hard-codes raw values
// beyond emitting the token table itself.
//
// Output is a reviewable proposal (an ordered file list): `index.html` (links every screen),
// `tokens.css` (the `:root` custom-property table), and one `screens/<id>.html` per screen. Pure: no
// IO, no model, no clock — a given plan yields a byte-identical artifact. All text and attribute values
// are HTML-escaped so the reviewable artifact cannot inject markup, and unsafe Unicode format chars
// (bidi-override / zero-width / C0-C1 / DEL) are stripped from every emitted string before escaping —
// these are not HTML metacharacters and would otherwise survive into the artifact, enabling
// Trojan-source spoofing and zero-width-split secrets that evade redaction (same invariant the QI atom
// path enforces). The TAB/LF/CR trio and all ordinary text survive, so clean boards are unchanged.
//
// CSS value handling: fontFamily tokens are emitted as quoted strings with embedded double-quotes
// escaped and control/injection characters ('{', '}', ';', '</', '*/', newlines) stripped, so a
// hostile font name cannot break out of the custom-property declaration. Color tokens are validated
// against /^#[0-9a-fA-F]{3,8}$/ and numeric tokens as finite numbers; invalid values are dropped
// rather than emitted.
//
// Screen file names: Figma ids may contain ':' (Windows-invalid) and ';' (URI scheme risk in hrefs).
// Stored evidence can also be tampered with, so screen ids are normalized to one safe POSIX path
// segment ([A-Za-z0-9_-]) before they become CodeFile.path / href material. Collisions after
// substitution are resolved by a numeric suffix. All relative hrefs inside screen HTML are prefixed
// with './' so they are relative to the screens/ directory, not ambiguous URI-scheme fragments. The
// raw screen id is preserved in the data-screen-id attribute.
//
// Layout / sizing / cornerRadius / typography (from IrNode, threaded through EmissionElement):
// For nodes with auto-layout, a deterministic CSS class is emitted (name = "n-" + sanitized node id)
// carrying display:flex, flex-direction, gap, padding, and border-radius. TEXT nodes with typography
// matching a tokens.css entry reference var(--font-N). fill-sized nodes emit flex:1 / width:100% on
// the relevant axis; hug is the default (no output).
//
// What IS reproduced: auto-layout direction, gap, padding, border-radius, font (via token var or
// inline).
// What is NOT reproduced: absolute positioning, constraints, effects (shadows/blur), image fills
// beyond refs, grid layout, overflow, z-ordering, component variants.

import { stripUnsafeFormatChars } from "../assertions.js";
import type { CodeArtifact, CodeFile, CodeTargetAdapter } from "./codeTargetAdapter.js";
import type {
  CodeEmissionPlan,
  EmissionElement,
  EmissionNavTarget,
  EmissionRole,
  ScreenEmission,
} from "./emissionPlan.js";
import type {
  AlignItems,
  ColorToken,
  DesignTokens,
  IrLayout,
  IrSizing,
  IrTypography,
  RadiusToken,
  SpacingToken,
  TypographyToken,
} from "./irTypes.js";

const ADAPTER_NAME = "html-css";
const INDENT = "  ";

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

// Strip unsafe Unicode format chars (bidi-override / zero-width / C0-C1 / DEL) BEFORE HTML-escaping.
// These are NOT HTML metacharacters, so escaping alone passes them verbatim into the reviewable
// artifact — enabling Trojan-source spoofing and zero-width-split secrets that evade redaction. This
// mirrors the QI atom-text invariant (stripUnsafeFormatChars). Clean text is unchanged — the TAB/LF/CR
// trio and all ordinary/accented/CJK/emoji code points survive — so deterministic output stays
// byte-identical for non-hostile boards.
const escapeHtml = (value: string): string =>
  stripUnsafeFormatChars(value).replace(/[&<>"']/gu, (char) => HTML_ESCAPES[char] ?? char);

const indent = (depth: number): string => INDENT.repeat(depth);

// ─── Fix #7: safe screen file names ──────────────────────────────────────────
//
// Figma ids contain ':' (invalid on Windows file paths) and INSTANCE ids contain ';' which is parsed
// as a URI scheme separator in sibling hrefs (e.g. "I123:456;789:12.html" → opaque URI). A tampered
// stored snapshot could also contain slashes, backslashes, or other path metacharacters. Normalize to
// a single artifact-relative filename segment. Ids are unique before substitution so collisions are
// rare, but a numeric suffix is appended defensively.
const SAFE_SCREEN_FILE_RE = /[^A-Za-z0-9_-]/gu;

function sanitizeScreenFileName(screenId: string): string {
  const cleaned = stripUnsafeFormatChars(screenId)
    .replace(SAFE_SCREEN_FILE_RE, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
  return cleaned.length > 0 ? cleaned : "screen";
}

function buildSafeNameIndex(screens: readonly ScreenEmission[]): ReadonlyMap<string, string> {
  const seen = new Map<string, number>();
  const result = new Map<string, string>();
  for (const screen of screens) {
    const base = sanitizeScreenFileName(screen.screenId);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    result.set(screen.screenId, count === 0 ? base : `${base}-${String(count)}`);
  }
  return result;
}

// ─── Fix #8: CSS value sanitization ──────────────────────────────────────────
//
// fontFamily is emitted as a CSS quoted string. Embedded double-quotes are escaped as \\22 (the
// CSS hex escape for ") and injection sequences ('{', '}', ';', '</', '*/', newlines, control
// chars) are stripped, so a hostile font name cannot break out of the declaration.
// Unicode escapes for control characters (U+0000-U+001F) and DEL (U+007F) avoid the no-control-regex
// lint rule while matching the same character set at runtime.
// eslint-disable-next-line no-control-regex
const CSS_INJECTION_RE = /[{};]|<\/|\*\/|[\u0000-\u001f\u007f]/gu;

const safeFontFamily = (family: string): string => {
  // Strip unsafe Unicode format chars first — bidi/zero-width/C1 are NOT covered by CSS_INJECTION_RE
  // (which only strips C0/DEL + structural injection sequences) — then escape embedded quotes. Same
  // egress invariant as escapeHtml: these chars would otherwise survive into the quoted CSS string.
  const cleaned = stripUnsafeFormatChars(family)
    .replace(CSS_INJECTION_RE, "")
    .replace(/"/gu, "\\22 ");
  return `"${cleaned}"`;
};

// Valid CSS hex color: 3, 4, 6, or 8 hex digits.
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/u;

const isSafeColor = (value: string): boolean => HEX_COLOR_RE.test(value);

// ─── Map a target-neutral element role to a semantic HTML tag ─────────────────
// Containers become <section>; everything else is the closest semantic element.
const TAG_BY_ROLE: Readonly<Record<EmissionRole, string>> = {
  button: "button",
  input: "input",
  link: "a",
  text: "p",
  image: "img",
  container: "section",
};

// Roles that render as void (self-closing) elements with no children/text.
const VOID_ROLES = new Set<EmissionRole>(["input", "image"]);

// ─── Token lookup maps (built once per emit call) ─────────────────────────────
//
// Maps token canonical value → CSS variable name so the adapter can reference var(--color-N) /
// var(--font-N) by value without scanning the array on every element.

interface TokenLookups {
  /** hex color value → CSS var name, e.g. "#112233" → "--color-1" */
  readonly colorVar: ReadonlyMap<string, string>;
  /** typography key → CSS var name, e.g. "Inter|16|400|24" → "--font-1" */
  readonly fontVar: ReadonlyMap<string, string>;
  /** spacing value → CSS var name, e.g. 8 → "--space-1" */
  readonly spaceVar: ReadonlyMap<number, string>;
  /** radius value → CSS var name, e.g. 4 → "--radius-1" */
  readonly radiusVar: ReadonlyMap<number, string>;
}

const colorVar = (index: number): string => `--color-${String(index + 1)}`;
const spaceVar = (index: number): string => `--space-${String(index + 1)}`;
const radiusVar = (index: number): string => `--radius-${String(index + 1)}`;
const fontVar = (index: number): string => `--font-${String(index + 1)}`;

// Typography key used to match per-node typography against the global token table.
const typographyKey = (t: IrTypography): string =>
  `${t.fontFamily}|${String(t.fontSize)}|${String(t.fontWeight)}|${String(t.lineHeight ?? "")}`;
const typographyTokenKey = (t: TypographyToken): string =>
  `${t.fontFamily}|${String(t.fontSize)}|${String(t.fontWeight)}|${String(t.lineHeight)}`;

const buildTokenLookups = (tokens: DesignTokens): TokenLookups => {
  const colorMap = new Map<string, string>();
  tokens.colors.forEach((token, i) => {
    colorMap.set(token.value, colorVar(i));
  });
  const fontMap = new Map<string, string>();
  tokens.typography.forEach((token, i) => {
    fontMap.set(typographyTokenKey(token), fontVar(i));
  });
  const spaceMap = new Map<number, string>();
  tokens.spacing.forEach((token, i) => {
    spaceMap.set(token.value, spaceVar(i));
  });
  const radiusMap = new Map<number, string>();
  tokens.radius.forEach((token, i) => {
    radiusMap.set(token.value, radiusVar(i));
  });
  return { colorVar: colorMap, fontVar: fontMap, spaceVar: spaceMap, radiusVar: radiusMap };
};

// ─── Per-node CSS class generation ───────────────────────────────────────────
//
// A deterministic class name is derived from the node id by replacing non-alphanumeric characters
// with "-" and prefixing "n-". When two raw ids sanitize to the same slug, append a stable raw-id
// hash to the later class so distinct Figma nodes cannot alias onto one CSS selector.

const sanitizeIdForClass = (id: string): string => id.replace(/[^a-zA-Z0-9]/gu, "-");
const classHash = (id: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};
const nodeClassBase = (id: string): string => `n-${sanitizeIdForClass(id) || "node"}`;
const nodeClass = (id: string, ctx: ScreenStyleContext): string => {
  const existing = ctx.classMap.get(id);
  if (existing !== undefined) return existing;
  const base = nodeClassBase(id);
  const owner = ctx.usedClasses.get(base);
  const cls = owner === undefined || owner === id ? base : `${base}-${classHash(id)}`;
  ctx.usedClasses.set(cls, id);
  ctx.classMap.set(id, cls);
  return cls;
};

const ALIGN_CSS: Readonly<Record<AlignItems, string>> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  "space-between": "space-between",
};

// Resolve a numeric spacing or radius value to a CSS token var or an inline px literal.
const spaceValue = (value: number, lookups: TokenLookups): string => {
  const varName = lookups.spaceVar.get(value);
  return varName !== undefined ? `var(${varName})` : `${String(value)}px`;
};

const radiusValue = (value: number, lookups: TokenLookups): string => {
  const varName = lookups.radiusVar.get(value);
  return varName !== undefined ? `var(${varName})` : `${String(value)}px`;
};

// Build CSS declarations for a layout node. Returns undefined when nothing would be emitted.
const layoutDeclarations = (layout: IrLayout, lookups: TokenLookups): readonly string[] => {
  const decls: string[] = ["display: flex;", `flex-direction: ${layout.mode};`];
  if (layout.itemSpacing !== undefined && Number.isFinite(layout.itemSpacing)) {
    decls.push(`gap: ${spaceValue(layout.itemSpacing, lookups)};`);
  }
  if (layout.padding !== undefined) {
    const [top, right, bottom, left] = layout.padding;
    const t = spaceValue(top, lookups);
    const r = spaceValue(right, lookups);
    const b = spaceValue(bottom, lookups);
    const l = spaceValue(left, lookups);
    decls.push(`padding: ${t} ${r} ${b} ${l};`);
  }
  if (layout.primaryAlign !== undefined) {
    decls.push(`justify-content: ${ALIGN_CSS[layout.primaryAlign]};`);
  }
  if (layout.counterAlign !== undefined) {
    decls.push(`align-items: ${ALIGN_CSS[layout.counterAlign]};`);
  }
  return decls;
};

// Build CSS declarations for sizing (fill = flex:1, hug = nothing [default], fixed = nothing here).
const sizingDeclarations = (sizing: IrSizing): readonly string[] => {
  const decls: string[] = [];
  if (sizing.horizontal === "fill") decls.push("width: 100%;");
  if (sizing.vertical === "fill") decls.push("flex: 1;");
  return decls;
};

// Build CSS declarations for typography. Prefer token var when matched; inline otherwise.
const typographyDeclarations = (typo: IrTypography, lookups: TokenLookups): readonly string[] => {
  const fontVarName = lookups.fontVar.get(typographyKey(typo));
  if (fontVarName !== undefined) {
    return [`font: var(${fontVarName});`];
  }
  // Inline fallback: validate each value before emitting.
  const decls: string[] = [];
  if (Number.isFinite(typo.fontWeight)) decls.push(`font-weight: ${String(typo.fontWeight)};`);
  if (Number.isFinite(typo.fontSize)) decls.push(`font-size: ${String(typo.fontSize)}px;`);
  if (typo.lineHeight !== undefined && Number.isFinite(typo.lineHeight)) {
    decls.push(`line-height: ${String(typo.lineHeight)}px;`);
  }
  if (typo.fontFamily.length > 0) decls.push(`font-family: ${safeFontFamily(typo.fontFamily)};`);
  return decls;
};

interface ScreenStyleContext {
  readonly lookups: TokenLookups;
  /** Map from node id to CSS class name — populated while building; used when rendering attributes. */
  readonly classMap: Map<string, string>;
  /** Reverse class ownership for collision-resistant class generation. */
  readonly usedClasses: Map<string, string>;
  /** Accumulated CSS rules for the screen, in element-tree order. */
  readonly rules: string[];
}

// Walk the element tree, collect CSS rules, populate classMap.
const collectStyles = (element: EmissionElement, ctx: ScreenStyleContext): void => {
  const decls: string[] = [
    ...(element.layout !== undefined ? layoutDeclarations(element.layout, ctx.lookups) : []),
    ...(element.sizing !== undefined ? sizingDeclarations(element.sizing) : []),
    ...(element.cornerRadius !== undefined && Number.isFinite(element.cornerRadius)
      ? [`border-radius: ${radiusValue(element.cornerRadius, ctx.lookups)};`]
      : []),
    ...(element.typography !== undefined
      ? typographyDeclarations(element.typography, ctx.lookups)
      : []),
  ];

  if (decls.length > 0) {
    const cls = nodeClass(element.id, ctx);
    ctx.rules.push(`.${cls} {`);
    for (const decl of decls) ctx.rules.push(`  ${decl}`);
    ctx.rules.push("}");
  }

  // renderElement discards the children of void-role elements (image/input), so collecting their
  // styles would emit orphaned CSS rules referencing classes that appear on no rendered element.
  // Skip the recursion for void roles to keep the stylesheet aligned with the emitted HTML.
  if (!VOID_ROLES.has(element.role)) {
    for (const child of element.children) collectStyles(child, ctx);
  }
};

// ─── HTML element rendering ───────────────────────────────────────────────────

// Fix #6: additionally emit data-node-id so the element's IR origin is traceable in the HTML output.
// True when this element renders any visible text — its own text or a descendant TEXT node's text.
// A button/link is usually a container whose visible label lives in a child TEXT node, so checking
// only the element's OWN `text` misses it (WCAG 4.1.2 / 2.5.3).
const hasRenderedText = (element: EmissionElement): boolean =>
  element.text !== undefined || element.children.some(hasRenderedText);

function elementAttributes(
  element: EmissionElement,
  classMap: ReadonlyMap<string, string>,
): string {
  const parts = [
    `data-role="${escapeHtml(element.role)}"`,
    `data-name="${escapeHtml(element.displayName)}"`,
    `data-node-id="${escapeHtml(element.id)}"`,
  ];
  const cls = classMap.get(element.id);
  if (cls !== undefined) parts.push(`class="${escapeHtml(cls)}"`);
  if (element.role === "link") parts.push('href="#"');
  if (element.role === "input") parts.push(`aria-label="${escapeHtml(element.displayName)}"`);
  if (element.role === "image") parts.push(`alt="${escapeHtml(element.displayName)}"`);
  // A button/link with NO visible text (icon-only) gets no accessible name from its content; fall
  // back to the structural display name so the artifact stays screen-reader navigable (WCAG 4.1.2).
  // But when it DOES render visible text (own or in a child TEXT node), adding aria-label would
  // OVERRIDE that visible label for assistive tech (and break label-in-name, WCAG 2.5.3) — so skip it.
  if ((element.role === "button" || element.role === "link") && !hasRenderedText(element)) {
    parts.push(`aria-label="${escapeHtml(element.displayName)}"`);
  }
  return parts.join(" ");
}

function renderElement(
  element: EmissionElement,
  depth: number,
  classMap: ReadonlyMap<string, string>,
): readonly string[] {
  const tag = TAG_BY_ROLE[element.role];
  const attributes = elementAttributes(element, classMap);
  if (VOID_ROLES.has(element.role)) {
    return [`${indent(depth)}<${tag} ${attributes} />`];
  }
  const lines: string[] = [`${indent(depth)}<${tag} ${attributes}>`];
  if (element.text !== undefined) lines.push(`${indent(depth + 1)}${escapeHtml(element.text)}`);
  for (const child of element.children) lines.push(...renderElement(child, depth + 1, classMap));
  lines.push(`${indent(depth)}</${tag}>`);
  return lines;
}

// Fix #7: hrefs use the sanitized name and are prefixed with './' so they resolve relative to the
// screens/ directory and cannot be misinterpreted as URI schemes.
function renderNav(
  navTargets: readonly EmissionNavTarget[],
  safeNames: ReadonlyMap<string, string>,
  depth: number,
): readonly string[] {
  if (navTargets.length === 0) return [];
  const lines: string[] = [`${indent(depth)}<nav aria-label="Screen navigation">`];
  for (const target of navTargets) {
    const safeName = safeNames.get(target.toScreenId) ?? sanitizeScreenFileName(target.toScreenId);
    const href = `./${escapeHtml(safeName)}.html`;
    const trigger = escapeHtml(target.trigger);
    const label = escapeHtml(target.toScreenName);
    lines.push(`${indent(depth + 1)}<a href="${href}" data-trigger="${trigger}">${label}</a>`);
  }
  lines.push(`${indent(depth)}</nav>`);
  return lines;
}

// Fix #7: screen file uses safe name; raw id is preserved in data-screen-id for traceability.
function renderScreenHtml(
  screen: ScreenEmission,
  safeNames: ReadonlyMap<string, string>,
  lookups: TokenLookups,
): string {
  // Collect per-node styles first so classMap is populated before HTML rendering.
  const ctx: ScreenStyleContext = {
    lookups,
    classMap: new Map(),
    usedClasses: new Map(),
    rules: [],
  };
  collectStyles(screen.root, ctx);

  const styleBlock: string[] =
    ctx.rules.length > 0
      ? [
          `${indent(2)}<style>`,
          ...ctx.rules.map((line) => `${indent(2)}${line}`),
          `${indent(2)}</style>`,
        ]
      : [];

  const title = escapeHtml(screen.screenName);
  const body = [
    ...renderNav(screen.navTargets, safeNames, 3),
    `${indent(3)}<main data-screen-id="${escapeHtml(screen.screenId)}">`,
    ...renderElement(screen.root, 4, ctx.classMap),
    `${indent(3)}</main>`,
  ];
  return [
    "<!doctype html>",
    '<html>',
    `${indent(1)}<head>`,
    `${indent(2)}<meta charset="utf-8" />`,
    `${indent(2)}<title>${title}</title>`,
    `${indent(2)}<link rel="stylesheet" href="../tokens.css" />`,
    ...styleBlock,
    `${indent(1)}</head>`,
    `${indent(1)}<body>`,
    ...body,
    `${indent(1)}</body>`,
    "</html>",
    "",
  ].join("\n");
}

// Fix #7: index links use safe names for the href path but display the human-readable screen name.
function renderIndexHtml(
  screens: readonly ScreenEmission[],
  safeNames: ReadonlyMap<string, string>,
): string {
  const links = screens.map((screen) => {
    const safeName = safeNames.get(screen.screenId) ?? sanitizeScreenFileName(screen.screenId);
    return (
      `${indent(3)}<li><a href="screens/${escapeHtml(safeName)}.html">` +
      `${escapeHtml(screen.screenName)}</a></li>`
    );
  });
  return [
    "<!doctype html>",
    '<html>',
    `${indent(1)}<head>`,
    `${indent(2)}<meta charset="utf-8" />`,
    `${indent(2)}<title>Screens</title>`,
    `${indent(2)}<link rel="stylesheet" href="tokens.css" />`,
    `${indent(1)}</head>`,
    `${indent(1)}<body>`,
    `${indent(2)}<nav aria-label="All screens">`,
    `${indent(3)}<ul>`,
    ...links,
    `${indent(3)}</ul>`,
    `${indent(2)}</nav>`,
    `${indent(1)}</body>`,
    "</html>",
    "",
  ].join("\n");
}

// Fix #8: validate color before emit; drop invalid tokens rather than emitting them.
const colorLine = (token: ColorToken, index: number): string | undefined =>
  isSafeColor(token.value) ? `${indent(1)}${colorVar(index)}: ${token.value};` : undefined;

const spaceLine = (token: SpacingToken, index: number): string | undefined =>
  Number.isFinite(token.value)
    ? `${indent(1)}${spaceVar(index)}: ${String(token.value)}px;`
    : undefined;

const radiusLine = (token: RadiusToken, index: number): string | undefined =>
  Number.isFinite(token.value)
    ? `${indent(1)}${radiusVar(index)}: ${String(token.value)}px;`
    : undefined;

// Fix #8: fontFamily is sanitized via safeFontFamily (quoted + injection chars stripped).
// Weight, size, lineHeight are validated as finite numbers before emit.
const fontLine = (token: TypographyToken, index: number): string | undefined => {
  if (
    !Number.isFinite(token.fontWeight) ||
    !Number.isFinite(token.fontSize) ||
    !Number.isFinite(token.lineHeight)
  ) {
    return undefined;
  }
  return (
    `${indent(1)}${fontVar(index)}: ${String(token.fontWeight)} ${String(token.fontSize)}px/` +
    `${String(token.lineHeight)}px ${safeFontFamily(token.fontFamily)};`
  );
};

function renderTokensCss(tokens: DesignTokens): string {
  const lines: string[] = [
    ...tokens.colors.map(colorLine).filter((l): l is string => l !== undefined),
    ...tokens.spacing.map(spaceLine).filter((l): l is string => l !== undefined),
    ...tokens.radius.map(radiusLine).filter((l): l is string => l !== undefined),
    ...tokens.typography.map(fontLine).filter((l): l is string => l !== undefined),
  ];
  return [
    "/* Design tokens (deterministic, from the Figma Snapshot Screen-IR). */",
    ":root {",
    ...lines,
    "}",
    "",
  ].join("\n");
}

function emitHtmlCss(plan: CodeEmissionPlan): CodeArtifact {
  const safeNames = buildSafeNameIndex(plan.screens);
  const lookups = buildTokenLookups(plan.tokens);
  const files: CodeFile[] = [
    { path: "index.html", contents: renderIndexHtml(plan.screens, safeNames) },
    { path: "tokens.css", contents: renderTokensCss(plan.tokens) },
    ...plan.screens.map((screen) => {
      const safeName = safeNames.get(screen.screenId) ?? sanitizeScreenFileName(screen.screenId);
      return {
        path: `screens/${safeName}.html`,
        contents: renderScreenHtml(screen, safeNames, lookups),
      };
    }),
  ];
  return { adapterName: ADAPTER_NAME, files };
}

/**
 * The framework-agnostic HTML/CSS adapter — the only adapter shipped in the first slice. Renders the
 * target-neutral plan to semantic HTML per screen, a `tokens.css` custom-property table, and an
 * `index.html`. Pure and deterministic: a given plan yields a byte-identical artifact.
 *
 * Layout fidelity: nodes with auto-layout emit display:flex + direction + gap + padding + radius in a
 * per-screen `<style>` block; TEXT nodes with matching typography tokens emit var(--font-N); fill-sized
 * nodes emit flex:1 / width:100%. Absolute positioning, constraints, effects, and image content are
 * not reproduced.
 */
export const htmlCssAdapter: CodeTargetAdapter = {
  name: ADAPTER_NAME,
  emit: emitHtmlCss,
};
