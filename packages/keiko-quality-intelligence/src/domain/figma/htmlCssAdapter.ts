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

// Map a target-neutral element role to a semantic HTML tag. Containers become <section>; everything
// else is the closest semantic element. No role yields a framework component.
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

function elementAttributes(element: EmissionElement): string {
  const parts = [
    `data-role="${escapeHtml(element.role)}"`,
    `data-name="${escapeHtml(element.displayName)}"`,
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

function renderNav(navTargets: readonly EmissionNavTarget[], depth: number): readonly string[] {
  if (navTargets.length === 0) return [];
  const lines: string[] = [`${indent(depth)}<nav aria-label="Screen navigation">`];
  for (const target of navTargets) {
    const href = `${escapeHtml(target.toScreenId)}.html`;
    const trigger = escapeHtml(target.trigger);
    const label = escapeHtml(target.toScreenName);
    lines.push(`${indent(depth + 1)}<a href="${href}" data-trigger="${trigger}">${label}</a>`);
  }
  lines.push(`${indent(depth)}</nav>`);
  return lines;
}

function renderScreenHtml(screen: ScreenEmission): string {
  const title = escapeHtml(screen.screenName);
  const body = [
    ...renderNav(screen.navTargets, 3),
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

function renderIndexHtml(screens: readonly ScreenEmission[]): string {
  const links = screens.map(
    (screen) =>
      `${indent(3)}<li><a href="screens/${escapeHtml(screen.screenId)}.html">` +
      `${escapeHtml(screen.screenName)}</a></li>`,
  );
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

const colorLine = (token: ColorToken, index: number): string =>
  `${indent(1)}${colorVar(index)}: ${token.value};`;

const spaceLine = (token: SpacingToken, index: number): string =>
  `${indent(1)}${spaceVar(index)}: ${String(token.value)}px;`;

const radiusLine = (token: RadiusToken, index: number): string =>
  `${indent(1)}${radiusVar(index)}: ${String(token.value)}px;`;

// A typography token becomes a font-shorthand-style custom property referencing its family + size.
const fontLine = (token: TypographyToken, index: number): string =>
  `${indent(1)}${fontVar(index)}: ${String(token.fontWeight)} ${String(token.fontSize)}px/` +
  `${String(token.lineHeight)}px ${token.fontFamily};`;

function renderTokensCss(tokens: DesignTokens): string {
  const lines = [
    ...tokens.colors.map(colorLine),
    ...tokens.spacing.map(spaceLine),
    ...tokens.radius.map(radiusLine),
    ...tokens.typography.map(fontLine),
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
  const files: CodeFile[] = [
    { path: "index.html", contents: renderIndexHtml(plan.screens) },
    { path: "tokens.css", contents: renderTokensCss(plan.tokens) },
    ...plan.screens.map((screen) => ({
      path: `screens/${screen.screenId}.html`,
      contents: renderScreenHtml(screen),
    })),
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
