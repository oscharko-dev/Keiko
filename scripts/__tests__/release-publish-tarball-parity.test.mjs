import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// #3577. The installable-package smoke proves a SELF-CONTAINED tarball: after staging it bundles the
// external runtime dependency closure (#3510), because on npm 11.19 `npm install -g` of a
// bundle-carrying package installs nothing that is not bundled. release-publish.mjs never received
// that call, so every release shipped a tarball the smoke had not tested: `npm install -g
// @oscharko-dev/keiko@1.1.1` left `ws` empty and every `keiko` command died with
// `Cannot find package 'ws'`. The publisher and the smoke must stage the same way.
const root = join(import.meta.dirname, "..", "..");

function stagingCalls(file) {
  const source = readFileSync(join(root, "scripts", file), "utf8");
  const calls = [];
  for (const match of source.matchAll(
    /\b(createStagedPublishPackage|bundleExternalRuntimeDependencies)\(/gu,
  )) {
    // Imports and declarations are not calls: a call site is followed by an argument or `)`.
    const before = source.slice(Math.max(0, match.index - 9), match.index);
    if (!before.endsWith("function ")) calls.push(match[1]);
  }
  return calls;
}

describe("the published tarball is the tarball the install smoke proves", () => {
  it.each(["release-publish.mjs", "installable-package-smoke.mjs"])(
    "%s bundles the external runtime closure right after staging, exactly once",
    (file) => {
      expect(stagingCalls(file)).toStrictEqual([
        "createStagedPublishPackage",
        "bundleExternalRuntimeDependencies",
      ]);
    },
  );
});
