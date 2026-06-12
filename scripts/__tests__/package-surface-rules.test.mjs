// Unit tests for scripts/package-surface-rules.mjs (Issue #287 native-addon guard).
//
// Tests the pure findForbiddenPaths helper and the FORBIDDEN_TARBALL_PATH_RULES array
// without invoking `npm pack` or importing any BFF package. Every rule gets a positive
// (flagged) test and a negative (clean) test. Rules that can match the same path (generic
// .node + canvas specialization) are tested for multi-hit behaviour.

import { describe, expect, it } from "vitest";

import { FORBIDDEN_TARBALL_PATH_RULES, findForbiddenPaths } from "../package-surface-rules.mjs";

// ---------------------------------------------------------------------------
// findForbiddenPaths — clean paths (nothing should be flagged)
// ---------------------------------------------------------------------------

describe("findForbiddenPaths — clean paths return empty array", () => {
  it("does not flag dist/index.js", () => {
    expect(findForbiddenPaths(["dist/index.js"])).toEqual([]);
  });

  it("does not flag dist/index.d.ts", () => {
    expect(findForbiddenPaths(["dist/index.d.ts"])).toEqual([]);
  });

  it("does not flag a declaration map (.d.ts.map stays — editor only, relative paths)", () => {
    expect(findForbiddenPaths(["dist/index.d.ts.map"])).toEqual([]);
  });

  it("does not flag dist/ui/static HTML", () => {
    expect(findForbiddenPaths(["dist/ui/static/index.html"])).toEqual([]);
  });

  it("does not flag a bundled workspace dist file", () => {
    expect(
      findForbiddenPaths(["node_modules/@oscharko-dev/keiko-contracts/dist/index.js"]),
    ).toEqual([]);
  });

  it("does not flag the CSP hashes file", () => {
    expect(findForbiddenPaths(["dist/ui/csp-hashes.json"])).toEqual([]);
  });

  it("does not flag the CLI binary", () => {
    expect(findForbiddenPaths(["dist/cli/index.js"])).toEqual([]);
  });

  it("returns empty array for an empty path list", () => {
    expect(findForbiddenPaths([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// JS source map rule
// ---------------------------------------------------------------------------

describe("findForbiddenPaths — .js.map (JS source map)", () => {
  it("flags a JS source map at the dist root", () => {
    const hits = findForbiddenPaths(["dist/index.js.map"]);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.label === "a JS source map")).toBe(true);
  });

  it("flags a deeply nested .js.map", () => {
    const hits = findForbiddenPaths(["dist/ui/static/chunks/abc123.js.map"]);
    expect(hits.some((h) => h.label === "a JS source map")).toBe(true);
  });

  it("preserves the exact path on the hit object", () => {
    const path = "dist/cli/index.js.map";
    const hits = findForbiddenPaths([path]);
    expect(hits.find((h) => h.label === "a JS source map")?.path).toBe(path);
  });
});

// ---------------------------------------------------------------------------
// Environment file rule
// ---------------------------------------------------------------------------

describe("findForbiddenPaths — .env (environment file)", () => {
  it("flags the bare .env file", () => {
    const hits = findForbiddenPaths([".env"]);
    expect(hits.some((h) => h.label === "an environment file")).toBe(true);
  });

  it("flags .env.local", () => {
    const hits = findForbiddenPaths([".env.local"]);
    expect(hits.some((h) => h.label === "an environment file")).toBe(true);
  });

  it("flags .env.production", () => {
    const hits = findForbiddenPaths([".env.production"]);
    expect(hits.some((h) => h.label === "an environment file")).toBe(true);
  });

  it("does NOT flag a file whose name merely contains .env as a substring (e.g. scripts/dotenv-helper.js)", () => {
    expect(findForbiddenPaths(["scripts/dotenv-helper.js"])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// keiko-ui workspace source rule
// ---------------------------------------------------------------------------

describe("findForbiddenPaths — keiko-ui workspace source", () => {
  it("flags the exact packages/keiko-ui path", () => {
    const hits = findForbiddenPaths(["packages/keiko-ui"]);
    expect(hits.some((h) => h.label === "keiko-ui workspace source")).toBe(true);
  });

  it("flags a file nested under packages/keiko-ui/", () => {
    const hits = findForbiddenPaths(["packages/keiko-ui/src/app/page.tsx"]);
    expect(hits.some((h) => h.label === "keiko-ui workspace source")).toBe(true);
  });

  it("does NOT flag a different workspace package under packages/", () => {
    expect(findForbiddenPaths(["packages/keiko-contracts/dist/index.js"])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Native addon binary rule (new Issue #287 AC4 guard)
// ---------------------------------------------------------------------------

describe("findForbiddenPaths — .node (native addon binary)", () => {
  it("flags a .node binary in node_modules", () => {
    const hits = findForbiddenPaths([
      "node_modules/some-native-package/build/Release/binding.node",
    ]);
    expect(hits.some((h) => h.label === "a native addon binary")).toBe(true);
  });

  it("flags a .node binary at any path depth", () => {
    const hits = findForbiddenPaths(["dist/addons/helper.node"]);
    expect(hits.some((h) => h.label === "a native addon binary")).toBe(true);
  });

  it("flags a .node file whose basename is just the extension", () => {
    const hits = findForbiddenPaths(["node_modules/pkg/prebuilds/linux-x64/node.node"]);
    expect(hits.some((h) => h.label === "a native addon binary")).toBe(true);
  });

  it("does NOT flag a file that merely ends in 'node' without the dot (e.g. dist/node)", () => {
    expect(findForbiddenPaths(["dist/cli/node"])).toEqual([]);
  });

  it("does NOT flag .d.ts.map (ends with 'map', not 'node')", () => {
    expect(findForbiddenPaths(["dist/index.d.ts.map"])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// @napi-rs/canvas specialization rule
// ---------------------------------------------------------------------------

describe("findForbiddenPaths — @napi-rs/canvas (platform-specific optional canvas)", () => {
  it("flags a path that includes node_modules/@napi-rs/canvas", () => {
    const hits = findForbiddenPaths([
      "node_modules/@napi-rs/canvas-linux-x64-gnu/canvas.linux-x64-gnu.node",
    ]);
    expect(
      hits.some((h) => h.label === "a platform-specific optional native canvas dependency"),
    ).toBe(true);
  });

  it("flags the canvas package even when it does not end in .node (belt-and-suspenders)", () => {
    const hits = findForbiddenPaths(["node_modules/@napi-rs/canvas/package.json"]);
    expect(
      hits.some((h) => h.label === "a platform-specific optional native canvas dependency"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Multi-hit: a @napi-rs/canvas .node file matches BOTH the generic and the
// specialization rule — the caller (gate script) sees two entries.
// ---------------------------------------------------------------------------

describe("findForbiddenPaths — multi-hit: canvas .node matches both rules", () => {
  it("returns two hits for a canvas .node path — generic native addon AND canvas specialization", () => {
    const path = "node_modules/@napi-rs/canvas-linux-x64-gnu/canvas.linux-x64-gnu.node";
    const hits = findForbiddenPaths([path]);
    const labels = hits.map((h) => h.label);
    expect(labels).toContain("a native addon binary");
    expect(labels).toContain("a platform-specific optional native canvas dependency");
    // Both hits carry the same path
    expect(hits.every((h) => h.path === path)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Absolute local path rule
// ---------------------------------------------------------------------------

describe("findForbiddenPaths — absolute local paths", () => {
  it("flags a Unix absolute path starting with /", () => {
    const hits = findForbiddenPaths(["/home/user/projects/keiko/dist/index.js"]);
    expect(hits.some((h) => h.label === "an absolute local path")).toBe(true);
  });

  it("flags a Windows absolute path (C:\\...)", () => {
    const hits = findForbiddenPaths(["C:\\Users\\dev\\keiko\\dist\\index.js"]);
    expect(hits.some((h) => h.label === "an absolute local path")).toBe(true);
  });

  it("flags a Windows absolute path with forward slash (C:/...)", () => {
    const hits = findForbiddenPaths(["C:/Users/dev/keiko/dist/index.js"]);
    expect(hits.some((h) => h.label === "an absolute local path")).toBe(true);
  });

  it("does NOT flag a relative path that happens to start with a letter", () => {
    expect(findForbiddenPaths(["dist/index.js"])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FORBIDDEN_TARBALL_PATH_RULES structure contract
// ---------------------------------------------------------------------------

describe("FORBIDDEN_TARBALL_PATH_RULES — structure", () => {
  it("is a non-empty array", () => {
    expect(Array.isArray(FORBIDDEN_TARBALL_PATH_RULES)).toBe(true);
    expect(FORBIDDEN_TARBALL_PATH_RULES.length).toBeGreaterThan(0);
  });

  it("every rule has a function test and a string label", () => {
    for (const rule of FORBIDDEN_TARBALL_PATH_RULES) {
      expect(typeof rule.test).toBe("function");
      expect(typeof rule.label).toBe("string");
      expect(rule.label.length).toBeGreaterThan(0);
    }
  });

  it("includes the native addon binary rule", () => {
    expect(FORBIDDEN_TARBALL_PATH_RULES.some((r) => r.label === "a native addon binary")).toBe(
      true,
    );
  });

  it("native addon rule matches .node suffix", () => {
    const rule = FORBIDDEN_TARBALL_PATH_RULES.find((r) => r.label === "a native addon binary");
    expect(rule).toBeDefined();
    expect(rule?.test("binding.node")).toBe(true);
    expect(rule?.test("binding.json")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findForbiddenPaths — mixed-path batch (integration-style)
// ---------------------------------------------------------------------------

describe("findForbiddenPaths — mixed-path batch", () => {
  it("correctly separates clean and forbidden paths in a realistic tarball listing", () => {
    const paths = [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/index.d.ts.map", // clean — declaration map stays
      "dist/index.js.map", // forbidden — JS source map
      "dist/ui/static/index.html", // clean
      ".env.local", // forbidden — env file
      "node_modules/@oscharko-dev/keiko-contracts/dist/index.js", // clean
      "node_modules/some-native/build/binding.node", // forbidden — native addon
      "dist/cli/index.js", // clean
    ];
    const hits = findForbiddenPaths(paths);
    const flaggedPaths = hits.map((h) => h.path);
    expect(flaggedPaths).toContain("dist/index.js.map");
    expect(flaggedPaths).toContain(".env.local");
    expect(flaggedPaths).toContain("node_modules/some-native/build/binding.node");
    // Clean paths must NOT appear
    expect(flaggedPaths).not.toContain("dist/index.js");
    expect(flaggedPaths).not.toContain("dist/index.d.ts.map");
    expect(flaggedPaths).not.toContain("dist/ui/static/index.html");
    expect(flaggedPaths).not.toContain("node_modules/@oscharko-dev/keiko-contracts/dist/index.js");
  });
});
