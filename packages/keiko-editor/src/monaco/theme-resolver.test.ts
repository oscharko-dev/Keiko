import { describe, expect, it } from "vitest";

import { EDITOR_THEME_TOKEN_NAMES } from "./theme.js";
import {
  createDomEditorTokenResolverDeps,
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

  it("converts browser-normalised oklch() colours to hex", () => {
    expect(hexFromColorString("oklch(0.16 0.004 160)")).toBe("#0c0e0d");
    expect(hexFromColorString("oklch(0.627966 0.257704 29.2346 / 0.5)")).toBe("#ff000080");
    expect(hexFromColorString("oklch(98.5% 0.003 160)")).toBe("#f8fbf9");
  });

  it("converts percentage channels", () => {
    expect(hexFromColorString("rgb(100% 50% 0%)")).toBe("#ff8000");
  });

  it("drops a fully-opaque alpha channel", () => {
    expect(hexFromColorString("rgba(0, 0, 0, 1)")).toBe("#000000");
  });

  it("throws on colour forms it cannot convert (post-canvas these never occur)", () => {
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

describe("createDomEditorTokenResolverDeps", () => {
  function createFakeView(options: {
    rootTokenValue: string;
    computedProbeColor: string;
    acceptedColors?: ReadonlySet<string>;
  }): {
    root: HTMLElement;
    view: Window;
  } {
    let fillStyle = "#000000";
    const acceptedColors =
      options.acceptedColors ?? new Set([options.computedProbeColor, "#010203"]);
    const probe = {
      remove(): undefined {
        return undefined;
      },
      style: {
        color: "",
        pointerEvents: "",
        position: "",
        visibility: "",
      },
    };
    const root = {
      appendChild(): undefined {
        return undefined;
      },
    };
    const view = {
      document: {
        createElement(tagName: string): unknown {
          if (tagName === "canvas") {
            return {
              getContext: () => ({
                get fillStyle(): string {
                  return fillStyle;
                },
                set fillStyle(value: string) {
                  if (acceptedColors.has(value)) {
                    fillStyle = value;
                  }
                },
              }),
            };
          }
          return probe;
        },
      },
      getComputedStyle(target: unknown): unknown {
        if (target === root) {
          return { getPropertyValue: () => options.rootTokenValue };
        }
        return { color: options.computedProbeColor };
      },
    };
    return { root: root as unknown as HTMLElement, view: view as unknown as Window };
  }

  it("checks custom-property presence on the root before reading inherited probe colour", () => {
    const { root, view } = createFakeView({
      computedProbeColor: "rgb(10, 20, 30)",
      rootTokenValue: "",
    });
    const deps = createDomEditorTokenResolverDeps(root, view);
    expect(deps.readResolvedColor("--ed-bg")).toBe("");
  });

  it("normalises browser-computed oklch colours", () => {
    const { root, view } = createFakeView({
      computedProbeColor: "oklch(0.16 0.004 160)",
      rootTokenValue: "oklch(0.16 0.004 160)",
    });
    const deps = createDomEditorTokenResolverDeps(root, view);
    expect(deps.readResolvedColor("--ed-bg")).toBe("oklch(0.16 0.004 160)");
    expect(deps.toHex("oklch(0.16 0.004 160)")).toBe("#0c0e0d");
  });

  it("fails closed when the canvas rejects a colour assignment", () => {
    const { root, view } = createFakeView({
      acceptedColors: new Set(["#010203"]),
      computedProbeColor: "not-a-colour",
      rootTokenValue: "not-a-colour",
    });
    const deps = createDomEditorTokenResolverDeps(root, view);
    expect(() => deps.toHex("not-a-colour")).toThrow(/cannot convert/);
  });
});
