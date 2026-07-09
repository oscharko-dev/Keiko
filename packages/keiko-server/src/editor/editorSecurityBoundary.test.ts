// Consolidated editor trust-boundary regression suite (Issue #1206). The per-route suites each prove
// their own containment; this suite pins the cross-cutting invariant in ONE place so a future editor
// route that accepts a workspace path cannot ship without rejecting denied and out-of-root paths.
//
// Invariant: every path-accepting editor BFF route rejects (a) a deny-listed path (.git/.env/…) and
// (b) an out-of-root / traversal path with a 4xx error and never processes it — and does so BEFORE any
// model call, retrieval, or file read. A deny-listed path is rejected uniformly as 403 DENIED across
// every route; an out-of-root path is rejected as 403 DENIED by the containment-first routes and as
// 400 INVALID_REQUEST by test-generation, which shape-checks `mustBeRelative` before containment.
//
// test-generation is gated off in v1, so it is exercised here with its feature flag enabled to prove
// the containment that guards it when wave-2 turns it on. The other routes need no env: the deps carry
// no gateway config, so a rejection proves containment is the first gate after request parsing.
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import { buildRedactor, createInMemoryUiStore } from "../index.js";
import type { RouteContext, UiHandlerDeps } from "../index.js";
import type { UiStore } from "../store/index.js";
import { handleEditorCompletion } from "./completionRoutes.js";
import { handleEditorInlineCompletion } from "./inlineCompletionRoutes.js";
import { handleEditorContext, handleEditorRepoSearch } from "./contextRoutes.js";
import { handleEditorLanguage } from "./languageRoutes.js";
import { handleEditorTestGeneration } from "./testGenerationRoutes.js";
import {
  handleEditorWorkspaceReplaceApply,
  handleEditorWorkspaceReplacePreview,
  handleEditorWorkspaceSearch,
} from "./workspaceSearchRoutes.js";

interface RouteResultLike {
  status: number;
  body: unknown;
}
type EditorRouteHandler = (ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResultLike>;

let root: string;
let store: UiStore;

function postContext(body: unknown, pathname: string): RouteContext {
  const req = Readable.from([
    Buffer.from(JSON.stringify(body), "utf8"),
  ]) as unknown as IncomingMessage;
  (req as { method?: string }).method = "POST";
  return {
    req,
    res: {} as unknown as ServerResponse,
    params: {},
    url: new URL(`http://localhost${pathname}`),
  };
}

function deps(env: Record<string, string | undefined> = {}): UiHandlerDeps {
  return {
    store,
    redactor: buildRedactor(env, undefined),
    evidenceStore: createInMemoryEvidenceStore(),
    env,
  } as unknown as UiHandlerDeps;
}

const TEST_GENERATION_ENABLED: Record<string, string | undefined> = {
  KEIKO_EDITOR_TEST_GENERATION: "on",
};

interface ExpectedRejection {
  readonly status: number;
  readonly code: string;
}

interface PathAcceptingRoute {
  readonly name: string;
  readonly path: string;
  readonly handler: EditorRouteHandler;
  readonly env: Record<string, string | undefined>;
  readonly bodyForPath: (maliciousPath: string) => Record<string, unknown>;
  // Expected rejection keyed by malicious-path kind ("denied" | "escape").
  readonly expected: Readonly<Record<string, ExpectedRejection>>;
}

const CONTAINMENT_FIRST: Readonly<Record<string, ExpectedRejection>> = {
  denied: { status: 403, code: "DENIED" },
  escape: { status: 403, code: "DENIED" },
};

// One entry per editor BFF route that accepts a caller-supplied workspace path.
const PATH_ACCEPTING_ROUTES: readonly PathAcceptingRoute[] = [
  {
    name: "POST /api/editor/completion",
    path: "/api/editor/completion",
    handler: handleEditorCompletion,
    env: {},
    bodyForPath: (p) => ({
      root,
      document: { path: p, languageId: "typescript", text: "const a = 1;\n" },
      position: { line: 0, character: 0 },
      triggerKind: "invoked",
      contextBudgetBytes: 4_096,
    }),
    expected: CONTAINMENT_FIRST,
  },
  {
    name: "POST /api/editor/inline-completion",
    path: "/api/editor/inline-completion",
    handler: handleEditorInlineCompletion,
    env: {},
    bodyForPath: (p) => ({
      root,
      document: { path: p, languageId: "typescript", text: "const a = 1;\n" },
      position: { line: 0, character: 0 },
      triggerKind: "automatic",
      contextBudgetBytes: 4_096,
    }),
    expected: CONTAINMENT_FIRST,
  },
  {
    name: "POST /api/editor/context",
    path: "/api/editor/context",
    handler: handleEditorContext,
    env: {},
    bodyForPath: (p) => ({ schemaVersion: "1", purpose: "completion", root, documentPath: p }),
    expected: CONTAINMENT_FIRST,
  },
  {
    name: "POST /api/editor/repo-search",
    path: "/api/editor/repo-search",
    handler: handleEditorRepoSearch,
    env: {},
    bodyForPath: (p) => ({ root, queryText: "x", paths: [p] }),
    expected: CONTAINMENT_FIRST,
  },
  {
    name: "POST /api/editor/workspace-search",
    path: "/api/editor/workspace-search",
    handler: handleEditorWorkspaceSearch,
    env: {},
    bodyForPath: (p) => ({
      root,
      query: "x",
      mode: "literal",
      caseSensitive: false,
      includeGlobs: [p],
      excludeGlobs: [],
      maxResults: 20,
    }),
    expected: {
      denied: { status: 403, code: "DENIED" },
      escape: { status: 400, code: "INVALID_REQUEST" },
    },
  },
  {
    name: "POST /api/editor/workspace-search/replace-preview",
    path: "/api/editor/workspace-search/replace-preview",
    handler: handleEditorWorkspaceReplacePreview,
    env: {},
    bodyForPath: (p) => ({
      root,
      query: "x",
      mode: "literal",
      caseSensitive: false,
      includeGlobs: [p],
      excludeGlobs: [],
      replacement: "y",
      maxFiles: 20,
    }),
    expected: {
      denied: { status: 403, code: "DENIED" },
      escape: { status: 400, code: "INVALID_REQUEST" },
    },
  },
  {
    name: "POST /api/editor/workspace-search/replace-apply",
    path: "/api/editor/workspace-search/replace-apply",
    handler: handleEditorWorkspaceReplaceApply,
    env: {},
    bodyForPath: (p) => ({
      root,
      files: [
        {
          path: p,
          baseContentHash: "a".repeat(64),
          edits: [
            {
              range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
              originalText: "x",
              newText: "y",
            },
          ],
        },
      ],
    }),
    expected: {
      denied: { status: 403, code: "DENIED" },
      escape: { status: 400, code: "INVALID_REQUEST" },
    },
  },
  {
    name: "POST /api/editor/language",
    path: "/api/editor/language",
    handler: handleEditorLanguage,
    env: {},
    bodyForPath: (p) => ({
      operation: "diagnostics",
      root,
      document: { path: p, languageId: "typescript", text: "const x = 1;\n" },
    }),
    expected: CONTAINMENT_FIRST,
  },
  {
    name: "POST /api/editor/test-generation",
    path: "/api/editor/test-generation",
    handler: handleEditorTestGeneration,
    // Gated off in v1; enabled here so the request reaches its target-path containment check.
    env: TEST_GENERATION_ENABLED,
    bodyForPath: (p) => ({
      schemaVersion: "1",
      root,
      target: { kind: "file", document: { path: p, languageId: "typescript", text: "x" } },
      contextBudgetBytes: 4_096,
    }),
    // test-generation shape-checks `mustBeRelative` before containment, so a traversal path is a 400.
    expected: {
      denied: { status: 403, code: "DENIED" },
      escape: { status: 400, code: "INVALID_REQUEST" },
    },
  },
];

const MALICIOUS_PATHS: readonly {
  readonly key: string;
  readonly label: string;
  readonly path: string;
}[] = [
  { key: "denied", label: "a deny-listed path (.git segment)", path: ".git/config.ts" },
  { key: "escape", label: "an out-of-root traversal path", path: "../escape.ts" },
];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "keiko-editor-security-")));
  await mkdir(join(root, "src"));
  store = createInMemoryUiStore();
  store.createProject(root, "fixture");
});

afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

describe("editor trust boundary (#1206): path containment is uniform across every editor route", () => {
  for (const route of PATH_ACCEPTING_ROUTES) {
    for (const malicious of MALICIOUS_PATHS) {
      const expected = route.expected[malicious.key];
      it(`${route.name} rejects ${malicious.label}`, async () => {
        const result = await route.handler(
          postContext(route.bodyForPath(malicious.path), route.path),
          deps(route.env),
        );
        expect(expected).toBeDefined();
        expect(result.status).toBe(expected?.status);
        expect(result.body).toMatchObject({ error: { code: expected?.code } });
      });
    }
  }

  it("rejects a deny-listed path with 403 DENIED uniformly on every route", () => {
    for (const route of PATH_ACCEPTING_ROUTES) {
      expect(route.expected.denied).toEqual({ status: 403, code: "DENIED" });
    }
  });

  it("covers every path-accepting editor route (regression guard for new routes)", () => {
    // If a new editor route accepts a workspace path, add it to PATH_ACCEPTING_ROUTES so its
    // containment is proven here too. This count is the human-maintained completeness anchor.
    expect(PATH_ACCEPTING_ROUTES).toHaveLength(9);
  });
});
