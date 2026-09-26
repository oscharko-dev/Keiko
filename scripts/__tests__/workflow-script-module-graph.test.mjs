import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { unresolvableImports, workflowEntryScripts } from "./workflow-script-graph.mjs";

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

  it("names a missing entry point instead of passing it silently", () => {
    const root = fixture({ "scripts/present.mjs": "export {};\n" });

    expect(unresolvableImports("scripts/absent.mjs", root)).toEqual([
      { from: "scripts/absent.mjs", specifier: "(entry point missing)" },
    ]);
  });
});
