import { describe, expect, it } from "vitest";

import {
  EDITOR_M7_SNIPPET_COLLECTION_VERSION,
  compileEditorM7SnippetBody,
  editorM7SnippetDiagnostics,
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

  it("allows a safe variable or plain tabstop nested inside a tabstop default", () => {
    expect(
      parseEditorM7WorkspaceSnippetCollection(
        collection([snippet({ body: ["${1:${CURRENT_YEAR}}"] })]),
      ),
    ).toMatchObject({ ok: true });
    expect(
      parseEditorM7WorkspaceSnippetCollection(collection([snippet({ body: ["${1:${2:inner}}"] })])),
    ).toMatchObject({ ok: true });
  });

  it("accepts documented variables in braced and unbraced syntax plus escaped dollars", () => {
    expect(
      parseEditorM7WorkspaceSnippetCollection(
        collection([
          snippet({
            body: [
              "$TM_FILENAME ${TM_FILENAME_BASE}",
              "$CURRENT_YEAR-${CURRENT_MONTH}-${CURRENT_DATE}",
              String.raw`\$CLIPBOARD \${ENV} \$UNKNOWN`,
              "$1 ${2:default $TM_FILENAME} ${3|left,right|} $0",
              "${4|left\\,side,right\\|pipe|} ${5:literal \\} brace}",
            ],
          }),
        ]),
      ),
    ).toMatchObject({ ok: true });
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

function rawSnippet(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    id: "ts-test",
    name: "TypeScript test",
    prefixes: ["ktest"],
    description: "Create a Vitest test",
    languages: ["typescript"],
    body: ["const x = 1;"],
    revision: 1,
    provenance: PROVENANCE,
    ...overrides,
  };
}

function rawCollection(snippets: readonly unknown[]): unknown {
  return {
    schemaVersion: EDITOR_M7_SNIPPET_COLLECTION_VERSION,
    revision: 1,
    snippets,
  };
}

describe("editor workspace snippets — rejection and diagnostic paths", () => {
  it.each<[string, unknown]>([
    ["null", null],
    ["primitive number", 42],
    ["array literal", []],
    [
      "unknown top-level key",
      {
        schemaVersion: EDITOR_M7_SNIPPET_COLLECTION_VERSION,
        revision: 1,
        snippets: [],
        extra: true,
      },
    ],
  ])("rejects non-collection top-level value: %s", (_label, value) => {
    expect(parseEditorM7WorkspaceSnippetCollection(value)).toMatchObject({
      ok: false,
      reasonCode: "INVALID_INPUT",
    });
  });

  it.each<[string, unknown]>([
    [
      "negative revision",
      { schemaVersion: EDITOR_M7_SNIPPET_COLLECTION_VERSION, revision: -1, snippets: [] },
    ],
    [
      "fractional revision",
      { schemaVersion: EDITOR_M7_SNIPPET_COLLECTION_VERSION, revision: 1.5, snippets: [] },
    ],
    [
      "non-array snippets",
      { schemaVersion: EDITOR_M7_SNIPPET_COLLECTION_VERSION, revision: 0, snippets: "no" },
    ],
    ["missing snippets key", { schemaVersion: EDITOR_M7_SNIPPET_COLLECTION_VERSION, revision: 0 }],
  ])("rejects malformed collection shape: %s", (_label, value) => {
    expect(parseEditorM7WorkspaceSnippetCollection(value)).toMatchObject({
      ok: false,
      reasonCode: "INVALID_INPUT",
    });
  });

  it("captures thrown errors during collection parsing", () => {
    const hostile: Record<string, unknown> = {
      schemaVersion: EDITOR_M7_SNIPPET_COLLECTION_VERSION,
      snippets: [],
    };
    Object.defineProperty(hostile, "revision", {
      enumerable: true,
      configurable: true,
      get(): number {
        throw new Error("hostile revision access");
      },
    });
    expect(parseEditorM7WorkspaceSnippetCollection(hostile)).toMatchObject({
      ok: false,
      reasonCode: "INVALID_INPUT",
    });
  });

  it.each<[string, unknown]>([
    ["absolute-rooted glob", ["/etc/hosts"]],
    ["backslash in glob", ["src\\bad.ts"]],
    ["null byte in glob", ["src/bad\0.ts"]],
    ["current-directory segment", ["src/./file.ts"]],
    ["include is not an array", "src/**/*.ts"],
  ])("rejects unsafe include pattern: %s", (_label, include) => {
    expect(
      parseEditorM7WorkspaceSnippetCollection(rawCollection([rawSnippet({ include })])),
    ).toMatchObject({ ok: false, reasonCode: "UNSAFE_PATH" });
  });

  it.each<[string, unknown]>([
    ["empty body array", []],
    ["over MAX_BODY_LINES", Array.from({ length: 65 }, () => "line")],
    ["non-string body entry", [42]],
    ["body is not an array", "single-line"],
  ])("rejects unsafe body shape: %s", (_label, body) => {
    expect(
      parseEditorM7WorkspaceSnippetCollection(rawCollection([rawSnippet({ body })])),
    ).toMatchObject({ ok: false, reasonCode: "UNSAFE_SNIPPET" });
  });

  it.each<[string, string | readonly string[]]>([
    ["javascript: URL", "javascript:alert(1)"],
    ["unbalanced open brace", "${1:x"],
    ["unrecognized placeholder variable", "${UNKNOWN_VAR}"],
    ["unrecognized variable nested in a tabstop default", "${1:${ENV}}"],
    ["unrecognized variable nested with surrounding text", "${1:prefix ${SECRET} suffix}"],
    ["choice with an unescaped pipe", "${1|left|right|}"],
    ["unbraced clipboard variable", "$CLIPBOARD"],
    ["unbraced environment variable", "$ENV"],
    ["unbraced unknown variable", "$UNKNOWN"],
    ["underscore-prefixed unknown variable", "$__ENV"],
    ["safe-variable prefix with an unknown suffix", "$TM_FILENAME_SECRET"],
    ["active image element", '<img src="x" onerror="alert(1)">'],
    ["active SVG event handler", '<svg onload="alert(1)"></svg>'],
    ["active HTML form", '<form action="https://example.test"><input></form>'],
    ["multiline active HTML", ["<div", '\tonload="alert(1)">unsafe</div>']],
    ["active Markdown image", "![tracking](https://example.test/pixel.png)"],
    ["active Markdown data target", "[payload](data:text/html,<b>unsafe</b>)"],
  ])("rejects unsafe body line: %s", (_label, line) => {
    expect(
      parseEditorM7WorkspaceSnippetCollection(
        rawCollection([rawSnippet({ body: Array.isArray(line) ? line : [line] })]),
      ),
    ).toMatchObject({ ok: false, reasonCode: "UNSAFE_SNIPPET" });
  });

  it.each<[string, Readonly<Record<string, unknown>>]>([
    ["invalid id token", { id: "bad space!" }],
    ["empty name", { name: "" }],
    ["empty description", { description: "" }],
    ["invalid language token", { languages: ["INVALID"] }],
    ["negative snippet revision", { revision: -1 }],
    [
      "bad provenance fingerprint",
      { provenance: { source: "workspace", workspaceFingerprint: "not-hex" } },
    ],
    [
      "wrong provenance source",
      { provenance: { source: "external", workspaceFingerprint: "0123456789abcdef" } },
    ],
  ])("rejects invalid snippet field: %s", (_label, overrides) => {
    expect(
      parseEditorM7WorkspaceSnippetCollection(rawCollection([rawSnippet(overrides)])),
    ).toMatchObject({ ok: false, reasonCode: "INVALID_INPUT" });
  });

  it("accepts snippet body containing 2-, 3-, and 4-byte UTF-8 characters", () => {
    const parsed = parseEditorM7WorkspaceSnippetCollection(
      rawCollection([rawSnippet({ body: ["// é 3-byte 漢 4-byte \u{1D552} tail"] })]),
    );
    expect(parsed.ok).toBe(true);
  });

  it("compileEditorM7SnippetBody rejects an unsafe body", () => {
    expect(compileEditorM7SnippetBody(["$(rm -rf)"])).toMatchObject({
      ok: false,
      reasonCode: "UNSAFE_SNIPPET",
    });
  });

  it("editorM7SnippetDiagnostics reports schema, revision, counts, and hash", () => {
    const parsed = parseEditorM7WorkspaceSnippetCollection(rawCollection([rawSnippet()]));
    if (!parsed.ok) throw new Error("expected valid collection");
    expect(editorM7SnippetDiagnostics(parsed.value, "hash-abc")).toStrictEqual({
      schemaVersion: EDITOR_M7_SNIPPET_COLLECTION_VERSION,
      revision: 1,
      snippetCount: 1,
      prefixCount: 1,
      bodyHash: "hash-abc",
      reasonCodes: [],
    });
  });

  it("matchingEditorM7Snippets returns empty when the signal is already aborted", () => {
    const parsed = parseEditorM7WorkspaceSnippetCollection(rawCollection([rawSnippet()]));
    if (!parsed.ok) throw new Error("expected valid collection");
    const controller = new AbortController();
    controller.abort();
    expect(
      matchingEditorM7Snippets({
        collection: parsed.value,
        languageId: "typescript",
        relativePath: "src/app.ts",
        prefix: "kte",
        insertionSafe: true,
        signal: controller.signal,
      }),
    ).toEqual([]);
  });

  it("matchingEditorM7Snippets observes an abort inside the snippet loop", () => {
    const parsed = parseEditorM7WorkspaceSnippetCollection(rawCollection([rawSnippet()]));
    if (!parsed.ok) throw new Error("expected valid collection");
    let reads = 0;
    const signal = {
      get aborted(): boolean {
        reads += 1;
        return reads > 1;
      },
    } as AbortSignal;
    expect(
      matchingEditorM7Snippets({
        collection: parsed.value,
        languageId: "typescript",
        relativePath: "src/app.ts",
        prefix: "kte",
        insertionSafe: true,
        signal,
      }),
    ).toEqual([]);
  });

  it("matchingEditorM7Snippets drops snippets whose prefix does not match", () => {
    const parsed = parseEditorM7WorkspaceSnippetCollection(rawCollection([rawSnippet()]));
    if (!parsed.ok) throw new Error("expected valid collection");
    expect(
      matchingEditorM7Snippets({
        collection: parsed.value,
        languageId: "typescript",
        relativePath: "src/app.ts",
        prefix: "zzz",
        insertionSafe: true,
      }),
    ).toEqual([]);
  });

  it("treats absent include as unrestricted and dedupes matches by label", () => {
    const parsed = parseEditorM7WorkspaceSnippetCollection(
      rawCollection([
        rawSnippet({ id: "one", name: "First" }),
        rawSnippet({ id: "two", name: "Second" }),
      ]),
    );
    if (!parsed.ok) throw new Error("expected valid collection");
    const matches = matchingEditorM7Snippets({
      collection: parsed.value,
      languageId: "typescript",
      relativePath: "docs/anywhere.ts",
      prefix: "kte",
      insertionSafe: true,
    });
    expect(matches).toHaveLength(1);
  });

  it("supports `**` glob patterns without a trailing slash", () => {
    const parsed = parseEditorM7WorkspaceSnippetCollection(
      rawCollection([rawSnippet({ include: ["src/**"] })]),
    );
    if (!parsed.ok) throw new Error("expected valid collection");
    expect(
      matchingEditorM7Snippets({
        collection: parsed.value,
        languageId: "typescript",
        relativePath: "src/deep/nested/file.ts",
        prefix: "kte",
        insertionSafe: true,
      }),
    ).toHaveLength(1);
  });

  it("rejects a glob containing repeated globstars before matching", () => {
    expect(
      parseEditorM7WorkspaceSnippetCollection(
        rawCollection([rawSnippet({ include: [`${"**/".repeat(24)}x.ts`] })]),
      ),
    ).toMatchObject({ ok: false, reasonCode: "UNSAFE_PATH" });
  });

  it.each([
    ["a**/a", "a/a"],
    ["component**/*.tsx", "component/file.tsx"],
  ])("preserves globstar-directory matching for %s against %s", (include, relativePath) => {
    const parsed = parseEditorM7WorkspaceSnippetCollection(
      rawCollection([rawSnippet({ include: [include] })]),
    );
    if (!parsed.ok) throw new Error("expected valid collection");
    expect(
      matchingEditorM7Snippets({
        collection: parsed.value,
        languageId: "typescript",
        relativePath,
        prefix: "kte",
        insertionSafe: true,
      }),
    ).toHaveLength(1);
  });

  it("matches hostile wildcard patterns within a bounded runtime", () => {
    const parsed = parseEditorM7WorkspaceSnippetCollection(
      rawCollection([rawSnippet({ include: [`${"a*".repeat(14)}b`] })]),
    );
    if (!parsed.ok) throw new Error("expected valid collection");
    const startedAt = performance.now();
    const matches = matchingEditorM7Snippets({
      collection: parsed.value,
      languageId: "typescript",
      relativePath: "a".repeat(30),
      prefix: "kte",
      insertionSafe: true,
    });
    expect(matches).toEqual([]);
    expect(performance.now() - startedAt).toBeLessThan(100);
  });
});
