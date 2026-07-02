import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkUiStaticJavaScriptCompatibility } from "../check-ui-static-js-compat.mjs";

describe("checkUiStaticJavaScriptCompatibility", () => {
  let root = "";

  afterEach(async () => {
    if (root.length > 0) {
      await rm(root, { recursive: true, force: true });
      root = "";
    }
  });

  async function writeChunk(source) {
    root = await mkdtemp(join(tmpdir(), "keiko-ui-static-compat-"));
    const chunkDir = join(root, "_next", "static", "chunks");
    await mkdir(chunkDir, { recursive: true });
    await writeFile(join(chunkDir, "chunk.js"), source, "utf8");
  }

  async function writeWorker(source) {
    root = await mkdtemp(join(tmpdir(), "keiko-ui-static-compat-"));
    const workerDir = join(root, "_next", "static", "media");
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "editor.worker.abc123.js"), source, "utf8");
  }

  it("allows dynamic import used by PDF.js worker and fallback loading", async () => {
    await writeChunk("async function loadWorker(src) { return import(src); }\n");

    await expect(checkUiStaticJavaScriptCompatibility(root)).resolves.toBeUndefined();
  });

  it("allows emitted module worker assets with top-level import/export", async () => {
    await writeWorker("import { work } from './chunk.js';\nexport { work };\n");

    await expect(checkUiStaticJavaScriptCompatibility(root)).resolves.toBeUndefined();
  });

  it("still blocks optional chaining", async () => {
    await writeChunk("window.keiko?.start();\n");

    await expect(checkUiStaticJavaScriptCompatibility(root)).rejects.toThrow("optional chaining");
  });

  it("still blocks nullish coalescing", async () => {
    await writeChunk("const mode = window.keikoMode ?? 'safe';\n");

    await expect(checkUiStaticJavaScriptCompatibility(root)).rejects.toThrow("nullish coalescing");
  });

  it("still blocks import.meta", async () => {
    await writeChunk("console.log(import.meta.url);\n");

    await expect(checkUiStaticJavaScriptCompatibility(root)).rejects.toThrow("import.meta");
  });
});
