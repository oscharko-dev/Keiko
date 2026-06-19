// Consolidated editor trust-boundary regression suite (Issue #1206). The per-route suites each prove
// their own containment; this suite pins the cross-cutting invariant in ONE place so a future editor
// route that accepts a workspace path cannot ship without rejecting denied and out-of-root paths.
//
// Every path-accepting editor BFF route must reject (a) a deny-listed path (.git/.env/node_modules…)
// and (b) an out-of-root / traversal path with 403 DENIED — and must do so BEFORE any model call,
// retrieval, or file read. The deps here carry NO gateway config, so a 403 proves containment is the
// first gate after request parsing, never reached after model/provider work.
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

function deps(): UiHandlerDeps {
  return {
    store,
    redactor: buildRedactor({}),
    evidenceStore: createInMemoryEvidenceStore(),
  } as unknown as UiHandlerDeps;
}

interface PathAcceptingRoute {
  readonly name: string;
  readonly path: string;
  readonly handler: EditorRouteHandler;
  readonly bodyForPath: (maliciousPath: string) => Record<string, unknown>;
}

// One entry per editor BFF route that accepts a caller-supplied workspace path.
const PATH_ACCEPTING_ROUTES: readonly PathAcceptingRoute[] = [
  {
    name: "POST /api/editor/completion",
    path: "/api/editor/completion",
    handler: handleEditorCompletion,
    bodyForPath: (p) => ({
      root,
      document: { path: p, languageId: "typescript", text: "const a = 1;\n" },
      position: { line: 0, character: 0 },
      triggerKind: "invoked",
      contextBudgetBytes: 4_096,
    }),
  },
  {
    name: "POST /api/editor/inline-completion",
    path: "/api/editor/inline-completion",
    handler: handleEditorInlineCompletion,
    bodyForPath: (p) => ({
      root,
      document: { path: p, languageId: "typescript", text: "const a = 1;\n" },
      position: { line: 0, character: 0 },
      triggerKind: "automatic",
      contextBudgetBytes: 4_096,
    }),
  },
  {
    name: "POST /api/editor/context",
    path: "/api/editor/context",
    handler: handleEditorContext,
    bodyForPath: (p) => ({ schemaVersion: "1", purpose: "completion", root, documentPath: p }),
  },
  {
    name: "POST /api/editor/repo-search",
    path: "/api/editor/repo-search",
    handler: handleEditorRepoSearch,
    bodyForPath: (p) => ({ root, queryText: "x", paths: [p] }),
  },
  {
    name: "POST /api/editor/language",
    path: "/api/editor/language",
    handler: handleEditorLanguage,
    bodyForPath: (p) => ({
      operation: "diagnostics",
      root,
      document: { path: p, languageId: "typescript", text: "const x = 1;\n" },
    }),
  },
];

const MALICIOUS_PATHS: readonly { readonly label: string; readonly path: string }[] = [
  { label: "a deny-listed path (.git segment)", path: ".git/config.ts" },
  { label: "an out-of-root traversal path", path: "../escape.ts" },
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
      it(`${route.name} rejects ${malicious.label} with 403 DENIED`, async () => {
        const result = await route.handler(
          postContext(route.bodyForPath(malicious.path), route.path),
          deps(),
        );
        expect(result.status).toBe(403);
        expect(result.body).toMatchObject({ error: { code: "DENIED" } });
      });
    }
  }

  it("covers every path-accepting editor route (regression guard for new routes)", () => {
    // If a new editor route accepts a workspace path, add it to PATH_ACCEPTING_ROUTES so its
    // containment is proven here too. This count is the human-maintained completeness anchor.
    expect(PATH_ACCEPTING_ROUTES).toHaveLength(5);
  });
});
