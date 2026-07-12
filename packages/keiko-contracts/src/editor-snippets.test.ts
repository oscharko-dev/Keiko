import { describe, expect, it } from "vitest";

import {
  EDITOR_M7_SNIPPET_COLLECTION_VERSION,
  compileEditorM7SnippetBody,
  matchingEditorM7Snippets,
  parseEditorM7WorkspaceSnippetCollection,
  type EditorM7WorkspaceSnippet,
  type EditorM7WorkspaceSnippetCollection,
} from "./editor-snippets.js";

const PROVENANCE = {
  source: "workspace",
  workspaceFingerprint: "0123456789abcdef0123456789abcdef",
} as const;

function snippet(change: Partial<EditorM7WorkspaceSnippet> = {}): EditorM7WorkspaceSnippet {
  return {
    id: "ts-test",
    name: "TypeScript test",
    prefixes: ["ktest"],
    description: "Create a Vitest test",
    languages: ["typescript"],
    include: ["src/**/*.ts"],
    exclude: ["src/**/*.spec.ts"],
    body: ['describe("${1:name}", () => {', "  it('${2:works}', () => {", "    $0", "  });", "});"],
    revision: 1,
    provenance: PROVENANCE,
    ...change,
  };
}

function collection(
  snippets: readonly EditorM7WorkspaceSnippet[] = [snippet()],
): EditorM7WorkspaceSnippetCollection {
  return {
    schemaVersion: EDITOR_M7_SNIPPET_COLLECTION_VERSION,
    revision: 1,
    snippets,
  };
}

describe("editor workspace snippets", () => {
  it("parses bounded safe snippets and compiles them for Monaco snippet insertion", () => {
    const parsed = parseEditorM7WorkspaceSnippetCollection(collection());
    expect(parsed.ok).toBe(true);
    expect(
      compileEditorM7SnippetBody([
        "const ${1|left,right|} = ${CURRENT_YEAR};",
        "console.log(${1});",
      ]),
    ).toStrictEqual({
      ok: true,
      value: "const ${1|left,right|} = ${CURRENT_YEAR};\nconsole.log(${1});$0",
    });
  });

  it("rejects code execution, clipboard/environment variables, transforms, HTML, and unsafe paths", () => {
    expect(
      parseEditorM7WorkspaceSnippetCollection(collection([snippet({ body: ["$(whoami)"] })])),
    ).toMatchObject({
      ok: false,
      reasonCode: "UNSAFE_SNIPPET",
    });
    expect(
      parseEditorM7WorkspaceSnippetCollection(collection([snippet({ body: ["${CLIPBOARD}"] })])),
    ).toMatchObject({ ok: false, reasonCode: "UNSAFE_SNIPPET" });
    expect(
      parseEditorM7WorkspaceSnippetCollection(collection([snippet({ body: ["${1/foo/bar/}"] })])),
    ).toMatchObject({ ok: false, reasonCode: "UNSAFE_SNIPPET" });
    expect(
      parseEditorM7WorkspaceSnippetCollection(
        collection([snippet({ body: ["<script>x</script>"] })]),
      ),
    ).toMatchObject({ ok: false, reasonCode: "UNSAFE_SNIPPET" });
    expect(
      parseEditorM7WorkspaceSnippetCollection(collection([snippet({ include: ["../secret.ts"] })])),
    ).toMatchObject({ ok: false, reasonCode: "UNSAFE_PATH" });
  });

  it("matches by canonical language, workspace-relative include/exclude, prefix, and cancellation", () => {
    const parsed = parseEditorM7WorkspaceSnippetCollection(collection());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected valid snippets");
    expect(
      matchingEditorM7Snippets({
        collection: parsed.value,
        languageId: "typescript",
        relativePath: "src/app.ts",
        prefix: "kte",
        insertionSafe: true,
      }),
    ).toHaveLength(1);
    expect(
      matchingEditorM7Snippets({
        collection: parsed.value,
        languageId: "javascript",
        relativePath: "src/app.ts",
        prefix: "kte",
        insertionSafe: true,
      }),
    ).toHaveLength(0);
    expect(
      matchingEditorM7Snippets({
        collection: parsed.value,
        languageId: "typescript",
        relativePath: "src/app.spec.ts",
        prefix: "kte",
        insertionSafe: true,
      }),
    ).toHaveLength(0);
    expect(
      matchingEditorM7Snippets({
        collection: parsed.value,
        languageId: "typescript",
        relativePath: "src/app.ts",
        prefix: "kte",
        insertionSafe: false,
      }),
    ).toHaveLength(0);
  });

  it("fails closed for future, malformed, duplicate, oversized, and deeply nested collections", () => {
    expect(
      parseEditorM7WorkspaceSnippetCollection({ schemaVersion: "99", revision: 1, snippets: [] }),
    ).toMatchObject({ ok: false, reasonCode: "SCHEMA_VERSION_UNSUPPORTED" });
    expect(
      parseEditorM7WorkspaceSnippetCollection(collection([snippet({ prefixes: [] })])),
    ).toMatchObject({
      ok: false,
      reasonCode: "INVALID_INPUT",
    });
    expect(
      parseEditorM7WorkspaceSnippetCollection(
        collection([snippet({ body: ["${1:${2:${3:${4:${5:x}}}}}"] })]),
      ),
    ).toMatchObject({ ok: false, reasonCode: "UNSAFE_SNIPPET" });
    expect(
      parseEditorM7WorkspaceSnippetCollection(
        collection(
          Array.from({ length: 129 }, (_, index) => snippet({ id: `s${index.toString()}` })),
        ),
      ),
    ).toMatchObject({
      ok: false,
      reasonCode: "OVERSIZED",
    });
  });
});
