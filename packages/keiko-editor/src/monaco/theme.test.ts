import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CHROME_TOKEN_COLOR_IDS,
  EDITOR_THEME_DEAD_COLOR_IDS,
  EDITOR_THEME_NAME,
  EDITOR_THEME_TOKEN_NAMES,
  EDITOR_THEME_VARIANTS,
  MONACO_BASE_THEME,
  SYNTAX_TOKEN_SCOPES,
  buildKeikoEditorMonacoTheme,
  registerKeikoEditorTheme,
  type EditorThemeVariant,
  type ResolvedEditorThemeTokens,
} from "./theme.js";

/** Build a fixture where every token has a unique, deterministic hex so mapping is verifiable. */
function fakeResolvedTokens(): Record<string, string> {
  const tokens: Record<string, string> = {};
  EDITOR_THEME_TOKEN_NAMES.forEach((name, index) => {
    tokens[name] = `#${(index + 1).toString(16).padStart(6, "0")}`;
  });
  return tokens;
}

describe("theme token contract", () => {
  it("derives EDITOR_THEME_TOKEN_NAMES from the syntax + chrome maps with no duplicates", () => {
    const expected = [...Object.keys(SYNTAX_TOKEN_SCOPES), ...Object.keys(CHROME_TOKEN_COLOR_IDS)];
    expect([...EDITOR_THEME_TOKEN_NAMES]).toEqual(expected);
    expect(new Set(EDITOR_THEME_TOKEN_NAMES).size).toBe(EDITOR_THEME_TOKEN_NAMES.length);
  });

  it("names twelve syntax tokens and maps each to at least one scope", () => {
    expect(Object.keys(SYNTAX_TOKEN_SCOPES)).toHaveLength(12);
    for (const scopes of Object.values(SYNTAX_TOKEN_SCOPES)) {
      expect(scopes.length).toBeGreaterThan(0);
    }
  });

  it("maps editor-theme.html §06 design tokens to the documented Monaco targets", () => {
    // tokenColors (TextMate scopes) per the §06 'How engineering wires it' table.
    expect(SYNTAX_TOKEN_SCOPES["--ed-syn-keyword"]).toEqual(
      expect.arrayContaining(["keyword", "storage.type", "keyword.control"]),
    );
    expect(SYNTAX_TOKEN_SCOPES["--ed-syn-string"]).toEqual(
      expect.arrayContaining(["string", "string.template"]),
    );
    expect(SYNTAX_TOKEN_SCOPES["--ed-syn-comment"]).toEqual(
      expect.arrayContaining(["comment", "punctuation.definition.comment"]),
    );
    expect(SYNTAX_TOKEN_SCOPES["--ed-syn-type"]).toEqual(
      expect.arrayContaining(["entity.name.type", "support.class"]),
    );
    expect(SYNTAX_TOKEN_SCOPES["--ed-syn-function"]).toEqual(
      expect.arrayContaining(["entity.name.function", "support.function"]),
    );
    expect(SYNTAX_TOKEN_SCOPES["--ed-syn-property"]).toEqual(
      expect.arrayContaining(["variable.other.property", "meta.object-literal.key"]),
    );
    // colors dictionary per the §06 table (a token may drive several Monaco colour ids).
    expect(CHROME_TOKEN_COLOR_IDS["--ed-bg"]).toEqual(["editor.background"]);
    expect(CHROME_TOKEN_COLOR_IDS["--ed-fg"]).toEqual(["editor.foreground"]);
    expect(CHROME_TOKEN_COLOR_IDS["--ed-line-active"]).toEqual(["editor.lineHighlightBackground"]);
    expect(CHROME_TOKEN_COLOR_IDS["--ed-selection"]).toEqual(["editor.selectionBackground"]);
    expect(CHROME_TOKEN_COLOR_IDS["--ed-diff-ins-line"]).toEqual([
      "diffEditor.insertedLineBackground",
    ]);
    expect(CHROME_TOKEN_COLOR_IDS["--ed-diff-rem-line"]).toEqual([
      "diffEditor.removedLineBackground",
    ]);
    expect(CHROME_TOKEN_COLOR_IDS["--ed-diff-ins-text"]).toEqual([
      "diffEditor.insertedTextBackground",
    ]);
    expect(CHROME_TOKEN_COLOR_IDS["--ed-diff-rem-text"]).toEqual([
      "diffEditor.removedTextBackground",
    ]);
    expect(CHROME_TOKEN_COLOR_IDS["--ed-error"]).toEqual(["editorError.foreground"]);
    expect(CHROME_TOKEN_COLOR_IDS["--ed-warn"]).toEqual(["editorWarning.foreground"]);
    expect(CHROME_TOKEN_COLOR_IDS["--ed-info"]).toEqual(["editorInfo.foreground"]);
    expect(CHROME_TOKEN_COLOR_IDS["--ed-ghost"]).toEqual(["editorGhostText.foreground"]);
    // Finalized #1212 token (#1232): the focus ring maps to several registered Monaco ids.
    expect(CHROME_TOKEN_COLOR_IDS["--ed-focus"]).toEqual([
      "focusBorder",
      "editorWidget.border",
      "editor.findMatchBorder",
    ]);
  });

  it("does not map the diff-gutter tokens to Monaco theme colours (handled by decorations in #1195)", () => {
    // Their natural targets are VS Code SCM colours monaco-editor 0.55.1 standalone never registers,
    // so a theme mapping would be an inert no-op. They stay surfaced in globals.css for the diff editor.
    expect(CHROME_TOKEN_COLOR_IDS["--ed-diff-ins-gutter"]).toBeUndefined();
    expect(CHROME_TOKEN_COLOR_IDS["--ed-diff-rem-gutter"]).toBeUndefined();
    expect(CHROME_TOKEN_COLOR_IDS["--ed-diff-chg-gutter"]).toBeUndefined();
  });

  it("never emits a colour id that monaco-editor 0.55.1 standalone does not register", () => {
    const tokens = fakeResolvedTokens();
    for (const variant of EDITOR_THEME_VARIANTS) {
      const theme = buildKeikoEditorMonacoTheme(variant, tokens);
      for (const deadId of EDITOR_THEME_DEAD_COLOR_IDS) {
        expect(theme.colors[deadId], `${deadId} must not be in the built theme`).toBeUndefined();
      }
    }
  });
});

describe("buildKeikoEditorMonacoTheme", () => {
  it("inherits the correct Monaco base theme per variant", () => {
    const tokens = fakeResolvedTokens();
    expect(buildKeikoEditorMonacoTheme("dark", tokens).base).toBe("vs-dark");
    expect(buildKeikoEditorMonacoTheme("light", tokens).base).toBe("vs");
    expect(buildKeikoEditorMonacoTheme("high-contrast", tokens).base).toBe("hc-black");
    for (const variant of EDITOR_THEME_VARIANTS) {
      expect(buildKeikoEditorMonacoTheme(variant, tokens).inherit).toBe(true);
      expect(MONACO_BASE_THEME[variant]).toBe(buildKeikoEditorMonacoTheme(variant, tokens).base);
    }
  });

  it("maps each syntax token onto rules whose foreground is the resolved hex without '#'", () => {
    const tokens = fakeResolvedTokens();
    const theme = buildKeikoEditorMonacoTheme("dark", tokens);
    for (const [tokenName, scopes] of Object.entries(SYNTAX_TOKEN_SCOPES)) {
      const expectedForeground = (tokens[tokenName] ?? "").slice(1);
      for (const scope of scopes) {
        const rule = theme.rules.find((r) => r.token === scope);
        expect(rule, `rule for scope ${scope}`).toBeDefined();
        expect(rule?.foreground).toBe(expectedForeground);
      }
    }
  });

  it("renders comment scopes italic, matching the #1212 source", () => {
    const theme = buildKeikoEditorMonacoTheme("dark", fakeResolvedTokens());
    const commentRule = theme.rules.find((r) => r.token === "comment");
    expect(commentRule?.fontStyle).toBe("italic");
    const keywordRule = theme.rules.find((r) => r.token === "keyword");
    expect(keywordRule?.fontStyle).toBeUndefined();
  });

  it("maps each chrome token onto its colour id with the resolved hex including '#'", () => {
    const tokens = fakeResolvedTokens();
    const theme = buildKeikoEditorMonacoTheme("light", tokens);
    for (const [tokenName, colorIds] of Object.entries(CHROME_TOKEN_COLOR_IDS)) {
      for (const colorId of colorIds) {
        expect(theme.colors[colorId]).toBe(tokens[tokenName]);
      }
    }
  });

  it("normalises hex with or without a leading '#' (rules drop it, colors keep it)", () => {
    const tokens = fakeResolvedTokens();
    // Provide a no-'#' value for a syntax + a chrome token; builder must normalise both directions.
    tokens["--ed-syn-keyword"] = "abcdef";
    tokens["--ed-bg"] = "123456";
    const theme = buildKeikoEditorMonacoTheme("dark", tokens);
    expect(theme.rules.find((r) => r.token === "keyword")?.foreground).toBe("abcdef");
    expect(theme.colors["editor.background"]).toBe("#123456");
  });

  it("uses only caller-supplied colours — never an embedded literal", () => {
    const tokens = fakeResolvedTokens();
    const allowed = new Set<string>();
    for (const value of Object.values(tokens)) {
      allowed.add(value);
      allowed.add(value.slice(1));
    }
    const theme = buildKeikoEditorMonacoTheme("dark", tokens);
    for (const rule of theme.rules) {
      expect(allowed.has(rule.foreground ?? "")).toBe(true);
    }
    for (const value of Object.values(theme.colors)) {
      expect(allowed.has(value)).toBe(true);
    }
  });

  it("throws an actionable error naming a missing token", () => {
    const tokens = fakeResolvedTokens();
    delete tokens["--ed-syn-keyword"];
    expect(() => buildKeikoEditorMonacoTheme("dark", tokens)).toThrow(/--ed-syn-keyword/);
  });

  it("throws when a token resolves to an empty string", () => {
    const tokens = fakeResolvedTokens();
    tokens["--ed-bg"] = "   ";
    expect(() => buildKeikoEditorMonacoTheme("dark", tokens)).toThrow(/--ed-bg/);
  });
});

describe("registerKeikoEditorTheme", () => {
  it("defines the variant theme on the injected registrar and returns its name", () => {
    const defined: { name: string; base: string }[] = [];
    const registrar = {
      defineTheme(name: string, data: { base: string }): void {
        defined.push({ name, base: data.base });
      },
    };
    const tokens: ResolvedEditorThemeTokens = fakeResolvedTokens();
    const variants: EditorThemeVariant[] = ["dark", "light", "high-contrast"];
    for (const variant of variants) {
      const returned = registerKeikoEditorTheme(registrar, variant, tokens);
      expect(returned).toBe(EDITOR_THEME_NAME[variant]);
    }
    expect(defined.map((d) => d.name)).toEqual([
      "keiko-editor-dark",
      "keiko-editor-light",
      "keiko-editor-high-contrast",
    ]);
    expect(defined.map((d) => d.base)).toEqual(["vs-dark", "vs", "hc-black"]);
  });
});

/** Remove block/JSDoc comments so the scan inspects code, not documentation prose. */
function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("theme code carries no colour literals (Issue #1193 AC)", () => {
  it("theme.ts maps tokens only — no hex/oklch/rgb/color-mix literal", () => {
    const code = stripBlockComments(
      readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "theme.ts"), "utf8"),
    );
    expect(code).not.toMatch(/#[0-9a-fA-F]{3}\b/);
    expect(code).not.toMatch(/#[0-9a-fA-F]{6}\b/);
    expect(code).not.toMatch(/#[0-9a-fA-F]{8}\b/);
    expect(code).not.toMatch(/\boklch\s*\(/);
    expect(code).not.toMatch(/\bcolor-mix\s*\(/);
    expect(code).not.toMatch(/\brgba?\s*\(/);
  });
});
