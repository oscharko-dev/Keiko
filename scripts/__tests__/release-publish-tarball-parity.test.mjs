import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// #3577 gave release-publish.mjs the smoke's external-closure bundling so the published tarball
// was the tarball the smoke proved; #3565 removed that bundling from both. 1.1.2 embedded 20
// third-party packages and doubled the artefact, and a customer's repository firewall refused to
// evaluate it, so the release could not be installed at all. The two scripts must keep staging the
// same way: the vendored workspaces only, third-party runtime dependencies declared, never
// embedded. A bundling call reappearing in one of them is the parity hole and the artefact change
// at once.
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
    "%s stages the vendored workspaces exactly once and embeds no external closure",
    (file) => {
      expect(stagingCalls(file)).toStrictEqual(["createStagedPublishPackage"]);
    },
  );

  it("the staging module no longer offers an external-closure bundler", () => {
    const source = readFileSync(join(root, "scripts", "stage-publish-package.mjs"), "utf8");
    expect(source).not.toMatch(/bundleExternalRuntimeDependencies/u);
  });
});
