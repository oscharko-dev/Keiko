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
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import { endpointContractAdapter } from "@oscharko-dev/keiko-workspace";
import { CancelledError } from "@oscharko-dev/keiko-model-gateway";

import {
  collectDiscoveredSymbolTraceEvidence,
  collectFollowSymbolTraceEvidence,
  GROUNDED_TRACE_SEARCH_LIMITS,
} from "./grounded-symbol-trace.js";

const NOW = 1_784_653_600_000;
const WORKSPACE_ROOT = "/workspace";
const ROUTE_PATH = "src/routes.ts";
const ROUTE_CONTENT = 'router.post("/api/items", handlePostItem);\n';
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
    expect(result.atoms).toEqual([]);
    expect(result.uncertainty).toHaveLength(1);
    expect(result.uncertainty[0]?.claim).toContain("search-budget");
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
      { nowMs: () => currentMs, deadlineAtMs: 10 },
    );
    currentMs = 11;

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
  it("does not reserve graph work for directly requested implementation facts", async () => {
    const probe = fsProbe();
    let reservations = 0;
    const result = await collectFollowSymbolTraceEvidence({
      scope: selectedScope(),
      query: {
        ...routeQuery(),
        text: "Where are WindowFrame and ChatPanel implemented, and what values do they return?",
      },
      anchors: [
        { term: "windowframe", weight: 0.85, kind: "identifier" },
        { term: "chatpanel", weight: 0.85, kind: "identifier" },
      ],
      retrievalIntent: "targeted-code-search",
      searchScope: { workspace: workspaceInfo(), scopeId: "direct-facts", relativePaths: [] },
      fs: probe.fs,
      nowMs: () => NOW,
      tryReserveSearchCall: () => {
        reservations += 1;
        return false;
      },
    });
    expect(result).toEqual({ atoms: [], uncertainty: [] });
    expect(reservations).toBe(0);
    expect(probe.accessCount()).toBe(0);
  });

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

describe("registered endpoint handler frontier", () => {
  it.each([0, 12])(
    "uses the exact registration with %i client calls before unrelated api/http filenames",
    async (clientCalls) => {
      const files = {
        "src/entry.ts": [
          'const routes = [{ method: "GET", pattern: "/api/items", handler: wrongMethod },',
          ' { method: "POST", pattern: "/api/other", handler: wrongPath },',
          ' { method: "POST", pattern: "/api/items", handler: handleItem }];',
        ].join("\n"),
        "src/implementation.ts": [
          "export function handleItem() { return admitItem(); }",
          "function admitItem() { return 1; }",
        ].join("\n"),
        "src/api.ts": Array.from({ length: 12 }, () =>
          clientCalls > 0
            ? 'fetch("/api/items", { method: "POST" });'
            : "export const unrelated = 1;",
        ).join("\n"),
      };
      const fs = memFs(WORKSPACE_ROOT, files);
      const searchScope = { workspace: workspaceInfo(), scopeId: "scope-route", relativePaths: [] };
      const requestContext = createStructuralAdapterRequestContext(
        searchScope,
        GROUNDED_TRACE_SEARCH_LIMITS,
        fs,
        { nowMs: () => NOW },
      );
      const endpointAtoms = await endpointContractAdapter.lookup(
        searchScope,
        { ...routeQuery(), maxResults: 100 },
        GROUNDED_TRACE_SEARCH_LIMITS,
        fs,
        { requestContext },
      );
      const unrelated = Array.from({ length: 12 }, (_value, index) => ({
        ...routeAtom(),
        stableId: `unrelated-${String(index)}`,
        scopePath: "src/api.ts",
        lineRange: { startLine: index + 1, endLine: index + 1 },
        score: 1,
      }));
      let reservations = 0;
      const result = await collectDiscoveredSymbolTraceEvidence({
        scope: selectedScope(),
        query: routeQuery(),
        anchors: [],
        retrievalIntent: "targeted-code-search",
        searchScope,
        fs,
        nowMs: () => NOW,
        atoms: [...unrelated, ...endpointAtoms],
        requestContext,
        tryReserveSearchCall: () => {
          reservations += 1;
          return true;
        },
      });
      expect(
        result.atoms.some(
          (atom) =>
            atom.scopePath === "src/implementation.ts" &&
            atom.provenance.tool === "discovered-symbol-definition",
        ),
      ).toBe(true);
      expect(
        result.atoms
          .filter((atom) => atom.scopePath === "src/entry.ts")
          .every((atom) => atom.lineRange?.startLine === 3),
      ).toBe(true);
      expect(reservations).toBeGreaterThan(0);
      expect(reservations).toBeLessThanOrEqual(8);
    },
  );
});

describe("fluent endpoint handler certification", () => {
  it.each(["factory()", "handlers.other"])(
    "does not promote a dynamic fluent handler: %s",
    async (handler) => {
      const fs = memFs(WORKSPACE_ROOT, {
        "src/routes.ts": `router.post("/api/items", ${handler});`,
      });
      const searchScope = { workspace: workspaceInfo(), scopeId: "scope-route", relativePaths: [] };
      let reservations = 0;
      const result = await collectDiscoveredSymbolTraceEvidence({
        scope: selectedScope(),
        query: routeQuery(),
        anchors: [],
        retrievalIntent: "targeted-code-search",
        searchScope,
        fs,
        nowMs: () => NOW,
        atoms: [routeAtom()],
        tryReserveSearchCall: () => {
          reservations += 1;
          return false;
        },
      });
      expect(result.atoms).toEqual([]);
      expect(reservations).toBe(0);
    },
  );
});

describe("admitted multiline handler definitions", () => {
  it("traces actual body calls while excluding comment and string examples", async () => {
    const fs = memFs(WORKSPACE_ROOT, {
      "src/routes.ts": ROUTE_CONTENT,
      "src/implementation.ts": [
        "export function handlePostItem(",
        "  input: unknown,",
        ") {",
        "  // fakeOne(); fakeTwo(); fakeThree(); fakeFour();",
        '  const example = "fakeOne(); fakeTwo(); fakeThree(); fakeFour();";',
        "  return admitItem(input);",
        "}",
        "export function admitItem(input: unknown) { return input; }",
        "function fakeOne() {}",
        "function fakeTwo() {}",
        "function fakeThree() {}",
        "function fakeFour() {}",
      ].join("\n"),
    });
    const searchScope = { workspace: workspaceInfo(), scopeId: "scope-route", relativePaths: [] };
    const requestContext = createStructuralAdapterRequestContext(
      searchScope,
      GROUNDED_TRACE_SEARCH_LIMITS,
      fs,
      { nowMs: () => NOW },
    );
    const result = await collectDiscoveredSymbolTraceEvidence({
      scope: selectedScope(),
      query: routeQuery(),
      anchors: [],
      retrievalIntent: "targeted-code-search",
      searchScope,
      fs,
      nowMs: () => NOW,
      atoms: [routeAtom()],
      requestContext,
    });
    const definitions = result.atoms.filter(
      (atom) => atom.provenance.tool === "discovered-symbol-definition",
    );
    expect(
      definitions.some((atom) => atom.lineRange?.startLine === 1 && atom.lineRange.endLine === 7),
    ).toBe(true);
    expect(definitions.some((atom) => atom.lineRange?.startLine === 8)).toBe(true);
    expect(definitions.some((atom) => (atom.lineRange?.startLine ?? 0) >= 9)).toBe(false);
    expect(requestContext.diagnostics().textSearchCount).toBe(1);
    expect(requestContext.diagnostics().codeIndexBuildCount).toBe(1);
  });
});

describe("symbol declaration source binding", () => {
  it("does not reuse an old AST extent after the indexed file changes", async () => {
    const files = {
      "src/routes.ts": ROUTE_CONTENT,
      "src/implementation.ts": [
        "export function handlePostItem(input: unknown) {",
        " const first = input;",
        " const second = first;",
        " const third = second;",
        " return admitItem(third);",
        "}",
        "export function admitItem(input: unknown) { return input; }",
      ].join("\n"),
      "src/other.ts": "export function unrelatedOperation() { return false; }",
    };
    const fs = memFs(WORKSPACE_ROOT, files);
    const searchScope = { workspace: workspaceInfo(), scopeId: "scope-route", relativePaths: [] };
    const requestContext = createStructuralAdapterRequestContext(
      searchScope,
      GROUNDED_TRACE_SEARCH_LIMITS,
      fs,
      { nowMs: () => NOW },
    );
    await requestContext.codeIntelligenceIndex();
    files["src/implementation.ts"] = [
      "export function handlePostItem(input: unknown) {",
      " return input;",
      "}",
      "export function otherHandler() {",
      " return unrelatedOperation();",
      "}",
      "export function admitItem(input: unknown) { return input; }",
    ].join("\n");
    const result = await collectDiscoveredSymbolTraceEvidence({
      scope: selectedScope(),
      query: routeQuery(),
      anchors: [],
      retrievalIntent: "targeted-code-search",
      searchScope,
      fs,
      nowMs: () => NOW,
      atoms: [routeAtom()],
      requestContext,
    });
    expect(
      result.atoms.some(
        (atom) =>
          atom.scopePath === "src/other.ts" &&
          atom.provenance.tool === "discovered-symbol-definition",
      ),
    ).toBe(false);
    expect(requestContext.diagnostics().codeIndexBuildCount).toBe(1);
  });

  it("does not certify declarations contained only in comments or quoted examples", async () => {
    const files: Record<string, string> = {
      "src/routes.ts": ROUTE_CONTENT,
      "src/zz-implementation.ts": "export function handlePostItem() { return true; }",
      "src/aa-string.ts":
        'export const example = "function handlePostItem() { return fakeCall(); }";',
    };
    files["src/ab-comment-decoy.go"] = "// func handlePostItem() { fakeCall() }";
    files["src/ab-comment-decoy.py"] = "# def handlePostItem(): fakeCall()";
    files["src/ab-comment-block.ts"] = "/*\nfunction handlePostItem() { fakeCall(); }\n*/";
    files["src/ab-comment-template.ts"] =
      "const example = `\nfunction handlePostItem() { fakeCall(); }\n`;";
    for (let index = 0; index < 12; index += 1)
      files[`src/ab-comment-${String(index)}.ts`] =
        "// function handlePostItem() { return fakeCall(); }";
    const fs = memFs(WORKSPACE_ROOT, files);
    const searchScope = { workspace: workspaceInfo(), scopeId: "scope-route", relativePaths: [] };
    const requestContext = createStructuralAdapterRequestContext(
      searchScope,
      GROUNDED_TRACE_SEARCH_LIMITS,
      fs,
      { nowMs: () => NOW },
    );
    const result = await collectDiscoveredSymbolTraceEvidence({
      scope: selectedScope(),
      query: routeQuery(),
      anchors: [],
      retrievalIntent: "targeted-code-search",
      searchScope,
      fs,
      nowMs: () => NOW,
      atoms: [routeAtom()],
      requestContext,
    });
    expect(
      result.atoms.some(
        (atom) =>
          atom.scopePath === "src/zz-implementation.ts" &&
          atom.provenance.tool === "discovered-symbol-definition",
      ),
    ).toBe(true);
    expect(
      result.atoms.filter(
        (atom) =>
          (atom.scopePath.includes("comment-") || atom.scopePath.endsWith("aa-string.ts")) &&
          atom.provenance.tool === "discovered-symbol-definition",
      ),
    ).toEqual([]);
  });
});

async function traceFixture(
  files: Record<string, string>,
  reserve: () => boolean = () => true,
  withContext = true,
): Promise<Awaited<ReturnType<typeof collectDiscoveredSymbolTraceEvidence>>> {
  const fs = memFs(WORKSPACE_ROOT, { "src/routes.ts": ROUTE_CONTENT, ...files });
  const searchScope = { workspace: workspaceInfo(), scopeId: "scope-route", relativePaths: [] };
  const requestContext = withContext
    ? createStructuralAdapterRequestContext(searchScope, GROUNDED_TRACE_SEARCH_LIMITS, fs, {
        nowMs: () => NOW,
      })
    : undefined;
  return collectDiscoveredSymbolTraceEvidence({
    scope: selectedScope(),
    query: routeQuery(),
    anchors: [],
    retrievalIntent: "targeted-code-search",
    searchScope,
    fs,
    nowMs: () => NOW,
    atoms: [routeAtom()],
    requestContext,
    tryReserveSearchCall: reserve,
  });
}

describe("source-bound AST route continuation", () => {
  it("reuses an actual resolved alias target without certifying a same-named decoy", async () => {
    const result = await traceFixture({
      "src/implementation.ts":
        'import { executeItem as ask } from "./actual.js";\nexport function handlePostItem() { const result = ask(); return result; }',
      "src/actual.ts": "export function executeItem() { return true; }",
      "src/decoy.ts": "export function executeItem() { return false; }",
    });
    const paths = result.atoms
      .filter((atom) => atom.provenance.tool === "discovered-symbol-definition")
      .map((atom) => atom.scopePath);
    expect(paths).toContain("src/actual.ts");
    expect(paths).not.toContain("src/decoy.ts");
  });

  it("does not traverse a call after the byte-clipped tail of a single physical line", async () => {
    const result = await traceFixture({
      "src/implementation.ts": `export function handlePostItem() { const example = "${"x".repeat(16000)}"; return hiddenTail(); }`,
      "src/hidden.ts": "export function hiddenTail() { return true; }",
    });
    expect(
      result.atoms.some(
        (atom) =>
          atom.scopePath === "src/hidden.ts" &&
          atom.provenance.tool === "discovered-symbol-definition",
      ),
    ).toBe(false);
    expect(result.uncertainty.some((marker) => marker.claim.includes("excerpt-clipped"))).toBe(
      true,
    );
  });

  it("reports the unsearched handler frontier when its existing search grant is refused", async () => {
    const result = await traceFixture(
      { "src/implementation.ts": "export function handlePostItem() { return true; }" },
      () => false,
    );
    expect(result.atoms).toEqual([]);
    expect(result.uncertainty.some((marker) => marker.claim.includes("search-budget"))).toBe(true);
  });

  it("keeps fragment-only declarations uncertified without an admitted AST context", async () => {
    const result = await traceFixture(
      {
        "src/comment.ts": "/*\nfunction handlePostItem() { fakeCall(); }\n*/",
        "src/template.ts": "const example = `\nfunction handlePostItem() { fakeCall(); }\n`;",
        "src/implementation.ts": "export function handlePostItem() { return true; }",
      },
      () => true,
      false,
    );
    expect(result.atoms.every((atom) => atom.provenance.tool === "structural-edge-target")).toBe(
      true,
    );
  });
});

describe("bounded sibling delegation frontier", () => {
  it("keeps a real delegate when another handler sibling contains many early-return helpers", async () => {
    const failures = Array.from(
      { length: 20 },
      (_value, index) => `if (Math.random()) return refused${String(index)}();`,
    );
    const declarations = Array.from(
      { length: 20 },
      (_value, index) => `function refused${String(index)}() { return undefined; }`,
    );
    const result = await traceFixture({
      "src/implementation.ts": [
        'import { actualDelegate } from "./actual.js";',
        "export function handlePostItem() { const prepared = prepareItem(); const result = executeItem(prepared); return result; }",
        `function prepareItem() { ${failures.join(" ")} return {}; }`,
        "function executeItem(input: unknown) { return actualDelegate(input); }",
        ...declarations,
      ].join("\n"),
      "src/actual.ts": "export function actualDelegate(input: unknown) { return input; }",
    });
    expect(
      result.atoms.some(
        (atom) =>
          atom.scopePath === "src/actual.ts" &&
          atom.provenance.tool === "discovered-symbol-definition",
      ),
    ).toBe(true);
  });
});

describe("bounded awaited delegation frontier", () => {
  it("keeps the guarded awaited dispatch ahead of synchronous refusal siblings", async () => {
    const failures = Array.from(
      { length: 10 },
      (_value, index) => `if (Math.random()) return refused${String(index)}();`,
    );
    const declarations = Array.from(
      { length: 10 },
      (_value, index) => `function refused${String(index)}() { return undefined; }`,
    );
    const result = await traceFixture({
      "src/implementation.ts": [
        'import { actualDelegate } from "./actual.js";',
        `export async function handlePostItem() { ${failures.join(" ")} const result = await actualDelegate(); return result; }`,
        ...declarations,
      ].join("\n"),
      "src/actual.ts": "export async function actualDelegate() { return true; }",
    });
    expect(
      result.atoms.some(
        (atom) =>
          atom.scopePath === "src/actual.ts" &&
          atom.provenance.tool === "discovered-symbol-definition",
      ),
    ).toBe(true);
  });
});

describe("bounded compiler-certified continuation completeness", () => {
  it("observes a retained thirteenth sibling before traversing its actual delegate", async () => {
    const names = Array.from({ length: 13 }, (_value, index) => `branch${String(index)}`);
    const result = await traceFixture({
      "src/implementation.ts": [
        'import { actualDelegate } from "./actual.js";',
        `export function handlePostItem() { ${names.map((name) => `${name}();`).join(" ")} }`,
        ...names.map(
          (name, index) =>
            `function ${name}() { return ${index === names.length - 1 ? "actualDelegate()" : "true"}; }`,
        ),
      ].join("\n"),
      "src/actual.ts": "export function actualDelegate() { return true; }",
    });
    expect(result.atoms.some((atom) => atom.scopePath === "src/actual.ts")).toBe(true);
  });

  it("retains a fifth actual delegate inside the accepted request grants", async () => {
    const result = await traceFixture({
      "src/implementation.ts": [
        'import { actualDelegate } from "./actual.js";',
        "export async function handlePostItem() { await first(); await second(); await third(); await fourth(); const result = await actualDelegate(); return result; }",
        "async function first() { return true; }",
        "async function second() { return true; }",
        "async function third() { return true; }",
        "async function fourth() { return true; }",
      ].join("\n"),
      "src/actual.ts": "export async function actualDelegate() { return true; }",
    });
    expect(result.atoms.some((atom) => atom.scopePath === "src/actual.ts")).toBe(true);
  });

  it("reports omitted certified calls at the finite continuation bound", async () => {
    const names = Array.from({ length: 80 }, (_value, index) => `delegate${String(index)}`);
    const result = await traceFixture({
      "src/implementation.ts": [
        `export async function handlePostItem() { ${names.map((name) => `await ${name}();`).join(" ")} }`,
        ...names.map((name) => `async function ${name}() { return true; }`),
      ].join("\n"),
    });
    expect(result.uncertainty.some((marker) => marker.claim.includes("frontier-width"))).toBe(true);
    const definitions = result.atoms.filter(
      (atom) => atom.provenance.tool === "discovered-symbol-definition",
    );
    expect(definitions.length).toBeGreaterThan(4);
    expect(definitions.length).toBeLessThan(names.length);
  });
});
