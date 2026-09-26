import { describe, expect, it } from "vitest";

import { createRequire } from "node:module";
import { KEIKO_GIT_VERSION } from "./version.js";

// The packaged manifest owns the version; a literal here re-states it and goes
// stale on every release cut (KfQ findings on #3055).
const { version: packageVersion } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

describe("KEIKO_GIT_VERSION", () => {
  it("matches the packaged manifest version", () => {
    expect(KEIKO_GIT_VERSION).toBe(packageVersion);
  });
});
