import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { fsyncDirectoryContaining } from "./durable-write.js";

describe("fsyncDirectoryContaining", () => {
  it("skips the unsupported directory fsync operation on Windows", () => {
    expect(() => {
      fsyncDirectoryContaining(join("missing", "evidence.json"), "win32");
    }).not.toThrow();
  });
});
