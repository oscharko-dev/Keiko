import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  checkUiStaticJavaScriptCompatibility,
  runUiStaticJavaScriptCompatibilityCli,
} from "../check-ui-static-js-compat.mjs";
import { rejectUiStaticRootCliOverride } from "../lib/ui-static-root-boundary.mjs";
import { runTranspileUiStaticJavaScriptCli } from "../transpile-ui-static-js.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("checkUiStaticJavaScriptCompatibility", () => {
  let root = "";
  let outsideRoot = "";

  afterEach(async () => {
    if (root.length > 0) {
      await rm(root, { recursive: true, force: true });
      root = "";
    }
    if (outsideRoot.length > 0) {
      await rm(outsideRoot, { recursive: true, force: true });
      outsideRoot = "";
    }
  });

  async function writeChunk(source) {
    root = await mkdtemp(join(repoRoot, ".keiko-ui-static-compat-"));
    const chunkDir = join(root, "_next", "static", "chunks");
    await mkdir(chunkDir, { recursive: true });
    await writeFile(join(chunkDir, "chunk.js"), source, "utf8");
  }

  async function writeWorker(source, filename = "editor.worker.abc123.js") {
    root = await mkdtemp(join(repoRoot, ".keiko-ui-static-compat-"));
    const workerDir = join(root, "_next", "static", "media");
    const workerPath = join(workerDir, filename);
    await mkdir(dirname(workerPath), { recursive: true });
    await writeFile(workerPath, source, "utf8");
  }

  it("allows dynamic import used by PDF.js worker and fallback loading", async () => {
    await writeChunk("async function loadWorker(src) { return import(src); }\n");

    await expect(checkUiStaticJavaScriptCompatibility(root)).resolves.toBeUndefined();
  });

  it("allows emitted module worker assets with top-level import/export", async () => {
    await writeWorker("import { work } from './chunk.js';\nexport { work };\n");

    await expect(checkUiStaticJavaScriptCompatibility(root)).resolves.toBeUndefined();
  });

  it("allows Monaco 0.56 editor worker assets with top-level import/export", async () => {
    await writeWorker(
      "import { bootstrapWebWorker } from './webWorkerBootstrap.js';\nexport { bootstrapWebWorker };\n",
      "editorWebWorkerMain.abc123.js",
    );

    await expect(checkUiStaticJavaScriptCompatibility(root)).resolves.toBeUndefined();
  });

  it.each([
    "editorWebWorkerMain.js",
    "editorWebWorkerMain.foo.bar.js",
    "editorWebWorkerMain.abc\n123.js",
    join("nested", "editorWebWorkerMain.abc123.js"),
  ])("rejects lookalike Monaco editor worker module filename %s", async (filename) => {
    await writeWorker(
      "import { bootstrapWebWorker } from './webWorkerBootstrap.js';\nexport { bootstrapWebWorker };\n",
      filename,
    );

    await expect(checkUiStaticJavaScriptCompatibility(root)).rejects.toThrow("sourceType: module");
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

  it("rejects a static root outside the repository", async () => {
    outsideRoot = await mkdtemp(join(tmpdir(), "keiko-ui-static-outside-"));

    await expect(checkUiStaticJavaScriptCompatibility(outsideRoot)).rejects.toThrow(
      "must stay inside the repository",
    );
  });

  it("rejects CLI static-root overrides before they can reach filesystem operations", () => {
    expect(() => rejectUiStaticRootCliOverride(undefined)).not.toThrow();
    expect(() => rejectUiStaticRootCliOverride("../../outside")).toThrow(
      "CLI overrides are not supported",
    );
  });

  it("runs both CLI entrypoint operations only with their canonical static roots", async () => {
    const operations = [];

    await runUiStaticJavaScriptCompatibilityCli([], async () => operations.push("check"));
    await runTranspileUiStaticJavaScriptCli([], async () => operations.push("transpile"));

    expect(operations).toEqual(["check", "transpile"]);
  });

  it("rejects symbolic links before reading JavaScript", async () => {
    root = await mkdtemp(join(repoRoot, ".keiko-ui-static-compat-"));
    outsideRoot = await mkdtemp(join(tmpdir(), "keiko-ui-static-outside-"));
    const outsideFile = join(outsideRoot, "outside.js");
    await writeFile(outsideFile, "globalThis.compromised = true;\n", "utf8");
    await symlink(outsideFile, join(root, "linked.js"));

    await expect(checkUiStaticJavaScriptCompatibility(root)).rejects.toThrow(
      "must not contain symbolic links",
    );
  });
});
