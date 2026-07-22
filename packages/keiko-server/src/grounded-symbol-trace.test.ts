import { describe, expect, it } from "vitest";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  type EvidenceAtom,
  type RetrievalQuery,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts";
import type {
  SearchScope,
  WorkspaceFs,
  WorkspaceInfo,
  WorkspaceStat,
} from "@oscharko-dev/keiko-workspace";

import { collectDiscoveredSymbolTraceEvidence } from "./grounded-symbol-trace.js";

const NOW = 1_784_653_600_000;
const WORKSPACE_ROOT = "/workspace";
const ROUTE_PATH = "src/routes.ts";
const ROUTE_CONTENT = 'router.post("/api/items", handler: handlePostItem);\n';

interface FsProbe {
  readonly fs: WorkspaceFs;
  readonly accessCount: () => number;
}

function workspaceInfo(): WorkspaceInfo {
  return {
    root: WORKSPACE_ROOT,
    name: "workspace",
    version: "1.0.0",
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages: ["typescript"],
    ignoreLines: [],
  };
}

function fsProbe(): FsProbe {
  let accesses = 0;
  const touch = (): void => {
    accesses += 1;
  };
  const stat = (): WorkspaceStat => {
    touch();
    return {
      size: Buffer.byteLength(ROUTE_CONTENT),
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      hardLinkCount: 1,
      mtimeMs: NOW,
    };
  };
  return {
    fs: {
      readFileUtf8: (): string => {
        touch();
        return ROUTE_CONTENT;
      },
      stat,
      readDir: (): readonly never[] => {
        touch();
        return [];
      },
      realPath: (absolutePath): string => {
        touch();
        return absolutePath;
      },
      exists: (): boolean => {
        touch();
        return true;
      },
      readFileBytes: (_absolutePath, maxBytes): Promise<Uint8Array> => {
        touch();
        return Promise.resolve(new TextEncoder().encode(ROUTE_CONTENT).subarray(0, maxBytes));
      },
    },
    accessCount: (): number => accesses,
  };
}

function selectedScope(): SelectedScope {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    scopeId: "scope-route",
    workspaceRoot: WORKSPACE_ROOT,
    kind: "workspace-root",
    relativePaths: [],
    conversationId: undefined,
    connectedAtMs: NOW,
    explicitConnection: true,
  };
}

function routeQuery(): RetrievalQuery {
  return {
    kind: "natural-language",
    text: "Trace POST /api/items from route to handler",
    caseSensitive: false,
    maxResults: 20,
    emittedAtMs: NOW,
  };
}

function routeAtom(): EvidenceAtom {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: "route-atom",
    scopePath: ROUTE_PATH,
    lineRange: { startLine: 1, endLine: 1 },
    score: 1,
    provenance: {
      kind: "lexical-search",
      tool: "repo.searchText",
      queryFingerprint: "route-query",
    },
    redactionState: "redacted",
    emittedAtMs: NOW,
    ledgerRef: undefined,
  };
}

describe("collectDiscoveredSymbolTraceEvidence", () => {
  it("forwards cancellation before reading discovery excerpts", async () => {
    const probe = fsProbe();
    const controller = new AbortController();
    controller.abort();
    const searchScope: SearchScope = {
      workspace: workspaceInfo(),
      scopeId: "scope-route",
      relativePaths: [],
    };

    await expect(
      collectDiscoveredSymbolTraceEvidence({
        scope: selectedScope(),
        query: routeQuery(),
        anchors: [],
        retrievalIntent: "targeted-code-search",
        searchScope,
        fs: probe.fs,
        nowMs: () => NOW,
        atoms: [routeAtom()],
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/iu);
    expect(probe.accessCount()).toBe(0);
  });
});
