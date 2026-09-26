import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import { DEFAULT_SEARCH_LIMITS, detectWorkspaceAt } from "@oscharko-dev/keiko-workspace";
import { buildRedactor, createInMemoryUiStore } from "../index.js";
import type { RouteContext, UiHandlerDeps } from "../index.js";
import {
  createFakeSessionPairingPort,
  fakePairingRequestBody,
} from "../coding-app-session/_support.js";
import { createCodingAppSessionChannel } from "../coding-app-session/sessionChannel.js";
import { APP_SESSION_COOKIE_NAME } from "../coding-app-session/sessionCookie.js";
import { createSessionRegistry } from "../coding-app-session/sessionRegistry.js";
import type { UiStore } from "../store/index.js";
import { assertManagedRootOwned } from "../task-workspace/managed-root.js";
import { deriveManagedWorktreePath } from "../task-workspace/naming.js";
import { inspectManagedGitdirIdentity } from "../task-workspace/gitdir-identity.js";
import {
  createOrdinaryWorkspaceRootAccess,
  grantedWorkspaceRootAccess,
  type WorkspaceRootAccessOutcome,
} from "../task-workspace/workspace-root-access.js";
import type { WorkspaceProvisioningService } from "../task-workspace/types.js";
import {
  handleEditorWorkspaceReplaceApply,
  handleEditorWorkspaceReplacePreview,
  handleEditorWorkspaceSearch,
  handleEditorWorkspaceSymbols,
} from "./workspaceSearchRoutes.js";
import { readWorkspaceFileForEditing } from "@oscharko-dev/keiko-workspace/internal/editor-read";

function rawPostContext(raw: string, path: string): RouteContext {
  const req = Readable.from([Buffer.from(raw, "utf8")]) as unknown as IncomingMessage;
  (req as { method?: string }).method = "POST";
  return {
    correlationId: undefined,
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
let managedSourceRoot: string | undefined;
let store: UiStore;

function deps(overrides: Partial<UiHandlerDeps> = {}): UiHandlerDeps {
  return {
    store,
    redactor: buildRedactor({}),
    evidenceStore: createInMemoryEvidenceStore(),
    ...overrides,
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

async function managedSearchFixture(): Promise<{
  readonly managedWorktree: string;
  readonly cookie: string;
  readonly deps: UiHandlerDeps;
}> {
  const managedRoot = join(root, ".keiko", "task-workspaces");
  assertManagedRootOwned(managedRoot);
  const repositoryId = "repo_0123456789abcdef";
  const workspaceId = "ws_0123456789abcdef01234567";
  const managedWorktree = deriveManagedWorktreePath({ managedRoot, repositoryId, workspaceId });
  // #3347 managed-worktree identity: resolveManagedWorkspaceRootAccess re-proves a real Git
  // linked-worktree pointer instead of trusting a path shape, so this fixture needs an actual
  // `git worktree add` linkage -- a separate, independently-cleaned-up repositoryRoot, not the
  // shared search-fixture `root` (which dozens of unrelated tests scan directly and must not gain
  // a `.git` directory).
  const repositoryRoot = await mkdtemp(join(tmpdir(), "keiko-workspace-search-managed-source-"));
  managedSourceRoot = repositoryRoot;
  execFileSync("git", ["init", "-q"], { cwd: repositoryRoot });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repositoryRoot });
  execFileSync("git", ["config", "user.name", "Keiko Test"], { cwd: repositoryRoot });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "fixture"], { cwd: repositoryRoot });
  mkdirSync(dirname(managedWorktree), { recursive: true });
  execFileSync(
    "git",
    [
      "worktree",
      "add",
      "-q",
      "-b",
      "keiko/task/workspace-search-01234567",
      managedWorktree,
      "HEAD",
    ],
    { cwd: repositoryRoot },
  );
  const gitdirInspection = inspectManagedGitdirIdentity(managedWorktree, repositoryRoot);
  if (gitdirInspection === undefined) {
    throw new Error("fixture git worktree did not produce a resolvable gitdir identity");
  }
  await mkdir(join(managedWorktree, "src"), { recursive: true });
  await writeFile(join(managedWorktree, "src", "managed.ts"), "export const managedNeedle = 1;\n");
  const timestamp = new Date(0).toISOString();
  const instance: WorkspaceInstance = {
    schemaVersion: "1",
    workspaceId,
    taskId: "workspace-search",
    repositoryId,
    repositoryRoot,
    baseBranch: "dev",
    taskBranch: "keiko/task/workspace-search-01234567",
    managedWorktreePath: managedWorktree,
    gitdirIdentity: gitdirInspection.identity,
    lifecycleState: "active",
    health: "healthy",
    lock: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    driftMarkers: [],
    recoveryHints: [],
    auditCorrelationId: "corr_workspace_search",
  };
  const workspaceProvisioning = {
    provision: (): never => {
      throw new Error("not used in this test");
    },
    activate: (): never => {
      throw new Error("not used in this test");
    },
    getInstance: (id: string): WorkspaceInstance | undefined =>
      id === workspaceId ? instance : undefined,
  } satisfies WorkspaceProvisioningService;
  const channel = createCodingAppSessionChannel({
    registry: createSessionRegistry(),
    pairingPort: createFakeSessionPairingPort(),
  });
  const paired = channel.pair(fakePairingRequestBody());
  if (!paired.paired) throw new Error("pairing failed");
  return {
    managedWorktree,
    cookie: `${APP_SESSION_COOKIE_NAME}=${paired.cookieToken}`,
    deps: deps({
      managedTaskWorkspaceRoot: managedRoot,
      workspaceProvisioning,
      codingAppSessionChannel: channel,
    }),
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
  managedSourceRoot = undefined;
});

afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
  if (managedSourceRoot !== undefined) {
    await rm(managedSourceRoot, { recursive: true, force: true });
  }
});

// Qodo review on #2869: the raw editor read reaches this route through the package's
// `./internal/editor-read` export subpath, not a relative import, so a broken export map would take
// the whole replace surface down. The rest of this suite already proves that implicitly — breaking
// the map makes this file fail to load at all — but that failure reads as "suite did not run"
// rather than "the export map is broken". This asserts the subpath directly so the diagnosis is in
// the failure message. Verified by temporarily pointing the subpath at a missing file: without this
// test the suite reports "no tests"; with it, the cause is named.
describe("the editor read lane is reachable through its published export subpath", () => {
  it("resolves and returns raw bytes, not the redacted evidence shape", () => {
    const workspace = detectWorkspaceAt(root);

    const raw = readWorkspaceFileForEditing(workspace, "src/a.ts");

    // `rawText`, never `text`: the two read lanes are structurally incompatible on purpose, so a
    // raw read can never be substituted for a redacted evidence read by accident.
    expect(raw.rawText.length).toBeGreaterThan(0);
    expect(raw).not.toHaveProperty("text");
  });
});

describe("POST /api/editor/workspace-search", () => {
  it("uses request-scoped owned-root access for a paired managed worktree", async () => {
    const fixture = await managedSearchFixture();
    const request = postContext(
      searchBody({ root: fixture.managedWorktree, query: "managedNeedle" }),
    );
    request.req.headers = { cookie: fixture.cookie };

    const result = await handleEditorWorkspaceSearch(request, fixture.deps);

    expect(result.status).toBe(200);
    const body = result.body as { readonly results: readonly { path: string; snippet: string }[] };
    expect(body.results[0]?.path, JSON.stringify(body)).toBe("src/managed.ts");
    expect(body.results[0]?.snippet).toContain("managedNeedle");
  });

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

  it("searches only within the validated text-search scope", async () => {
    const result = await handleEditorWorkspaceSearch(
      postContext(searchBody({ scopePath: "src/scoped" })),
      deps(),
    );

    expect(result.status).toBe(200);
    const paths = (result.body as { results: { path: string }[] }).results.map(
      (entry) => entry.path,
    );
    expect(paths).toContain("src/scoped/c.ts");
    expect(paths.every((path) => path.startsWith("src/scoped/"))).toBe(true);

    const malformed = await handleEditorWorkspaceSearch(
      postContext(searchBody({ scopePath: 42 })),
      deps(),
    );
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("never searches, previews, or applies an excluded path beyond the glob result cap", async () => {
    const excludedRoot = join(root, "excluded");
    await mkdir(excludedRoot, { recursive: true });
    await Promise.all(
      Array.from({ length: DEFAULT_SEARCH_LIMITS.maxMatchesReturned }, async (_, index) => {
        const name = `${String(index).padStart(3, "0")}.ts`;
        await writeFile(join(excludedRoot, name), "export const filler = true;\n", "utf8");
      }),
    );
    const targetPath = "excluded/zzz-target.ts";
    const targetAbsolutePath = join(root, targetPath);
    const original = 'export const target = excludedNeedle("excluded");\n';
    await writeFile(targetAbsolutePath, original, "utf8");
    const excludeGlobs = ["excluded/**/*.ts"];

    const search = await handleEditorWorkspaceSearch(
      postContext(searchBody({ query: "excludedNeedle", excludeGlobs })),
      deps(),
    );
    const preview = await handleEditorWorkspaceReplacePreview(
      postContext(
        replaceBody({
          query: "excludedNeedle",
          replacement: "replacementNeedle",
          excludeGlobs,
        }),
        "/api/editor/workspace-search/replace-preview",
      ),
      deps(),
    );
    const previewBody = preview.body as { files: readonly unknown[] };
    const apply = await handleEditorWorkspaceReplaceApply(
      postContext({ root, files: previewBody.files }, "/api/editor/workspace-search/replace-apply"),
      deps(),
    );

    expect(search.status).toBe(200);
    expect(search.body).toMatchObject({ results: [] });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ files: [], fileCount: 0, editCount: 0 });
    expect(apply.status).toBe(400);
    expect(apply.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    await expect(readFile(targetAbsolutePath, "utf8")).resolves.toBe(original);
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
      searchTruncationReasons: readonly string[];
    };
    expect(body.files).toHaveLength(1);
    expect(body.fileCount).toBe(1);
    expect(body.omittedFileCount).toBeGreaterThan(0);
    expect(body.truncated).toBe(true);
    // KEIKO-0645-r3: this truncation is entirely from the per-request maxFiles cap; the upstream
    // search selection did not itself truncate, so searchTruncationReasons must be empty.
    expect(body.searchTruncationReasons).toEqual([]);
  });

  it("KEIKO-0645-r3: emits searchTruncationReasons on the response so callers can distinguish the truncation cause", async () => {
    // Prove the field is present and always reflects searchText's own result.coverage.reasons --
    // so a caller can tell whether `truncated: true` was caused by the upstream candidate-file
    // selection (maxFilesScanned/maxMatchesReturned/timeout/depth-pruning) or by the per-request
    // `maxFiles` cap (omittedFileCount > 0). This shape test locks the field in; the maxFiles-only
    // test above covers the "search did not truncate" branch (searchTruncationReasons: []), and
    // this one asserts the field is always emitted on the wire even in the trivial no-truncation
    // case.
    const result = await handleEditorWorkspaceReplacePreview(
      postContext(
        replaceBody({ includeGlobs: ["src/a.ts"] }),
        "/api/editor/workspace-search/replace-preview",
      ),
      deps(),
    );

    expect(result.status).toBe(200);
    const body = result.body as {
      truncated: boolean;
      omittedFileCount: number;
      searchTruncationReasons: readonly string[];
    };
    expect(body.truncated).toBe(false);
    expect(body.omittedFileCount).toBe(0);
    expect(body.searchTruncationReasons).toEqual([]);
    // Distinctness: the response must expose both fields as separate wire shape entries so a
    // future caller can bind on either one without inspecting `truncated`.
    expect(Object.keys(body)).toEqual(
      expect.arrayContaining(["truncated", "omittedFileCount", "searchTruncationReasons"]),
    );
  });

  it("KEIKO-0645-r3: an upstream match-cap truncation is reported as match-cap, not conflated with a file omission", async () => {
    // Regression for the round-3 finding: the pre-fix field (`filesOmittedBySearchLimit:
    // result.truncated`) was set whenever the upstream search truncated for ANY reason -- so a
    // caller could not tell "the query fanned out across too many distinct files to enumerate them
    // all" (a genuine per-file omission, reason "file-cap") apart from "the total match-return
    // budget (200) was exhausted while emitting results" (reason "match-cap"), which can happen
    // with plenty of scanned files and zero files dropped by the route's own maxFiles cap. Build
    // more distinct matching files than DEFAULT_SEARCH_LIMITS.maxMatchesReturned (200), each
    // contributing one match, so searchText's emission-time cap (repoSearchScan.ts hitEmissionLimit)
    // fires with reason "match-cap" -- never "file-cap" (maxFilesScanned is 2,000, far above 250).
    const manyDir = join(root, "src", "many");
    await mkdir(manyDir, { recursive: true });
    await Promise.all(
      Array.from({ length: 250 }, (_, i) =>
        writeFile(
          join(manyDir, `file-${String(i).padStart(3, "0")}.ts`),
          "needle_marker\n",
          "utf8",
        ),
      ),
    );

    const result = await handleEditorWorkspaceReplacePreview(
      postContext(
        replaceBody({
          query: "needle_marker",
          mode: "literal",
          includeGlobs: ["src/many/**"],
          // WORKSPACE_REPLACE_MAX_FILES is 200 -- the contract-validated ceiling for this field --
          // which happens to equal DEFAULT_SEARCH_LIMITS.maxMatchesReturned, so the route's own
          // per-request cap never binds ahead of the upstream search's match-cap in this scenario.
          maxFiles: 200,
        }),
        "/api/editor/workspace-search/replace-preview",
      ),
      deps(),
    );

    expect(result.status).toBe(200);
    const body = result.body as {
      omittedFileCount: number;
      truncated: boolean;
      searchTruncationReasons: readonly string[];
    };
    // The route's own maxFiles cap (300) never bound the response -- every file that made it into
    // the upstream search's result set was processed, so the route-local omission count is 0.
    expect(body.omittedFileCount).toBe(0);
    // The upstream search itself still truncated (match-cap), so `truncated` stays true --
    // but the precise cause must be "match-cap", never "file-cap".
    expect(body.truncated).toBe(true);
    expect(body.searchTruncationReasons).toContain("match-cap");
    expect(body.searchTruncationReasons).not.toContain("file-cap");
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

  it.each(["parse Config", "[literal].value (x)+?", "prefix\\suffix", "x-y"])(
    "keeps exact literal text %s after shared-pattern conversion",
    async (literal) => {
      await writeFile(join(root, "src", "d.ts"), `// ${literal}\n`, "utf8");

      const result = await handleEditorWorkspaceReplacePreview(
        postContext(
          replaceBody({
            query: literal,
            replacement: "parseConfig",
            includeGlobs: ["src/d.ts"],
          }),
          "/api/editor/workspace-search/replace-preview",
        ),
        deps(),
      );

      expect(result.status).toBe(200);
      const body = result.body as { files: { edits: { originalText: string }[] }[] };
      expect(body.files[0]?.edits.map((edit) => edit.originalText)).toEqual([literal]);
    },
  );

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

  // #3347 write-boundary re-proof. Admission, the closed-file read and the keiko-tools preflight all
  // run on the capability proved once, at the top of the request; the WRITE is the only effect that
  // leaves authorized memory. Authority can be revoked — or the managed root replaced — inside that
  // window, so the writer is constructed from a capability re-proved immediately before it, and a
  // denial is a route-level 403 rather than a per-file conflict: the request never reached bytes it
  // was allowed to change. Verified red by hand: with the writer built from the admission-time root,
  // the revoked apply returned 200 with appliedCount 1 and rewrote the file on disk.
  it("leaves disk untouched when authority is revoked before the governed write", async () => {
    const file = await previewForApply();
    const before = await readFile(join(root, "src", "a.ts"), "utf8");

    const result = await handleEditorWorkspaceReplaceApply(
      postContext({ root, files: [file] }, "/api/editor/workspace-search/replace-apply"),
      deps({
        workspaceRootAccessResolver: (): WorkspaceRootAccessOutcome => ({ decision: "denied" }),
      }),
    );

    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: { code: "DENIED" } });
    expect(await readFile(join(root, "src", "a.ts"), "utf8")).toBe(before);
    expect(before).toContain("parseConfig");
  });

  it("re-proves authority once per governed write, not once per admitted request", async () => {
    const preview = await handleEditorWorkspaceReplacePreview(
      postContext(
        replaceBody({ includeGlobs: ["src/a.ts", "src/b.ts"] }),
        "/api/editor/workspace-search/replace-preview",
      ),
      deps(),
    );
    const previewed = (
      preview.body as {
        files: { path: string; baseContentHash: string; edits: readonly unknown[] }[];
      }
    ).files;
    expect(previewed).toHaveLength(2);
    const proofs: string[] = [];

    const result = await handleEditorWorkspaceReplaceApply(
      postContext({ root, files: previewed }, "/api/editor/workspace-search/replace-apply"),
      deps({
        workspaceRootAccessResolver: (requestedRoot: string): WorkspaceRootAccessOutcome => {
          proofs.push(requestedRoot);
          return grantedWorkspaceRootAccess(createOrdinaryWorkspaceRootAccess(requestedRoot));
        },
      }),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ appliedCount: 2, conflictCount: 0 });
    expect(proofs).toEqual([root, root]);
  });
});

// ─── Secret-shaped source text (editor P1: a silent, release-blocking replace failure) ───────────
//
// The workspace read path redacts at the IO boundary for the evidence/RAG lane. Search & replace
// derived its match coordinates, its base-content hash, and its replacement text from that REDACTED
// text, while the `keiko-tools` write preflight reads the file RAW and compares every `-` line of
// the rendered diff against the raw lines. So every file containing so much as one secret-shaped
// assignment — token/password/api_key/client_secret/private_key, a Bearer header, URL userinfo, a
// phone number, an IBAN, a PEM header: all common in real source — could never be replaced, and the
// failure surfaced as a false "write-conflict" with nothing written.
//
// These fixtures use redaction PATTERNS only; none of them is a real credential.
describe("workspace search & replace over secret-shaped source text", () => {
  const SECRET_LINE = 'const token = "s3cr3tlookupvalue";';
  const PEM_LINES = [
    "-----BEGIN PRIVATE KEY-----",
    "AAAAB3NzaC1yc2EAAAADAQABAAABgQ",
    "CqGKukO1De7zhZj6H0qtjTkVxwTCpv",
    "-----END PRIVATE KEY-----",
  ];

  async function previewFile(
    body: Record<string, unknown>,
  ): Promise<{ path: string; baseContentHash: string; edits: readonly unknown[] }> {
    const preview = await handleEditorWorkspaceReplacePreview(
      postContext(body, "/api/editor/workspace-search/replace-preview"),
      deps(),
    );
    expect(preview.status).toBe(200);
    const parsed = preview.body as {
      files: { path: string; baseContentHash: string; edits: readonly unknown[] }[];
    };
    const file = parsed.files[0];
    if (file === undefined) throw new Error("missing preview file");
    return file;
  }

  it("finds a match on the line after a secret-shaped assignment", async () => {
    await writeFile(
      join(root, "src", "secret.ts"),
      [SECRET_LINE, 'export const marker = "needleaftersecret";', ""].join("\n"),
      "utf8",
    );

    const result = await handleEditorWorkspaceSearch(
      postContext(searchBody({ query: "needleaftersecret", includeGlobs: ["src/secret.ts"] })),
      deps(),
    );

    expect(result.status).toBe(200);
    const body = result.body as {
      results: { path: string; lineRange: { startLine: number; endLine: number } }[];
    };
    expect(body.results.map((entry) => entry.path)).toContain("src/secret.ts");
    expect(
      body.results.some((entry) => entry.lineRange.startLine <= 2 && entry.lineRange.endLine >= 2),
    ).toBe(true);
  });

  it("redacts the secret-shaped line inside a search snippet window", async () => {
    await writeFile(
      join(root, "src", "secret-snippet.ts"),
      [SECRET_LINE, 'export const marker = "needlenearsecret";', ""].join("\n"),
      "utf8",
    );

    const result = await handleEditorWorkspaceSearch(
      postContext(
        searchBody({ query: "needlenearsecret", includeGlobs: ["src/secret-snippet.ts"] }),
      ),
      deps(),
    );

    expect(result.status).toBe(200);
    const body = result.body as { results: { snippet: string }[] };
    const snippets = body.results.map((entry) => entry.snippet).join("\n");
    expect(snippets).toContain("[REDACTED]");
    expect(snippets).not.toContain("s3cr3tlookupvalue");
  });

  it("finds a match that only exists inside the redacted region itself", async () => {
    await writeFile(join(root, "src", "secret-only.ts"), `${SECRET_LINE}\n`, "utf8");

    const result = await handleEditorWorkspaceSearch(
      postContext(searchBody({ query: "s3cr3tlookupvalue", includeGlobs: ["src/secret-only.ts"] })),
      deps(),
    );

    expect(result.status).toBe(200);
    const body = result.body as { results: { path: string }[] };
    expect(body.results.map((entry) => entry.path)).toContain("src/secret-only.ts");
  });

  it("reports the real file line for a match after a multi-line PEM block", async () => {
    await writeFile(
      join(root, "src", "pem-search.ts"),
      [...PEM_LINES, 'export const marker = "needleafterpem";', ""].join("\n"),
      "utf8",
    );

    const result = await handleEditorWorkspaceSearch(
      postContext(searchBody({ query: "needleafterpem", includeGlobs: ["src/pem-search.ts"] })),
      deps(),
    );

    expect(result.status).toBe(200);
    const body = result.body as {
      results: { path: string; lineRange: { startLine: number; endLine: number } }[];
    };
    // Raw: line 5. A redacted read collapsed the 4-line block into one token and reported line 2.
    expect(
      body.results.some((entry) => entry.lineRange.startLine <= 5 && entry.lineRange.endLine >= 5),
    ).toBe(true);
  });

  it("applies a replacement in a file containing a secret-shaped assignment", async () => {
    await writeFile(
      join(root, "src", "secret-apply.ts"),
      [SECRET_LINE, 'export const marker = parseConfig("a");', ""].join("\n"),
      "utf8",
    );

    const file = await previewFile(replaceBody({ includeGlobs: ["src/secret-apply.ts"] }));
    const result = await handleEditorWorkspaceReplaceApply(
      postContext({ root, files: [file] }, "/api/editor/workspace-search/replace-apply"),
      deps(),
    );
    const content = await readFile(join(root, "src", "secret-apply.ts"), "utf8");

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ appliedCount: 1, conflictCount: 0, conflicts: [] });
    // The secret-shaped line must survive the write byte-for-byte: the editor lane reads and writes
    // the real file, it never persists the redacted view back over the user's source.
    expect(content).toBe([SECRET_LINE, 'export const marker = readConfig("a");', ""].join("\n"));
  });

  it("applies a replacement preceded on the SAME line by a redacted value", async () => {
    // "[REDACTED]" is wider than the value it replaces, so a redacted read reported this match's
    // column several characters to the right of where it really is.
    await writeFile(
      join(root, "src", "same-line.ts"),
      'const token = "abc"; export const marker = parseConfig("a");\n',
      "utf8",
    );

    const file = await previewFile(replaceBody({ includeGlobs: ["src/same-line.ts"] }));
    const result = await handleEditorWorkspaceReplaceApply(
      postContext({ root, files: [file] }, "/api/editor/workspace-search/replace-apply"),
      deps(),
    );
    const content = await readFile(join(root, "src", "same-line.ts"), "utf8");

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ appliedCount: 1, conflictCount: 0, conflicts: [] });
    expect(content).toBe('const token = "abc"; export const marker = readConfig("a");\n');
  });

  it("applies a replacement after a multi-line PEM block, at the real file line", async () => {
    const original = [...PEM_LINES, 'export const marker = parseConfig("a");', ""].join("\n");
    await writeFile(join(root, "src", "pem.ts"), original, "utf8");

    const file = await previewFile(replaceBody({ includeGlobs: ["src/pem.ts"] }));
    const previewEdits = file.edits as { range: { startLine: number } }[];
    const result = await handleEditorWorkspaceReplaceApply(
      postContext({ root, files: [file] }, "/api/editor/workspace-search/replace-apply"),
      deps(),
    );
    const content = await readFile(join(root, "src", "pem.ts"), "utf8");

    expect(previewEdits.map((edit) => edit.range.startLine)).toEqual([5]);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ appliedCount: 1, conflictCount: 0, conflicts: [] });
    expect(content).toBe([...PEM_LINES, 'export const marker = readConfig("a");', ""].join("\n"));
  });
});

// ─── The preview payload must cross the wire verbatim (residual of the raw-read lane) ────────────
//
// The raw-read lane fixed the SERVER half: match ranges, the base hash and the write preflight all
// read the file RAW. The residual was the WIRE half — the preview response was re-serialized
// through the live-payload redactor, and `deepRedactStrings` rewrites each string leaf on its own.
// A leaf that is ITSELF secret-shaped therefore came back masked, and the client echoes the payload
// straight back into replace-apply:
//
//   * a masked `originalText` fails the apply-side equality check against the raw file, so a
//     secret-shaped string could not be replaced at all ("preview edits no longer match current
//     content");
//   * a masked `newText` is what apply WRITES, so a secret-shaped replacement silently landed
//     "[REDACTED]" in the user's source with status 200 and appliedCount 1.
//
// These fixtures use redaction PATTERNS only; none of them is a real credential.
describe("replace preview payload crosses the wire verbatim", () => {
  const SECRET_ASSIGNMENT = 'const password = "hunter2placeholder";';
  const SECRET_SHAPED_REPLACEMENT = '"sk-placeholder0123456789abcdef"';

  async function previewResponse(body: Record<string, unknown>): Promise<{
    files: {
      path: string;
      baseContentHash: string;
      edits: { originalText: string; newText: string }[];
    }[];
  }> {
    const preview = await handleEditorWorkspaceReplacePreview(
      postContext(body, "/api/editor/workspace-search/replace-preview"),
      deps(),
    );
    expect(preview.status).toBe(200);
    return preview.body as {
      files: {
        path: string;
        baseContentHash: string;
        edits: { originalText: string; newText: string }[];
      }[];
    };
  }

  function firstFile<T>(files: readonly T[]): T {
    const file = files[0];
    if (file === undefined) throw new Error("missing preview file");
    return file;
  }

  function firstEdit<T>(edits: readonly T[]): T {
    const edit = edits[0];
    if (edit === undefined) throw new Error("missing preview edit");
    return edit;
  }

  // Collects the dotted key path of every string leaf, arrays collapsed to "[]". Pins WHICH fields
  // of the preview response are verbatim, so a future string-bearing field (a message, a reason, a
  // snippet) cannot join the unredacted payload unnoticed.
  function stringLeafPaths(value: unknown, prefix: string): readonly string[] {
    if (typeof value === "string") return [prefix];
    if (Array.isArray(value)) {
      return value.flatMap((entry: unknown) => stringLeafPaths(entry, `${prefix}[]`));
    }
    if (typeof value === "object" && value !== null) {
      return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
        stringLeafPaths(child, prefix.length === 0 ? key : `${prefix}.${key}`),
      );
    }
    return [];
  }

  it("returns matched text verbatim when the match itself is secret-shaped", async () => {
    const target = join(root, "src", "secret-match.ts");
    await writeFile(target, [SECRET_ASSIGNMENT, "export const marker = 1;", ""].join("\n"), "utf8");
    const before = await readFile(target, "utf8");

    const preview = await previewResponse(
      replaceBody({
        query: 'password = "hunter2placeholder"',
        replacement: "PASSWORD_FROM_ENV",
        includeGlobs: ["src/secret-match.ts"],
      }),
    );
    const file = firstFile(preview.files);
    const edit = firstEdit(file.edits);

    // Fail-before anchor: the redacted payload carried `password = "[REDACTED]"`, which is not in
    // the file, so the apply-side equality check could never succeed.
    expect(before).toContain(edit.originalText);

    const applied = await handleEditorWorkspaceReplaceApply(
      postContext({ root, files: [file] }, "/api/editor/workspace-search/replace-apply"),
      deps(),
    );
    const after = await readFile(target, "utf8");

    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ appliedCount: 1, conflictCount: 0, conflicts: [] });
    expect(after).toBe(before.replace(edit.originalText, edit.newText));
  });

  it("writes a secret-shaped replacement verbatim instead of writing the mask", async () => {
    const target = join(root, "src", "secret-replacement.ts");
    await writeFile(target, "export const marker = PLACEHOLDER_VALUE;\n", "utf8");
    const before = await readFile(target, "utf8");

    const preview = await previewResponse(
      replaceBody({
        query: "PLACEHOLDER_VALUE",
        replacement: SECRET_SHAPED_REPLACEMENT,
        includeGlobs: ["src/secret-replacement.ts"],
      }),
    );
    const file = firstFile(preview.files);
    const edit = firstEdit(file.edits);

    // Fail-before anchor: the preview echoed the operator's own replacement back as "[REDACTED]".
    expect(edit.newText).toBe(SECRET_SHAPED_REPLACEMENT);

    const applied = await handleEditorWorkspaceReplaceApply(
      postContext({ root, files: [file] }, "/api/editor/workspace-search/replace-apply"),
      deps(),
    );
    const after = await readFile(target, "utf8");

    expect(applied.body).toMatchObject({ appliedCount: 1, conflictCount: 0, conflicts: [] });
    expect(after).toBe(before.replace(edit.originalText, SECRET_SHAPED_REPLACEMENT));
    expect(after).not.toContain("[REDACTED]");
  });

  it("returns a base content hash the apply route accepts", async () => {
    const target = join(root, "src", "secret-hash.ts");
    await writeFile(target, [SECRET_ASSIGNMENT, "export const marker = 1;", ""].join("\n"), "utf8");

    const preview = await previewResponse(
      replaceBody({
        query: 'password = "hunter2placeholder"',
        replacement: "PASSWORD_FROM_ENV",
        includeGlobs: ["src/secret-hash.ts"],
      }),
    );
    const file = firstFile(preview.files);

    expect(file.baseContentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(file.path).toBe("src/secret-hash.ts");
  });

  it("carries no string leaf beyond the four round-trip fields", async () => {
    const target = join(root, "src", "leaf-shape.ts");
    await writeFile(target, [SECRET_ASSIGNMENT, "export const marker = 1;", ""].join("\n"), "utf8");

    const preview = await previewResponse(
      replaceBody({
        query: 'password = "hunter2placeholder"',
        replacement: "PASSWORD_FROM_ENV",
        includeGlobs: ["src/leaf-shape.ts"],
      }),
    );

    expect([...new Set(stringLeafPaths(preview, ""))].sort()).toEqual([
      "files[].baseContentHash",
      "files[].edits[].newText",
      "files[].edits[].originalText",
      "files[].path",
    ]);
  });

  // The boundary this fix deliberately does NOT move. `handleEditorWorkspaceSearch` is reachable
  // from the editor agent bridge (`agentRoutes.ts` -> `runSearchWorkspaceAction`), so its snippets
  // can reach a model prompt; replace-preview and replace-apply are registered for the browser
  // alone. Search snippets therefore stay redacted.
  it("keeps the agent-reachable SEARCH response redacted", async () => {
    await writeFile(
      join(root, "src", "search-lane.ts"),
      [SECRET_ASSIGNMENT, 'export const marker = "needleinsearchlane";', ""].join("\n"),
      "utf8",
    );

    const result = await handleEditorWorkspaceSearch(
      postContext(
        searchBody({ query: "needleinsearchlane", includeGlobs: ["src/search-lane.ts"] }),
      ),
      deps(),
    );

    expect(result.status).toBe(200);
    const body = result.body as { results: { snippet: string }[] };
    const snippets = body.results.map((entry) => entry.snippet).join("\n");
    expect(snippets).toContain("needleinsearchlane");
    expect(snippets).not.toContain("hunter2placeholder");
    expect(snippets).toContain("[REDACTED]");
  });
});
