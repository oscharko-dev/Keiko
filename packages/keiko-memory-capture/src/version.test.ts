import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import { KEIKO_MEMORY_CAPTURE_VERSION } from "./version.js";

const require = createRequire(import.meta.url);
const manifest = require("../package.json") as { version: string };

describe("KEIKO_MEMORY_CAPTURE_VERSION", () => {
  it("matches the package manifest so a release bump cannot drift the constant", () => {
    expect(KEIKO_MEMORY_CAPTURE_VERSION).toBe(manifest.version);
  });
});
