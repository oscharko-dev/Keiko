import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { parsedTypeScriptSyntaxState } from "./redaction-typescript.js";

function publicSyntaxState(
  text: string,
  kind: ts.ScriptKind,
): {
  readonly file: ts.SourceFile;
  readonly valid: boolean;
  readonly firstError: number;
} {
  const name = kind === ts.ScriptKind.JSON ? "fixture.json" : "fixture.tsx";
  const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, kind);
  const host: ts.CompilerHost = {
    getSourceFile: (path): ts.SourceFile | undefined => (path === name ? file : undefined),
    getDefaultLibFileName: (): string => "",
    writeFile: (): void => undefined,
    getCurrentDirectory: (): string => "",
    getDirectories: (): string[] => [],
    fileExists: (path): boolean => path === name,
    readFile: (path): string | undefined => (path === name ? text : undefined),
    getCanonicalFileName: (path): string => path,
    useCaseSensitiveFileNames: (): boolean => true,
    getNewLine: (): string => "\n",
  };
  const diagnostics = ts
    .createProgram([name], { noLib: true, noResolve: true }, host)
    .getSyntacticDiagnostics(file);
  return {
    file,
    valid: diagnostics.length === 0,
    firstError: Math.min(text.length, ...diagnostics.map((entry) => entry.start)),
  };
}

describe("TypeScript source syntax work", () => {
  it("executes the real public fallback when parser metadata is not exposed", async () => {
    const require = createRequire(import.meta.url);
    const compiler = require("typescript") as typeof ts;
    const entry = require.cache[require.resolve("typescript")];
    if (entry === undefined) throw new TypeError("Missing loaded compiler");
    const original: unknown = entry.exports;
    entry.exports = {
      ...compiler,
      createSourceFile(...args: Parameters<typeof ts.createSourceFile>): ts.SourceFile {
        return new Proxy(compiler.createSourceFile(...args), {
          has(target, key): boolean {
            return key !== "parseDiagnostics" && Reflect.has(target, key);
          },
        });
      },
    };
    try {
      vi.resetModules();
      const owner = await import("./redaction-typescript.js");
      expect(owner.isTypeScriptSource("export const value = 1;")).toBe(true);
      expect(owner.isTypeScriptSource("export const value = ;")).toBe(false);
      expect(owner.isJsonSourcePrefix('["Public value"]', true)).toBe(true);
      expect(owner.isJsonSourcePrefix('{"value":', true)).toBe(false);
    } finally {
      entry.exports = original;
      vi.resetModules();
    }
  });

  it.each([
    "export const value = 1;",
    "export const value = ;",
    "function work( {",
    "const view = <button disabled={true}>Public</button>;",
    "const value = `unclosed",
    '{"password":"fixture-private","public":true}',
    '["Public value"]',
    '{"password":"unterminated',
  ])("matches the actual public compiler diagnostics for %s", (text) => {
    for (const kind of [ts.ScriptKind.TS, ts.ScriptKind.TSX, ts.ScriptKind.JSON]) {
      const expected = publicSyntaxState(text, kind);
      expect(parsedTypeScriptSyntaxState(expected.file, text.length, kind)).toEqual({
        valid: expected.valid,
        firstError: expected.firstError,
      });
    }
  });

  it.each([
    undefined,
    null,
    {},
    { parseDiagnostics: null },
    { parseDiagnostics: [null] },
    { parseDiagnostics: [{}] },
    { parseDiagnostics: [{ start: -1 }] },
    { parseDiagnostics: [{ start: 2 }] },
    { parseDiagnostics: [{ start: 0.5 }] },
    { parseDiagnostics: [{ start: "0" }] },
  ])("requires public-API fallback for an unsupported diagnostic shape (%j)", (file) => {
    expect(parsedTypeScriptSyntaxState(file, 1, ts.ScriptKind.TS)).toBeUndefined();
  });

  it.each([ts.ScriptKind.JS, ts.ScriptKind.JSX, ts.ScriptKind.Unknown])(
    "retains the public compiler path for unsupported script kind %s",
    (kind) => {
      expect(parsedTypeScriptSyntaxState({ parseDiagnostics: [] }, 0, kind)).toBeUndefined();
    },
  );

  it.each([
    { hideDiagnostics: false, programs: 0 },
    { hideDiagnostics: true, programs: 4 },
  ])("uses existing diagnostics or the unchanged public fallback (%j)", (control) => {
    const moduleUrl = new URL("../dist/redaction-typescript.js", import.meta.url).href;
    const script = `
      import { createRequire } from "node:module";
      const require = createRequire(${JSON.stringify(moduleUrl)});
      const entry = require.resolve("typescript");
      const compiler = require(entry);
      let programs = 0;
      require.cache[entry].exports = { ...compiler,
        createSourceFile(...args) {
          const file = compiler.createSourceFile(...args);
          return ${String(control.hideDiagnostics)} ? new Proxy(file, {
            has(target, key) { return key !== "parseDiagnostics" && Reflect.has(target, key); }
          }) : file;
        },
        createProgram(...args) { programs++; return compiler.createProgram(...args); }
      };
      const owner = await import(${JSON.stringify(moduleUrl)});
      const valid = owner.isTypeScriptSource("export const publicValue = 1;");
      const invalid = owner.isTypeScriptSource("export const publicValue = ;");
      const json = owner.isJsonSourcePrefix('["Public value"]', true);
      process.stdout.write(JSON.stringify({valid, invalid, json, programs}));
    `;
    const result: unknown = JSON.parse(
      execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
        encoding: "utf8",
      }),
    );
    expect(result).toEqual({ valid: true, invalid: false, json: true, programs: control.programs });
  });
});
