import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Every `git` the product runs inside the delivery journeys (#3387, #3388, #3389) is a fresh Node
// process started from `coding-issue-delivery-transport.mts`: `installDeliveryTransport` writes a
// `git` and a `gh` wrapper that import this module and nothing else. One stage or commit step makes
// a few hundred of those calls, strictly one after the other, so the module's import graph is paid a
// few hundred times per step.
//
// The module used to import `buildPrBodyReadArgv` from the `@oscharko-dev/keiko-tools` package
// barrel. Loading that barrel alone costs about 0.25 s per process, against about 0.03 s for a bare
// Node process and about 0.07 s for the same four argv builders imported from their own files. A
// staged-candidate step then ran past the 60 s tool-bridge deadline (`MAX_TOOL_BRIDGE_DEADLINE_MS`,
// opencodeRuntimeComposition.ts) on the Linux runner, the fixture's stage promise rejected, and the
// run never reached "verified-turn-ready" -- in every nightly run since the suites were added.
//
// A fixture that restated the cost would stay green over the regression, so this pin reads the
// module's own import statements: a value import of a package barrel fails here, long before it
// fails as a 120 s poll on a runner nobody can attach to.

const SOURCE = readFileSync(
  join(import.meta.dirname, "coding-issue-delivery-transport.mts"),
  "utf8",
);

/** The module specifier of every import that is not type-only (type imports are erased). */
function valueImportSpecifiers(source: string): readonly string[] {
  return [...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)";/gmu)].map(
    (match) => match[1] ?? "",
  );
}

describe("delivery transport shim import graph", () => {
  it("imports no workspace package barrel, which every wrapped git call would load", () => {
    const barrels = valueImportSpecifiers(SOURCE).filter((specifier) =>
      /^@oscharko-dev\/[^/]+$/u.test(specifier),
    );

    expect(barrels).toEqual([]);
  });

  it("still reads the argv builders it matches provider calls against", () => {
    const specifiers = valueImportSpecifiers(SOURCE);

    expect(specifiers).toContain("../../../packages/keiko-tools/src/git-pr-body.js");
    expect(specifiers).toContain("../../../packages/keiko-tools/src/git-pr-gateway.js");
  });

  it("recognises a barrel import written across several lines", () => {
    const sample =
      'import {\n  buildPrBodyReadArgv,\n  other,\n} from "@oscharko-dev/keiko-tools";\n';

    expect(valueImportSpecifiers(sample)).toEqual(["@oscharko-dev/keiko-tools"]);
    expect(valueImportSpecifiers('import type { A } from "@oscharko-dev/keiko-tools";\n')).toEqual(
      [],
    );
  });
});
