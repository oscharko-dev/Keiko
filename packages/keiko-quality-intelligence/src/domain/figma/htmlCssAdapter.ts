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
// IO, no model, no Date — a given plan yields a byte-identical artifact. All text and attribute values
// are HTML-escaped so the reviewable artifact cannot inject markup.
//
// CSS value handling: fontFamily tokens are emitted as quoted strings with embedded double-quotes
// escaped and control/injection characters ('{', '}', ';', '</', '*/', newlines) stripped, so a
// hostile font name cannot break out of the custom-property declaration. Color tokens are validated
// against /^#[0-9a-fA-F]{3,8}$/ and numeric tokens as finite numbers; invalid values are dropped
// rather than emitted.
//
// Screen file names: Figma ids may contain ':' (Windows-invalid) and ';' (URI scheme risk in hrefs).
// sanitizeScreenFileName replaces /[:;]/g with '-'. Collisions after substitution are resolved by a
// numeric suffix. All relative hrefs inside screen HTML are prefixed with './' so they are relative
// to the screens/ directory, not ambiguous URI-scheme fragments. The raw screen id is preserved in
// the data-screen-id attribute.

import type { CodeArtifact, CodeFile, CodeTargetAdapter } from "./codeTargetAdapter.js";
import type {
  CodeEmissionPlan,
  EmissionElement,
  EmissionNavTarget,
  EmissionRole,
  ScreenEmission,
} from "./emissionPlan.js";
import type {
  ColorToken,
  DesignTokens,
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

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/gu, (char) => HTML_ESCAPES[char] ?? char);

const indent = (depth: number): string => INDENT.repeat(depth);

// ─── Fix #7: safe screen file names ──────────────────────────────────────────
//
// Figma ids contain ':' (invalid on Windows file paths) and INSTANCE ids contain ';' which is
// parsed as a URI scheme separator in sibling hrefs (e.g. "I123:456;789:12.html" → opaque URI).
// We replace /[:;]/g with '-'; ids are unique before substitution so collisions are rare, but a
// numeric suffix is appended defensively.
function buildSafeNameIndex(screens: readonly ScreenEmission[]): ReadonlyMap<string, string> {
  const seen = new Map<string, number>();
  const result = new Map<string, string>();
  for (const screen of screens) {
    const base = screen.screenId.replace(/[:;]/gu, "-");
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
  const cleaned = family.replace(CSS_INJECTION_RE, "").replace(/"/gu, "\\22 ");
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

// Fix #6: additionally emit data-node-id so the element's IR origin is traceable in the HTML output.
function elementAttributes(element: EmissionElement): string {
  const parts = [
    `data-role="${escapeHtml(element.role)}"`,
    `data-name="${escapeHtml(element.displayName)}"`,
    `data-node-id="${escapeHtml(element.id)}"`,
  ];
  if (element.role === "link") parts.push('href="#"');
  if (element.role === "input") parts.push(`aria-label="${escapeHtml(element.displayName)}"`);
  if (element.role === "image") parts.push(`alt="${escapeHtml(element.displayName)}"`);
  return parts.join(" ");
}

function renderElement(element: EmissionElement, depth: number): readonly string[] {
  const tag = TAG_BY_ROLE[element.role];
  const attributes = elementAttributes(element);
  if (VOID_ROLES.has(element.role)) {
    return [`${indent(depth)}<${tag} ${attributes} />`];
  }
  const lines: string[] = [`${indent(depth)}<${tag} ${attributes}>`];
  if (element.text !== undefined) lines.push(`${indent(depth + 1)}${escapeHtml(element.text)}`);
  for (const child of element.children) lines.push(...renderElement(child, depth + 1));
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
    const safeName = safeNames.get(target.toScreenId) ?? target.toScreenId.replace(/[:;]/gu, "-");
    const href = `./${escapeHtml(safeName)}.html`;
    const trigger = escapeHtml(target.trigger);
    const label = escapeHtml(target.toScreenName);
    lines.push(`${indent(depth + 1)}<a href="${href}" data-trigger="${trigger}">${label}</a>`);
  }
  lines.push(`${indent(depth)}</nav>`);
  return lines;
}

// Fix #7: screen file uses safe name; raw id is preserved in data-screen-id for traceability.
function renderScreenHtml(screen: ScreenEmission, safeNames: ReadonlyMap<string, string>): string {
  const title = escapeHtml(screen.screenName);
  const body = [
    ...renderNav(screen.navTargets, safeNames, 3),
    `${indent(3)}<main data-screen-id="${escapeHtml(screen.screenId)}">`,
    ...renderElement(screen.root, 4),
    `${indent(3)}</main>`,
  ];
  return [
    "<!doctype html>",
    '<html lang="en">',
    `${indent(1)}<head>`,
    `${indent(2)}<meta charset="utf-8" />`,
    `${indent(2)}<title>${title}</title>`,
    `${indent(2)}<link rel="stylesheet" href="../tokens.css" />`,
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
    const safeName = safeNames.get(screen.screenId) ?? screen.screenId.replace(/[:;]/gu, "-");
    return (
      `${indent(3)}<li><a href="screens/${escapeHtml(safeName)}.html">` +
      `${escapeHtml(screen.screenName)}</a></li>`
    );
  });
  return [
    "<!doctype html>",
    '<html lang="en">',
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

const colorVar = (index: number): string => `--color-${String(index + 1)}`;
const spaceVar = (index: number): string => `--space-${String(index + 1)}`;
const radiusVar = (index: number): string => `--radius-${String(index + 1)}`;
const fontVar = (index: number): string => `--font-${String(index + 1)}`;

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
  const files: CodeFile[] = [
    { path: "index.html", contents: renderIndexHtml(plan.screens, safeNames) },
    { path: "tokens.css", contents: renderTokensCss(plan.tokens) },
    ...plan.screens.map((screen) => {
      const safeName = safeNames.get(screen.screenId) ?? screen.screenId.replace(/[:;]/gu, "-");
      return {
        path: `screens/${safeName}.html`,
        contents: renderScreenHtml(screen, safeNames),
      };
    }),
  ];
  return { adapterName: ADAPTER_NAME, files };
}

/**
 * The framework-agnostic HTML/CSS adapter — the only adapter shipped in the first slice. Renders the
 * target-neutral plan to semantic HTML per screen, a `tokens.css` custom-property table, and an
 * `index.html`. Pure and deterministic: a given plan yields a byte-identical artifact.
 */
export const htmlCssAdapter: CodeTargetAdapter = {
  name: ADAPTER_NAME,
  emit: emitHtmlCss,
};
