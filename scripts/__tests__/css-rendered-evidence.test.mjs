import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compareColourProbes,
  rgbaClose,
  loadHtmlFixture,
  fixtureMediaProbe,
  renderedFixtureColours,
  measureFixtureScroll,
  captureResponsiveFixture,
} from "../lib/css-rendered-evidence.mjs";

afterEach(() => vi.unstubAllGlobals());
describe("shared design-system evidence mechanics", () => {
  it("retains the one-LSB channel tolerance and missing-colour semantics", () => {
    expect(rgbaClose("1,2,3,255", "2,3,4,255")).toBe(true);
    expect(rgbaClose("1,2,3,255", "3,2,3,255")).toBe(false);
    expect(rgbaClose("1,2,3", "1,2,3")).toBe(false);
    expect(rgbaClose("__MISSING__", "__MISSING__")).toBe(true);
    expect(rgbaClose("__MISSING__", "1,2,3,255")).toBe(false);
  });
  it("keeps property ordering, counts and every missing selector", () => {
    const reference = {
      ".present": { color: "1,2,3,255", background: "4,5,6,255" },
      ".missing": "__MISSING__",
    };
    const product = {
      ".present": { color: "3,2,3,255", background: "5,5,6,255" },
      ".missing": { color: "1,2,3,255" },
    };
    const result = compareColourProbes(
      reference,
      product,
      [
        [".present", ["color", "background"]],
        [".missing", ["color"]],
      ],
      "dark",
    );
    expect(result).toEqual({
      total: 2,
      missing: [".missing"],
      differences: [
        {
          mode: "dark",
          selector: ".present",
          prop: "color",
          reference: "1,2,3,255",
          product: "3,2,3,255",
        },
      ],
    });
    expect(compareColourProbes(product, reference, [[".missing", ["color"]]], "light")).toEqual({
      total: 0,
      missing: [".missing"],
      differences: [],
    });
  });
  it("retains the measured scroll sequence and sticky-header result", () => {
    const calls = [];
    class FixtureElement {
      position = 0;
      scrollHeight = 2000;
      clientHeight = 500;
      get scrollTop() {
        return this.position;
      }
      set scrollTop(value) {
        calls.push(value);
        this.position = Math.min(value, this.scrollHeight - this.clientHeight);
      }
      getBoundingClientRect() {
        return { top: 16 };
      }
    }
    const scroll = new FixtureElement();
    const header = new FixtureElement();
    let tick = 100;
    vi.stubGlobal("HTMLElement", FixtureElement);
    vi.stubGlobal("performance", { now: () => tick++ });
    vi.stubGlobal("document", {
      querySelector: (selector) => (selector === "#scroll" ? scroll : header),
      querySelectorAll: () => ({ length: 250 }),
    });
    expect(
      measureFixtureScroll({
        scrollSelector: "#scroll",
        headerSelector: "#header",
        rowSelector: "tr",
      }),
    ).toEqual({
      ok: true,
      rowCount: 250,
      durationMs: 1,
      afterScrollTop: 1500,
      scrollHeight: 2000,
      clientHeight: 500,
      stickyHeaderDeltaPx: 0,
    });
    expect(calls).toEqual([2000, 0, 1000]);
  });
  it("rejects missing bounded-scroll elements", () => {
    vi.stubGlobal(
      "HTMLElement",
      class FixtureElement {
        fixture = true;
      },
    );
    vi.stubGlobal("document", { querySelector: () => null, querySelectorAll: () => [] });
    expect(measureFixtureScroll({})).toEqual({
      ok: false,
      reason: "missing bounded-row smoke elements",
    });
  });
  it("closes the responsive fixture page when rendering fails", async () => {
    const page = {
      emulateMedia: vi.fn(),
      setViewportSize: vi.fn(),
      setContent: vi.fn().mockRejectedValue(new Error("fixture load failed")),
      close: vi.fn(),
    };
    await expect(
      captureResponsiveFixture(
        { newPage: async () => page },
        "<main></main>",
        { width: 560, height: 2000 },
        "/tmp/fixture.png",
      ),
    ).rejects.toThrow("fixture load failed");
    expect(page.close).toHaveBeenCalledOnce();
  });
});

function colourFixture() {
  const colours = new Map([
    ["#000", [0, 0, 0, 255]],
    ["rgb(1, 2, 3)", [1, 2, 3, 255]],
  ]);
  let active = "#000";
  const context = {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    get fillStyle() {
      return active;
    },
    set fillStyle(value) {
      if (colours.has(value)) active = value;
    },
    getImageData: () => ({ data: Uint8ClampedArray.from(colours.get(active)) }),
  };
  const element = { color: "rgb(1, 2, 3)", backgroundColor: "invalid-css-colour" };
  const document = {
    documentElement: {
      getPropertyValue: (name) => (name === "--known" ? "  rgb(1, 2, 3)  " : " "),
    },
    createElement: () => ({ getContext: () => context }),
    querySelector: (selector) => (selector.includes("missing") ? null : element),
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("getComputedStyle", (value) => value);
  return context;
}
it("clears stale fixture contrast after replacing the document", async () => {
  const dataset = { theme: "light", hc: "more" };
  vi.stubGlobal("document", {
    documentElement: {
      dataset,
      removeAttribute: vi.fn(() => {
        delete dataset.hc;
      }),
    },
  });
  const calls = [];
  const page = {
    emulateMedia: async () => {
      calls.push("media");
    },
    setContent: async () => {
      calls.push("html");
    },
    evaluate: async (fn, input) => {
      calls.push("theme");
      return fn(input);
    },
  };
  await loadHtmlFixture(
    page,
    "<main></main>",
    { theme: "dark", hc: null },
    { colorScheme: "dark" },
  );
  expect(calls).toEqual(["media", "html", "theme"]);
  expect(dataset).toEqual({ theme: "dark" });
});
it("records each media feature independently", async () => {
  vi.stubGlobal("matchMedia", (query) => ({
    matches: query === "(prefers-reduced-motion: reduce)",
  }));
  expect(await fixtureMediaProbe({ evaluate: async (fn) => fn() })).toEqual({
    reducedMotion: true,
    forcedColors: false,
    prefersContrast: false,
  });
});
it("resets an invalid pixel colour and keeps missing probe selectors visible", () => {
  const context = colourFixture();
  expect(
    renderedFixtureColours({
      kind: "probes",
      probes: [
        [".present", ["color", "backgroundColor"]],
        [".missing", ["color"]],
      ],
    }),
  ).toEqual({
    ".present": { color: "1,2,3,255", backgroundColor: "0,0,0,255" },
    ".missing": "__MISSING__",
  });
  expect(context.clearRect).toHaveBeenCalledTimes(2);
  expect(context.fillRect).toHaveBeenCalledTimes(2);
});
it("distinguishes undefined tokens from missing token probe elements", () => {
  colourFixture();
  expect(
    renderedFixtureColours({ kind: "tokens", tokens: ["--known", "--undefined", "--missing"] }),
  ).toEqual({
    "--known": { rgba: "1,2,3,255", defined: true },
    "--undefined": { rgba: "1,2,3,255", defined: false },
    "--missing": { rgba: "__MISSING__", defined: false },
  });
});
it("fails closed when the colour context is unavailable", () => {
  vi.stubGlobal("document", { createElement: () => ({ getContext: () => null }) });
  expect(() => renderedFixtureColours({ kind: "tokens", tokens: [] })).toThrow(
    "Fixture colour context is unavailable",
  );
});
