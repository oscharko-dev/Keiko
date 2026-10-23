import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  importGraphReachesDist,
  unresolvableImports,
  workflowEntryScripts,
} from "./workflow-script-graph.mjs";

// The workflows run repository scripts with plain node, while this suite runs them under vitest,
// which rewrites ".js" specifiers to ".ts" sources and adds extensions. A green suite was therefore
// no evidence that a release script could even load: on the v1.0.0 cut,
// linux-portable-signing.mjs imported a .ts module whose own graph carried ".js" specifiers, and
// every prepare/finalize/verify died with ERR_MODULE_NOT_FOUND 90 minutes into a tagged release
// while its tests passed. This pins, on the pull request, that every script any workflow invokes
// resolves its relative imports exactly as the release runner will.

describe("workflow-invoked scripts resolve under plain node", () => {
  const entries = workflowEntryScripts();

  it("guards the workflow entry points it is meant to guard", () => {
    expect(entries.length).toBeGreaterThan(50);
    for (const script of [
      "scripts/linux-portable-signing.mjs",
      "scripts/assemble-portable-release-assets.mjs",
      "scripts/release-publish.mjs",
      "native/secure-workspace-read/test-protocol.mjs",
    ]) {
      expect(entries).toContain(script);
    }
  });

  it("resolves every relative import of every workflow entry point as written", () => {
    const unresolved = entries.flatMap((entry) =>
      unresolvableImports(entry).map(({ from, specifier }) => `${entry}: ${from} -> ${specifier}`),
    );

    expect(unresolved).toEqual([]);
  });
});

describe("the resolver the guard relies on", () => {
  const roots = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  });

  const fixture = (files) => {
    const root = mkdtempSync(join(tmpdir(), "keiko-script-graph-"));
    roots.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  };

  it("reports a .js specifier that exists only as a .ts source, even inside a .ts module", () => {
    // The exact shape of the v1.0.0 failure: an .mjs script importing a .ts module whose own
    // graph names "./dep.js" while only dep.ts exists.
    const root = fixture({
      "scripts/entry.mjs": 'import { run } from "../packages/x/src/lib.ts";\nrun();\n',
      "packages/x/src/lib.ts": 'import { dep } from "./dep.js";\nexport const run = dep;\n',
      "packages/x/src/dep.ts": "export const dep = (): void => undefined;\n",
    });

    expect(unresolvableImports("scripts/entry.mjs", root)).toEqual([
      { from: "packages/x/src/lib.ts", specifier: "./dep.js" },
    ]);
  });

  it("ignores type-only imports, built output and bare package specifiers", () => {
    const root = fixture({
      "scripts/entry.mjs": [
        'import { a } from "./a.mjs";',
        'import { b } from "../packages/x/dist/b.js";',
        'import { readFileSync } from "node:fs";',
        'import { c } from "@oscharko-dev/keiko-contracts";',
        "",
      ].join("\n"),
      "scripts/a.mjs": 'import type { T } from "./missing.js";\nexport const a = 1;\n',
    });

    expect(unresolvableImports("scripts/entry.mjs", root)).toEqual([]);
  });

  it("reports a relative require() target a CommonJS module in the graph cannot load", () => {
    // An .mjs entry may import a .cjs bridge; node resolves that bridge's require() calls just
    // as literally, so a missing target there is the same MODULE_NOT_FOUND on the runner.
    const root = fixture({
      "scripts/entry.mjs": 'import bridge from "./bridge.cjs";\nbridge();\n',
      "scripts/bridge.cjs": 'const dep = require("./missing.cjs");\nmodule.exports = dep;\n',
    });

    expect(unresolvableImports("scripts/entry.mjs", root)).toEqual([
      { from: "scripts/bridge.cjs", specifier: "./missing.cjs" },
    ]);
  });

  it.each([
    [
      "quoted generated source",
      `const source = 'import "./missing-string.mjs";';
const built = 'export { value } from "../packages/x/dist/string.js";';`,
    ],
    [
      "line comments",
      '// import "./missing-comment.mjs";\n// import "../packages/x/dist/comment.js";',
    ],
    [
      "block comments",
      '/* import "./missing-comment.mjs"; export { value } from "../packages/x/dist/comment.js"; */',
    ],
    [
      "template text",
      'const source = `import "./missing-template.mjs"; import "../packages/x/dist/template.js";`;',
    ],
    [
      "regular expressions",
      String.raw`const source = /import ".\/missing-regex.mjs";/u;
const built = /import "..\/packages\/x\/dist\/regex.js";/u;`,
    ],
  ])("ignores import-like %s in both graph consumers", (_shape, source) => {
    const root = fixture({ "scripts/entry.mjs": source });

    expect.soft(unresolvableImports("scripts/entry.mjs", root)).toEqual([]);
    expect.soft(importGraphReachesDist("scripts/entry.mjs", root)).toBe(false);
  });

  it.each([
    ["a static named import", (specifier) => `import { value } from "${specifier}";`],
    ["a static re-export", (specifier) => `export { value } from "${specifier}";`],
    ["a side-effect import", (specifier) => `import "${specifier}";`],
    ["a literal dynamic import", (specifier) => `void import("${specifier}");`],
    ["a template expression", (specifier) => 'const value = `${import("' + specifier + '")}`;'],
  ])("retains %s as an actual edge in both graph consumers", (_shape, source) => {
    const missingRoot = fixture({ "scripts/entry.mjs": source("./missing.mjs") });
    const builtRoot = fixture({
      "scripts/entry.mjs": source("../packages/x/dist/missing.js"),
    });

    expect(unresolvableImports("scripts/entry.mjs", missingRoot)).toEqual([
      { from: "scripts/entry.mjs", specifier: "./missing.mjs" },
    ]);
    expect(importGraphReachesDist("scripts/entry.mjs", builtRoot)).toBe(true);
  });

  it.each(["require", "module.require"])(
    "preserves %s without expanding the provisioning import scope",
    (loader) => {
      const root = fixture({
        "scripts/entry.cjs": `const value = ${loader}("./missing.cjs");`,
        "scripts/lazy.mjs": `const load = () => ${loader}("../packages/x/dist/value.js");`,
      });

      expect(unresolvableImports("scripts/entry.cjs", root)).toEqual([
        { from: "scripts/entry.cjs", specifier: "./missing.cjs" },
      ]);
      expect(importGraphReachesDist("scripts/lazy.mjs", root)).toBe(false);
    },
  );

  it("names a missing entry point instead of passing it silently", () => {
    const root = fixture({ "scripts/present.mjs": "export {};\n" });

    expect(unresolvableImports("scripts/absent.mjs", root)).toEqual([
      { from: "scripts/absent.mjs", specifier: "(entry point missing)" },
    ]);
  });
});
