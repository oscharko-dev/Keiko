/**
 * Runtime resolver: read the Keiko Editor design tokens (#1212) from the live DOM and convert them
 * to the hex colours Monaco's `Color.fromHex` requires (Issue #1193).
 *
 * The `--ed-*` / `--ed-syn-*` tokens are authored in `design-system/keiko-editor-tokens.css` (and
 * lifted into the keiko-ui runtime) as `oklch()` / `color-mix()` / `var()` expressions. Monaco
 * cannot consume those forms, so this resolver reads each token's *computed* colour from a probe
 * element (which the browser resolves to a concrete colour), normalises it to `#rrggbb` /
 * `#rrggbbaa`, and returns the {@link ResolvedEditorThemeTokens} the pure theme builder
 * (`./theme.ts`) maps. Resolving from the DOM — never embedding literals — keeps the #1212 tokens
 * the single source of truth and lets the theme follow runtime theme/contrast switches.
 *
 * The DOM/canvas edges are injected, so the resolution logic and the colour conversion are pure and
 * node-testable; only the thin default browser factories touch `document`/`getComputedStyle`.
 */

import { EDITOR_THEME_TOKEN_NAMES, type ResolvedEditorThemeTokens } from "./theme.js";

/** Injected colour access used by {@link resolveEditorThemeTokens}. */
export interface EditorTokenResolverDeps {
  /** Resolve a CSS custom property name (e.g. `--ed-syn-keyword`) to a concrete CSS colour string. */
  readResolvedColor(cssVariableName: string): string;
  /** Normalise a concrete CSS colour string to `#rrggbb` / `#rrggbbaa`. */
  toHex(cssColor: string): string;
  /** Release any resources the deps hold (e.g. a DOM probe element). Safe to call more than once. */
  dispose(): void;
}

function toByte(value: number): string {
  const clamped = Math.min(255, Math.max(0, Math.round(value)));
  return clamped.toString(16).padStart(2, "0");
}

function channelToByte(token: string): string {
  const text = token.trim();
  if (text.endsWith("%")) {
    return toByte((Number.parseFloat(text) / 100) * 255);
  }
  return toByte(Number.parseFloat(text));
}

function alphaToByte(token: string): string {
  const text = token.trim();
  const value = text.endsWith("%") ? Number.parseFloat(text) / 100 : Number.parseFloat(text);
  return toByte(value * 255);
}

function expandShortHex(hex: string): string {
  // #rgb -> #rrggbb, #rgba -> #rrggbbaa
  const body = hex
    .slice(1)
    .split("")
    .map((c) => c + c)
    .join("");
  return `#${body.toLowerCase()}`;
}

function hexFromHashColor(color: string): string {
  if (color.length === 4 || color.length === 5) {
    return expandShortHex(color);
  }
  if (color.length === 7 || color.length === 9) {
    return color;
  }
  throw new Error(`Keiko editor theme: unparseable hex colour "${color}".`);
}

function hexFromRgbColor(color: string): string | undefined {
  const rgbMatch = /^rgba?\(([^)]+)\)$/.exec(color);
  if (rgbMatch?.[1] === undefined) {
    return undefined;
  }
  const parts = rgbMatch[1].split(/[,/\s]+/).filter((part) => part !== "");
  const [r, g, b, alpha] = parts;
  if (r === undefined || g === undefined || b === undefined) {
    throw new Error(`Keiko editor theme: unparseable rgb colour "${color}".`);
  }
  const base = `#${channelToByte(r)}${channelToByte(g)}${channelToByte(b)}`;
  if (alpha === undefined) {
    return base;
  }
  const alphaByte = alphaToByte(alpha);
  return alphaByte === "ff" ? base : `${base}${alphaByte}`;
}

/**
 * Normalise a concrete CSS colour string to Monaco hex (`#rrggbb` or `#rrggbbaa`).
 *
 * Handles `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, and `rgb()/rgba()` in both legacy comma and
 * modern space/slash syntax. In the browser path the canvas normaliser feeds only `#rrggbb` /
 * `rgba(...)` here; any other form throws (actionable) so a bad token surfaces loudly rather than
 * producing an un-themed editor.
 * @internal Not part of the package public API (used by the DOM normaliser + tests).
 */
export function hexFromColorString(cssColor: string): string {
  const color = cssColor.trim().toLowerCase();
  if (color.startsWith("#")) {
    return hexFromHashColor(color);
  }
  const rgb = hexFromRgbColor(color);
  if (rgb !== undefined) {
    return rgb;
  }
  throw new Error(
    `Keiko editor theme: cannot convert colour "${cssColor}" to hex. ` +
      "Expected a hex or rgb()/rgba() value (the browser/canvas normaliser produces these).",
  );
}

/**
 * Resolve every editor theme token to hex using the injected colour access.
 *
 * Throws (naming the token) if a token resolves to an empty value, so a missing/mis-lifted token in
 * the runtime CSS fails loudly.
 */
export function resolveEditorThemeTokens(deps: EditorTokenResolverDeps): ResolvedEditorThemeTokens {
  const resolved: Record<string, string> = {};
  for (const tokenName of EDITOR_THEME_TOKEN_NAMES) {
    const raw = deps.readResolvedColor(tokenName);
    if (raw.trim() === "") {
      throw new Error(
        `Keiko editor theme: design token "${tokenName}" is not present in the runtime stylesheet. ` +
          "Ensure keiko-editor-tokens.css (#1212) is surfaced into the host token pipeline.",
      );
    }
    resolved[tokenName] = deps.toHex(raw);
  }
  return resolved;
}

/**
 * Browser default: build resolver deps backed by a probe element and a `<canvas>` colour normaliser.
 *
 * A hidden probe is attached under `rootElement` (so it inherits the `--ed-*` cascade); each token's
 * computed colour is read off the probe and normalised through a 2D canvas context, which serialises
 * any CSS colour (incl. `oklch`/`color-mix`) to `#rrggbb` / `rgba(...)`. Browser-only.
 */
export function createDomEditorTokenResolverDeps(
  rootElement: HTMLElement,
  view: Window = window,
): EditorTokenResolverDeps {
  const probe = view.document.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  rootElement.appendChild(probe);

  const canvas = view.document.createElement("canvas");
  const maybeContext = canvas.getContext("2d");
  if (maybeContext === null) {
    probe.remove();
    throw new Error("Keiko editor theme: a 2D canvas context is required to normalise colours.");
  }
  const context = maybeContext;

  function normaliseToHex(cssColor: string): string {
    // Canvas serialises any valid CSS colour (incl. oklch()/color-mix()) back as #rrggbb or
    // rgba(...), which hexFromColorString then normalises — a deliberate browser-native conversion.
    // The input is a host-authored --ed-* custom-property value (not user/network input), so this is
    // a normalisation step, not an injection sink. Two distinct reset sentinels detect a rejected
    // (unparseable) assignment: a valid colour overwrites both identically, a rejected one leaves the
    // two resets in place, so we fail loudly instead of silently returning a black fallback.
    context.fillStyle = "#000000";
    context.fillStyle = cssColor;
    const fromBlack = context.fillStyle;
    context.fillStyle = "#ffffff";
    context.fillStyle = cssColor;
    const fromWhite = context.fillStyle;
    if (fromBlack !== fromWhite) {
      throw new Error(`Keiko editor theme: the browser could not parse colour "${cssColor}".`);
    }
    return hexFromColorString(fromBlack);
  }

  return {
    readResolvedColor(cssVariableName: string): string {
      probe.style.color = `var(${cssVariableName})`;
      return view.getComputedStyle(probe).color;
    },
    toHex: normaliseToHex,
    dispose(): void {
      probe.remove();
    },
  };
}

/**
 * One-shot browser helper: resolve all editor theme tokens from the live DOM and clean up.
 *
 * Creates the probe deps, resolves the {@link ResolvedEditorThemeTokens}, and disposes the probe —
 * leaving no element behind even when re-called on theme/contrast switches. This is the recommended
 * host entry point; use {@link createDomEditorTokenResolverDeps} + {@link resolveEditorThemeTokens}
 * directly only when the deps must outlive a single resolution. Browser-only.
 */
export function resolveEditorThemeTokensFromDom(
  rootElement: HTMLElement,
  view: Window = window,
): ResolvedEditorThemeTokens {
  const deps = createDomEditorTokenResolverDeps(rootElement, view);
  try {
    return resolveEditorThemeTokens(deps);
  } finally {
    deps.dispose();
  }
}
