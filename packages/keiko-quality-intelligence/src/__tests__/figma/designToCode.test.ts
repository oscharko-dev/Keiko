// Unit tests for deterministic design-to-code emission (Epic #750, Issue #755).
// Pure domain — no IO, no model, no Date, no Figma. Synthetic Screen-IR fixtures only.
//
// Mutation-robust: the target-neutral emission plan (component tree, roles, nav targets), the
// htmlCssAdapter (semantic tags, escaped text, CSS custom properties from design tokens, per-screen
// nav scaffolding), the CodeTargetAdapter seam (a second fake adapter is selectable), the
// model-only-for-naming port (renames only — element tree byte-identical), graceful model-absence
// (structural default names, no crash), and byte-stable determinism each have a case. Edge cases:
// empty screen, no tokens, no hints, deeply nested, text-only screen.

import { describe, expect, it } from "vitest";

import {
  buildEmissionPlan,
  emitCode,
  applyNaming,
  htmlCssAdapter,
  type CodeArtifact,
  type CodeEmissionPlan,
  type CodeTargetAdapter,
  type SemanticNamingProvider,
} from "../../domain/figma/index.js";
import type {
  DesignTokens,
  InterScreenLink,
  IrNode,
  ScreenIr,
} from "../../domain/figma/irTypes.js";
import {
  deriveNavGraph,
  deriveRoutingHints,
  type RoutingHint,
} from "../../domain/figma/navGraph.js";

// ─── Fixture builders ──────────────────────────────────────────────────────────

const node = (
  id: string,
  hint: IrNode["interactionHint"],
  extra: Partial<IrNode> = {},
): IrNode => ({
  id,
  name: id,
  type: "FRAME",
  interactionHint: hint,
  imageFills: [],
  children: [],
  ...extra,
});

const screen = (id: string, name: string, root: IrNode): ScreenIr => ({ id, name, root });

const NO_TOKENS: DesignTokens = { colors: [], typography: [], spacing: [], radius: [] };

const link = (sourceNodeId: string, trigger: string, targetNodeId: string): InterScreenLink => ({
  sourceNodeId,
  trigger,
  targetNodeId,
});

const tokens: DesignTokens = {
  colors: [{ id: "color:#112233", kind: "color", value: "#112233" }],
  typography: [
    {
      id: "typography:Inter|16|400|24",
      kind: "typography",
      fontFamily: "Inter",
      fontSize: 16,
      fontWeight: 400,
      lineHeight: 24,
    },
  ],
  spacing: [{ id: "spacing:8", kind: "spacing", value: 8 }],
  radius: [{ id: "radius:4", kind: "radius", value: 4 }],
};

// A login screen: a heading, an email input, a submit button that navigates to Home.
const loginScreen = (): ScreenIr =>
  screen(
    "s-login",
    "Login",
    node("login-root", "container", {
      name: "login-root",
      children: [
        node("login-title", "text", { name: "Title", text: "Sign in" }),
        node("login-email", "input", { name: "Email" }),
        node("login-submit", "button", { name: "Submit", text: "Continue" }),
      ],
    }),
  );

const homeScreen = (): ScreenIr =>
  screen("s-home", "Home", node("home-root", "container", { name: "home-root" }));

const loginHomeHints = (): readonly RoutingHint[] =>
  deriveRoutingHints(
    deriveNavGraph({
      screens: [loginScreen(), homeScreen()],
      links: [link("login-submit", "ON_CLICK", "home-root")],
      tokens: NO_TOKENS,
      reduction: { inputNodeCount: 0, keptNodeCount: 0, removedNodeCount: 0, removedRatio: 0 },
    }),
  );

const fileByPath = (artifact: CodeArtifact, path: string): string => {
  const file = artifact.files.find((f) => f.path === path);
  if (file === undefined)
    throw new Error(`expected file ${path}; got ${artifact.files.map((f) => f.path).join(", ")}`);
  return file.contents;
};

// ─── Emission plan (target-neutral) ─────────────────────────────────────────────

describe("buildEmissionPlan — target-neutral component tree", () => {
  it("reduces a screen's IR to an element tree preserving role, text, and child order", () => {
    const plan = buildEmissionPlan({ screens: [loginScreen()], tokens, hints: [] });
    expect(plan.screens).toHaveLength(1);
    const root = plan.screens[0]?.root;
    expect(root?.role).toBe("container");
    expect(root?.children.map((c) => c.role)).toEqual(["text", "input", "button"]);
    expect(root?.children.map((c) => c.id)).toEqual(["login-title", "login-email", "login-submit"]);
    expect(root?.children[0]?.text).toBe("Sign in");
  });

  it("attaches resolved nav targets to the source screen from routing hints", () => {
    const plan = buildEmissionPlan({
      screens: [loginScreen(), homeScreen()],
      tokens: NO_TOKENS,
      hints: loginHomeHints(),
    });
    const login = plan.screens.find((s) => s.screenId === "s-login");
    expect(login?.navTargets).toEqual([
      { trigger: "ON_CLICK", toScreenId: "s-home", toScreenName: "Home" },
    ]);
    const home = plan.screens.find((s) => s.screenId === "s-home");
    expect(home?.navTargets).toEqual([]);
  });

  it("carries the design tokens through unchanged for the adapter to theme", () => {
    const plan = buildEmissionPlan({ screens: [loginScreen()], tokens, hints: [] });
    expect(plan.tokens).toEqual(tokens);
  });

  it("assigns a structural default display name when no naming provider is present", () => {
    const plan = buildEmissionPlan({ screens: [loginScreen()], tokens, hints: [] });
    const submit = plan.screens[0]?.root.children.find((c) => c.id === "login-submit");
    // Structural default derives from the node name — never empty, never a model-invented name.
    expect(submit?.displayName.length).toBeGreaterThan(0);
    expect(submit?.displayName).toContain("Submit");
  });
});

// ─── htmlCssAdapter — semantic HTML + CSS ───────────────────────────────────────

describe("htmlCssAdapter — semantic HTML", () => {
  it("emits a per-screen HTML file with semantic tags mapped from element roles", () => {
    const artifact = emitCode({ screens: [loginScreen()], tokens, hints: [] }, htmlCssAdapter);
    const html = fileByPath(artifact, "screens/s-login.html");
    expect(html).toContain("<button");
    expect(html).toContain("<input");
    expect(html).toMatch(/<section[^>]*>/u);
    expect(html.trim().startsWith("<!doctype html>")).toBe(true);
  });

  it("escapes text content so the reviewable artifact cannot inject markup", () => {
    const evil = screen(
      "s-x",
      "X",
      node("root", "container", {
        children: [node("t", "text", { text: '<script>alert("x")</script>' })],
      }),
    );
    const artifact = emitCode({ screens: [evil], tokens: NO_TOKENS, hints: [] }, htmlCssAdapter);
    const html = fileByPath(artifact, "screens/s-x.html");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("links the design tokens into CSS custom properties referencing token values", () => {
    const artifact = emitCode({ screens: [loginScreen()], tokens, hints: [] }, htmlCssAdapter);
    const css = fileByPath(artifact, "tokens.css");
    expect(css).toContain(":root");
    expect(css).toContain("#112233");
    expect(css).toMatch(/--color-[a-z0-9-]+:\s*#112233;/u);
    expect(css).toMatch(/--space-[a-z0-9-]+:\s*8px;/u);
    expect(css).toMatch(/--radius-[a-z0-9-]+:\s*4px;/u);
    expect(css).toContain("Inter");
    // Every screen HTML links the token stylesheet.
    const html = fileByPath(artifact, "screens/s-login.html");
    expect(html).toContain('href="../tokens.css"');
  });

  it("scaffolds per-screen navigation from routing hints to target screens (no router vocabulary)", () => {
    const artifact = emitCode(
      { screens: [loginScreen(), homeScreen()], tokens: NO_TOKENS, hints: loginHomeHints() },
      htmlCssAdapter,
    );
    const html = fileByPath(artifact, "screens/s-login.html");
    expect(html).toMatch(/<nav[^>]*>/u);
    // Fix #7: hrefs are now prefixed with "./" so they are unambiguous relative references.
    expect(html).toContain('href="./s-home.html"');
    expect(html).toContain('data-trigger="ON_CLICK"');
    // The anchor is labelled with the human-readable target screen name.
    expect(html).toMatch(/<a href="\.\/s-home\.html" data-trigger="ON_CLICK">Home<\/a>/u);
    // Framework/router vocabulary must not leak into framework-agnostic output.
    expect(html.toLowerCase()).not.toContain("react");
    expect(html.toLowerCase()).not.toContain("router");
    expect(html.toLowerCase()).not.toContain("useeffect");
  });

  it("emits an index.html linking every screen", () => {
    const artifact = emitCode(
      { screens: [loginScreen(), homeScreen()], tokens: NO_TOKENS, hints: [] },
      htmlCssAdapter,
    );
    const index = fileByPath(artifact, "index.html");
    expect(index).toContain('href="screens/s-login.html"');
    expect(index).toContain('href="screens/s-home.html"');
  });

  it("names itself so the artifact records which adapter produced it", () => {
    const artifact = emitCode({ screens: [loginScreen()], tokens, hints: [] }, htmlCssAdapter);
    expect(artifact.adapterName).toBe(htmlCssAdapter.name);
    expect(htmlCssAdapter.name.length).toBeGreaterThan(0);
  });
});

// ─── CodeTargetAdapter seam — pluggability ──────────────────────────────────────

describe("CodeTargetAdapter seam", () => {
  it("renders through a second, fake adapter selected at the call site", () => {
    const fakeAdapter: CodeTargetAdapter = {
      name: "fake-json",
      emit: (plan: CodeEmissionPlan): CodeArtifact => ({
        adapterName: "fake-json",
        files: [
          {
            path: "plan.json",
            contents: JSON.stringify(plan.screens.map((s) => s.screenId)),
          },
        ],
      }),
    };
    const artifact = emitCode(
      { screens: [loginScreen(), homeScreen()], tokens, hints: [] },
      fakeAdapter,
    );
    expect(artifact.adapterName).toBe("fake-json");
    expect(fileByPath(artifact, "plan.json")).toBe(JSON.stringify(["s-login", "s-home"]));
  });

  it("feeds the SAME target-neutral plan to whichever adapter is selected", () => {
    const captured: CodeEmissionPlan[] = [];
    const probe: CodeTargetAdapter = {
      name: "probe",
      emit: (plan) => {
        captured.push(plan);
        return { adapterName: "probe", files: [] };
      },
    };
    emitCode({ screens: [loginScreen()], tokens, hints: [] }, probe);
    const direct = buildEmissionPlan({ screens: [loginScreen()], tokens, hints: [] });
    expect(captured[0]).toEqual(direct);
  });
});

// ─── Model-only-for-naming port ─────────────────────────────────────────────────

describe("semantic naming port (model only renames — never changes structure)", () => {
  const treeShape = (plan: CodeEmissionPlan): unknown =>
    plan.screens.map((s) => ({
      screenId: s.screenId,
      nav: s.navTargets,
      ids: (function walk(el): readonly unknown[] {
        return [el.id, el.role, el.text ?? null, ...el.children.flatMap(walk)];
      })(s.root),
    }));

  it("overrides only display names; the element tree is structurally byte-identical", () => {
    const provider: SemanticNamingProvider = () =>
      new Map([
        ["login-submit", "PrimarySubmitButton"],
        ["login-email", "EmailField"],
      ]);
    const base = buildEmissionPlan({ screens: [loginScreen()], tokens, hints: [] });
    const named = applyNaming(base, provider);
    expect(treeShape(named)).toEqual(treeShape(base));
    const submit = named.screens[0]?.root.children.find((c) => c.id === "login-submit");
    expect(submit?.displayName).toBe("PrimarySubmitButton");
  });

  it("ignores names for unknown ids and keeps the structural default for unnamed elements", () => {
    const provider: SemanticNamingProvider = () => new Map([["does-not-exist", "Ghost"]]);
    const base = buildEmissionPlan({ screens: [loginScreen()], tokens, hints: [] });
    const named = applyNaming(base, provider);
    expect(named).toEqual(base);
  });

  it("drops empty/whitespace model names and falls back to the structural default (no crash)", () => {
    const provider: SemanticNamingProvider = () =>
      new Map([
        ["login-submit", "   "],
        ["login-email", ""],
      ]);
    const base = buildEmissionPlan({ screens: [loginScreen()], tokens, hints: [] });
    const named = applyNaming(base, provider);
    expect(named).toEqual(base);
  });

  it("emitCode with NO naming provider produces structural-default names and never throws", () => {
    expect(() =>
      emitCode({ screens: [loginScreen()], tokens, hints: [] }, htmlCssAdapter),
    ).not.toThrow();
  });
});

// ─── Determinism (no model) ─────────────────────────────────────────────────────

describe("deterministic emission without any model", () => {
  it("produces byte-identical artifacts for the same input (no Date, stable order)", () => {
    const input = { screens: [loginScreen(), homeScreen()], tokens, hints: loginHomeHints() };
    const a = emitCode(input, htmlCssAdapter);
    const b = emitCode(
      { screens: [loginScreen(), homeScreen()], tokens, hints: loginHomeHints() },
      htmlCssAdapter,
    );
    expect(a).toEqual(b);
  });

  it("emits well-formed HTML/CSS with NO naming provider (structural defaults only)", () => {
    const artifact = emitCode({ screens: [loginScreen()], tokens, hints: [] }, htmlCssAdapter);
    const html = fileByPath(artifact, "screens/s-login.html");
    // Balanced top-level structure: a doctype, an <html>…</html> envelope.
    expect(html).toMatch(/<html[^>]*>[\s\S]*<\/html>/u);
    expect(html).toContain("</body>");
    // Token stylesheet is non-empty and valid-shaped.
    expect(fileByPath(artifact, "tokens.css")).toContain(":root {");
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("empty screen (root with no children) emits a valid, empty-body screen", () => {
    const empty = screen("s-e", "Empty", node("root", "container"));
    const artifact = emitCode({ screens: [empty], tokens: NO_TOKENS, hints: [] }, htmlCssAdapter);
    const html = fileByPath(artifact, "screens/s-e.html");
    expect(html).toContain("</html>");
    expect(html).not.toContain("<button");
  });

  it("no tokens emits a tokens.css with an empty :root block (still valid)", () => {
    const artifact = emitCode(
      { screens: [homeScreen()], tokens: NO_TOKENS, hints: [] },
      htmlCssAdapter,
    );
    const css = fileByPath(artifact, "tokens.css");
    expect(css).toContain(":root {");
    expect(css).not.toContain("--color-");
  });

  it("no hints emits screens with no nav scaffolding", () => {
    const artifact = emitCode({ screens: [loginScreen()], tokens, hints: [] }, htmlCssAdapter);
    const html = fileByPath(artifact, "screens/s-login.html");
    expect(html).not.toContain("<nav");
  });

  it("deeply nested elements are emitted nested without loss", () => {
    const deep = screen(
      "s-d",
      "Deep",
      node("root", "container", {
        children: [
          node("l1", "container", {
            children: [
              node("l2", "container", { children: [node("leaf", "button", { text: "Go" })] }),
            ],
          }),
        ],
      }),
    );
    const artifact = emitCode({ screens: [deep], tokens: NO_TOKENS, hints: [] }, htmlCssAdapter);
    const html = fileByPath(artifact, "screens/s-d.html");
    expect(html).toContain("<button");
    expect(html).toContain("Go");
  });

  it("a text-only screen emits text without any interactive controls", () => {
    const textOnly = screen(
      "s-t",
      "Text",
      node("root", "container", {
        children: [node("a", "text", { text: "Hello" }), node("b", "text", { text: "World" })],
      }),
    );
    const artifact = emitCode(
      { screens: [textOnly], tokens: NO_TOKENS, hints: [] },
      htmlCssAdapter,
    );
    const html = fileByPath(artifact, "screens/s-t.html");
    expect(html).toContain("Hello");
    expect(html).toContain("World");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<input");
  });
});

// ─── Fix #6: traceability — data-node-id on every element ───────────────────

describe("htmlCssAdapter — data-node-id traceability (Fix #6)", () => {
  it("emits data-node-id on every element so generated tests are node-attributable", () => {
    const artifact = emitCode(
      { screens: [loginScreen()], tokens: NO_TOKENS, hints: [] },
      htmlCssAdapter,
    );
    const html = fileByPath(artifact, "screens/s-login.html");
    // Each element carries data-node-id matching its IR node id.
    expect(html).toContain('data-node-id="login-root"');
    expect(html).toContain('data-node-id="login-title"');
    expect(html).toContain('data-node-id="login-email"');
    expect(html).toContain('data-node-id="login-submit"');
  });
});

// ─── Fix #7: safe screen file paths for ids containing ':' or ';' ───────────

describe("htmlCssAdapter — sanitized screen file names (Fix #7)", () => {
  it("replaces ':' and ';' in screen ids with '-' in file paths and hrefs", () => {
    // Real Figma INSTANCE ids look like 'I123:456;789:12' — ':' is Windows-invalid and
    // INSTANCE:COMPONENT parses as a URI scheme in an href.
    const instanceScreen = screen("I123:456;789:12", "InstanceScreen", node("root", "container"));
    const artifact = emitCode(
      { screens: [instanceScreen], tokens: NO_TOKENS, hints: [] },
      htmlCssAdapter,
    );
    // File path must use the sanitized name (colons and semicolons replaced).
    const html = fileByPath(artifact, "screens/I123-456-789-12.html");
    expect(html).toBeDefined();
    // The raw id must be preserved in data-screen-id for traceability.
    expect(html).toContain('data-screen-id="I123:456;789:12"');
    // index.html must link to the sanitized name.
    const index = fileByPath(artifact, "index.html");
    expect(index).toContain('href="screens/I123-456-789-12.html"');
    // Sanitized href must not parse as a URI scheme (no bare 'I123:' scheme).
    const hrefMatch = /href="([^"]+)"/u.exec(index);
    expect(hrefMatch?.[1]).not.toMatch(/^[A-Za-z][A-Za-z0-9+\-.]*:/u);
  });

  it("prefixes in-screen nav hrefs with './' to prevent URI-scheme misparse", () => {
    const artifact = emitCode(
      { screens: [loginScreen(), homeScreen()], tokens: NO_TOKENS, hints: loginHomeHints() },
      htmlCssAdapter,
    );
    const html = fileByPath(artifact, "screens/s-login.html");
    // Must use './' prefix — 's-home.html' alone could be confused with a relative path starting
    // with a scheme-like prefix if the id had colons.
    expect(html).toContain('href="./s-home.html"');
    expect(html).not.toContain('href="s-home.html"');
  });
});

// ─── Fix #8: CSS value injection prevention ──────────────────────────────────

describe("htmlCssAdapter — CSS value sanitization (Fix #8)", () => {
  it("quotes fontFamily and cannot break out of the CSS declaration block", () => {
    // A hostile fontFamily tries to close the declaration, inject a rule, then open a comment.
    const hostiletokens: DesignTokens = {
      colors: [],
      typography: [
        {
          id: "typo:evil",
          kind: "typography",
          fontFamily: "'}; } body { background: red } /*",
          fontSize: 16,
          fontWeight: 400,
          lineHeight: 24,
        },
      ],
      spacing: [],
      radius: [],
    };
    const artifact = emitCode(
      { screens: [loginScreen()], tokens: hostiletokens, hints: [] },
      htmlCssAdapter,
    );
    const css = fileByPath(artifact, "tokens.css");
    // Injection characters must not appear unquoted in the CSS.
    expect(css).not.toContain("body { background");
    // The typography token is still emitted — sanitized, not dropped.
    // The CSS variable uses the --font-N numbering convention.
    expect(css).toContain("--font-1");
    // The curly braces and semicolons are stripped; the remainder is quoted.
    expect(css).toContain('"');
  });

  it("drops invalid (non-hex) color tokens rather than emitting them verbatim", () => {
    const badTokens: DesignTokens = {
      colors: [
        { id: "c:bad", kind: "color", value: "red; } body{background:blue" },
        { id: "c:good", kind: "color", value: "#aabbcc" },
      ],
      typography: [],
      spacing: [],
      radius: [],
    };
    const artifact = emitCode(
      { screens: [loginScreen()], tokens: badTokens, hints: [] },
      htmlCssAdapter,
    );
    const css = fileByPath(artifact, "tokens.css");
    // Invalid color token must be dropped.
    expect(css).not.toContain("body{background");
    // Valid color token must still appear.
    expect(css).toContain("#aabbcc");
  });
});

// ─── Layout / sizing / cornerRadius / typography CSS emission ────────────────
//
// Verifies that htmlCssAdapter consumes the additive IrNode layout fields threaded through
// EmissionElement: a flex container emits display:flex + flex-direction + gap + padding, a
// token-matching TEXT emits var(--font-N), fill sizing emits width:100% / flex:1, and a node
// with no layout fields emits no class or per-screen <style> block.

describe("htmlCssAdapter — layout/sizing/cornerRadius/typography CSS (additive IR fields)", () => {
  // A container node carrying auto-layout: HORIZONTAL, 8px gap, 16px padding all round.
  const flexContainer = (): IrNode =>
    node("flex-root", "container", {
      name: "flex-root",
      layout: { mode: "row", itemSpacing: 8, padding: [16, 16, 16, 16] },
      children: [node("child-a", "text", { text: "A" }), node("child-b", "text", { text: "B" })],
    });

  it("emits display:flex, flex-direction:row, gap, and padding for an auto-layout container", () => {
    const s = screen("s-f", "Flex", flexContainer());
    const artifact = emitCode({ screens: [s], tokens: NO_TOKENS, hints: [] }, htmlCssAdapter);
    const html = fileByPath(artifact, "screens/s-f.html");
    expect(html).toContain("display: flex;");
    expect(html).toContain("flex-direction: row;");
    expect(html).toContain("gap: 8px;");
    expect(html).toContain("padding: 16px 16px 16px 16px;");
  });

  it("emits the layout CSS class on the element carrying layout", () => {
    const s = screen("s-f", "Flex", flexContainer());
    const artifact = emitCode({ screens: [s], tokens: NO_TOKENS, hints: [] }, htmlCssAdapter);
    const html = fileByPath(artifact, "screens/s-f.html");
    // The CSS class name is "n-" + sanitized node id ("flex-root" → "flex-root").
    expect(html).toContain('class="n-flex-root"');
    // The matching rule must appear in a <style> block.
    expect(html).toContain("<style>");
    expect(html).toContain(".n-flex-root {");
  });

  it("emits border-radius when cornerRadius is set", () => {
    const s = screen("s-r", "Radius", node("card", "container", { name: "card", cornerRadius: 8 }));
    const artifact = emitCode({ screens: [s], tokens: NO_TOKENS, hints: [] }, htmlCssAdapter);
    const html = fileByPath(artifact, "screens/s-r.html");
    expect(html).toContain("border-radius: 8px;");
  });

  it("emits flex:1 for a fill-sized node (vertical fill)", () => {
    const s = screen(
      "s-fill",
      "Fill",
      node("fill-node", "container", {
        layout: { mode: "column" },
        sizing: { vertical: "fill" },
      }),
    );
    const artifact = emitCode({ screens: [s], tokens: NO_TOKENS, hints: [] }, htmlCssAdapter);
    const html = fileByPath(artifact, "screens/s-fill.html");
    expect(html).toContain("flex: 1;");
  });

  it("emits width:100% for a horizontal fill-sized node", () => {
    const s = screen(
      "s-hfill",
      "HFill",
      node("hfill-node", "container", {
        layout: { mode: "row" },
        sizing: { horizontal: "fill" },
      }),
    );
    const artifact = emitCode({ screens: [s], tokens: NO_TOKENS, hints: [] }, htmlCssAdapter);
    const html = fileByPath(artifact, "screens/s-hfill.html");
    expect(html).toContain("width: 100%;");
  });

  it("emits var(--font-N) when TEXT typography matches a token in tokens.css", () => {
    // The typography token matches fontFamily+fontSize+fontWeight of the node.
    const typographyTokens: DesignTokens = {
      colors: [],
      typography: [
        {
          id: "typography:Inter|16|400|24",
          kind: "typography",
          fontFamily: "Inter",
          fontSize: 16,
          fontWeight: 400,
          lineHeight: 24,
        },
      ],
      spacing: [],
      radius: [],
    };
    const s = screen(
      "s-typo",
      "Typo",
      node("label", "text", {
        text: "Hello",
        typography: { fontFamily: "Inter", fontSize: 16, fontWeight: 400 },
      }),
    );
    const artifact = emitCode(
      { screens: [s], tokens: typographyTokens, hints: [] },
      htmlCssAdapter,
    );
    const html = fileByPath(artifact, "screens/s-typo.html");
    // The first (only) typography token maps to --font-1.
    expect(html).toContain("font: var(--font-1);");
    // The var(--font-1) must actually be declared in tokens.css.
    const css = fileByPath(artifact, "tokens.css");
    expect(css).toContain("--font-1:");
  });

  it("emits no <style> block and no class attribute when no layout fields are present", () => {
    const artifact = emitCode(
      { screens: [loginScreen()], tokens: NO_TOKENS, hints: [] },
      htmlCssAdapter,
    );
    const html = fileByPath(artifact, "screens/s-login.html");
    // The login screen fixture carries no layout/sizing/cornerRadius/typography fields.
    expect(html).not.toContain("<style>");
    expect(html).not.toContain("class=");
  });

  it("is byte-identical on a re-run even with layout fields (deterministic)", () => {
    const input = {
      screens: [screen("s-f", "Flex", flexContainer())],
      tokens: NO_TOKENS,
      hints: [],
    };
    const a = emitCode(input, htmlCssAdapter);
    const b = emitCode(
      { screens: [screen("s-f", "Flex", flexContainer())], tokens: NO_TOKENS, hints: [] },
      htmlCssAdapter,
    );
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
