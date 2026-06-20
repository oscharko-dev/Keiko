import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeRuntimeJavaScriptSourceMaps } from "../ui-static-cleanup.mjs";

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("removeRuntimeJavaScriptSourceMaps", () => {
  let root = "";

  afterEach(async () => {
    if (root.length > 0) {
      await rm(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("removes only JavaScript source maps from the copied UI runtime tree", async () => {
    root = await mkdtemp(join(tmpdir(), "keiko-ui-static-"));
    await mkdir(join(root, "_next", "static", "chunks"), { recursive: true });
    await mkdir(join(root, "types"), { recursive: true });

    const jsMap = join(root, "_next", "static", "chunks", "app.js.map");
    const nestedJsMap = join(root, "_next", "static", "chunks", "vendor.js.map");
    const jsChunk = join(root, "_next", "static", "chunks", "app.js");
    const declarationMap = join(root, "types", "index.d.ts.map");
    const html = join(root, "index.html");

    await writeFile(jsMap, '{"version":3}\n', "utf8");
    await writeFile(nestedJsMap, '{"version":3}\n', "utf8");
    await writeFile(jsChunk, "console.log('keiko');\n", "utf8");
    await writeFile(declarationMap, '{"version":3}\n', "utf8");
    await writeFile(html, "<!doctype html>\n", "utf8");

    const removed = await removeRuntimeJavaScriptSourceMaps(root);

    expect(removed.map((path) => relative(root, path)).sort()).toEqual([
      "_next/static/chunks/app.js.map",
      "_next/static/chunks/vendor.js.map",
    ]);
    await expect(exists(jsMap)).resolves.toBe(false);
    await expect(exists(nestedJsMap)).resolves.toBe(false);
    await expect(exists(jsChunk)).resolves.toBe(true);
    await expect(exists(declarationMap)).resolves.toBe(true);
    await expect(exists(html)).resolves.toBe(true);
  });
});
