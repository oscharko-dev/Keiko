// Unit tests for the deterministic Screen-IR structural test baseline (Epic #750, Issue #754).
// Pure domain — no IO, no model. Synthetic Screen-IR fixtures only; never any real board content.

import { describe, expect, it } from "vitest";

import {
  deriveScreenTestBaseline,
  parseScreenIr,
  renderBaselineText,
  type StructuralTestItem,
} from "../../domain/figma/screenIrTestBaseline.js";
import type { IrNode, ScreenIr } from "../../domain/figma/irTypes.js";

// ─── Fixture builders ──────────────────────────────────────────────────────────

const node = (
  id: string,
  interactionHint: IrNode["interactionHint"],
  over: Partial<IrNode> = {},
): IrNode => ({
  id,
  name: over.name ?? id,
  type: over.type ?? "FRAME",
  interactionHint,
  ...(over.text !== undefined ? { text: over.text } : {}),
  imageFills: over.imageFills ?? [],
  children: over.children ?? [],
});

const screen = (id: string, name: string, root: IrNode): ScreenIr => ({ id, name, root });

const categories = (items: readonly StructuralTestItem[]): readonly string[] =>
  items.map((i) => i.category);

// ─── Structural derivation rules ─────────────────────────────────────────────────

describe("deriveScreenTestBaseline", () => {
  it("derives presence + validation tests for every input field", () => {
    const ir = screen(
      "s1",
      "Login",
      node("root", "container", {
        children: [node("email", "input", { text: "Email" })],
      }),
    );

    const baseline = deriveScreenTestBaseline(ir);
    const fieldItems = baseline.items.filter((i) => i.sourceNodeId === "email");

    expect(categories(fieldItems)).toEqual(["field-presence", "field-validation"]);
    expect(fieldItems.every((i) => i.title.includes("Email"))).toBe(true);
  });

  it("derives an action test for every button and link control", () => {
    const ir = screen(
      "s2",
      "Home",
      node("root", "container", {
        children: [
          node("submit", "button", { text: "Submit" }),
          node("help", "link", { text: "Help" }),
        ],
      }),
    );

    const actions = deriveScreenTestBaseline(ir).items.filter(
      (i) => i.category === "control-action",
    );

    expect(actions).toHaveLength(2);
    expect(actions[0]?.title).toContain("Activating");
    expect(actions[0]?.title).toContain("Submit");
    expect(actions[1]?.title).toContain("Following");
    expect(actions[1]?.title).toContain("Help");
  });

  it("always derives exactly one screen-render test, listed first", () => {
    const ir = screen(
      "s3",
      "Dashboard",
      node("root", "container", {
        children: [node("a", "button")],
      }),
    );

    const items = deriveScreenTestBaseline(ir).items;
    const render = items.filter((i) => i.category === "screen-render");

    expect(render).toHaveLength(1);
    expect(items[0]?.category).toBe("screen-render");
    expect(render[0]?.sourceNodeId).toBeUndefined();
    expect(render[0]?.title).toContain("Dashboard");
  });

  it("derives a state test from a generic state/variant naming convention", () => {
    const ir = screen(
      "s4",
      "Button gallery",
      node("root", "container", {
        children: [node("btn", "button", { name: "Primary, state=disabled", text: "Save" })],
      }),
    );

    const states = deriveScreenTestBaseline(ir).items.filter((i) => i.category === "state");

    expect(states).toHaveLength(1);
    expect(states[0]?.title).toContain("disabled");
  });

  it("attributes every item to its origin screen", () => {
    const ir = screen(
      "screen-xyz",
      "Profile",
      node("root", "container", {
        children: [node("name", "input")],
      }),
    );

    const items = deriveScreenTestBaseline(ir).items;

    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.screenId === "screen-xyz" && i.screenName === "Profile")).toBe(
      true,
    );
  });

  it("is deterministic — the same IR yields a byte-identical baseline", () => {
    const build = (): ScreenIr =>
      screen(
        "s5",
        "Form",
        node("root", "container", {
          children: [node("a", "input"), node("b", "button", { text: "Go" })],
        }),
      );

    const first = deriveScreenTestBaseline(build());
    const second = deriveScreenTestBaseline(build());

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("produces only the screen-render item for a screen with no interactive nodes", () => {
    const ir = screen("s6", "Static", node("root", "text", { text: "Welcome" }));

    expect(categories(deriveScreenTestBaseline(ir).items)).toEqual(["screen-render"]);
  });

  it("appends extra items additively without altering the structural items", () => {
    const ir = screen(
      "s7",
      "Nav",
      node("root", "container", {
        children: [node("go", "button")],
      }),
    );
    const extra: StructuralTestItem = {
      id: "nav-1",
      title: "Navigates from Nav to Home",
      category: "control-action",
      screenId: "s7",
      screenName: "Nav",
    };

    const withoutExtra = deriveScreenTestBaseline(ir);
    const withExtra = deriveScreenTestBaseline(ir, [extra]);

    expect(withExtra.items).toHaveLength(withoutExtra.items.length + 1);
    expect(withExtra.items.slice(0, withoutExtra.items.length)).toEqual(withoutExtra.items);
    expect(withExtra.items.at(-1)).toEqual(extra);
  });
});

// ─── Defensive IR parser ─────────────────────────────────────────────────────────

describe("parseScreenIr", () => {
  it("parses a well-formed serialised Screen-IR", () => {
    const json: unknown = {
      id: "s",
      name: "S",
      root: {
        id: "r",
        name: "r",
        type: "FRAME",
        interactionHint: "container",
        imageFills: [],
        children: [
          {
            id: "i",
            name: "i",
            type: "FRAME",
            interactionHint: "input",
            imageFills: [],
            children: [],
          },
        ],
      },
    };

    const parsed = parseScreenIr(json);

    expect(parsed?.id).toBe("s");
    expect(parsed?.root.children).toHaveLength(1);
    expect(parsed?.root.children[0]?.interactionHint).toBe("input");
  });

  it("returns undefined for a non-object / missing-root / malformed value", () => {
    expect(parseScreenIr(undefined)).toBeUndefined();
    expect(parseScreenIr({ id: "s", name: "S" })).toBeUndefined();
    expect(parseScreenIr({ id: "s", name: "S", root: { id: "r" } })).toBeUndefined();
    expect(
      parseScreenIr({
        id: 1,
        name: "S",
        root: { id: "r", name: "r", type: "F", interactionHint: "container" },
      }),
    ).toBeUndefined();
  });

  it("rejects a node with an unknown interactionHint", () => {
    const json: unknown = {
      id: "s",
      name: "S",
      root: {
        id: "r",
        name: "r",
        type: "F",
        interactionHint: "bogus",
        imageFills: [],
        children: [],
      },
    };

    expect(parseScreenIr(json)).toBeUndefined();
  });

  it("drops malformed children rather than failing the whole parse", () => {
    const json: unknown = {
      id: "s",
      name: "S",
      root: {
        id: "r",
        name: "r",
        type: "F",
        interactionHint: "container",
        imageFills: [],
        children: [
          { not: "a node" },
          { id: "ok", name: "ok", type: "F", interactionHint: "button" },
        ],
      },
    };

    const parsed = parseScreenIr(json);

    expect(parsed?.root.children).toHaveLength(1);
    expect(parsed?.root.children[0]?.id).toBe("ok");
  });

  it("round-trips the additive a11y colour + boundingBox fields (#812)", () => {
    const json: unknown = {
      id: "s",
      name: "S",
      root: {
        id: "r",
        name: "r",
        type: "FRAME",
        interactionHint: "container",
        backgroundColor: "#ffffff",
        boundingBox: { x: 1, y: 2, width: 3, height: 4 },
        imageFills: [],
        children: [
          {
            id: "t",
            name: "t",
            type: "TEXT",
            interactionHint: "text",
            text: "Hi",
            textColor: "#000000",
            imageFills: [],
            children: [],
          },
        ],
      },
    };

    const parsed = parseScreenIr(json);

    expect(parsed?.root.backgroundColor).toBe("#ffffff");
    expect(parsed?.root.boundingBox).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(parsed?.root.children[0]?.textColor).toBe("#000000");
  });

  it("drops a malformed boundingBox without failing the parse (#812)", () => {
    const json: unknown = {
      id: "s",
      name: "S",
      root: {
        id: "r",
        name: "r",
        type: "FRAME",
        interactionHint: "container",
        boundingBox: { x: "nope", y: 0, width: 1, height: 1 },
        imageFills: [],
        children: [],
      },
    };

    expect(parseScreenIr(json)?.root.boundingBox).toBeUndefined();
  });
});

// ─── Citation-ready rendering ────────────────────────────────────────────────────

describe("renderBaselineText", () => {
  it("renders per-screen provenance and one line per item", () => {
    const ir = screen(
      "s8",
      "Checkout",
      node("root", "container", {
        children: [node("pay", "button", { text: "Pay" })],
      }),
    );

    const text = renderBaselineText(deriveScreenTestBaseline(ir));

    expect(text).toContain("Screen: Checkout [s8]");
    expect(text).toContain("(screen-render)");
    expect(text).toContain("(control-action)");
    expect(text).toContain("Pay");
  });

  // Fix #6: traceability — sourceNodeId must appear in rendered text so the
  // generated test case is attributable to its origin node.
  it("appends [node:<sourceNodeId>] for items that have a sourceNodeId (Fix #6)", () => {
    const ir = screen(
      "s9",
      "Profile",
      node("root", "container", {
        children: [node("save-btn", "button", { text: "Save" })],
      }),
    );
    const text = renderBaselineText(deriveScreenTestBaseline(ir));
    // control-action item for "save-btn" must carry [node:save-btn]
    expect(text).toContain("[node:save-btn]");
    // screen-render item has no sourceNodeId → no [node:...] suffix on that line
    const screenRenderLine = text.split("\n").find((l) => l.includes("(screen-render)"));
    expect(screenRenderLine).toBeDefined();
    expect(screenRenderLine).not.toContain("[node:");
  });
});

// ─── Fix #4: deep-chain parseIrNode RangeError regression ───────────────────
// parseScreenIr on a 5000-deep irJson chain must not throw.

describe("parseScreenIr — 5000-deep irJson chain degrades, no RangeError (Fix #4)", () => {
  // Build a deeply nested irJson object. Each level is a valid serialised IrNode.
  const deepIrJson = (depth: number): Record<string, unknown> => {
    let inner: Record<string, unknown> = {
      id: "leaf",
      name: "leaf",
      type: "FRAME",
      interactionHint: "container",
      imageFills: [],
      children: [],
    };
    for (let i = depth; i >= 1; i -= 1) {
      const si = String(i);
      inner = {
        id: `n${si}`,
        name: `n${si}`,
        type: "FRAME",
        interactionHint: "container",
        imageFills: [],
        children: [inner],
      };
    }
    return { id: "screen-deep", name: "DeepScreen", root: inner };
  };

  it("does not throw RangeError for a 5000-deep irJson chain", () => {
    expect(() => parseScreenIr(deepIrJson(5000))).not.toThrow();
  });

  it("returns a defined ScreenIr (not undefined) from a deep chain", () => {
    const result = parseScreenIr(deepIrJson(5000));
    expect(result).toBeDefined();
    expect(result?.id).toBe("screen-deep");
    expect(result?.root).toBeDefined();
  });
});

// ─── Layout-fidelity fields survive the persisted-irJson round trip ──────────
//
// The codegen route re-hydrates IrNode from the snapshot's opaque irJson via parseScreenIr. A
// live integration pass caught these fields being DROPPED on parse (the in-memory emitCode tests
// were blind to it), which silently disabled the per-screen <style> block on stored snapshots.

describe("parseScreenIr — layout/sizing/cornerRadius/typography round trip", () => {
  it("re-hydrates the layout-fidelity fields from persisted irJson", () => {
    const json = JSON.parse(
      JSON.stringify({
        id: "s1",
        name: "Login",
        root: {
          id: "s1-root",
          name: "Root",
          type: "FRAME",
          interactionHint: "container",
          layout: { mode: "column", itemSpacing: 12, padding: [16, 16, 16, 16] },
          sizing: { horizontal: "fill" },
          cornerRadius: 8,
          imageFills: [],
          children: [
            {
              id: "s1-t",
              name: "Titel",
              type: "TEXT",
              interactionHint: "text",
              text: "Hallo",
              typography: { fontFamily: "Inter", fontSize: 16, fontWeight: 400 },
              imageFills: [],
              children: [],
            },
          ],
        },
      }),
    ) as unknown;
    const parsed = parseScreenIr(json);
    expect(parsed?.root.layout).toEqual({
      mode: "column",
      itemSpacing: 12,
      padding: [16, 16, 16, 16],
    });
    expect(parsed?.root.sizing).toEqual({ horizontal: "fill" });
    expect(parsed?.root.cornerRadius).toBe(8);
    expect(parsed?.root.children[0]?.typography).toEqual({
      fontFamily: "Inter",
      fontSize: 16,
      fontWeight: 400,
    });
  });

  it("drops malformed layout-fidelity values instead of failing the node", () => {
    const json = {
      id: "s1",
      name: "X",
      root: {
        id: "r",
        name: "r",
        type: "FRAME",
        interactionHint: "container",
        layout: { mode: "diagonal" },
        sizing: { horizontal: "stretch" },
        cornerRadius: Number.NaN,
        typography: { fontFamily: 7 },
        imageFills: [],
        children: [],
      },
    } as unknown;
    const parsed = parseScreenIr(json);
    expect(parsed?.root.layout).toBeUndefined();
    expect(parsed?.root.sizing).toBeUndefined();
    expect(parsed?.root.cornerRadius).toBeUndefined();
    expect(parsed?.root.typography).toBeUndefined();
  });
});
