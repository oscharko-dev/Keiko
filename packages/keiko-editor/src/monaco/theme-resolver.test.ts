import { describe, expect, it } from "vitest";

import { EDITOR_THEME_TOKEN_NAMES } from "./theme.js";
import {
  createDomEditorTokenResolverDeps,
  hexFromColorString,
  resolveEditorThemeTokens,
  resolveEditorThemeTokensFromDom,
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
      dispose: () => undefined,
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
      dispose: () => undefined,
    });
    expect(seen).toEqual([...EDITOR_THEME_TOKEN_NAMES]);
  });

  it("throws naming a token absent from the runtime stylesheet", () => {
    const deps: EditorTokenResolverDeps = {
      readResolvedColor: (name) => (name === "--ed-bg" ? "" : "#000000"),
      toHex: hexFromColorString,
      dispose: () => undefined,
    };
    expect(() => resolveEditorThemeTokens(deps)).toThrow(/--ed-bg/);
  });
});

describe("DOM editor token resolver", () => {
  function fakeView(options: { computedProbeColor: string; rootTokenValue?: string }): {
    view: Window;
    root: HTMLElement;
    events: { appended: number; removed: number };
  } {
    const events = { appended: 0, removed: 0 };
    const probe = {
      style: {} as Record<string, string>,
      remove: (): void => {
        events.removed += 1;
      },
    };
    let fill = "";
    const context = {
      set fillStyle(value: string) {
        if (value.startsWith("#")) {
          fill = value;
          return;
        }
        if (value.startsWith("rgb")) {
          fill = hexFromColorString(value);
          return;
        }
        if (value.startsWith("oklch")) {
          fill = value;
        }
      },
      get fillStyle(): string {
        return fill;
      },
    };
    const document = {
      createElement: (tag: string): unknown =>
        tag === "canvas" ? { getContext: (): unknown => context } : probe,
    };
    const view = {
      document,
      getComputedStyle(target: unknown): unknown {
        if (target === root) {
          return {
            getPropertyValue: (): string => options.rootTokenValue ?? options.computedProbeColor,
          };
        }
        return { color: options.computedProbeColor };
      },
    };
    const root = {
      appendChild: (): void => {
        events.appended += 1;
      },
    };
    return {
      view: view as unknown as Window,
      root: root as unknown as HTMLElement,
      events,
    };
  }

  it("checks custom-property presence on the root before reading inherited probe colour", () => {
    const { root, view } = fakeView({
      computedProbeColor: "rgb(10, 20, 30)",
      rootTokenValue: "",
    });
    const deps = createDomEditorTokenResolverDeps(root, view);
    expect(deps.readResolvedColor("--ed-bg")).toBe("");
    deps.dispose();
  });

  it("normalises browser-computed oklch colours", () => {
    const { root, view } = fakeView({
      computedProbeColor: "oklch(0.16 0.004 160)",
    });
    const deps = createDomEditorTokenResolverDeps(root, view);
    expect(deps.readResolvedColor("--ed-bg")).toBe("oklch(0.16 0.004 160)");
    expect(deps.toHex("oklch(0.16 0.004 160)")).toBe("#0c0e0d");
    deps.dispose();
  });

  it("fails closed when the canvas rejects a colour assignment", () => {
    const { root, view } = fakeView({ computedProbeColor: "not-a-colour" });
    const deps = createDomEditorTokenResolverDeps(root, view);
    expect(() => deps.toHex("not-a-colour")).toThrow(/could not parse/);
    deps.dispose();
  });

  it("resolves all tokens and removes its probe (no DOM leak)", () => {
    const { view, root, events } = fakeView({ computedProbeColor: "rgb(16, 32, 48)" });
    const resolved = resolveEditorThemeTokensFromDom(root, view);
    expect(Object.keys(resolved).sort()).toEqual([...EDITOR_THEME_TOKEN_NAMES].sort());
    expect(events.appended).toBe(1);
    expect(events.removed).toBe(1);
  });

  it("disposes the probe even when the browser rejects a colour (two-sentinel guard)", () => {
    const { view, root, events } = fakeView({ computedProbeColor: "not-a-parseable-colour" });
    expect(() => resolveEditorThemeTokensFromDom(root, view)).toThrow(/could not parse/);
    expect(events.removed).toBe(1);
  });
});
