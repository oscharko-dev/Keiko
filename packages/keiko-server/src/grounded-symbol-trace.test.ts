import { describe, expect, it } from "vitest";
import type { EvidenceAtom, RetrievalQuery, SelectedScope } from "@oscharko-dev/keiko-contracts";
import { CONNECTED_CONTEXT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/connected-context";
import type {
  SearchScope,
  WorkspaceFs,
  WorkspaceInfo,
  WorkspaceStat,
} from "@oscharko-dev/keiko-workspace";
import { WorkspaceDescriptorReadError } from "@oscharko-dev/keiko-workspace/internal/fs";
import { createStructuralAdapterRequestContext } from "@oscharko-dev/keiko-workspace/code-intelligence";
import { CancelledError } from "@oscharko-dev/keiko-model-gateway";

import {
  collectDiscoveredSymbolTraceEvidence,
  collectFollowSymbolTraceEvidence,
  GROUNDED_TRACE_SEARCH_LIMITS,
} from "./grounded-symbol-trace.js";

const NOW = 1_784_653_600_000;
const WORKSPACE_ROOT = "/workspace";
const ROUTE_PATH = "src/routes.ts";
const ROUTE_CONTENT = 'router.post("/api/items", handler: handlePostItem);\n';
const ROUTE_FILE_IDENTITY = `symbol-trace-probe:${WORKSPACE_ROOT}/${ROUTE_PATH}`;

interface FsProbe {
  readonly fs: WorkspaceFs;
  readonly accessCount: () => number;
}

function workspaceInfo(): WorkspaceInfo {
  return {
    root: WORKSPACE_ROOT,
    selectedRoot: WORKSPACE_ROOT,
    name: "workspace",
    version: "1.0.0",
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages: ["typescript"],
    ignoreLines: [],
  };
}

function routeStat(): WorkspaceStat {
  return {
    size: Buffer.byteLength(ROUTE_CONTENT),
    isFile: true,
    isDirectory: false,
    isSymbolicLink: false,
    hardLinkCount: 1,
    mtimeMs: NOW,
    // Production's `fileIdentity` is `dev:ino`: stable per path, independent of content. The
    // bounded reader below re-proves it, so the probe has to publish one.
    fileIdentity: ROUTE_FILE_IDENTITY,
  };
}

// ADR-0005 D1: discovery's read lane uses the bounded same-descriptor primitive when the port
// provides it and reports the read as unavailable when it does not -- the unbounded
// `readFileUtf8` fallback that used to sit beside the byte cap was removed. A probe that omits
// this method therefore loses every excerpt read instead of exercising the reservation and
// deadline paths under test. Mirrors `readFileUtf8SameDescriptor` in keiko-workspace's node port:
// refuse a hard-linked alias, re-prove the caller's expected snapshot, and refuse a file that does
// not fit the cap rather than truncating it.
function routeDescriptorReader(
  touch: () => void,
): NonNullable<WorkspaceFs["readFileUtf8SameDescriptor"]> {
  return (_absolutePath, maxBytes, hardLinkPolicy, expected) => {
    touch();
    const observed = routeStat();
    if (hardLinkPolicy === "reject" && (observed.hardLinkCount ?? 1) > 1) {
      throw new WorkspaceDescriptorReadError("hard-link");
    }
    if (expected.fileIdentity !== observed.fileIdentity || expected.size !== observed.size) {
      throw new WorkspaceDescriptorReadError("changed");
    }
    const sizeBytes = Buffer.byteLength(ROUTE_CONTENT);
    if (sizeBytes > Math.max(0, Math.floor(maxBytes))) {
      throw new WorkspaceDescriptorReadError("too-large", sizeBytes);
    }
    return { rawText: ROUTE_CONTENT, sizeBytes, stat: observed };
  };
}

function fsProbe(): FsProbe {
  let accesses = 0;
  const touch = (): void => {
    accesses += 1;
  };
  const stat = (): WorkspaceStat => {
    touch();
    return routeStat();
  };
  return {
    fs: {
      readFileUtf8: (): string => {
        touch();
        return ROUTE_CONTENT;
      },
      readFileUtf8SameDescriptor: routeDescriptorReader(touch),
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
    ).rejects.toBeInstanceOf(CancelledError);
    expect(probe.accessCount()).toBe(0);
  });

  it("does not start a discovered-symbol search without a reserved search call", async () => {
    const probe = fsProbe();
    const searchScope: SearchScope = {
      workspace: workspaceInfo(),
      scopeId: "scope-route",
      relativePaths: [],
    };
    const requestContext = createStructuralAdapterRequestContext(
      searchScope,
      GROUNDED_TRACE_SEARCH_LIMITS,
      probe.fs,
      { nowMs: () => NOW },
    );
    let reservations = 0;

    const result = await collectDiscoveredSymbolTraceEvidence({
      scope: selectedScope(),
      query: routeQuery(),
      anchors: [],
      retrievalIntent: "targeted-code-search",
      searchScope,
      fs: probe.fs,
      nowMs: () => NOW,
      atoms: [routeAtom()],
      requestContext,
      tryReserveSearchCall: () => {
        reservations += 1;
        return false;
      },
    });

    expect(reservations).toBe(1);
    expect(requestContext.diagnostics().textSearchCount).toBe(0);
    expect(result).toEqual({ atoms: [], uncertainty: [] });
  });

  it("surfaces incomplete discovered-symbol searches after the shared deadline expires", async () => {
    const probe = fsProbe();
    const searchScope: SearchScope = {
      workspace: workspaceInfo(),
      scopeId: "scope-route",
      relativePaths: [],
    };
    let currentMs = 0;
    const requestContext = createStructuralAdapterRequestContext(
      searchScope,
      GROUNDED_TRACE_SEARCH_LIMITS,
      probe.fs,
      { nowMs: () => currentMs },
    );
    currentMs = GROUNDED_TRACE_SEARCH_LIMITS.elapsedMsMax + 1;

    const result = await collectDiscoveredSymbolTraceEvidence({
      scope: selectedScope(),
      query: routeQuery(),
      anchors: [],
      retrievalIntent: "targeted-code-search",
      searchScope,
      fs: probe.fs,
      nowMs: () => currentMs,
      atoms: [routeAtom()],
      requestContext,
    });

    expect(result.atoms).toEqual([]);
    expect(result.uncertainty).toHaveLength(1);
    expect(result.uncertainty[0]?.kind).toBe("budget-clipped");
    expect(result.uncertainty[0]?.claim).toContain("Discovered-symbol trace search was incomplete");
    expect(JSON.stringify(result.uncertainty)).not.toContain(ROUTE_CONTENT);
  });
});

describe("collectFollowSymbolTraceEvidence", () => {
  it("does not start the trace when its search call cannot be reserved", async () => {
    const probe = fsProbe();
    const searchScope: SearchScope = {
      workspace: workspaceInfo(),
      scopeId: "scope-route",
      relativePaths: [],
    };
    let reservations = 0;

    const result = await collectFollowSymbolTraceEvidence({
      scope: selectedScope(),
      query: routeQuery(),
      anchors: [{ term: "handlePostItem", weight: 0.9, kind: "identifier" }],
      retrievalIntent: "targeted-code-search",
      searchScope,
      fs: probe.fs,
      nowMs: () => NOW,
      tryReserveSearchCall: () => {
        reservations += 1;
        return false;
      },
    });

    expect(result).toEqual({ atoms: [], uncertainty: [] });
    expect(reservations).toBe(1);
    expect(probe.accessCount()).toBe(0);
  });
});
