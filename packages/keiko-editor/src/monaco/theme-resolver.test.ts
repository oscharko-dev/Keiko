import { describe, expect, it } from "vitest";

import { EDITOR_THEME_TOKEN_NAMES } from "./theme.js";
import {
  hexFromColorString,
  resolveEditorThemeTokens,
  type EditorTokenResolverDeps,
} from "./theme-resolver.js";

describe("hexFromColorString", () => {
  it("expands short hex (#rgb, #rgba)", () => {
    expect(hexFromColorString("#abc")).toBe("#aabbcc");
    expect(hexFromColorString("#abcd")).toBe("#aabbccdd");
  });

  it("passes through and lower-cases full hex", () => {
    expect(hexFromColorString("#AABBCC")).toBe("#aabbcc");
    expect(hexFromColorString("#7EA7FF42")).toBe("#7ea7ff42");
  });

  it("converts legacy comma rgb()/rgba() to hex", () => {
    expect(hexFromColorString("rgb(199, 146, 234)")).toBe("#c792ea");
    expect(hexFromColorString("rgba(126, 167, 255, 0.26)")).toBe("#7ea7ff42");
  });

  it("converts modern space/slash rgb() syntax to hex", () => {
    expect(hexFromColorString("rgb(255 128 0)")).toBe("#ff8000");
    expect(hexFromColorString("rgb(255 128 0 / 0.5)")).toBe("#ff800080");
  });

  it("converts percentage channels", () => {
    expect(hexFromColorString("rgb(100% 50% 0%)")).toBe("#ff8000");
  });

  it("drops a fully-opaque alpha channel", () => {
    expect(hexFromColorString("rgba(0, 0, 0, 1)")).toBe("#000000");
  });

  it("throws on colour forms it cannot convert (post-canvas these never occur)", () => {
    expect(() => hexFromColorString("oklch(0.5 0.1 160)")).toThrow(/cannot convert/);
    expect(() => hexFromColorString("rebeccapurple")).toThrow(/cannot convert/);
    expect(() => hexFromColorString("#12")).toThrow(/unparseable hex/);
  });
});

describe("resolveEditorThemeTokens", () => {
  function depsReturning(color: string): EditorTokenResolverDeps {
    return {
      readResolvedColor: () => color,
      toHex: hexFromColorString,
    };
  }

  it("resolves exactly the editor theme token contract to hex", () => {
    const resolved = resolveEditorThemeTokens(depsReturning("rgb(16, 32, 48)"));
    expect(Object.keys(resolved).sort()).toEqual([...EDITOR_THEME_TOKEN_NAMES].sort());
    for (const value of Object.values(resolved)) {
      expect(value).toBe("#102030");
    }
  });

  it("passes each token name through to the colour reader", () => {
    const seen: string[] = [];
    resolveEditorThemeTokens({
      readResolvedColor: (name) => {
        seen.push(name);
        return "#000000";
      },
      toHex: hexFromColorString,
    });
    expect(seen).toEqual([...EDITOR_THEME_TOKEN_NAMES]);
  });

  it("throws naming a token absent from the runtime stylesheet", () => {
    const deps: EditorTokenResolverDeps = {
      readResolvedColor: (name) => (name === "--ed-bg" ? "" : "#000000"),
      toHex: hexFromColorString,
    };
    expect(() => resolveEditorThemeTokens(deps)).toThrow(/--ed-bg/);
  });
});
