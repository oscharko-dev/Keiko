import { describe, expect, it, vi } from "vitest";
import { memFs } from "./_memfs.js";

describe("in-memory workspace live membership", () => {
  it("streams current membership through the actual receiver's instrumented directory port", async () => {
    const files: Record<string, string> = { "a.ts": "first" };
    const fs = memFs("/workspace", files);
    const readDir = vi.spyOn(fs, "readDir");
    files["new.ts"] = "new content";
    delete files["a.ts"];
    if (fs.iterateDirectory === undefined) throw new TypeError("Missing fixture iterator");
    const names: string[] = [];
    for await (const item of fs.iterateDirectory("/workspace")) names.push(item.name);
    expect(names).toEqual(["new.ts"]);
    expect(readDir).toHaveBeenCalledExactlyOnceWith("/workspace");
  });

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
