import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import { buildRedactor, createInMemoryUiStore } from "../index.js";
import type { RouteContext, UiHandlerDeps } from "../index.js";
import type { UiStore } from "../store/index.js";
import {
  handleEditorWorkspaceReplaceApply,
  handleEditorWorkspaceReplacePreview,
  handleEditorWorkspaceSearch,
  handleEditorWorkspaceSymbols,
} from "./workspaceSearchRoutes.js";

function rawPostContext(raw: string, path: string): RouteContext {
  const req = Readable.from([Buffer.from(raw, "utf8")]) as unknown as IncomingMessage;
  (req as { method?: string }).method = "POST";
  return {
    req,
    res: {} as unknown as ServerResponse,
    params: {},
    url: new URL(`http://localhost${path}`),
  };
}

function postContext(body: unknown, path = "/api/editor/workspace-search"): RouteContext {
  return rawPostContext(JSON.stringify(body), path);
}

let root: string;
let store: UiStore;

function deps(): UiHandlerDeps {
  return {
    store,
    redactor: buildRedactor({}),
    evidenceStore: createInMemoryEvidenceStore(),
  } as unknown as UiHandlerDeps;
}

function searchBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    root,
    query: "parseConfig",
    mode: "literal",
    caseSensitive: false,
    includeGlobs: [],
    excludeGlobs: [],
    maxResults: 20,
    ...overrides,
  };
}

function replaceBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    root,
    query: "parseConfig",
    mode: "literal",
    caseSensitive: false,
    includeGlobs: [],
    excludeGlobs: [],
    replacement: "readConfig",
    maxFiles: 20,
    ...overrides,
  };
}

function symbolBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    root,
    query: "parse",
    maxResults: 20,
    ...overrides,
  };
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "keiko-workspace-search-route-")));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "src", "scoped"), { recursive: true });
  await writeFile(
    join(root, "src", "a.ts"),
    [
      "export function parseConfig(value: string): string {",
      "  return value.trim();",
      "}",
      'export const marker = parseConfig("a");',
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(root, "src", "b.ts"),
    [
      "export function parseConfigBeta(value: string): string {",
      "  return parseConfigBeta(value);",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(root, "src", "scoped", "c.ts"),
    [
      "export function parseConfigScoped(value: string): string {",
      "  return value.toUpperCase();",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(root, "src", "case.ts"), "Alpha\nalpha\n", "utf8");
  store = createInMemoryUiStore();
  store.createProject(root, "fixture");
});

afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

describe("POST /api/editor/workspace-search", () => {
  it("returns literal search results with bounded snippets", async () => {
    const result = await handleEditorWorkspaceSearch(postContext(searchBody()), deps());

    expect(result.status).toBe(200);
    const body = result.body as {
      results: { path: string; lineRange: { startLine: number }; snippet: string }[];
      filesScanned: number;
    };
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results[0]?.path).toMatch(/^src\/[ab]\.ts$/);
    expect(body.results[0]?.lineRange.startLine).toBeGreaterThan(0);
    expect(body.results[0]?.snippet).toContain("parseConfig");
    expect(body.filesScanned).toBeGreaterThan(0);
  });

  it("supports safe regex mode and rejects unsafe regex requests", async () => {
    const safe = await handleEditorWorkspaceSearch(
      postContext(searchBody({ query: "parseConfig\\w*", mode: "regex" })),
      deps(),
    );
    expect(safe.status).toBe(200);

    const unsafe = await handleEditorWorkspaceSearch(
      postContext(searchBody({ query: "(a+)+", mode: "regex" })),
      deps(),
    );
    expect(unsafe.status).toBe(400);
    expect(unsafe.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("honors case sensitivity", async () => {
    const sensitive = await handleEditorWorkspaceSearch(
      postContext(searchBody({ query: "Alpha", caseSensitive: true })),
      deps(),
    );
    const insensitive = await handleEditorWorkspaceSearch(
      postContext(searchBody({ query: "Alpha", caseSensitive: false })),
      deps(),
    );

    expect(sensitive.status).toBe(200);
    expect(insensitive.status).toBe(200);
    const sensitiveBody = sensitive.body as { results: unknown[] };
    const insensitiveBody = insensitive.body as { results: unknown[] };
    expect(insensitiveBody.results.length).toBeGreaterThan(sensitiveBody.results.length);
  });

  it("matches embedded identifiers only when whole-word search is disabled", async () => {
    await writeFile(join(root, "src", "whole-word.ts"), "export const id = 1;\n", "utf8");
    await writeFile(
      join(root, "src", "embedded-word.ts"),
      "export const userId = logId;\n",
      "utf8",
    );

    const wholeWord = await handleEditorWorkspaceSearch(
      postContext(searchBody({ query: "id", wholeWord: true })),
      deps(),
    );
    const substring = await handleEditorWorkspaceSearch(
      postContext(searchBody({ query: "id", wholeWord: false })),
      deps(),
    );

    expect(wholeWord.status).toBe(200);
    expect(substring.status).toBe(200);
    const wholeWordPaths = (wholeWord.body as { results: { path: string }[] }).results.map(
      (result) => result.path,
    );
    const substringPaths = (substring.body as { results: { path: string }[] }).results.map(
      (result) => result.path,
    );
    expect(wholeWordPaths).toContain("src/whole-word.ts");
    expect(wholeWordPaths).not.toContain("src/embedded-word.ts");
    expect(substringPaths).toEqual(
      expect.arrayContaining(["src/whole-word.ts", "src/embedded-word.ts"]),
    );
  });

  it("keeps user-facing workspace search lexical rather than semantic", async () => {
    const result = await handleEditorWorkspaceSearch(
      postContext(searchBody({ query: "configuration parser" })),
      deps(),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ results: [] });
  });

  it("applies include and exclude glob filters through the governed file-search facade", async () => {
    const included = await handleEditorWorkspaceSearch(
      postContext(searchBody({ includeGlobs: ["src/a.ts"] })),
      deps(),
    );
    const excluded = await handleEditorWorkspaceSearch(
      postContext(searchBody({ excludeGlobs: ["src/a.ts"] })),
      deps(),
    );

    expect(included.status).toBe(200);
    expect(excluded.status).toBe(200);
    const includedBody = included.body as { results: { path: string }[] };
    const excludedBody = excluded.body as { results: { path: string }[] };
    expect(new Set(includedBody.results.map((entry) => entry.path))).toEqual(new Set(["src/a.ts"]));
    expect(excludedBody.results.every((entry) => entry.path !== "src/a.ts")).toBe(true);
  });

  it("reports truncation when the requested cap is smaller than the true match set", async () => {
    const result = await handleEditorWorkspaceSearch(
      postContext(searchBody({ query: "parseConfig", maxResults: 1 })),
      deps(),
    );

    expect(result.status).toBe(200);
    const body = result.body as { results: unknown[]; truncated: boolean };
    expect(body.results).toHaveLength(1);
    expect(body.truncated).toBe(true);
  });

  it("rejects denied glob scopes and oversized request bodies", async () => {
    const denied = await handleEditorWorkspaceSearch(
      postContext(searchBody({ includeGlobs: [".git/config"] })),
      deps(),
    );
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: { code: "DENIED" } });

    const oversized = await handleEditorWorkspaceSearch(
      rawPostContext(
        JSON.stringify({ ...searchBody(), padding: "x".repeat(70 * 1024) }),
        "/api/editor/workspace-search",
      ),
      deps(),
    );
    expect(oversized.status).toBe(413);
  });
});

describe("POST /api/editor/workspace-symbols", () => {
  it("rejects an empty symbol query", async () => {
    const result = await handleEditorWorkspaceSymbols(
      postContext(symbolBody({ query: " " }), "/api/editor/workspace-symbols"),
      deps(),
    );

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("returns bounded definition symbols with jump locations", async () => {
    const result = await handleEditorWorkspaceSymbols(
      postContext(symbolBody({ query: "parseConfig" }), "/api/editor/workspace-symbols"),
      deps(),
    );

    expect(result.status).toBe(200);
    const body = result.body as {
      results: { symbol: string; kind: string; path: string; line: number }[];
      filesScanned: number;
    };
    expect(body.results[0]).toMatchObject({
      symbol: "parseConfig",
      kind: "function",
      path: "src/a.ts",
      line: 1,
    });
    expect(body.filesScanned).toBeGreaterThan(0);
  });

  it("narrows symbol results to the optional root-relative scope", async () => {
    const result = await handleEditorWorkspaceSymbols(
      postContext(
        symbolBody({ query: "parseConfig", scopePath: "src/scoped" }),
        "/api/editor/workspace-symbols",
      ),
      deps(),
    );

    expect(result.status).toBe(200);
    const body = result.body as { results: { path: string; symbol: string }[] };
    expect(body.results).toEqual([
      expect.objectContaining({ path: "src/scoped/c.ts", symbol: "parseConfigScoped" }),
    ]);
  });

  it("rejects denied and escaping symbol scopes before scanning", async () => {
    const denied = await handleEditorWorkspaceSymbols(
      postContext(symbolBody({ scopePath: ".git/config" }), "/api/editor/workspace-symbols"),
      deps(),
    );
    const escape = await handleEditorWorkspaceSymbols(
      postContext(symbolBody({ scopePath: "../secret" }), "/api/editor/workspace-symbols"),
      deps(),
    );

    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: { code: "DENIED" } });
    expect(escape.status).toBe(400);
    expect(escape.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("returns an empty result set when no symbols match", async () => {
    const result = await handleEditorWorkspaceSymbols(
      postContext(symbolBody({ query: "NoSuchSymbol" }), "/api/editor/workspace-symbols"),
      deps(),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ results: [], truncated: false });
  });

  it("reports truncation when the result cap is smaller than matching symbols", async () => {
    const result = await handleEditorWorkspaceSymbols(
      postContext(symbolBody({ query: "parse", maxResults: 1 }), "/api/editor/workspace-symbols"),
      deps(),
    );

    expect(result.status).toBe(200);
    const body = result.body as { results: unknown[]; truncated: boolean };
    expect(body.results).toHaveLength(1);
    expect(body.truncated).toBe(true);
  });
});

describe("POST /api/editor/workspace-search/replace-preview", () => {
  it("returns proposed edits without mutating files", async () => {
    const before = await readFile(join(root, "src", "a.ts"), "utf8");
    const result = await handleEditorWorkspaceReplacePreview(
      postContext(
        replaceBody({ includeGlobs: ["src/a.ts"] }),
        "/api/editor/workspace-search/replace-preview",
      ),
      deps(),
    );
    const after = await readFile(join(root, "src", "a.ts"), "utf8");

    expect(result.status).toBe(200);
    const body = result.body as {
      fileCount: number;
      editCount: number;
      files: {
        path: string;
        baseContentHash: string;
        edits: { originalText: string; newText: string }[];
      }[];
    };
    expect(body.fileCount).toBe(1);
    expect(body.editCount).toBeGreaterThan(0);
    expect(body.files[0]?.path).toBe("src/a.ts");
    expect(body.files[0]?.baseContentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(body.files[0]?.edits[0]).toMatchObject({
      originalText: "parseConfig",
      newText: "readConfig",
    });
    expect(after).toBe(before);
  });

  it("expands regex capture groups independently for every match", async () => {
    await writeFile(join(root, "src", "calls.ts"), "alpha(); beta();\n", "utf8");

    const result = await handleEditorWorkspaceReplacePreview(
      postContext(
        replaceBody({
          query: "(\\w+)\\(\\)",
          mode: "regex",
          replacement: "call_$1()",
          includeGlobs: ["src/calls.ts"],
        }),
        "/api/editor/workspace-search/replace-preview",
      ),
      deps(),
    );

    expect(result.status).toBe(200);
    const body = result.body as {
      files: { edits: { originalText: string; newText: string }[] }[];
    };
    expect(body.files[0]?.edits).toEqual([
      expect.objectContaining({ originalText: "alpha()", newText: "call_alpha()" }),
      expect.objectContaining({ originalText: "beta()", newText: "call_beta()" }),
    ]);
  });

  it("expands only numeric capture references and keeps expression-like text literal", async () => {
    await writeFile(join(root, "src", "bounded-replace.ts"), "safe();\n", "utf8");
    const replacement = "$1:${globalThis.compromised = true}:$&:$`:$'";

    const result = await handleEditorWorkspaceReplacePreview(
      postContext(
        replaceBody({
          query: "(\\w+)\\(\\)",
          mode: "regex",
          replacement,
          includeGlobs: ["src/bounded-replace.ts"],
        }),
        "/api/editor/workspace-search/replace-preview",
      ),
      deps(),
    );

    expect(result.status).toBe(200);
    const body = result.body as { files: { edits: { newText: string }[] }[] };
    expect(body.files[0]?.edits[0]?.newText).toBe("safe:${globalThis.compromised = true}:$&:$`:$'");
  });

  it("recomputes matches from current on-disk content at preview time", async () => {
    await handleEditorWorkspaceSearch(
      postContext(searchBody({ includeGlobs: ["src/a.ts"] })),
      deps(),
    );
    await writeFile(
      join(root, "src", "a.ts"),
      'export const current = parseConfigCurrent("x");\n',
      "utf8",
    );

    const result = await handleEditorWorkspaceReplacePreview(
      postContext(
        replaceBody({ query: "parseConfig\\w*", mode: "regex", includeGlobs: ["src/a.ts"] }),
        "/api/editor/workspace-search/replace-preview",
      ),
      deps(),
    );

    expect(result.status).toBe(200);
    const body = result.body as { files: { edits: { originalText: string }[] }[] };
    expect(body.files[0]?.edits.map((edit) => edit.originalText)).toEqual(["parseConfigCurrent"]);
  });

  it("enforces file caps with an honest omitted-file count", async () => {
    const result = await handleEditorWorkspaceReplacePreview(
      postContext(replaceBody({ maxFiles: 1 }), "/api/editor/workspace-search/replace-preview"),
      deps(),
    );

    expect(result.status).toBe(200);
    const body = result.body as {
      files: unknown[];
      fileCount: number;
      omittedFileCount: number;
      truncated: boolean;
    };
    expect(body.files).toHaveLength(1);
    expect(body.fileCount).toBe(1);
    expect(body.omittedFileCount).toBeGreaterThan(0);
    expect(body.truncated).toBe(true);
  });

  it("accepts a validator-approved regex containing an unescaped quantifier-like character instead of crashing", async () => {
    // "items{" is valid, non-ReDoS Annex-B regex syntax without the unicode ("u") flag but throws
    // a SyntaxError under it ("Incomplete quantifier"); `regexSafetyIssue` and the sibling search
    // route's matcher both validate/match without "u", so this route's own RegExp construction
    // must not add "u" either, or a validator-approved query would crash instead of previewing.
    await writeFile(join(root, "src", "flags.ts"), 'export const label = "items{";\n', "utf8");

    const result = await handleEditorWorkspaceReplacePreview(
      postContext(
        replaceBody({
          query: "items{",
          mode: "regex",
          replacement: "entries[",
          includeGlobs: ["src/flags.ts"],
        }),
        "/api/editor/workspace-search/replace-preview",
      ),
      deps(),
    );

    expect(result.status).toBe(200);
    const body = result.body as { files: { edits: { originalText: string }[] }[] };
    expect(body.files[0]?.edits.map((edit) => edit.originalText)).toEqual(["items{"]);
  });

  it("rejects an unsafe regex before constructing a RegExp, and mutates no file", async () => {
    const before = await readFile(join(root, "src", "a.ts"), "utf8");

    const result = await handleEditorWorkspaceReplacePreview(
      postContext(
        replaceBody({ query: "(a+)+", mode: "regex" }),
        "/api/editor/workspace-search/replace-preview",
      ),
      deps(),
    );

    const after = await readFile(join(root, "src", "a.ts"), "utf8");
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(after).toBe(before);
  });

  it("treats a literal query with embedded whitespace as an exact multi-word match", async () => {
    await writeFile(join(root, "src", "d.ts"), 'export const label = "parse Config";\n', "utf8");

    const result = await handleEditorWorkspaceReplacePreview(
      postContext(
        replaceBody({
          query: "parse Config",
          replacement: "parseConfig",
          includeGlobs: ["src/d.ts"],
        }),
        "/api/editor/workspace-search/replace-preview",
      ),
      deps(),
    );

    expect(result.status).toBe(200);
    const body = result.body as { files: { edits: { originalText: string }[] }[] };
    expect(body.files[0]?.edits.map((edit) => edit.originalText)).toEqual(["parse Config"]);
  });

  it("replaces a match that follows a brace-delimited block in the same file, not just the block's own declaration line", async () => {
    // src/a.ts has "parseConfig" both in the function declaration (line 1, inside a
    // brace-delimited block) and again in a standalone statement after the block's closing
    // brace (line 4). Both must be found and replaced, not merged/collapsed into one.
    const result = await handleEditorWorkspaceReplacePreview(
      postContext(
        replaceBody({ includeGlobs: ["src/a.ts"] }),
        "/api/editor/workspace-search/replace-preview",
      ),
      deps(),
    );

    expect(result.status).toBe(200);
    const body = result.body as {
      editCount: number;
      files: { edits: { range: { startLine: number }; originalText: string }[] }[];
    };
    expect(body.editCount).toBe(2);
    const matchedLines = body.files[0]?.edits.map((edit) => edit.range.startLine).sort();
    expect(matchedLines).toEqual([1, 4]);
  });

  it("replaces every non-overlapping occurrence in a file, even beyond the search engine's per-file evidence-diversity sample size", async () => {
    const functionCount = 5;
    const lines: string[] = [];
    for (let index = 0; index < functionCount; index += 1) {
      lines.push(`export function widget${String(index)}(): number {`);
      lines.push("  return widgetToken;");
      lines.push("}");
    }
    await writeFile(join(root, "src", "many-matches.ts"), `${lines.join("\n")}\n`, "utf8");

    const result = await handleEditorWorkspaceReplacePreview(
      postContext(
        replaceBody({
          query: "widgetToken",
          replacement: "WIDGET_TOKEN",
          includeGlobs: ["src/many-matches.ts"],
        }),
        "/api/editor/workspace-search/replace-preview",
      ),
      deps(),
    );

    expect(result.status).toBe(200);
    const body = result.body as { editCount: number; files: { edits: unknown[] }[] };
    expect(body.files[0]?.edits).toHaveLength(functionCount);
    expect(body.editCount).toBe(functionCount);
  });
});

describe("POST /api/editor/workspace-search/replace-apply", () => {
  async function previewForApply(): Promise<{
    readonly path: string;
    readonly baseContentHash: string;
    readonly edits: readonly unknown[];
  }> {
    const preview = await handleEditorWorkspaceReplacePreview(
      postContext(
        replaceBody({ includeGlobs: ["src/a.ts"] }),
        "/api/editor/workspace-search/replace-preview",
      ),
      deps(),
    );
    const body = preview.body as {
      files: {
        path: string;
        baseContentHash: string;
        edits: readonly unknown[];
      }[];
    };
    const file = body.files[0];
    if (file === undefined) throw new Error("missing preview file");
    return file;
  }

  it("applies closed-file edits through the governed replace apply route", async () => {
    const file = await previewForApply();
    const result = await handleEditorWorkspaceReplaceApply(
      postContext({ root, files: [file] }, "/api/editor/workspace-search/replace-apply"),
      deps(),
    );
    const content = await readFile(join(root, "src", "a.ts"), "utf8");

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ appliedCount: 1, conflictCount: 0, conflicts: [] });
    expect(content).toContain("export function readConfig(value: string): string {");
    expect(content).toContain('export const marker = readConfig("a");');
    expect(content).not.toContain("parseConfig");
  });

  it("keeps exact closed-file content while using the governed patch preflight", async () => {
    await writeFile(
      join(root, "src", "no-newline.ts"),
      'export const value = "parseConfig";',
      "utf8",
    );
    const preview = await handleEditorWorkspaceReplacePreview(
      postContext(
        replaceBody({ includeGlobs: ["src/no-newline.ts"] }),
        "/api/editor/workspace-search/replace-preview",
      ),
      deps(),
    );
    const body = preview.body as {
      files: {
        path: string;
        baseContentHash: string;
        edits: readonly unknown[];
      }[];
    };
    const file = body.files[0];
    if (file === undefined) throw new Error("missing preview file");

    const result = await handleEditorWorkspaceReplaceApply(
      postContext({ root, files: [file] }, "/api/editor/workspace-search/replace-apply"),
      deps(),
    );
    const content = await readFile(join(root, "src", "no-newline.ts"), "utf8");

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ appliedCount: 1, conflictCount: 0 });
    expect(content).toBe('export const value = "readConfig";');
  });

  it("reports a structured conflict when the file changed after preview", async () => {
    const file = await previewForApply();
    await writeFile(join(root, "src", "a.ts"), "export const changed = true;\n", "utf8");

    const result = await handleEditorWorkspaceReplaceApply(
      postContext({ root, files: [file] }, "/api/editor/workspace-search/replace-apply"),
      deps(),
    );
    const content = await readFile(join(root, "src", "a.ts"), "utf8");

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      appliedCount: 0,
      conflictCount: 1,
      conflicts: [{ path: "src/a.ts", reason: "write-conflict" }],
    });
    expect(content).toBe("export const changed = true;\n");
  });

  it("rejects a path escape before the contained writer can write", async () => {
    const file = await previewForApply();
    const result = await handleEditorWorkspaceReplaceApply(
      postContext(
        { root, files: [{ ...file, path: "../escape.ts" }] },
        "/api/editor/workspace-search/replace-apply",
      ),
      deps(),
    );

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("applies a single-word replacement in a real-world-sized file without a spurious patch-limit conflict", async () => {
    // A file this size produces a full-file preflight diff (renderFullFileModifyDiff renders
    // every original line as `-` and every new line as `+`) with well over 2,000 changed lines —
    // keiko-tools' DEFAULT_PATCH_LIMITS (sized for small assistant-generated patches) would reject
    // this even for a one-word replacement. REPLACE_APPLY_PREFLIGHT_LIMITS must be sized to the
    // search/replace engine's own file-size bound instead.
    const lines: string[] = [];
    for (let i = 0; i < 3000; i += 1) {
      lines.push(`export const item${String(i)} = ${String(i)};`);
    }
    lines.push('export const marker = parseConfig("large-file");');
    await writeFile(join(root, "src", "large.ts"), `${lines.join("\n")}\n`, "utf8");

    const preview = await handleEditorWorkspaceReplacePreview(
      postContext(
        replaceBody({ includeGlobs: ["src/large.ts"] }),
        "/api/editor/workspace-search/replace-preview",
      ),
      deps(),
    );
    const previewBody = preview.body as {
      files: { path: string; baseContentHash: string; edits: readonly unknown[] }[];
    };
    const file = previewBody.files[0];
    if (file === undefined) throw new Error("missing preview file");

    const result = await handleEditorWorkspaceReplaceApply(
      postContext({ root, files: [file] }, "/api/editor/workspace-search/replace-apply"),
      deps(),
    );
    const content = await readFile(join(root, "src", "large.ts"), "utf8");

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ appliedCount: 1, conflictCount: 0, conflicts: [] });
    expect(content).toContain('export const marker = readConfig("large-file");');
  });
});
