import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { compileGlob } from "./repoSearchMatchers.js";

// Load the actual source owner in an isolated worker. Only its normal local TypeScript imports
// are transpiled; no product files or built artifacts are written by this fixture.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { registerHooks } = require("node:module");
const { existsSync, readFileSync } = require("node:fs");
const ts = require("typescript");
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.endsWith(".ts")) {
      const source = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
      if (existsSync(source)) return { url: source.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.endsWith(".ts")) return nextLoad(url, context);
    const source = ts.transpileModule(readFileSync(new URL(url), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    return { format: "module", source, shortCircuit: true };
  }
});
import(workerData.moduleUrl).then(({ compileGlob }) => {
  parentPort.once("message", ({ pattern, path }) => {
    parentPort.postMessage(compileGlob(pattern).test(path));
  });
  parentPort.postMessage("ready");
});
`;

async function isolatedMatch(pattern: string, path: string): Promise<unknown> {
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { moduleUrl: new URL("./repoSearchMatchers.ts", import.meta.url).href },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await once(worker, "message");
    const result = once(worker, "message").then(([value]: unknown[]) => value);
    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => {
        resolve("deadline");
      }, 2_000);
    });
    worker.postMessage({ pattern, path });
    return await Promise.race([result, deadline]);
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}

describe("repository filename glob semantics", () => {
  it.each([
    ["", "", true],
    ["", "x", false],
    ["*", "", true],
    ["*", "a/b", false],
    ["?", "😀", true],
    ["??", "😀", false],
    ["?", "/", false],
    ["**", "a/b", true],
    ["**/a", "a", true],
    ["**/a", "ba", true],
    ["**/a", "x//a", true],
    ["a/**/b", "a/b", true],
    ["a/**/b", "a//b", true],
    ["a/*/b", "a/b", false],
    ["a/*/b", "a//b", true],
    ["***", "a/b", true],
    ["****/a", "x/y/a", true],
    ["[a](b){c}+d.$^|\\", "[a](b){c}+d.$^|\\", true],
    ["{a,b}", "a", false],
    ["*.ts", "file.tsx", false],
    ["*.ts", "file.ts", true],
    ["file", "file\n", false],
    ["file", "file\r\n", false],
    ["*", "line\nrest", true],
    ["**", "line\nrest", false],
    ["a?b", "a\nb", true],
    ["a**b", "a\nb", false],
    ["😀*", "😀résumé", true],
    ["\ud800?", "\ud800x", true],
    ["**/**/file", "file", true],
    ["**/**/file", "//nested//file", true],
    ["??", "é", true],
    ["?", "é", false],
    ["*.txt", "file\u2028.txt", true],
    ["**.txt", "file\u2028.txt", false],
  ])("preserves %j against %j", (pattern, path, expected) => {
    expect(compileGlob(pattern).test(path)).toBe(expected);
  });

  it.each([
    ["*.TS", "file.ts", true],
    ["K?", "k1", true],
    ["ſ?", "S1", true],
    ["σ", "ς", true],
    ["İ", "i", false],
    ["ß", "ss", false],
    ["𐐀", "𐐨", true],
  ])("preserves Unicode simple case folding for %j", (pattern, path, expected) => {
    expect(compileGlob(pattern, false).test(path)).toBe(expected);
    expect(compileGlob(pattern, true).test(path)).toBe(false);
  });
});

describe("adversarial repository filename patterns", () => {
  it.each([
    ["*a".repeat(12) + "b", "a".repeat(128)],
    ["**/a".repeat(12) + "b", "a/".repeat(128)],
    ["*a".repeat(256) + "b", "a".repeat(4_096)],
  ])(
    "settles hostile no-match patterns within the isolated worker deadline",
    async (pattern, path) => {
      expect(await isolatedMatch(pattern, path)).toBe(false);
    },
  );
});
