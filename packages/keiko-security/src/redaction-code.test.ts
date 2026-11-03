import { execFileSync } from "node:child_process";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { redact } from "./redaction.js";

const sourceOptions = {
  preserveSourceLineBreaks: true,
  sourceLanguage: "typescript" as const,
};

function parseErrors(source: string): number {
  return (
    ts.transpileModule(source, {
      fileName: "fixture.tsx",
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.Preserve,
      },
      reportDiagnostics: true,
    }).diagnostics?.length ?? 0
  );
}

describe("code redaction retains syntax while protecting literal secrets", () => {
  it.each([
    "unrelated prefix\nsession renewal authentication token session renewal",
    "const unrelated = true;\nexport function renewSession() {\n  return refresh token rotation;\n}",
    "0123456789\n",
    '{ method: "POST", pattern: "/api/chats/messages/grounded", handler: handleGroundedAsk },\n',
    "export const largeNeedle = 1;\n x x",
    "'quoted phrase' is mentioned here",
  ])("retains public fragments with no credential value (%s)", (source) => {
    let refusals = 0;
    const output = redact(source, [], {
      ...sourceOptions,
      onCodeProjection: (report): void => {
        refusals += report.syntaxRefusals;
      },
    });
    expect(output).toBe(source);
    expect(refusals).toBe(0);
  });

  it.each(["\n", "\r\n"])(
    "keeps public source after a completed standalone PEM block (%j)",
    (newline) => {
      const boundary = "-".repeat(5);
      const source = [
        `${boundary}BEGIN PRIVATE KEY${boundary}`,
        "AAAAB3NzaC1yc2EAAAADAQABAAABgQ",
        `${boundary}END PRIVATE KEY${boundary}`,
        'export const marker = "public-after-pem";',
        'const password = "private-after-pem";',
        "",
      ].join(newline);
      let refusals = 0;
      const output = redact(source, [], {
        ...sourceOptions,
        onCodeProjection: (report): void => {
          refusals += report.syntaxRefusals;
        },
      });
      expect(refusals).toBe(0);
      expect(output.split(newline)[3]).toBe('export const marker = "public-after-pem";');
      expect(output.split(newline)).toHaveLength(source.split(newline).length);
      expect(output).not.toContain("AAAAB3NzaC1yc2EAAAADAQABAAABgQ");
      expect(output).not.toContain("private-after-pem");
    },
  );

  it.each([
    "let complete: (token: string) => void;",
    "interface Input { readonly token: string; password?: string; }",
    "type Handler<T> = (token: T) => Promise<T>;",
    "async function submit() { const token = await reserve(); return token; }",
    "function submit() { const password = credentials.current(); return password; }",
    "const token: ReturnType<typeof reserve> = reserve();",
    "function Component() { let done: (token: string) => void; return <button>Reserve</button>; }",
  ])("preserves non-literal TypeScript structure: %s", (source) => {
    expect(parseErrors(source)).toBe(0);
    const output = redact(source, [], sourceOptions);
    expect(output).toBe(source);
    expect(parseErrors(output)).toBe(0);
  });

  it.each(["typescript", "tsx", "javascript", "java"])(
    "preserves a computed value inside a %s code fence",
    (language) => {
      const source =
        language === "java"
          ? "final String token = client.reserve();"
          : "async function submit() { const token = await reserve(); return token; }";
      const text = `\`\`\`${language}\n${source}\n\`\`\``;
      expect(redact(text)).toBe(text);
    },
  );

  it.each([
    'const token: string = "synthetic-unit-fixture-value";',
    'const credentials = { token: "synthetic-unit-fixture-value" };',
    'const credentials = { "password": "synthetic-unit-fixture-value" };',
    'const token: { value: string } = { value: "synthetic-unit-fixture-value" };',
    'let password = ""; password += "synthetic-unit-fixture-value";',
    'let token = ""; token ||= "synthetic-unit-fixture-value";',
    'let password: string | undefined; password ??= "synthetic-unit-fixture-value";',
    'class Input { #password = "synthetic-unit-fixture-value"; }',
    'class Input { #password = ""; set(){ this.#password = "synthetic-unit-fixture-value"; } }',
    'const { label: password = "synthetic-unit-fixture-value" } = options;',
  ])("masks assigned literal values without invalidating TypeScript: %s", (source) => {
    expect(parseErrors(source)).toBe(0);
    const output = redact(source, [], sourceOptions);
    expect(output).not.toContain("synthetic-unit-fixture-value");
    expect(output).toContain("[REDACTED]");
    expect(parseErrors(output)).toBe(0);
    expect(redact(output, [], sourceOptions)).toBe(output);
  });

  it("retains the generic plain-text key/value protection", () => {
    expect(redact("token: string")).toBe("token: [REDACTED]");
    expect(redact("token = synthetic-unit-fixture-value")).not.toContain(
      "synthetic-unit-fixture-value",
    );
    expect(redact('{"token":"synthetic-unit-fixture-value"}')).not.toContain(
      "synthetic-unit-fixture-value",
    );
  });

  it.each(["\n", "\r\n"])(
    "retains physical source lines and unconditional configured literal protection (%j)",
    (newline) => {
      const source = [
        "interface Input { token: string; }",
        'const token: string = "synthetic-unit-fixture-value";',
        'const visible = "configured-private-fixture";',
      ].join(newline);
      const output = redact(source, ["configured-private-fixture"], sourceOptions);
      expect(output.split(newline)).toHaveLength(3);
      expect(output).not.toContain("synthetic-unit-fixture-value");
      expect(output).not.toContain("configured-private-fixture");
      expect(parseErrors(output)).toBe(0);
    },
  );
  it("refuses parser stack exhaustion without exposing the source body", () => {
    const source =
      'const token: string = "opaque-depth-witness";\n' +
      "const value = " +
      "(".repeat(4000) +
      "1" +
      ")".repeat(4000) +
      ";";
    expect(() => redact(source, [], sourceOptions)).not.toThrow();
    expect(redact(source, [], sourceOptions)).not.toContain("opaque-depth-witness");
  });
  it("retains Markdown presentation prefixes around masked multiline code data", () => {
    const source = "> ```ts\n> const password = `private-prefix\n> private-suffix`;\n> ```";
    const output = redact(source);
    expect(output).not.toContain("private-prefix");
    expect(output).not.toContain("private-suffix");
    expect(output.split("\n").every((line) => line.startsWith("> "))).toBe(true);
  });

  it("protects configured multiline data after the renderer removes quote prefixes", () => {
    const source = "> ```ts\n> const visible = `private-prefix\n> private-suffix`;\n> ```";
    const output = redact(source, ["private-prefix\nprivate-suffix"]);
    expect(output).not.toContain("private-prefix");
    expect(output).not.toContain("private-suffix");
    expect(output.split("\n").every((line) => line.startsWith("> "))).toBe(true);
  });
  it("keeps plain word histories and their literal secrets outside language SDK initialization", () => {
    const moduleUrl = new URL("../dist/redaction.js", import.meta.url).href;
    const script = `
      import { createRequire } from "node:module";
      const url = ${JSON.stringify(moduleUrl)};
      const require = createRequire(url);
      const api = await import(url);
      const texts = ["private-history ".repeat(300), "private-history, ordinary prose."];
      const exactPlain = texts.every(text => api.redact(text) === text);
      const privateHidden = texts.every(text => !api.redact(text,["private-history"]).includes("private-history"));
      process.stdout.write(JSON.stringify({exactPlain,privateHidden,
        typescriptLoaded:Boolean(require.cache[require.resolve("typescript")]),
        javaLoaded:Boolean(require.cache[require.resolve("java-parser")])}));
    `;
    const result: unknown = JSON.parse(
      execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
        encoding: "utf8",
      }),
    );
    expect(result).toEqual({
      exactPlain: true,
      privateHidden: true,
      typescriptLoaded: false,
      javaLoaded: false,
    });
  });

  it("loads the TypeScript parser only for actual TypeScript source work", () => {
    const moduleUrl = new URL("../dist/redaction.js", import.meta.url).href;
    const script = `
      import { createRequire } from "node:module";
      const url = ${JSON.stringify(moduleUrl)};
      const require = createRequire(url);
      const entry = require.resolve("typescript");
      const api = await import(url);
      const onImport = Boolean(require.cache[entry]);
      api.redact("Ordinary diagnostic.");
      const onPlain = Boolean(require.cache[entry]);
      api.redact("class Basic extends Base {}", [], {sourceLanguage:"java"});
      const onJava = Boolean(require.cache[entry]);
      api.redact("interface Input { token: string; }", [], {sourceLanguage:"typescript"});
      process.stdout.write(JSON.stringify({onImport,onPlain,onJava,onTypescript:Boolean(require.cache[entry])}));
    `;
    const result: unknown = JSON.parse(
      execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
        encoding: "utf8",
      }),
    );
    expect(result).toEqual({ onImport: false, onPlain: false, onJava: false, onTypescript: true });
  });
});
