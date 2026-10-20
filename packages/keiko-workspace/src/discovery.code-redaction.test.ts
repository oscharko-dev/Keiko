import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectWorkspaceAt } from "./detect.js";
import {
  readWorkspaceFile,
  readWorkspaceFileForEditing,
  readWorkspaceFilePrefixForEvidence,
  readWorkspaceFileTextForInternalUse,
} from "./discovery.js";
import { nodeWorkspaceFs } from "./fs.js";
import { readExcerpt, searchText } from "./repoSearch.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sources = [
  ["source.ts", "let complete: (token: string) => void;\nconst token = client.reserve();"],
  ["source.tsx", "const token = client.reserve();\nconst element = <Widget token={token} />;"],
  ["source.js", "const token = client.reserve();\nexport { token };"],
  ["Source.java", "class Basic extends Base {\nString token = client.reserve();\n}"],
] as const;

function fixture(name: string, text: string): ReturnType<typeof detectWorkspaceAt> {
  const root = mkdtempSync(join(tmpdir(), "keiko-code-redaction-"));
  roots.push(root);
  writeFileSync(join(root, name), text);
  return detectWorkspaceAt(root, undefined, { scanSourceFilesForLanguages: false });
}

describe("workspace code evidence redaction", () => {
  it.each([
    'class Example { string password = @"private-first""private-second"; }',
    'class Example { string password = $"private-first{1}private-second"; }',
    'class Example { string password = """private-first private-second"""; }',
    'class Example { string p\\u0061ssword = "private-first private-second"; }',
  ])("refuses ambiguous C# literal syntax without publishing its data (%s)", (source) => {
    const workspace = fixture("source.cs", source);
    expect(() => readWorkspaceFile(workspace, "source.cs")).toThrow(
      "code source redaction is unavailable",
    );
    expect(readWorkspaceFileForEditing(workspace, "source.cs").rawText).toBe(source);
  });

  it("retains strict protection for an ordinary escaped C# credential literal", () => {
    const source = 'class Example { string password = "private-first\\"private-second"; }';
    const workspace = fixture("source.cs", source);
    const evidence = readWorkspaceFile(workspace, "source.cs").text;
    expect(evidence).not.toContain("private-first");
    expect(evidence).not.toContain("private-second");
  });

  it("refuses a broken JSON string whose newline detaches its private tail", () => {
    const source = '{"public":"kept","password":"private-first\nprivate-second"}';
    const workspace = fixture("source.json", source);
    expect(() => readWorkspaceFile(workspace, "source.json")).toThrow(
      "code source redaction is unavailable",
    );
    expect(readWorkspaceFileForEditing(workspace, "source.json").rawText).toBe(source);
  });

  it.each([
    ["source.cs", "class Example { public string Read() { return client.reserve(); } }"],
    ["schema.graphql", "type Query { reserve: String }"],
    ["source.java", "Maple partner refunds.\n"],
    ["package-lock.json", "export const publicFact = 37;\n"],
  ])("retains admitted public %s bytes without imposing another language", (name, source) => {
    const workspace = fixture(name, source);
    expect(readWorkspaceFile(workspace, name).text).toBe(source);
  });

  it.each([
    '{"public":"kept","password":"private-first',
    '{"public":"kept","pass\\u0077ord":"private-first',
    '{"public":"kept","password":{"value":"private-first","pending":{',
  ])("retains a safe JSON prefix without extending its read grant (%s)", (source) => {
    const workspace = fixture("partial.json", source);
    const evidence = readWorkspaceFile(workspace, "partial.json").text;
    expect(evidence).toContain('"public":"kept"');
    expect(evidence).not.toContain("private-first");
    expect(readWorkspaceFileForEditing(workspace, "partial.json").rawText).toBe(source);
  });

  it.each(sources)(
    "retains %s code in complete, prefix and internal evidence reads",
    (name, source) => {
      const workspace = fixture(name, source);
      expect(readWorkspaceFile(workspace, name).text).toBe(source);
      expect(readWorkspaceFilePrefixForEvidence(workspace, name, 4096, nodeWorkspaceFs)).toBe(
        source,
      );
      expect(
        readWorkspaceFileTextForInternalUse(
          workspace,
          name,
          { maxBytes: 4096 },
          nodeWorkspaceFs,
          "evidence",
        ).content,
      ).toBe(source);
      expect(readWorkspaceFileForEditing(workspace, name).rawText).toBe(source);
    },
  );

  it.each(sources)(
    "retains %s code through actual search and excerpt readers",
    async (name, source) => {
      const scope = {
        workspace: fixture(name, source),
        scopeId: "code-redaction",
        relativePaths: [name],
      };
      const result = await searchText(scope, {
        kind: "exact-symbol",
        text: "client.reserve",
        caseSensitive: true,
        maxResults: 10,
        emittedAtMs: 0,
      });
      expect(result.atoms).toHaveLength(1);
      const excerpt = await readExcerpt(scope, {
        scopePath: name,
        startLine: 1,
        endLine: source.split("\n").length,
        maxBytes: 4096,
      });
      expect(excerpt.content).toBe(source);
    },
  );

  it("retains literal secrecy in source while leaving the manual editor exact", () => {
    const source =
      'interface Input { token: string; }\nconst token: string = "opaque-workspace-witness";';
    const workspace = fixture("source.ts", source);
    const evidence = readWorkspaceFile(workspace, "source.ts").text;
    expect(evidence).toContain("token: string");
    expect(evidence).not.toContain("opaque-workspace-witness");
    expect(readWorkspaceFileForEditing(workspace, "source.ts").rawText).toBe(source);
  });
  it("reports unavailable source when its safe parser cannot complete", () => {
    const source =
      'const token: string = "opaque-depth-witness";\nconst value = ' +
      "(".repeat(4000) +
      "1" +
      ")".repeat(4000) +
      ";";
    const workspace = fixture("deep.ts", source);
    expect(() => readWorkspaceFile(workspace, "deep.ts")).toThrow(
      "code source redaction is unavailable",
    );
    expect(readWorkspaceFileForEditing(workspace, "deep.ts").rawText).toBe(source);
  });
});
