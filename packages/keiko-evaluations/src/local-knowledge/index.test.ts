// KEIKO-0653 regression pin — local-knowledge's public barrel (index.ts) states that consumers
// outside this package never import from this subdirectory directly, so every fixture exported
// from fixtures.ts must be individually re-exported by name here too. The 8 `htmlManual*`
// fixtures added later (Epic #1858/#1902) joined `ALL_FIXTURES` but were never added to this
// named-export block, silently leaving them reachable only through the collective array.

import { describe, expect, it } from "vitest";
import * as barrel from "./index.js";

describe("KEIKO-0653 local-knowledge barrel re-exports every fixture by name", () => {
  it.each([
    "htmlManualStructureFixture",
    "htmlManualTableRowFixture",
    "htmlManualFramesetFixture",
    "htmlManualCodeBlockFixture",
    "htmlManualMalformedFixture",
    "htmlManualDeniedLinkFixture",
    "htmlManualIndexPageFixture",
    "htmlManualMultilingualFixture",
  ])("%s is a named export of the barrel", (name) => {
    const value = (barrel as unknown as Record<string, unknown>)[name];
    expect(value, `expected ${name} on local-knowledge barrel`).toBeDefined();
  });
});
