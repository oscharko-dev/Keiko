import { describe, expect, it } from "vitest";
import { memFs } from "./_memfs.js";

describe("in-memory workspace live membership", () => {
  it("reads files added after construction without a preceding directory scan", () => {
    const files: Record<string, string> = { "src/a.ts": "first" };
    const fs = memFs("/workspace", files);
    files["src/new.ts"] = "new content";
    expect(fs.exists("/workspace/src/new.ts")).toBe(true);
    expect(fs.stat("/workspace/src/new.ts").isFile).toBe(true);
    expect(fs.readFileUtf8("/workspace/src/new.ts")).toBe("new content");
  });

  it("does not retain deleted files as empty files in its lookup index", () => {
    const files: Record<string, string> = { "src/a.ts": "first" };
    const fs = memFs("/workspace", files);
    delete files["src/a.ts"];
    expect(fs.exists("/workspace/src/a.ts")).toBe(false);
    expect(() => fs.readFileUtf8("/workspace/src/a.ts")).toThrow("ENOENT");
  });
});
