import { describe, expect, it } from "vitest";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
  type EvidenceAtom,
  type RetrievalQuery,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { searchText, type SearchScope, type WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import { createStructuralAdapterRequestContext } from "@oscharko-dev/keiko-workspace/code-intelligence";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import {
  _readKeptExcerptsForTests,
  retrieveConnectedContextPack,
  type ExcerptReadSummary,
} from "./grounded-orchestrator.js";
import {
  collectDiscoveredSymbolTraceEvidence,
  GROUNDED_TRACE_SEARCH_LIMITS,
} from "./grounded-symbol-trace.js";

const NOW = 1_700_000_000_000;
const PATH = "src/implementation.ts";

interface OverlapFixture {
  readonly fs: WorkspaceFs;
  readonly scope: SearchScope;
  readonly atoms: readonly EvidenceAtom[];
  readonly lines: readonly string[];
}

function overlapScope(): SearchScope {
  return {
    workspace: {
      root: "/workspace",
      selectedRoot: "/workspace",
      name: "overlap",
      version: "1.0.0",
      testFramework: "vitest",
      sourceDirs: ["src"],
      testDirs: [],
      languages: ["typescript"],
      ignoreLines: [],
    },
    scopeId: "overlap",
    relativePaths: [],
  };
}

function overlapQuery(text: string): RetrievalQuery {
  return {
    kind: "natural-language",
    text,
    caseSensitive: false,
    maxResults: 500,
    emittedAtMs: NOW,
  };
}

function selectedScope(scope: SearchScope): SelectedScope {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    scopeId: scope.scopeId,
    workspaceRoot: scope.workspace.root,
    kind: "workspace-root",
    relativePaths: [],
    conversationId: undefined,
    connectedAtMs: NOW,
    explicitConnection: true,
  };
}

function overlapLines(
  start: number,
  end: number,
  bridge: boolean,
  lexicalBlock: boolean,
): readonly string[] {
  const lines = Array.from({ length: 220 }, (_unused, index) => `// filler ${String(index + 1)}`);
  for (let line = start; line <= end; line += 1)
    lines[line - 1] = `// overlap coverage physical fact ${String(line)}`;
  lines[19] = "// overlap unrelated bookkeeping";
  lines[99] = bridge
    ? "export function registeredHandler() { return nextHandler(); }"
    : "export function registeredHandler() { return true; }";
  if (bridge) lines[149] = "function nextHandler() { return true; }";
  if (lexicalBlock) {
    for (let line = start; line <= end; line += 1) lines[line - 1] = "  // padding";
    lines[start - 1] = "function unrelatedLexicalBody() {";
    lines[start + 4] = `  const observed = "overlap coverage physical fact ${String(start + 5)}";`;
    lines[end - 1] = "}";
  }
  return lines;
}

async function overlapFixture(
  start: number,
  end: number,
  bridge = false,
  lexicalBlock = false,
): Promise<OverlapFixture> {
  const scope = overlapScope();
  const lines = overlapLines(start, end, bridge, lexicalBlock);
  const fs = memFs(scope.workspace.root, {
    "src/routes.ts":
      'import { registeredHandler } from "./implementation.js";\nrouter.post("/api/items", registeredHandler);',
    [PATH]: lines.join("\n"),
  });
  const requestContext = createStructuralAdapterRequestContext(
    scope,
    GROUNDED_TRACE_SEARCH_LIMITS,
    fs,
    { nowMs: () => NOW },
  );
  const query = overlapQuery("Trace POST /api/items through overlap coverage");
  const routes = await requestContext.searchText(query, GROUNDED_TRACE_SEARCH_LIMITS);
  const trace = await collectDiscoveredSymbolTraceEvidence({
    scope: selectedScope(scope),
    query,
    anchors: [],
    retrievalIntent: "targeted-code-search",
    searchScope: scope,
    fs,
    nowMs: () => NOW,
    atoms: routes.atoms,
    requestContext,
  });
  const lexical = await searchText(
    scope,
    overlapQuery("overlap coverage"),
    {
      ...GROUNDED_TRACE_SEARCH_LIMITS,
      maxMatchesReturned: query.maxResults,
    },
    { fs, nowMs: () => NOW },
  );
  return {
    fs,
    scope,
    lines,
    atoms: [...trace.atoms, ...lexical.atoms].filter((atom) => atom.scopePath === PATH),
  };
}

async function readOverlap(
  fixture: OverlapFixture,
  maxBytes = 100_000,
): Promise<ExcerptReadSummary> {
  return _readKeptExcerptsForTests([PATH], {
    searchScope: fixture.scope,
    fs: fixture.fs,
    budget: { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: maxBytes },
    initialUsage: {
      searchCalls: 0,
      filesRead: 0,
      excerptBytes: 0,
      modelInputTokens: 0,
      modelOutputTokens: 0,
      elapsedMs: 0,
      rerankCalls: 0,
    },
    atomsByPath: new Map([[PATH, fixture.atoms]]),
    nowMs: () => NOW,
    deadlineAtMs: Number.POSITIVE_INFINITY,
  });
}

function readContent(result: ExcerptReadSummary): string {
  return (result.excerpts.get(PATH) ?? []).map((excerpt) => excerpt.content).join("\n");
}

function expectPhysicalFacts(
  result: ExcerptReadSummary,
  lines: readonly string[],
  facts: readonly number[],
): void {
  for (const line of facts) expect(readContent(result)).toContain(lines[line - 1]);
  expect(result.observation?.omittedRangeCount).toBe(0);
  expect(result.observation?.truncatedWindowCount).toBe(0);
  const ranges = (result.excerpts.get(PATH) ?? []).map((excerpt) => ({
    startLine: excerpt.startLine,
    endLine: excerpt.endLine,
  }));
  expect(
    ranges.every((range, index) =>
      ranges.every(
        (other, otherIndex) =>
          index === otherIndex ||
          range.endLine < other.startLine ||
          other.endLine < range.startLine,
      ),
    ),
  ).toBe(true);
}

describe("owning excerpt reader preserves partially covered lexical evidence", () => {
  it("preserves the actual path:line selection and its uncovered lexical tail in public retrieval", async () => {
    const fixture = await overlapFixture(120, 145);
    const activityLog = createBufferedServerLogSink();
    const result = await retrieveConnectedContextPack(
      {
        scope: selectedScope(fixture.scope),
        query: overlapQuery("Inspect src/implementation.ts:100 and overlap coverage"),
        workspaceRoot: fixture.scope.workspace.root,
        budget: { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 100_000 },
      },
      {
        correlationId: undefined,
        answerer: { answer: () => Promise.resolve("observed source") },
        detectWorkspace: () => fixture.scope.workspace,
        nowMs: () => NOW,
        fs: fixture.fs,
        activityLog,
      },
    );
    const excerpts = result.pack.files.find((file) => file.scopePath === PATH)?.excerpts ?? [];
    const content = excerpts.map((excerpt) => excerpt.content).join("\n");
    expect(content).toContain(fixture.lines[99]);
    expect(content).toContain(fixture.lines[124]);
    expect(content).toContain(fixture.lines[144]);
    expect(
      activityLog.events.find((event) => event.op === "search.connected-context.source-details")
        ?.extra?.explicitPathAdmittedCount,
    ).toBe(1);
    expect(excerpts.some((excerpt) => excerpt.atom.provenance.tool === "repo.selectedFile")).toBe(
      true,
    );
  });

  it.each([
    { shape: "tail", start: 120, end: 145, facts: [125, 145], bridge: false },
    { shape: "head", start: 80, end: 105, facts: [80, 99], bridge: false },
    { shape: "bridge", start: 85, end: 180, facts: [85, 99, 125, 149, 175, 180], bridge: true },
    { shape: "contained", start: 105, end: 115, facts: [105, 115], bridge: false },
    { shape: "disjoint", start: 140, end: 155, facts: [140, 155], bridge: false },
  ])(
    "retains every uncovered $shape fact within an ample unchanged grant",
    async ({ start, end, facts, bridge }) => {
      const fixture = await overlapFixture(start, end, bridge);
      expect(
        fixture.atoms.some((atom) => atom.provenance.tool === "discovered-symbol-definition"),
      ).toBe(true);
      expect(fixture.atoms.some((atom) => atom.provenance.tool === "repo.searchText")).toBe(true);
      expectPhysicalFacts(await readOverlap(fixture), fixture.lines, facts);
    },
  );

  it("retains the anchor before the remainder and the remainder's original lexical strength under a tight grant", async () => {
    const fixture = await overlapFixture(120, 145);
    const anchor = await readOverlap({
      ...fixture,
      atoms: fixture.atoms.filter(
        (atom) => atom.provenance.tool === "discovered-symbol-definition",
      ),
    });
    const remainingFact = fixture.lines[124] ?? "";
    const result = await readOverlap(
      fixture,
      Buffer.byteLength(readContent(anchor)) + Buffer.byteLength(remainingFact) + 1,
    );
    expect(readContent(result)).toContain(fixture.lines[99]);
    expect(readContent(result)).toContain(remainingFact);
    expect(readContent(result)).not.toContain(fixture.lines[19]);
    expect(
      (result.observation?.omittedRangeCount ?? 0) +
        (result.observation?.truncatedWindowCount ?? 0),
    ).toBeGreaterThan(0);
  });

  it("keeps a split real lexical block's strength without moving it ahead of its definition anchor", async () => {
    const fixture = await overlapFixture(120, 145, false, true);
    const block = fixture.atoms.find(
      (atom) =>
        atom.provenance.tool === "repo.searchText" &&
        atom.lineRange?.startLine === 120 &&
        atom.lineRange.endLine === 145,
    );
    const decoy = fixture.atoms.find(
      (atom) => atom.provenance.tool === "repo.searchText" && atom.lineRange?.startLine === 20,
    );
    expect(block).toBeDefined();
    expect(block?.score ?? 0).toBeGreaterThan(decoy?.score ?? 0);
    const anchor = await readOverlap({
      ...fixture,
      atoms: fixture.atoms.filter(
        (atom) => atom.provenance.tool === "discovered-symbol-definition",
      ),
    });
    const remainingFact = fixture.lines[124] ?? "";
    const result = await readOverlap(
      fixture,
      Buffer.byteLength(readContent(anchor)) + Buffer.byteLength(remainingFact) + 1,
    );
    expect(readContent(result)).toContain(fixture.lines[99]);
    expect(readContent(result)).toContain(remainingFact);
    expect(readContent(result)).not.toContain(fixture.lines[19]);
  });
});
