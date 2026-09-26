import { describe, expect, it } from "vitest";

import { createRequire } from "node:module";

import { KEIKO_MEMORY_CONSOLIDATION_VERSION } from "./version.js";

// The packaged manifest owns the version; a literal here re-states it and goes
// stale on every release cut (KfQ findings on #3055).
const { version: packageVersion } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

describe("KEIKO_MEMORY_CONSOLIDATION_VERSION", () => {
  it("pins the package's published version literal", () => {
    expect(KEIKO_MEMORY_CONSOLIDATION_VERSION).toBe(packageVersion);
  });
});
