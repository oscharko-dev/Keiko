import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { EvidenceAtom, RetrievalQuery, SelectedScope } from "@oscharko-dev/keiko-contracts";
import { CONNECTED_CONTEXT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/connected-context";
import {
  createWorkspaceIndex,
  DEFAULT_SEARCH_LIMITS,
  detectWorkspaceAt,
  searchText,
  type SearchScope,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import {
  buildRedactor,
  createInMemoryUiStore,
  type RouteContext,
  type UiHandlerDeps,
} from "./index.js";
import { runRepoSearchProvider } from "./editor/codingContextProviders.js";
import {
  handleEditorWorkspaceReplacePreview,
  handleEditorWorkspaceSearch,
  handleEditorWorkspaceSymbols,
} from "./editor/workspaceSearchRoutes.js";
import { collectDiscoveredSymbolTraceEvidence } from "./grounded-symbol-trace.js";

const TARGET_PATH = "zzz/nested/handler.ts";
const SYMBOL = "handleLateRequest";
const TARGET_CONTENT = `export function ${SYMBOL}(): number { return 42; }\n`;
const BACKGROUND_FILES = 2_001;
const NOW = 1_784_653_600_000;
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "keiko-shared-search-consumers-"));
  // The streamed walker visits the root files before descending to the nested target.
  for (let index = 0; index < BACKGROUND_FILES; index += 1) {
    writeFileSync(join(root, `background-${String(index).padStart(4, "0")}.ts`), "export {};\n");
  }
  mkdirSync(join(root, "zzz", "nested"), { recursive: true });
  writeFileSync(join(root, TARGET_PATH), TARGET_CONTENT);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/routes.ts"), `router.post("/api/items", ${SYMBOL});\n`);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
});

function deps(overrides: Partial<UiHandlerDeps> = {}): UiHandlerDeps {
  return {
    store: createInMemoryUiStore(),
    evidenceStore: createInMemoryEvidenceStore(),
    redactor: buildRedactor({}),
    env: {},
    ...overrides,
  } as UiHandlerDeps;
}

function context(body: unknown): RouteContext {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  return {
    req,
    res: {} as ServerResponse,
    params: {},
    correlationId: undefined,
    url: new URL("http://localhost/api/editor/workspace-search"),
  };
}

function searchRequest(): Record<string, unknown> {
  return {
    root,
    query: SYMBOL,
    mode: "literal",
    caseSensitive: true,
    includeGlobs: [],
    excludeGlobs: [],
    maxResults: 20,
  };
}

function scope(): SearchScope {
  return {
    workspace: detectWorkspaceAt(root, nodeWorkspaceFs),
    scopeId: "editor-coding-context",
    relativePaths: [],
  };
}

function query(): RetrievalQuery {
  return {
    kind: "exact-symbol",
    text: SYMBOL,
    caseSensitive: true,
    maxResults: 20,
    emittedAtMs: NOW,
  };
}

function routeAtom(): EvidenceAtom {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: "shared-consumer-route",
    scopePath: "src/routes.ts",
    lineRange: { startLine: 1, endLine: 1 },
    score: 1,
    provenance: { kind: "lexical-search", tool: "repo.searchText", queryFingerprint: "route" },
    redactionState: "redacted",
    emittedAtMs: NOW,
    ledgerRef: undefined,
  };
}

function selectedScope(): SelectedScope {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    scopeId: "shared-consumer-trace",
    workspaceRoot: root,
    kind: "workspace-root",
    relativePaths: [],
    conversationId: undefined,
    connectedAtMs: NOW,
    explicitConnection: true,
  };
}

// Advance logical time, not wall time: this guards the retired five-second default without sleeps.
function advancingClock(): () => number {
  let now = NOW;
  const clock = (): number => {
    now += 1_000;
    return now;
  };
  vi.spyOn(Date, "now").mockImplementation(clock);
  return clock;
}

describe("ADR-0022 shared recursive-search consumers", () => {
  it("finds a nested Editor match beyond the former default scan count", async () => {
    advancingClock();
    const result = await handleEditorWorkspaceSearch(context(searchRequest()), deps());
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ truncated: false, filesScanned: BACKGROUND_FILES + 2 });
    expect(result.body).toHaveProperty(
      "results",
      expect.arrayContaining([
        expect.objectContaining({
          path: TARGET_PATH,
          snippet: expect.stringContaining("return 42") as unknown,
        }),
      ]),
    );
  });

  it("previews a nested replacement beyond the former default scan count without writing it", async () => {
    advancingClock();
    const result = await handleEditorWorkspaceReplacePreview(
      context({ ...searchRequest(), replacement: "handleUpdatedRequest", maxFiles: 20 }),
      deps(),
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ truncated: false, searchTruncationReasons: [] });
    expect(result.body).toHaveProperty(
      "files",
      expect.arrayContaining([
        expect.objectContaining({
          path: TARGET_PATH,
          edits: expect.arrayContaining([
            expect.objectContaining({ originalText: SYMBOL, newText: "handleUpdatedRequest" }),
          ]) as unknown,
        }),
      ]),
    );
    expect(nodeWorkspaceFs.readFileUtf8(join(root, TARGET_PATH))).toContain(SYMBOL);
  });

  it("finds a nested Editor definition beyond the former default scan count", async () => {
    advancingClock();
    const result = await handleEditorWorkspaceSymbols(
      context({ root, query: SYMBOL, maxResults: 20 }),
      deps(),
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ truncated: false, filesScanned: BACKGROUND_FILES + 2 });
    expect(result.body).toHaveProperty(
      "results",
      expect.arrayContaining([
        expect.objectContaining({ path: TARGET_PATH, symbol: SYMBOL, line: 1 }),
      ]),
    );
  });

  it("uses the live coding-context traversal instead of an incomplete finite index", async () => {
    const workspaceIndex = createWorkspaceIndex();
    const load = vi.spyOn(workspaceIndex, "loadSnapshot");
    const save = vi.spyOn(workspaceIndex, "saveSnapshot");
    rmSync(join(root, TARGET_PATH));
    const warm = await searchText(
      scope(),
      query(),
      { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: 2_000, elapsedMsMax: null },
      { workspaceIndex },
    ).finally(() => {
      writeFileSync(join(root, TARGET_PATH), TARGET_CONTENT);
    });
    expect(warm.coverage.reasons).toContain("file-cap");
    expect(save).toHaveBeenCalled();
    expect(save.mock.lastCall?.[1].records.some((entry) => entry.scopePath === TARGET_PATH)).toBe(
      false,
    );
    load.mockClear();
    save.mockClear();
    advancingClock();
    const result = await runRepoSearchProvider(
      {
        deps: deps({ workspaceIndexForRoot: () => workspaceIndex }),
        realRoot: root,
        fs: nodeWorkspaceFs,
        signal: new AbortController().signal,
        maxBytesPerExcerpt: 8192,
        nowMs: NOW,
        currentTimeMs: () => NOW,
      },
      {
        documentPath: "src/routes.ts",
        symbol: SYMBOL,
        queryText: undefined,
        changedFiles: undefined,
      },
    );
    expect(result.omission).toBeUndefined();
    expect(result.excerpts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceKind: "repo-search",
          citationRef: "handler.ts",
          text: expect.stringContaining("return 42") as unknown,
        }),
      ]),
    );
    expect(load).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("discovers the grounded route handler beyond the former default scan count", async () => {
    const clock = advancingClock();
    const result = await collectDiscoveredSymbolTraceEvidence({
      scope: selectedScope(),
      query: {
        ...query(),
        kind: "natural-language",
        text: "Trace POST /api/items from route to handler",
      },
      anchors: [],
      retrievalIntent: "targeted-code-search",
      searchScope: scope(),
      fs: nodeWorkspaceFs,
      nowMs: clock,
      atoms: [routeAtom()],
    });
    expect(result.atoms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scopePath: TARGET_PATH,
          lineRange: { startLine: 1, endLine: 1 },
        }),
      ]),
    );
    expect(result.uncertainty).toEqual([]);
  });
});
