import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  importGraphReachesDist,
  providesBuiltPackages,
  repositoryScriptsIn,
  rootPackageScripts,
  workflowJobs,
} from "./workflow-script-graph.mjs";

// Every job installs with `npm ci --ignore-scripts`, which builds nothing, so a step that loads
// packages/*/dist needs an earlier step of its own job that builds it. The previous walker followed
// relative imports only and guarded two Linux jobs. On the v1.0.0 release, 2026-09-14, `assemble`
// died with ERR_MODULE_NOT_FOUND on @oscharko-dev/keiko-contracts, which it reaches through the
// qualification producers. Walking workspace package specifiers as well showed that release.yml's
// publish job would have died the same way after the npm-publish approval (release-publish.mjs has
// imported @oscharko-dev/keiko-security since #3456, and no publish ran since), and that the
// scheduled code-task-real-binary lane had been failing that way every day.

describe("built workspace packages in every workflow job", () => {
  it("builds the packages before any step whose scripts load built package output", () => {
    const scripts = rootPackageScripts();
    const missing = [];
    for (const { file, name, job } of workflowJobs()) {
      const steps = job.steps ?? [];
      const providerAt = steps.findIndex((step) => providesBuiltPackages(step.run, scripts));
      steps.forEach((step, index) => {
        for (const script of repositoryScriptsIn(step.run ?? "", scripts)) {
          if (!importGraphReachesDist(script)) continue;
          if (providerAt < 0 || providerAt >= index) {
            missing.push(`${file} ${name}: "${String(step.name)}" runs ${script}`);
          }
        }
      });
    }

    expect(missing).toEqual([]);
  });

  it("still sees the release entry points that load built package output", () => {
    // A walker gone blind would pass the pin above over a broken job.
    for (const script of [
      "scripts/assemble-portable-release-assets.mjs",
      "scripts/release-publish.mjs",
      "scripts/linux-portable-signing.mjs",
      "scripts/run-code-task-real-binary.mjs",
    ]) {
      expect(importGraphReachesDist(script), script).toBe(true);
    }
    // It runs before `npm ci` in every job, so it must not need a build.
    expect(importGraphReachesDist("scripts/check-runtime-toolchain.mjs")).toBe(false);
  });
});

describe("the import walk and build detection the pin relies on", () => {
  const roots = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  });

  const fixture = (files) => {
    const root = mkdtempSync(join(tmpdir(), "keiko-built-packages-"));
    roots.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(
        join(root, path),
        typeof content === "string" ? content : JSON.stringify(content),
      );
    }
    return root;
  };

  const contracts = {
    "packages/contracts/package.json": {
      name: "@scope/contracts",
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
        "./runtime/acceptance": { import: "./dist/acceptance.js" },
        "./schemas/*": { import: "./dist/schemas/*.js" },
      },
    },
  };

  it.each([
    ["a relative path into built output", 'import { a } from "../packages/contracts/dist/a.js";\n'],
    ["a workspace export", 'import { b } from "@scope/contracts/runtime/acceptance";\n'],
    ["a workspace wildcard export", 'import { c } from "@scope/contracts/schemas/task";\n'],
    ["a workspace root export", 'export { d } from "@scope/contracts";\n'],
    ["a dynamic workspace import", 'await import("@scope/contracts");\n'],
    ["an unexported workspace subpath", 'import { e } from "@scope/contracts/internal";\n'],
  ])("reaches built output through %s", (_shape, source) => {
    const root = fixture({ ...contracts, "scripts/entry.mjs": source });

    expect(importGraphReachesDist("scripts/entry.mjs", root)).toBe(true);
  });

  it("substitutes every * of a pattern export target, as node does", () => {
    // Node replaces each "*" on the target side, so "./src/*/*.mjs" for "tools/run" is
    // ./src/run/run.mjs. Substituting only the first one looks at a file that does not exist and
    // misses the built output that file imports.
    const root = fixture({
      "packages/tools/package.json": {
        name: "@scope/tools",
        exports: { "./tools/*": "./src/*/*.mjs" },
      },
      "packages/tools/src/run/run.mjs": 'export { x } from "../../dist/x.js";\n',
      "scripts/entry.mjs": 'import { x } from "@scope/tools/tools/run";\n',
    });

    expect(importGraphReachesDist("scripts/entry.mjs", root)).toBe(true);
  });

  it("follows a script into a TypeScript source that imports a workspace package", () => {
    const root = fixture({
      ...contracts,
      "scripts/entry.mjs": 'import { run } from "../packages/tool/src/run.ts";\n',
      "packages/tool/src/run.ts": 'import { f } from "@scope/contracts";\nexport const run = f;\n',
    });

    expect(importGraphReachesDist("scripts/entry.mjs", root)).toBe(true);
  });

  it("ignores type-only imports, non-workspace packages and node builtins", () => {
    const root = fixture({
      ...contracts,
      "scripts/entry.mjs": [
        'import type { T } from "@scope/contracts";',
        'import { parse } from "yaml";',
        'import { readFileSync } from "node:fs";',
        'import { local } from "./local.mjs";',
        "",
      ].join("\n"),
      "scripts/local.mjs": "export const local = 1;\n",
    });

    expect(importGraphReachesDist("scripts/entry.mjs", root)).toBe(false);
  });

  it("detects a build behind npm scripts, and nothing else", () => {
    const scripts = {
      "build:packages": "node scripts/build-packages.mjs",
      typecheck: "npm run build:packages && tsc --noEmit",
      test: "npm run build:packages && vitest run",
      lint: "eslint .",
      "release:publish": "node scripts/release-publish.mjs",
    };

    expect(providesBuiltPackages("npm run build:packages", scripts)).toBe(true);
    expect(providesBuiltPackages("npm run typecheck", scripts)).toBe(true);
    expect(providesBuiltPackages("npm test", scripts)).toBe(true);
    expect(providesBuiltPackages("npm run -s typecheck", scripts)).toBe(true);
    expect(providesBuiltPackages("npm ci --ignore-scripts", scripts)).toBe(false);
    expect(providesBuiltPackages("npm run lint", scripts)).toBe(false);
    expect(providesBuiltPackages('npm run release:publish -- --tag "$TAG"', scripts)).toBe(false);
    expect(providesBuiltPackages(undefined, scripts)).toBe(false);
  });
});
