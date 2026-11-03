import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compileProductDesignTokens,
  writeProductDesignTokens,
  PRODUCT_TOKEN_OUTPUT,
} from "../../packages/keiko-ui/design-tokens.mjs";
import { readStylesheet } from "../../packages/keiko-ui/read-stylesheet.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function file(root, name, content) {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "keiko-design-tokens-"));
  roots.push(root);
  file(root, "design-system/keiko-tokens.css", ":root { --shared: rgb(1 2 3); }");
  const bindings = {
    schemaVersion: 1,
    rules: [
      {
        selector: ":root",
        conditions: [],
        declarations: [
          {
            property: "--shared",
            source: "design-system/keiko-tokens.css",
            selector: ":root",
            conditions: [],
          },
          { property: "--product", value: "12px" },
        ],
      },
    ],
  };
  file(root, "design-system/product-token-bindings.json", JSON.stringify(bindings));
  return { root, bindings };
}

describe("existing design-system token bindings and CSS source projection", () => {
  it("reuses current canonical values, keeps overrides and emits the same CSS the source loader reads", () => {
    const { root } = fixture();
    writeProductDesignTokens(root);
    const expected = readFileSync(join(root, PRODUCT_TOKEN_OUTPUT), "utf8");
    const source = file(root, "entry.css", `@import "${PRODUCT_TOKEN_OUTPUT}";`);
    expect(readStylesheet(source, root)).toBe(expected);
    expect(expected).toContain("--shared: rgb(1 2 3);");
    expect(expected).toContain("--product: 12px;");
    file(root, "design-system/keiko-tokens.css", ":root { --shared: rgb(4 5 6); }");
    expect(readStylesheet(source, root)).toContain("--shared: rgb(4 5 6);");
  });
  it("preserves consecutive media branches, comments and authored declaration fallbacks", () => {
    const { root, bindings } = fixture();
    bindings.rules = ["dark", "light"].map((theme) => ({
      selector: `[data-theme="${theme}"]`,
      conditions: [{ name: "media", params: "(prefers-contrast: more)" }],
      declarations: [
        { comment: "owned fixture" },
        { property: "max-height", value: "100vh" },
        { property: "max-height", value: "100dvh" },
      ],
    }));
    file(root, "design-system/product-token-bindings.json", JSON.stringify(bindings));
    const css = compileProductDesignTokens(root);
    expect(css.match(/@media/gu)).toHaveLength(1);
    expect(css).toContain('[data-theme="light"]');
    expect(css).toContain("max-height: 100vh;");
    expect(css).toContain("max-height: 100dvh;");
    expect(css).toContain("owned fixture");
  });
  it.each(["missing", "ambiguous", "external"])("fails closed on %s canonical bindings", (kind) => {
    const { root, bindings } = fixture();
    if (kind === "missing")
      file(root, "design-system/keiko-tokens.css", ":root { --other: blue; }");
    if (kind === "ambiguous")
      file(root, "design-system/keiko-tokens.css", ":root { --shared: red; --shared: blue; }");
    if (kind === "external") bindings.rules[0].declarations[0].source = "../outside.css";
    file(root, "design-system/product-token-bindings.json", JSON.stringify(bindings));
    expect(() => compileProductDesignTokens(root)).toThrow();
  });
  it("projects composed ancestor scopes before local state overrides", () => {
    const { root } = fixture();
    file(
      root,
      "shared.module.css",
      ".cmp-scope .button { color: red; } .cmp-scope .button:hover { color: blue; }",
    );
    const source = file(
      root,
      "widget.module.css",
      '.scope { composes: cmp-scope from "./shared.module.css"; } .scope .button:disabled { color: gray; }',
    );
    const css = readStylesheet(source, root);
    expect(css).toContain(".scope .button { color: red; }");
    expect(css).toContain(".scope .button:hover { color: blue; }");
    expect(css.indexOf("color: red")).toBeLessThan(css.indexOf("color: gray"));
    expect(css).not.toContain("composes:");
  });
  it("rejects cycles, unknown composed scopes, path traversal and symlink escapes", () => {
    const { root } = fixture();
    const source = file(root, "entry.css", '@import "entry.css";');
    expect(() => readStylesheet(source, root)).toThrow("Cyclic");
    file(root, "shared.module.css", ".different { color: red; }");
    file(root, "entry.css", '.scope { composes: absent from "./shared.module.css"; }');
    expect(() => readStylesheet(source, root)).toThrow("scope is unavailable");
    file(root, "entry.css", '@import "../outside.css";');
    expect(() => readStylesheet(source, root)).toThrow("escapes repository");
    const other = fixture().root;
    file(other, "outside.css", ".outside { color: red; }");
    symlinkSync(join(other, "outside.css"), join(root, "linked.css"));
    file(root, "entry.css", '@import "linked.css";');
    expect(() => readStylesheet(source, root)).toThrow("escapes repository");
  });
});
