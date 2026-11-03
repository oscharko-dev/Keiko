import ts from "typescript";
import { describe, expect, it } from "vitest";
import { redact } from "./redaction.js";

function diagnosticCodes(text: string): readonly number[] {
  const name = "/keiko-redaction-fixture.tsx";
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.Preserve,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (path, version, onError, fresh): ts.SourceFile | undefined =>
    path === name
      ? ts.createSourceFile(path, `export {};\n${text}`, version, true, ts.ScriptKind.TSX)
      : original(path, version, onError, fresh);
  const program = ts.createProgram([name], options, host);
  return [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()]
    .filter((diagnostic) => diagnostic.file?.fileName === name)
    .map((diagnostic) => diagnostic.code);
}

const preserved = [
  'declare const sourceValue: string; const token = "Bearer " + sourceValue;',
  'declare function derive(value: string): string; const token = derive("public context");',
  "let complete: (token: string) => void;",
  'type Descriptor = { token: "public-discriminant" };',
  "interface Configuration { api_key: string; }",
  "class Base {} class Basic extends Base {}",
  "const pattern = /\\/\\/token: string/;",
  "declare function reserve(): Promise<string>; async function submit() { const token = await reserve(); return token; }",
];
const masked = [
  'const token: "opaque-compiler-witness" = "opaque-compiler-witness";',
  'const value: { password: "opaque-compiler-witness" } = { password: "opaque-compiler-witness" };',
  'const token: string = "opaque-compiler-witness";',
  'const credentials = { "pass\\u0077ord": "opaque-compiler-witness" };',
  'declare const input: { token?: string }; const { token: localToken = "opaque-compiler-witness" } = input;',
  'const credentials = { ["password"]: "opaque-compiler-witness" };',
  "const password = `opaque-compiler-witness\r\nsecond-private-part`;",
  "// password: opaque-compiler-witness\nconst publicValue = 1;",
];

describe("code redaction preserves both syntax and types", () => {
  it.each(["731916", "731916n"])("protects typed numeric credential data %s", (value) => {
    const source = `const password: ${value} = ${value};`;
    expect(diagnosticCodes(source)).toEqual([]);
    const output = redact(source, [], { sourceLanguage: "typescript" });
    expect(output).not.toContain("731916");
    expect(diagnosticCodes(output)).toEqual([]);
  });
  it.each(preserved)("retains public code with zero compiler errors: %s", (source) => {
    expect(diagnosticCodes(source)).toEqual([]);
    const output = redact(source, [], { sourceLanguage: "typescript" });
    expect(output).toBe(source);
    expect(diagnosticCodes(output)).toEqual([]);
  });

  it.each(masked)("masks actual literal data without introducing compiler errors: %s", (source) => {
    expect(diagnosticCodes(source)).toEqual([]);
    const output = redact(source, [], { sourceLanguage: "typescript" });
    expect(output).not.toContain("opaque-compiler-witness");
    expect(diagnosticCodes(output)).toEqual([]);
    expect(redact(output, [], { sourceLanguage: "typescript" })).toBe(output);
  });
});
