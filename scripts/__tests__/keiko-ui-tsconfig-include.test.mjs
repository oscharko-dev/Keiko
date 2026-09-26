import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { nextChildEnv } from "../dev-runner.mjs";

// KEIKO-0965: packages/keiko-ui/tsconfig.json used to carry a ".next/dev/dev/types/**/*.ts" include
// beside the two canonical Next-emitted entries; it matched nothing and was removed. It was not
// residue of a rename: Next's own tsconfig verifier appends it whenever next dev runs under a
// NODE_ENV other than development, and the e2e harness ran it under NODE_ENV=test, so every local
// smoke run rewrote this file and dirtied the tree. scripts/dev-runner.mjs now starts next dev as
// the development server, and the tests below derive the required globs from Next itself for the
// ways this repository runs it. Pin the include list so the entry cannot come back and so any
// legitimate future addition is a reviewed change to this pin.

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const TSCONFIG_PATH = resolve(REPO_ROOT, "packages", "keiko-ui", "tsconfig.json");
const UI_DIR = resolve(REPO_ROOT, "packages", "keiko-ui");

// Next's own producers of the answer: its config loader (distDir per phase) and the helper its
// tsconfig verifier uses to decide which type globs the include list must hold.
const requireFromUi = createRequire(resolve(UI_DIR, "package.json"));
const loadConfig = requireFromUi("next/dist/server/config.js").default;
const { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } = requireFromUi(
  "next/dist/shared/lib/constants.js",
);
const { getTypeDefinitionGlobPatterns } = requireFromUi("next/dist/lib/typescript/type-paths.js");

function typeGlobsUnder(nodeEnv, distDir) {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = nodeEnv;
  try {
    return getTypeDefinitionGlobPatterns(distDir);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

describe("keiko-ui tsconfig include list", () => {
  it("declares only the canonical Next.js emitted-type globs", () => {
    const tsconfig = JSON.parse(readFileSync(TSCONFIG_PATH, "utf8"));
    expect(tsconfig.include).toStrictEqual([
      "next-env.d.ts",
      "**/*.ts",
      "**/*.tsx",
      ".next/types/**/*.ts",
      ".next/dev/types/**/*.ts",
    ]);
  });

  it("holds every type glob Next demands for how this repository runs it", async () => {
    // A missing glob makes Next rewrite this committed file on startup.
    const include = JSON.parse(readFileSync(TSCONFIG_PATH, "utf8")).include;
    const devServer = await loadConfig(PHASE_DEVELOPMENT_SERVER, UI_DIR);
    const productionBuild = await loadConfig(PHASE_PRODUCTION_BUILD, UI_DIR);
    const required = [
      ...typeGlobsUnder(nextChildEnv(0).NODE_ENV, devServer.distDir),
      ...typeGlobsUnder("production", productionBuild.distDir),
    ];

    expect(required.filter((glob) => !include.includes(glob))).toStrictEqual([]);
  });

  it("would be rewritten if next dev inherited the e2e harness's NODE_ENV", async () => {
    const include = JSON.parse(readFileSync(TSCONFIG_PATH, "utf8")).include;
    const devServer = await loadConfig(PHASE_DEVELOPMENT_SERVER, UI_DIR);

    expect(
      typeGlobsUnder("test", devServer.distDir).filter((glob) => !include.includes(glob)),
    ).toStrictEqual([".next/dev/dev/types/**/*.ts"]);
  });
});
