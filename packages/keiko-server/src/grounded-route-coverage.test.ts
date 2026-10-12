import * as documentLane from "./grounded-document-evidence.js";
import { describe, expect, it, vi } from "vitest";
import * as workspace from "@oscharko-dev/keiko-workspace";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
  validateConnectedContextPack,
  type ConnectedContextPack,
  type EvidenceAtom,
  type ExplorationUsage,
  type RetrievalQuery,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { assembleContextPack, rankCandidates } from "@oscharko-dev/keiko-workflows";
import {
  readExcerpt,
  type ReadExcerptRequest,
  type SearchScope,
  type WorkspaceFs,
} from "@oscharko-dev/keiko-workspace";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import { endpointContractAdapter } from "@oscharko-dev/keiko-workspace";
import { createStructuralAdapterRequestContext } from "@oscharko-dev/keiko-workspace/code-intelligence";
import {
  _readKeptExcerptsForTests,
  retrieveConnectedContextPack,
  type ExcerptInputs,
  type ExcerptReadSummary,
} from "./grounded-orchestrator.js";
import { selectGroundedCandidateFiles } from "./grounded-evidence-selection.js";
import { buildGroundedGatewayMessages } from "./grounded-qa.js";
import { remainingTurnBudget } from "./grounded-follow-up.js";
import {
  collectDiscoveredSymbolTraceEvidence,
  GROUNDED_TRACE_SEARCH_LIMITS,
} from "./grounded-symbol-trace.js";

const NOW = 1_700_000_000_000;
const CONNECTOR_FACT = "return continueProcessing(selectedRoot);";
const DESCENT_FACT = "for (const child of directoryEntries(root)) visitChild(child);";
const USAGE: ExplorationUsage = {
  searchCalls: 0,
  filesRead: 0,
  excerptBytes: 0,
  modelInputTokens: 0,
  modelOutputTokens: 0,
  elapsedMs: 0,
  rerankCalls: 0,
};

interface CoverageFixture {
  readonly fs: WorkspaceFs;
  readonly searchScope: SearchScope;
  readonly scope: SelectedScope;
  readonly query: RetrievalQuery;
  readonly ordinaryAtoms: readonly EvidenceAtom[];
  readonly requestContext: ReturnType<typeof createStructuralAdapterRequestContext>;
  readonly trace: Awaited<ReturnType<typeof collectDiscoveredSymbolTraceEvidence>>;
  readonly files: Record<string, string>;
  readonly reads: Map<string, number>;
  readonly checks: { stat: number; realPath: number };
}

interface CoverageReadOptions {
  readonly paths?: readonly string[] | undefined;
  readonly atoms?: readonly EvidenceAtom[];
  readonly inputs?: Partial<ExcerptInputs>;
}

function coverageSearchScope(): SearchScope {
  return {
    workspace: {
      root: "/workspace",
      selectedRoot: "/workspace",
      name: "route-coverage",
      version: "1.0.0",
      testFramework: "vitest",
      sourceDirs: ["src"],
      testDirs: [],
      languages: ["typescript"],
      ignoreLines: [],
    },
    scopeId: "route-coverage",
    relativePaths: [],
  };
}

function coverageScope(searchScope: SearchScope): SelectedScope {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    scopeId: searchScope.scopeId,
    workspaceRoot: searchScope.workspace.root,
    kind: "workspace-root",
    relativePaths: [],
    conversationId: undefined,
    connectedAtMs: NOW,
    explicitConnection: true,
  };
}

function bookkeepingBody(index: number): string {
  return [
    `export function bookkeeping${String(index)}() {`,
    ...Array.from(
      { length: 20 },
      () => "  // Scope admission recursive candidate discovery prompt fitting bookkeeping.",
    ),
    "  return false;",
    "}",
  ].join("\n");
}

function coverageFiles(): Readonly<Record<string, string>> {
  const helpers = Array.from({ length: 9 }, (_unused, index) => bookkeepingBody(index));
  return {
    "src/routes.ts":
      'import { handleItem } from "./implementation.js";\nrouter.post("/api/items", handleItem);',
    "src/implementation.ts": [
      'import { continueProcessing } from "./z-processing.js";',
      ...helpers.map(
        (_unused, index) =>
          `import { bookkeeping${String(index)} as externalBookkeeping${String(index)} } from "./helper-${String(index)}.js";`,
      ),
      "export function handleItem() { return () => processItem(); }",
      "function processItem() {",
      ...helpers.map((_unused, index) => `  bookkeeping${String(index)}();`),
      ...helpers.map((_unused, index) => `  externalBookkeeping${String(index)}();`),
      "  return connector();",
      "}",
      ...helpers,
      ...Array.from({ length: 30 }, () => "// separation"),
      `function connector() { ${CONNECTOR_FACT} }`,
    ].join("\n"),
    "src/z-processing.ts": [
      "export function continueProcessing(root) {",
      `  ${DESCENT_FACT}`,
      "  return root;",
      "}",
    ].join("\n"),
    ...Object.fromEntries(helpers.map((body, index) => [`src/helper-${String(index)}.ts`, body])),
  };
}

function observedCoverageFs(
  root: string,
  files: Record<string, string>,
  reads: Map<string, number>,
  checks: { stat: number; realPath: number },
): WorkspaceFs {
  const base = memFs(root, files);
  const read = base.readFileBytes;
  if (read === undefined) throw new TypeError("fixture requires bounded byte reads");
  return {
    ...base,
    readFileBytes: (...args): ReturnType<typeof read> => {
      const path = args[0];
      reads.set(path, (reads.get(path) ?? 0) + 1);
      return read(...args);
    },
    stat: (...args): ReturnType<WorkspaceFs["stat"]> => {
      checks.stat += 1;
      return base.stat(...args);
    },
    realPath: (...args): string => {
      checks.realPath += 1;
      return base.realPath(...args);
    },
  };
}

async function coverageFixture(
  text = "Trace POST /api/items through scope admission recursive candidate discovery and prompt fitting",
  source: Readonly<Record<string, string>> = coverageFiles(),
): Promise<CoverageFixture> {
  const searchScope = coverageSearchScope();
  const scope = coverageScope(searchScope);
  const files = { ...source };
  const reads = new Map<string, number>();
  const checks = { stat: 0, realPath: 0 };
  const fs = observedCoverageFs(searchScope.workspace.root, files, reads, checks);
  const query: RetrievalQuery = {
    kind: "natural-language",
    text,
    caseSensitive: false,
    maxResults: 500,
    emittedAtMs: NOW,
  };
  const requestContext = createStructuralAdapterRequestContext(
    searchScope,
    GROUNDED_TRACE_SEARCH_LIMITS,
    fs,
    { nowMs: () => NOW },
  );
  const routes = await requestContext.searchText(query, GROUNDED_TRACE_SEARCH_LIMITS);
  const trace = await collectDiscoveredSymbolTraceEvidence({
    scope,
    query,
    anchors: [],
    retrievalIntent: "targeted-code-search",
    searchScope,
    fs,
    nowMs: () => NOW,
    atoms: routes.atoms,
    requestContext,
  });
  reads.clear();
  checks.stat = 0;
  checks.realPath = 0;
  return {
    fs,
    searchScope,
    scope,
    query,
    trace,
    files,
    reads,
    checks,
    ordinaryAtoms: routes.atoms,
    requestContext,
  };
}

function coverageRanking(atoms: readonly EvidenceAtom[]): ReturnType<typeof rankCandidates> {
  const ranking = rankCandidates({
    atoms,
    anchors: [],
    context: { retrievalIntent: "targeted-code-search" },
  });
  const priorityPaths = endpointPriorityPaths(atoms);
  if (priorityPaths.size === 0) return ranking;
  return {
    ...ranking,
    ...selectGroundedCandidateFiles({
      ...ranking,
      priorityPaths,
      scopeKind: "workspace-root",
      filesReadMax: null,
      nowMs: NOW,
    }),
  };
}

function endpointPriorityPaths(atoms: readonly EvidenceAtom[]): ReadonlySet<string> {
  return new Set(
    atoms
      .filter((atom) => atom.provenance.tool === "endpoint-contract-server-route")
      .map((atom) => atom.scopePath),
  );
}

function atomsByPath(atoms: readonly EvidenceAtom[]): ReadonlyMap<string, readonly EvidenceAtom[]> {
  const grouped = new Map<string, EvidenceAtom[]>();
  for (const atom of atoms) {
    const existing = grouped.get(atom.scopePath) ?? [];
    existing.push(atom);
    grouped.set(atom.scopePath, existing);
  }
  return grouped;
}

async function coverageRead(
  fixture: CoverageFixture,
  options: CoverageReadOptions = {},
): Promise<ExcerptReadSummary> {
  const atoms = options.atoms ?? fixture.trace.atoms;
  const ranking = coverageRanking(atoms);
  return _readKeptExcerptsForTests(
    options.paths ?? ranking.kept.map((candidate) => candidate.scopePath),
    {
      searchScope: fixture.searchScope,
      fs: fixture.fs,
      budget: { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 8192 },
      initialUsage: USAGE,
      atomsByPath: atomsByPath(atoms),
      priorityPaths: endpointPriorityPaths(atoms),
      nowMs: () => NOW,
      deadlineAtMs: Infinity,
      ...fixture.trace,
      ...options.inputs,
    },
  );
}

async function observedCoverageRead(
  fixture: CoverageFixture,
  options: CoverageReadOptions = {},
): Promise<{
  readonly reads: ExcerptReadSummary;
  readonly requests: readonly ReadExcerptRequest[];
}> {
  const requests: ReadExcerptRequest[] = [];
  const native = workspace.readExcerpt;
  const observer = vi.spyOn(workspace, "readExcerpt").mockImplementation((...args) => {
    requests.push(args[1]);
    return native(...args);
  });
  try {
    return { reads: await coverageRead(fixture, options), requests };
  } finally {
    observer.mockRestore();
  }
}

function expectTargetCoverageFunding(
  fixture: CoverageFixture,
  requests: readonly ReadExcerptRequest[],
  scopePath: string,
  funded: boolean,
): void {
  const target = fixture.trace.routeCoverage?.entries.find(
    (entry) => entry.atom.scopePath === scopePath,
  );
  const range = target?.atom.lineRange;
  if (range === undefined)
    throw new TypeError("fixture requires the actual target declaration range");
  const targetRequests = requests.filter((request) => request.scopePath === scopePath);
  expect(targetRequests.length).toBeGreaterThan(0);
  if (funded) {
    expect(
      targetRequests.some((request) =>
        request.ranges?.some(
          (window) => window.startLine === range.startLine && window.endLine === range.endLine,
        ),
      ),
    ).toBe(true);
    return;
  }
  expect(targetRequests.every((request) => (request.ranges?.length ?? 0) === 0)).toBe(true);
  expect(targetRequests.every((request) => request.rangeQueues?.length === 1)).toBe(true);
}

function readContent(reads: ExcerptReadSummary, path: string): string {
  return (reads.excerpts.get(path) ?? []).map((window) => window.content).join("\n");
}

function readBytes(reads: ExcerptReadSummary): number {
  return [...reads.excerpts.values()]
    .flatMap((windows) => windows)
    .reduce((bytes, window) => bytes + Buffer.byteLength(window.content), 0);
}

function actualPublicRetrieval(
  fixture: CoverageFixture,
  budget = { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 8192 },
  activityLog = createBufferedServerLogSink(),
): ReturnType<typeof retrieveConnectedContextPack> {
  return retrieveConnectedContextPack(
    {
      scope: fixture.scope,
      query: fixture.query,
      workspaceRoot: fixture.searchScope.workspace.root,
      budget,
    },
    {
      correlationId: undefined,
      fs: fixture.fs,
      nowMs: () => NOW,
      detectWorkspace: () => fixture.searchScope.workspace,
      answerer: { answer: () => Promise.resolve("observed source") },
      activityLog,
    },
  );
}

function invalidatingExpansionRead(fixture: CoverageFixture): {
  readonly bytes: Map<string, number>;
  readonly invalidatedPath: () => string | undefined;
  readonly restore: () => void;
} {
  const nativeRead = workspace.readExcerpt;
  const bytes = new Map<string, number>();
  let invalidated: string | undefined;
  const spy = vi.spyOn(workspace, "readExcerpt").mockImplementation(async (...args) => {
    const path = args[1].scopePath;
    if (
      invalidated === undefined &&
      args[1].expectedSourceFingerprint !== undefined &&
      (bytes.get(path) ?? 0) > 0
    ) {
      invalidated = path;
      fixture.files[path] = "// replacement source after the initial guarded read";
    }
    const result = await nativeRead(...args);
    if (args[1].rangeQueues === undefined) return result;
    const consumed = (result.windows ?? [result]).reduce(
      (total, window) => total + Buffer.byteLength(window.content),
      0,
    );
    bytes.set(path, (bytes.get(path) ?? 0) + consumed);
    return result;
  });
  return { bytes, invalidatedPath: () => invalidated, restore: () => spy.mockRestore() };
}

function remainingPublicReadGrant(
  fixture: CoverageFixture,
  result: Awaited<ReturnType<typeof retrieveConnectedContextPack>>,
): ReturnType<typeof remainingTurnBudget> {
  const initial = {
    content: "No synthesis was requested",
    usage: { promptTokens: 0, completionTokens: 0 },
  };
  return remainingTurnBudget({
    input: {
      scope: fixture.scope,
      query: fixture.query,
      workspaceRoot: fixture.searchScope.workspace.root,
    },
    deps: {},
    pack: result.pack,
    initial,
    nowMs: () => NOW,
    deadlineAtMs: Infinity,
    retrieve: () => Promise.resolve(result),
    answer: () => Promise.resolve(initial),
  });
}

async function actualExplicitAtoms(fixture: CoverageFixture): Promise<readonly EvidenceAtom[]> {
  const result = await actualPublicRetrieval(fixture);
  return result.pack.files.flatMap((file) =>
    file.excerpts
      .map((excerpt) => excerpt.atom)
      .filter((atom) => atom.provenance.tool === "repo.selectedFile"),
  );
}

async function assembledCoveragePack(
  fixture: CoverageFixture,
  reads: ExcerptReadSummary,
  atoms: readonly EvidenceAtom[] = fixture.trace.atoms,
  budget = { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 8192 },
): Promise<ConnectedContextPack> {
  const { pack } = await assembleContextPack(
    {
      scope: fixture.scope,
      query: fixture.query,
      budget,
      atoms,
      ranked: coverageRanking(atoms).kept,
      omittedFromRanking: [],
      excerpts: reads.excerpts,
      initialUncertainty: [...fixture.trace.uncertainty, ...reads.uncertainty],
    },
    { nowMs: () => NOW, includeSurroundingContext: true },
  );
  expect(pack.usage.excerptBytes).toBeLessThanOrEqual(pack.budget.excerptBytesMax);
  return pack;
}

async function sentPrompt(
  fixture: CoverageFixture,
  reads: ExcerptReadSummary,
  atoms: readonly EvidenceAtom[] = fixture.trace.atoms,
  budget = { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 8192 },
): Promise<string> {
  const pack = await assembledCoveragePack(fixture, reads, atoms, budget);
  return buildGroundedGatewayMessages(fixture.query.text, pack, (value) => value)
    .map((message) => message.content)
    .join("\n");
}

function sameFileCoverageFiles(): Readonly<Record<string, string>> {
  const source = { ...coverageFiles() };
  const continuation = source["src/z-processing.ts"] ?? "";
  source["src/implementation.ts"] =
    (source["src/implementation.ts"] ?? "")
      .replace('import { continueProcessing } from "./z-processing.js";\n', "")
      .replace(
        "export function handleItem() { return () => processItem(); }",
        "export function handleItem() { return processItem(); }",
      ) +
    "\n" +
    continuation;
  delete source["src/z-processing.ts"];
  return source;
}

const REGISTRATION_FACT =
  'const routes = [{ method: "POST", path: "/api/items", handler: handleItem }];';

function configuredCoverageFiles(): Readonly<Record<string, string>> {
  return {
    ...coverageFiles(),
    "src/routes.ts": ['import { handleItem } from "./implementation.js";', REGISTRATION_FACT].join(
      "\n",
    ),
  };
}
const FITTING_FACT =
  "return promptFittingBudget > scopeAdmissionBudget ? scopeAdmissionBudget : promptFittingBudget;";

function allocationFiles(): Readonly<Record<string, string>> {
  const source = { ...configuredCoverageFiles() };
  const original = source["src/implementation.ts"] ?? "";
  source["src/implementation.ts"] =
    original.replace(
      "  return connector();",
      "  promptFittingBudgetAndScopeAdmission();\n  return connector();",
    ) +
    "\n" +
    Array.from({ length: 30 }, () => "// separation").join("\n") +
    [
      "\nfunction promptFittingBudgetAndScopeAdmission() {",
      "  const promptFittingBudget = 4096;",
      "  const scopeAdmissionBudget = 2048;",
      `  ${FITTING_FACT}`,
      "}",
    ].join("\n");
  for (const [path, content] of Object.entries(source))
    source[path] = content.replaceAll(
      "Scope admission recursive candidate discovery prompt fitting bookkeeping.",
      "unrelated accounting detail.",
    );
  return source;
}

function disconnectedDefinitionFiles(): Readonly<Record<string, string>> {
  return {
    "src/routes.ts": [
      'import { handleItem } from "./implementation.js";',
      REGISTRATION_FACT,
      ...Array.from(
        { length: 100 },
        () => "// Scope admission recursive candidate discovery prompt fitting bookkeeping.",
      ),
    ].join("\n"),
    "src/implementation.ts": [
      'import { finalizeRecord } from "./z-handler.js";',
      "export function handleItem(value) { return finalizeRecord(value); }",
    ].join("\n"),
    "src/z-handler.ts": [
      "export function finalizeRecord(value) {",
      "  const normalized = String(value);",
      "  return normalized.trim();",
      "}",
    ].join("\n"),
  };
}

async function allocationAtoms(fixture: CoverageFixture): Promise<readonly EvidenceAtom[]> {
  const endpoints = await endpointContractAdapter.lookup(
    fixture.searchScope,
    fixture.query,
    GROUNDED_TRACE_SEARCH_LIMITS,
    fixture.fs,
    { requestContext: fixture.requestContext, nowMs: () => NOW },
  );
  expect(endpoints.some((atom) => atom.scopePath === "src/routes.ts")).toBe(true);
  return [...fixture.ordinaryAtoms, ...endpoints, ...fixture.trace.atoms];
}

const TERMINAL_FACT = "return recursiveCandidateDiscovery(selectedRoot);";
const SECOND_TERMINAL_FACT = "return promptFitting(selectedRoot);";

function branchCoverageFiles(): Readonly<Record<string, string>> {
  const source = { ...configuredCoverageFiles() };
  for (let index = 0; index < 9; index += 1) {
    const original = bookkeepingBody(index);
    const crowded = original.replace(
      "  return false;",
      Array.from(
        { length: 30 },
        () => "  // Scope admission recursive candidate discovery prompt fitting bookkeeping.",
      ).join("\n") + "\n  return false;",
    );
    for (const [path, content] of Object.entries(source))
      source[path] = content.replace(original, crowded);
  }
  source["src/implementation.ts"] =
    (source["src/implementation.ts"] ?? "").replace(
      "  return connector();",
      "  return beginTraversal();",
    ) +
    [
      "",
      "function beginTraversal() { return stageOne(); }",
      "function stageOne() { return stageTwo(); }",
      "function stageTwo() { return selectedTraversal(); }",
      `function selectedTraversal() { ${TERMINAL_FACT} }`,
      "function recursiveCandidateDiscovery(selectedRoot) {",
      `  ${DESCENT_FACT}`,
      "  return selectedRoot;",
      "}",
      `function latePromptFitting() { ${SECOND_TERMINAL_FACT} }`,
      "function promptFitting(selectedRoot) { return selectedRoot; }",
    ].join("\n");
  return source;
}

function repeatedFileCoverageFiles(): Readonly<Record<string, string>> {
  const files = { ...configuredCoverageFiles() };
  let implementation = files["src/implementation.ts"] ?? "";
  for (let index = 0; index < 9; index += 1) {
    delete files[`src/helper-${String(index)}.ts`];
    implementation = implementation
      .replace(
        `import { bookkeeping${String(index)} as externalBookkeeping${String(index)} } from "./helper-${String(index)}.js";`,
        "",
      )
      .replace(`  externalBookkeeping${String(index)}();`, "")
      .replace(
        bookkeepingBody(index),
        bookkeepingBody(index).replace(
          "  return false;",
          [
            "  // Scope admission recursive candidate discovery prompt fitting bookkeeping.",
            "  // Scope admission recursive candidate discovery prompt fitting bookkeeping.",
            "  // Scope admission recursive candidate discovery prompt fitting bookkeeping.",
            "  return false;",
          ].join("\n"),
        ),
      );
  }
  files["src/implementation.ts"] = implementation;
  return files;
}

function finiteOwnedContinuationFiles(): Readonly<Record<string, string>> {
  const files = { ...sharedPrefixCoverageFiles() };
  files["src/implementation.ts"] = [
    'import { collectInventory } from "./inventory-scan.js";',
    (files["src/implementation.ts"] ?? "").replace(
      "  return continueProcessing(value);",
      "  const inventory = collectInventory(value);\n  return continueProcessing(inventory);",
    ),
  ].join("\n");
  files["src/inventory-scan.ts"] = [
    'import { discoverEntries } from "./inventory-walk.js";',
    "export function collectInventory(root) {",
    ...Array.from({ length: 8 }, () => "  // Keep the complete selected inventory source body."),
    "  const inventory = discoverEntries(root);",
    "  return inventory;",
    "}",
  ].join("\n");
  files["src/inventory-walk.ts"] = finiteInventoryWalkSource();
  return files;
}

function fundedHeadContinuationFiles(): Readonly<Record<string, string>> {
  const files = { ...finiteOwnedContinuationFiles() };
  const scan = (files["src/inventory-scan.ts"] ?? "").replace(
    "  const inventory = discoverEntries(root);",
    "  const scopeAdmissionBudget = 1024;\n  const inventory = discoverEntries(root);",
  );
  files["src/implementation.ts"] = [
    'import { discoverEntries } from "./inventory-walk.js";',
    (files["src/implementation.ts"] ?? "").replace(
      'import { collectInventory } from "./inventory-scan.js";\n',
      "",
    ),
    ...Array.from({ length: 30 }, () => "// Separate the current owned source declarations."),
    scan.replace('import { discoverEntries } from "./inventory-walk.js";\n', ""),
  ].join("\n");
  delete files["src/inventory-scan.ts"];
  for (let index = 0; index < 9; index += 1)
    files[`src/record-${String(index)}.ts`] = (
      files[`src/record-${String(index)}.ts`] ?? ""
    ).replace(
      "  return value;",
      "  const scopeAdmissionBudget = 1024;\n  return scopeAdmissionBudget + value;",
    );
  return files;
}

function finiteInventoryWalkSource(): string {
  const separation = Array.from({ length: 24 }, () => "// Separate selected declarations.");
  const detail = Array.from(
    { length: 8 },
    () => "  // Keep the actual directory inventory detail.",
  );
  return [
    "export function discoverEntries(root) {",
    ...detail,
    "  const inventory = [];",
    "  descend(root, inventory);",
    "  return inventory;",
    "}",
    ...separation,
    "function descend(root, inventory) {",
    ...detail,
    "  const children = directoryEntries(root);",
    "  for (const child of children) handleEntry(child, inventory);",
    "  return inventory;",
    "}",
    ...separation,
    "function handleEntry(entry, inventory) {",
    ...detail,
    "  inventory.push(entry);",
    "  if (entry.directory) descend(entry, inventory);",
    "  return inventory;",
    "}",
  ].join("\n");
}

type FiniteOwnedContinuationEntry = NonNullable<
  CoverageFixture["trace"]["routeCoverage"]
>["entries"][number];

type FiniteOwnedContinuationIndex = Awaited<
  ReturnType<CoverageFixture["requestContext"]["codeIntelligenceIndex"]>
>;

interface FiniteOwnedContinuationView {
  readonly entry: FiniteOwnedContinuationEntry;
  readonly range: NonNullable<EvidenceAtom["lineRange"]>;
  readonly lines: readonly string[];
  readonly body: string;
}

function finiteOwnedContinuationEntry(
  fixture: CoverageFixture,
  entries: readonly FiniteOwnedContinuationEntry[],
  index: FiniteOwnedContinuationIndex,
  name: string,
): FiniteOwnedContinuationEntry {
  const entry = entries.find((candidate) =>
    (
      fixture.files[candidate.atom.scopePath]?.split("\n")[
        (candidate.atom.lineRange?.startLine ?? 1) - 1
      ] ?? ""
    ).includes(`function ${name}(`),
  );
  if (entry === undefined) throw new TypeError("fixture requires the actual selected branch");
  const parent = entries.find((candidate) => candidate.definitionIdentity === entry.parentIdentity);
  if (parent === undefined) throw new TypeError("fixture requires the actual observed caller");
  const parentRange = parent.atom.lineRange;
  if (parentRange === undefined) throw new TypeError("fixture requires the complete parent span");
  const call = index.calls.find(
    (candidate) =>
      candidate.targetName === name &&
      candidate.targetPath === entry.atom.scopePath &&
      candidate.callerPath === parent.atom.scopePath &&
      candidate.callerDefinition?.lineRange.startLine === parentRange.startLine &&
      candidate.callerDefinition.lineRange.endLine === parentRange.endLine,
  );
  if (call === undefined) throw new TypeError("fixture requires the actual owned lexical call");
  expect(call.confidence).toBe("resolved");
  expect(call.binding).toBe("lexical");
  expect(call.callerSpan).toBeDefined();
  expect(call.resultUsage).toBeUndefined();
  expect(call.awaited).toBeUndefined();
  expect(entry.parentWitness?.parentIdentity).toBe(parent.definitionIdentity);
  expect(entry.parentWitness?.targetIdentity).toBe(entry.definitionIdentity);
  expect(entry.parentWitness?.callerSpan).toEqual(call.callerSpan);
  return entry;
}

function finiteOwnedContinuationViews(
  fixture: CoverageFixture,
  entries: readonly FiniteOwnedContinuationEntry[],
  prefix: readonly FiniteOwnedContinuationEntry[],
  branch: readonly FiniteOwnedContinuationEntry[],
): readonly FiniteOwnedContinuationView[] {
  expect(prefix).toHaveLength(6);
  expect(
    prefix.every((entry) => branch.every((child) => entry.atom.score > child.atom.score)),
  ).toBe(true);
  const caller = entries.find((entry) => entry.definitionIdentity === branch[0]?.parentIdentity);
  const later = entries.find((entry) => entry.atom.scopePath === "src/z-processing.ts");
  if (caller === undefined || later === undefined)
    throw new TypeError("fixture requires the actual common caller and usable later file");
  const watched = [caller, ...prefix, later, ...branch].map((entry) => {
    const range = entry.atom.lineRange;
    if (range === undefined) throw new TypeError("fixture requires complete declaration ranges");
    const lines = (fixture.files[entry.atom.scopePath] ?? "")
      .split("\n")
      .slice(range.startLine - 1, range.endLine);
    const body = lines.join("\n");
    expect(fixture.trace.routeCoverage?.isCurrent(entry.atom)).toBe(true);
    expect(entry.observedBytes).toBe(Buffer.byteLength(body));
    expect(entry.observedBytes).toBeLessThan(4096);
    return { entry, range, lines, body };
  });
  return watched;
}

function finiteOwnedContinuationMetadata(
  reads: ExcerptReadSummary,
  requests: readonly ReadExcerptRequest[],
  watched: readonly FiniteOwnedContinuationView[],
  restricted: readonly string[] | undefined,
): string {
  const metadata = JSON.stringify({
    restricted: restricted !== undefined,
    watched: watched.map(({ entry, range, body }) => ({
      path: entry.atom.scopePath,
      range,
      score: entry.atom.score,
      bytes: Buffer.byteLength(body),
      read: readContent(reads, entry.atom.scopePath).includes(body),
    })),
    requests: requests.map((request) => ({
      path: request.scopePath,
      funded: request.ranges,
      grant: request.maxTotalBytes,
    })),
  });
  return metadata;
}

function expectFiniteOwnedContinuationBody(
  reads: ExcerptReadSummary,
  pack: ConnectedContextPack,
  prompt: string,
  requests: readonly ReadExcerptRequest[],
  { entry, range, lines, body }: FiniteOwnedContinuationView,
  metadata: string,
): void {
  expect(readContent(reads, entry.atom.scopePath).includes(body), metadata).toBe(true);
  expect(
    pack.files
      .find((file) => file.scopePath === entry.atom.scopePath)
      ?.excerpts.some((view) => view.content.includes(body)),
    metadata,
  ).toBe(true);
  for (const [lineIndex, line] of lines.entries())
    expect(prompt, metadata).toContain(`${String(range.startLine + lineIndex)} | ${line}`);
  expect(
    requests.some(
      (request) =>
        request.scopePath === entry.atom.scopePath &&
        request.ranges?.some(
          (window) => window.startLine <= range.startLine && window.endLine >= range.endLine,
        ),
    ),
    metadata,
  ).toBe(true);
}

async function expectFiniteOwnedContinuationRead(
  fixture: CoverageFixture,
  atoms: readonly EvidenceAtom[],
  budget: typeof DEFAULT_EXPLORATION_BUDGET,
  watched: readonly FiniteOwnedContinuationView[],
  restricted: readonly string[] | undefined,
): Promise<void> {
  const { reads, requests } = await observedCoverageRead(fixture, {
    paths: restricted,
    atoms,
    inputs: { budget },
  });
  const pack = await assembledCoveragePack(fixture, reads, atoms, budget);
  const prompt = await sentPrompt(fixture, reads, atoms, budget);
  expect(readBytes(reads)).toBeLessThanOrEqual(budget.excerptBytesMax);
  expect(requests.every((request) => request.maxBytes <= 8192)).toBe(true);
  const metadata = finiteOwnedContinuationMetadata(reads, requests, watched, restricted);
  for (const view of watched)
    expectFiniteOwnedContinuationBody(reads, pack, prompt, requests, view, metadata);
}

function expectBorrowedHeadContinuationBody(
  reads: ExcerptReadSummary,
  pack: ConnectedContextPack,
  prompt: string,
  { entry, range, lines, body }: FiniteOwnedContinuationView,
  metadata: string,
): void {
  expect(readContent(reads, entry.atom.scopePath).includes(body), metadata).toBe(true);
  expect(
    pack.files
      .find((file) => file.scopePath === entry.atom.scopePath)
      ?.excerpts.some((view) => view.content.includes(body)),
    metadata,
  ).toBe(true);
  for (const [lineIndex, line] of lines.entries())
    expect(prompt, metadata).toContain(`${String(range.startLine + lineIndex)} | ${line}`);
}

async function expectBorrowedHeadContinuationRead(
  fixture: CoverageFixture,
  atoms: readonly EvidenceAtom[],
  budget: typeof DEFAULT_EXPLORATION_BUDGET,
  watched: readonly FiniteOwnedContinuationView[],
  requiredFunding: ReadonlySet<string>,
  restricted: readonly string[] | undefined,
): Promise<void> {
  const { reads, requests } = await observedCoverageRead(fixture, {
    paths: restricted,
    atoms,
    inputs: { budget },
  });
  const pack = await assembledCoveragePack(fixture, reads, atoms, budget);
  const prompt = await sentPrompt(fixture, reads, atoms, budget);
  expect(readBytes(reads)).toBeLessThanOrEqual(budget.excerptBytesMax);
  expect(requests.every((request) => request.maxBytes <= 8192)).toBe(true);
  const metadata = finiteOwnedContinuationMetadata(reads, requests, watched, restricted);
  for (const view of watched) {
    expectBorrowedHeadContinuationBody(reads, pack, prompt, view, metadata);
    if (requiredFunding.has(view.entry.definitionIdentity))
      expectFiniteOwnedContinuationBody(reads, pack, prompt, requests, view, metadata);
  }
}

async function expectPendingFairCompetingRead(
  fixture: CoverageFixture,
  atoms: readonly EvidenceAtom[],
  budget: typeof DEFAULT_EXPLORATION_BUDGET,
  watched: readonly FiniteOwnedContinuationView[],
  requiredFunding: ReadonlySet<string>,
  wholeConsumers: ReadonlySet<string>,
  restricted: readonly string[] | undefined,
): Promise<void> {
  const { reads, requests } = await observedCoverageRead(fixture, {
    paths: restricted,
    atoms,
    inputs: { budget },
  });
  const pack = await assembledCoveragePack(fixture, reads, atoms, budget);
  const prompt = await sentPrompt(fixture, reads, atoms, budget);
  expect(readBytes(reads)).toBeLessThanOrEqual(budget.excerptBytesMax);
  expect(requests.every((request) => request.maxBytes <= 8192)).toBe(true);
  const metadata = finiteOwnedContinuationMetadata(reads, requests, watched, restricted);
  const consumers =
    restricted === undefined
      ? watched.filter((view) => wholeConsumers.has(view.entry.definitionIdentity))
      : watched;
  for (const view of consumers) {
    expectBorrowedHeadContinuationBody(reads, pack, prompt, view, metadata);
    if (requiredFunding.has(view.entry.definitionIdentity))
      expectFiniteOwnedContinuationBody(reads, pack, prompt, requests, view, metadata);
  }
}

function returnedContinuationFiles(): Readonly<Record<string, string>> {
  const files = { ...configuredCoverageFiles() };
  files["src/implementation.ts"] = (files["src/implementation.ts"] ?? "").replace(
    'import { continueProcessing } from "./z-processing.js";',
    'import { stage8 as continueProcessing } from "./z-processing.js";',
  );
  files["src/z-processing.ts"] = [
    "export function stage8(root) {",
    ...Array.from({ length: 14 }, () => "  // Preserve the physical continuation source body."),
    `  ${DESCENT_FACT}`,
    "  return root;",
    "}",
  ].join("\n");
  return files;
}

function ordinaryCoverageFiles(): Readonly<Record<string, string>> {
  const files = { ...branchCoverageFiles() };
  const ordinaryFact = "return scopeAdmissionBudget + promptFittingBudget;";
  files["src/ordinary.ts"] = [
    "export class ScopeAdmission {",
    "  // Trace POST /api/items through scope admission recursive candidate discovery and prompt fitting",
    "  candidateSet() {",
    "    const scopeAdmissionBudget = 1024;",
    "    const promptFittingBudget = 2048;",
    `    ${ordinaryFact}`,
    "  }",
    "}",
  ].join("\n");
  for (const index of [7, 8]) {
    delete files[`src/helper-${String(index)}.ts`];
    files["src/implementation.ts"] = (files["src/implementation.ts"] ?? "")
      .replace(
        `import { bookkeeping${String(index)} as externalBookkeeping${String(index)} } from "./helper-${String(index)}.js";`,
        "",
      )
      .replace(`  externalBookkeeping${String(index)}();`, "");
  }
  return files;
}

function crossWaveCoverageFiles(): Readonly<Record<string, string>> {
  const files = { ...bulkyConnectorFiles() };
  for (let index = 0; index < 8; index += 1) {
    files[`src/stage-${String(index)}.ts`] = [
      `import { stage${String(index + 1)} } from "./stage-${String(index + 1)}.js";`,
      `export function stage${String(index)}(selectedRoot) {`,
      ...Array.from({ length: 65 }, () => "  // unrelated bookkeeping for the existing ledger"),
      `  return stage${String(index + 1)}(selectedRoot);`,
      "}",
    ].join("\n");
  }
  files["src/ordinary.ts"] = ordinaryCoverageFiles()["src/ordinary.ts"] ?? "";
  return files;
}

function sharedRelevanceFiles(): Readonly<Record<string, string>> {
  const files: Record<string, string> = {
    "src/routes.ts": ['import { handleItem } from "./implementation.js";', REGISTRATION_FACT].join(
      "\n",
    ),
  };
  files["src/implementation.ts"] = [
    ...Array.from(
      { length: 9 },
      (_value, index) =>
        `import { retainRecord${String(index)} } from "./record-${String(index)}.js";`,
    ),
    "export function handleItem(value) { return prepareRecord(value); }",
    "function prepareRecord(value) {",
    ...Array.from({ length: 9 }, (_value, index) => `  retainRecord${String(index)}(value);`),
    "  return scopeAdmissionAndPromptFitting(value);",
    "}",
    ...Array.from({ length: 35 }, () => "// separate the source declarations"),
    "function scopeAdmissionAndPromptFitting(value) {",
    "  const scopeAdmissionBudget = 1024;",
    "  const promptFittingBudget = 2048;",
    ...Array.from({ length: 24 }, () => "  // preserve the current selected terminal source body"),
    "  return scopeAdmissionBudget + promptFittingBudget + value;",
    "}",
  ].join("\n");
  for (let index = 0; index < 9; index += 1)
    files[`src/record-${String(index)}.ts`] = [
      `export function retainRecord${String(index)}(value) {`,
      ...Array.from(
        { length: 20 },
        () => "  // unrelated accounting detail for the existing ledger",
      ),
      "  return value;",
      "}",
    ].join("\n");
  return files;
}

function sharedPrefixCoverageFiles(): Readonly<Record<string, string>> {
  const files: Record<string, string> = {
    "src/routes.ts": ['import { handleItem } from "./implementation.js";', REGISTRATION_FACT].join(
      "\n",
    ),
    "src/z-processing.ts": [
      "export function continueProcessing(root) {",
      ...Array.from({ length: 24 }, () => "  // retain the current directory traversal detail"),
      `  ${DESCENT_FACT}`,
      "  return root;",
      "}",
    ].join("\n"),
  };
  const bodies = Array.from({ length: 6 }, (_value, index) =>
    [
      `function scopeAdmissionAndPromptFitting${String(index)}(value) {`,
      "  const scopeAdmissionBudget = 1024;",
      "  const promptFittingBudget = 2048;",
      ...Array.from(
        { length: 16 },
        () => "  // preserve the current selected prompt fitting source body",
      ),
      "  return scopeAdmissionBudget + promptFittingBudget + value;",
      "}",
    ].join("\n"),
  );
  files["src/implementation.ts"] = [
    'import { continueProcessing } from "./z-processing.js";',
    ...Array.from(
      { length: 9 },
      (_value, index) =>
        `import { retainRecord${String(index)} } from "./record-${String(index)}.js";`,
    ),
    "export function handleItem(value) { return prepareRecord(value); }",
    "function prepareRecord(value) {",
    ...Array.from({ length: 9 }, (_value, index) => `  retainRecord${String(index)}(value);`),
    ...Array.from(
      { length: 6 },
      (_value, index) => `  scopeAdmissionAndPromptFitting${String(index)}(value);`,
    ),
    "  return continueProcessing(value);",
    "}",
    ...bodies.flatMap((body) => [
      ...Array.from({ length: 30 }, () => "// separate the current callable declarations"),
      body,
    ]),
  ].join("\n");
  for (let index = 0; index < 9; index += 1)
    files[`src/record-${String(index)}.ts`] = [
      `export function retainRecord${String(index)}(value) {`,
      ...Array.from(
        { length: 30 },
        () => "  // unrelated accounting detail for the existing ledger",
      ),
      "  return value;",
      "}",
    ].join("\n");
  return files;
}

function delayedStrongFileCoverageFiles(): Readonly<Record<string, string>> {
  const files = { ...sharedPrefixCoverageFiles() };
  files["src/implementation.ts"] = (files["src/implementation.ts"] ?? "")
    .replace(
      'import { continueProcessing } from "./z-processing.js";',
      'import { continueProcessing } from "./z-processing.js";\nimport { admitScope } from "./scope-admission.js";',
    )
    .replace(
      "  return continueProcessing(value);",
      "  admitScope(value);\n  return continueProcessing(value);",
    );
  files["src/scope-admission.ts"] = [
    "export function admitScope(value) {",
    "  const scopeAdmissionBudget = 1024;",
    ...Array.from({ length: 48 }, () => "  // retain the complete selected scope admission body"),
    "  return scopeAdmissionBudget + value;",
    "}",
  ].join("\n");
  for (let index = 0; index < 80; index += 1)
    files[`src/ordinary-${String(index)}.ts`] = [
      "export class ScopeAdmissionPromptFitting {",
      "  // Trace POST /api/items through scope admission recursive candidate discovery and prompt fitting",
      "  // retain the admitted bounded candidate path",
      "  // preserve the selected source bytes",
      "  candidateSet() { return 1; }",
      "}",
    ].join("\n");
  return files;
}

function requirePendingBodyFixtureEntry<T>(entry: T | undefined, description: string): T {
  if (entry === undefined) throw new TypeError(`fixture requires ${description}`);
  return entry;
}

function pendingSameFileBodyCoverageFiles(): Readonly<Record<string, string>> {
  const files = { ...delayedStrongFileCoverageFiles() };
  const body = files["src/scope-admission.ts"] ?? "";
  files["src/implementation.ts"] = [
    (files["src/implementation.ts"] ?? "").replace(
      'import { admitScope } from "./scope-admission.js";\n',
      "",
    ),
    ...Array.from({ length: 30 }, () => "// separate the current callable declarations"),
    body,
  ].join("\n");
  delete files["src/scope-admission.ts"];
  for (let index = 0; index < 9; index += 1)
    files[`src/record-${String(index)}.ts`] = (
      files[`src/record-${String(index)}.ts`] ?? ""
    ).replace(
      "  return value;",
      "  const scopeAdmissionBudget = 1024;\n  return scopeAdmissionBudget + value;",
    );
  files["src/z-processing.ts"] = (files["src/z-processing.ts"] ?? "").replace(
    "  return root;",
    "  const scopeAdmissionBudget = 1024;\n  return scopeAdmissionBudget + root;",
  );
  return files;
}

function pendingFileRelevanceCoverageFiles(): Readonly<Record<string, string>> {
  const files = { ...delayedStrongFileCoverageFiles() };
  let caller = files["src/implementation.ts"] ?? "";
  const bodies = [...caller.matchAll(/function scopeAdmissionAndPromptFitting\d+\([\s\S]*?\n\}/gu)];
  for (const [index, match] of bodies.entries()) {
    const name = `scopeAdmissionAndPromptFitting${String(index)}`;
    const path = `src/useful-${String(Math.floor(index / 2))}.ts`;
    files[path] = [files[path], `export ${match[0]}`].filter(Boolean).join("\n");
    caller = `import { ${name} } from "./useful-${String(Math.floor(index / 2))}.js";\n${caller.replace(match[0], "")}`;
  }
  files["src/implementation.ts"] = caller;
  for (let index = 0; index < 9; index += 1)
    files[`src/record-${String(index)}.ts`] = [
      `export function retainRecord${String(index)}(value) {`,
      ...Array.from(
        { length: 48 },
        () => "  // unrelated accounting detail for the existing ledger",
      ),
      "  return value;",
      "}",
    ].join("\n");
  return files;
}

function canonicalCompetingCoverageFiles(): Readonly<Record<string, string>> {
  const files = { ...pendingFileRelevanceCoverageFiles() };
  for (let index = 0; index < 9; index += 1)
    files[`src/record-${String(index)}.ts`] = (
      files[`src/record-${String(index)}.ts`] ?? ""
    ).replace(
      "  return value;",
      "  const scopeAdmissionBudget = 1024;\n  return scopeAdmissionBudget + value;",
    );
  files["src/record-0.ts"] = [
    "export function retainRecord0(value) {",
    "  const scopeAdmissionBudget = 1024;",
    ...Array.from({ length: 16 }, () => "  // Retain the current ledger source detail."),
    "  const ledger = walkLedger(value);",
    "  return scopeAdmissionBudget + ledger;",
    "}",
    ...Array.from({ length: 24 }, () => "// Separate selected declarations."),
    "function walkLedger(value) {",
    "  const scopeAdmissionBudget = 1024;",
    ...Array.from(
      { length: 20 },
      () => "  // Retain the complete owned ledger continuation detail.",
    ),
    "  const result = finishLedger(value);",
    "  return scopeAdmissionBudget + result;",
    "}",
    ...Array.from({ length: 24 }, () => "// Separate selected declarations."),
    "function finishLedger(value) {",
    ...Array.from({ length: 16 }, () => "  // Retain the complete current ledger terminal detail."),
    "  return value;",
    "}",
  ].join("\n");
  return files;
}

function provisionalHeadPendingCoverageFiles(): Readonly<Record<string, string>> {
  const files = { ...canonicalCompetingCoverageFiles() };
  for (let number = 0; number < 3; number += 1) {
    const path = `src/useful-${String(number)}.ts`;
    files[path] = (files[path] ?? "")
      .replaceAll(
        Array.from(
          { length: 16 },
          () => "  // preserve the current selected prompt fitting source body",
        ).join("\n"),
        Array.from(
          { length: 8 },
          () => "  // preserve the current selected prompt fitting source body",
        ).join("\n"),
      )
      .replace(
        Array.from(
          { length: 8 },
          () => "  // preserve the current selected prompt fitting source body",
        ).join("\n"),
        Array.from(
          { length: 12 },
          () => "  // preserve the current selected prompt fitting source body",
        ).join("\n"),
      );
  }
  for (const path of ["src/implementation.ts", "src/scope-admission.ts"])
    files[path] = (files[path] ?? "").replaceAll(
      "admitScope",
      "scopeAdmissionAndPromptFittingTarget",
    );
  return files;
}

function pendingFairCompetingCoverageFiles(): Readonly<Record<string, string>> {
  const files = { ...canonicalCompetingCoverageFiles() };
  let caller = files["src/implementation.ts"] ?? "";
  const inline: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const path = `src/useful-${String(index)}.ts`;
    inline.push(
      (files[path] ?? "").replaceAll(
        Array.from(
          { length: 16 },
          () => "  // preserve the current selected prompt fitting source body",
        ).join("\n"),
        Array.from(
          { length: 8 },
          () => "  // preserve the current selected prompt fitting source body",
        ).join("\n"),
      ),
    );
    Reflect.deleteProperty(files, path);
  }
  caller = caller.replace(
    /^import \{ scopeAdmissionAndPromptFitting\d+ \} from "\.\/useful-\d+\.js";\n/gmu,
    "",
  );
  for (let index = 0; index < 3; index += 1) {
    const name = `scopeAdmissionAndPromptFittingQuota${String(index)}`;
    caller = `import { ${name} } from "./quota-${String(index)}.js";\n${caller}`;
    caller = caller.replace("  admitScope(value);", `  ${name}(value);\n  admitScope(value);`);
    files[`src/quota-${String(index)}.ts`] = [
      `export function ${name}(value) {`,
      `  const result = retainQuota${String(index)}(value);`,
      "  return result;",
      "}",
      ...Array.from({ length: 24 }, () => "// Separate selected declarations."),
      `function retainQuota${String(index)}(value) {`,
      "  const scopeAdmissionBudget = 1024;",
      "  const promptFittingBudget = 2048;",
      ...Array.from({ length: 24 }, () => "  // Retain the complete current accounting detail."),
      "  return scopeAdmissionBudget + promptFittingBudget + value;",
      "}",
    ].join("\n");
  }
  files["src/implementation.ts"] = [caller, ...inline].join("\n");
  files["src/record-0.ts"] = (files["src/record-0.ts"] ?? "").replaceAll(
    "  const scopeAdmissionBudget = 1024;",
    "  const scopeAdmissionBudget = 1024;\n  const promptFittingBudget = 2048;",
  );
  files["src/scope-admission.ts"] = (files["src/scope-admission.ts"] ?? "")
    .replace(
      "  const scopeAdmissionBudget = 1024;",
      "  const scopeAdmissionBudget = 1024;\n  const promptFittingBudget = 2048;",
    )
    .replace(
      Array.from(
        { length: 48 },
        () => "  // retain the complete selected scope admission body",
      ).join("\n"),
      Array.from(
        { length: 16 },
        () => "  // retain the complete selected scope admission body",
      ).join("\n"),
    );
  for (const [before, after] of [
    ["retainRecord0", "scopeAdmissionAndPromptFittingLedger"],
    ["walkLedger", "scopeAdmissionAndPromptFittingWalk"],
    ["admitScope", "scopeAdmissionAndPromptFittingTarget"],
  ] as const) {
    for (const path of ["src/implementation.ts", "src/record-0.ts", "src/scope-admission.ts"])
      files[path] = (files[path] ?? "").replaceAll(before, after);
  }
  return files;
}

function delayedFileHeadCoverageFiles(): Readonly<Record<string, string>> {
  const files = { ...delayedStrongFileCoverageFiles() };
  files["src/scope-admission.ts"] = [
    "export function admitScope(value) {",
    "  const scopeAdmissionBudget = 1024;",
    ...Array.from({ length: 32 }, () => "  // retain the complete selected scope admission body"),
    "  return continueEntry(scopeAdmissionBudget + value);",
    "}",
    ...Array.from({ length: 30 }, () => "// separate the current file declarations"),
    "function continueEntry(value) {",
    ...Array.from({ length: 16 }, () => "  // retain the complete returned entry body"),
    "  return value;",
    "}",
  ].join("\n");
  return files;
}

function crowdedInitialOpportunityFiles(): Readonly<Record<string, string>> {
  const files = { ...configuredCoverageFiles() };
  files["src/z-processing.ts"] = [
    "export function continueProcessing(root) {",
    ...Array.from(
      { length: 24 },
      () => "  // retain the selected current directory traversal source detail",
    ),
    `  ${DESCENT_FACT}`,
    "  return root;",
    "}",
  ].join("\n");
  return files;
}

function multiWindowCoverageFiles(): Readonly<Record<string, string>> {
  const padding =
    "  // Trace POST /api/items and explain scopeAdmissionBudget and promptFittingBudget";
  const body = (declaration: string, returned: string): string =>
    [declaration, ...Array.from({ length: 34 }, () => padding), returned, "}"].join("\n");
  const files: Record<string, string> = {
    "src/routes.ts": ['import { handleItem } from "./implementation.js";', REGISTRATION_FACT].join(
      "\n",
    ),
    "src/implementation.ts": [
      body("export function handleItem(value) {", "  return governRequest(value);"),
      ...Array.from({ length: 30 }, () => "// separate current callable declarations"),
      body("function governRequest(value) {", "  return inspectCandidates(value);"),
      ...Array.from({ length: 30 }, () => "// separate current callable declarations"),
      body("function inspectCandidates(value) {", "  return value;"),
    ].join("\n"),
  };
  for (let index = 0; index < 9; index += 1)
    files[`src/ordinary-${String(index)}.ts`] = [
      `export class OrdinaryEvidence${String(index)} {`,
      "  explain() {",
      ...Array.from({ length: 34 }, () => padding),
      "    return scopeAdmissionBudget + promptFittingBudget;",
      "  }",
      "}",
    ].join("\n");
  return files;
}

function deferredCrossWaveFiles(): Readonly<Record<string, string>> {
  const files = { ...crossWaveCoverageFiles() };
  files["src/ordinary.ts"] = (files["src/ordinary.ts"] ?? "").replace(
    "    return scopeAdmissionBudget + promptFittingBudget;",
    [
      ...Array.from(
        { length: 16 },
        () => `    // ${"retain the current ordinary source detail ".repeat(8)}`,
      ),
      "    return scopeAdmissionBudget + promptFittingBudget;",
    ].join("\n"),
  );
  for (let index = 0; index < 8; index += 1)
    files[`src/stage-${String(index)}.ts`] = [
      `import { stage${String(index + 1)} } from "./stage-${String(index + 1)}.js";`,
      `export function stage${String(index)}(selectedRoot) {`,
      `  return stage${String(index + 1)}(selectedRoot);`,
      "}",
      ...Array.from({ length: 40 }, () => "// separate ordinary source detail"),
      "export function scopeAdmissionBudgetAndPromptFittingBudget() {",
      "  const scopeAdmissionBudget = 1024;",
      "  const promptFittingBudget = 2048;",
      ...Array.from(
        { length: 16 },
        () => `  // ${"retain the current ordinary source detail ".repeat(5)}`,
      ),
      "  return scopeAdmissionBudget + promptFittingBudget;",
      "}",
    ].join("\n");
  files["src/spare-a.ts"] = ordinaryCoverageFiles()["src/ordinary.ts"] ?? "";
  files["src/spare-b.ts"] = ordinaryCoverageFiles()["src/ordinary.ts"] ?? "";
  return files;
}

function mixedAccountingFiles(): Readonly<Record<string, string>> {
  const files = { ...crossWaveCoverageFiles() };
  files["docs/manual.pdf"] = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 44 >> stream
BT /F1 24 Tf 72 72 Td (Hello PDF) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
xref
0 6
0000000000 65535 f
0000000010 00000 n
0000000063 00000 n
0000000122 00000 n
0000000248 00000 n
0000000342 00000 n
trailer << /Root 1 0 R /Size 6 >>
startxref
412
%%EOF`;
  return files;
}

async function crossWaveOrdinaryRange(
  fixture: CoverageFixture,
): Promise<NonNullable<EvidenceAtom["lineRange"]>> {
  const index = await fixture.requestContext.codeIntelligenceIndex();
  const method = index.symbols.find(
    (symbol) => symbol.scopePath === "src/ordinary.ts" && symbol.name === "candidateSet",
  );
  expect(method).toBeDefined();
  if (method === undefined) throw new TypeError("fixture requires the current ordinary method");
  expect(index.calls.some((call) => call.targetName === method.name)).toBe(false);
  expect(
    fixture.trace.routeCoverage?.entries.some((entry) => entry.atom.scopePath === method.scopePath),
  ).toBe(false);
  expect(fixture.ordinaryAtoms.some((atom) => atom.scopePath === method.scopePath)).toBe(true);
  return method.lineRange;
}

function expectCrossWaveOrdinaryViews(
  fixture: CoverageFixture,
  reads: ExcerptReadSummary,
  pack: ConnectedContextPack,
  prompt: string,
  range: NonNullable<EvidenceAtom["lineRange"]>,
): void {
  const path = "src/ordinary.ts";
  const lines = (fixture.files[path] ?? "").split("\n").slice(range.startLine - 1, range.endLine);
  const body = lines.join("\n");
  expect(
    readContent(reads, path).includes(body),
    JSON.stringify({
      range,
      fullBodyBytes: Buffer.byteLength(body),
      actualPathBytes: Buffer.byteLength(readContent(reads, path)),
      actualReadBytes: readBytes(reads),
      actualReadPaths: [...reads.excerpts.keys()],
      observation: reads.observation,
      actualOmissions: reads.omitted,
    }),
  ).toBe(true);
  expect(
    pack.files
      .find((file) => file.scopePath === path)
      ?.excerpts.some((item) => item.content.includes(body)),
  ).toBe(true);
  for (const [index, line] of lines.entries())
    expect(prompt.includes(`${String(range.startLine + index)} | ${line}`)).toBe(true);
}

function busyOrdinaryMethodFiles(): Readonly<Record<string, string>> {
  const helpers = Array.from({ length: 18 }, (_value, index) =>
    [
      `function helper${String(index)}() {`,
      ...Array.from(
        { length: 60 },
        (_unused, line) => `  const checkpoint${String(line)} = ${String(line)};`,
      ),
      "  return false;",
      "}",
    ].join("\n"),
  );
  return {
    "src/routes.ts": ['import { handleItem } from "./implementation.js";', REGISTRATION_FACT].join(
      "\n",
    ),
    "src/implementation.ts": [
      "export function handleItem() { return () => processItem(); }",
      "function processItem() {",
      ...helpers.map((_value, index) => `  helper${String(index)}();`),
      "  return true;",
      "}",
      ...helpers,
      ...Array.from({ length: 40 }, () => "// separate ordinary source"),
      "export class ScopeAdmission {",
      "  scopeAdmissionBudgetAndPromptFittingBudget() {",
      "    const scopeAdmissionBudget = 1024;",
      "    const promptFittingBudget = 2048;",
      ...Array.from(
        { length: 16 },
        (_unused, index) =>
          `    const admittedBudget${String(index)} = scopeAdmissionBudget + promptFittingBudget;`,
      ),
      "    return scopeAdmissionBudget + promptFittingBudget;",
      "  }",
      "}",
    ].join("\n"),
  };
}

function busyUnfundedDefinitionFiles(): Readonly<Record<string, string>> {
  const files = { ...busyOrdinaryMethodFiles() };
  files["src/implementation.ts"] = [
    'import { stage0 } from "./stage-0.js";',
    (files["src/implementation.ts"] ?? "").replace("  return true;", "  return stage0();"),
    ...Array.from({ length: 12 }, (_unused, index) =>
      [
        ...Array.from({ length: 40 }, () => "// separate independent ordinary method"),
        `export class RequestAdmission${String(index)} {`,
        "  scopeAdmissionBudgetAndPromptFittingBudget() {",
        "    const scopeAdmissionBudget = 1024;",
        "    const promptFittingBudget = 2048;",
        ...Array.from(
          { length: 16 },
          (_unusedAssignment, assignment) =>
            `    const admittedBudget${String(assignment)} = scopeAdmissionBudget + promptFittingBudget;`,
        ),
        "    return scopeAdmissionBudget + promptFittingBudget;",
        "  }",
        "}",
      ].join("\n"),
    ),
    ...Array.from({ length: 40 }, () => "// separate useful current definition"),
    "export function governRequest() {",
    ...Array.from(
      { length: 38 },
      (_unused, index) => `  const recordedCheckpoint${String(index)} = ${String(index)};`,
    ),
    "  const scopeAdmissionBudget = 1024;",
    "  const promptFittingBudget = 2048;",
    "  return scopeAdmissionBudget + promptFittingBudget;",
    "}",
  ].join("\n");
  for (let index = 0; index < 7; index += 1) {
    const next = index === 6 ? "governRequest" : `stage${String(index + 1)}`;
    const imported = index === 6 ? "./implementation.js" : `./stage-${String(index + 1)}.js`;
    files[`src/stage-${String(index)}.ts`] = [
      `import { ${next} } from "${imported}";`,
      `export function stage${String(index)}() {`,
      `  return ${next}("${"observed connector detail ".repeat(72)}");`,
      "}",
    ].join("\n");
  }
  return files;
}

async function busyOrdinaryMethodRange(
  fixture: CoverageFixture,
): Promise<NonNullable<EvidenceAtom["lineRange"]>> {
  const index = await fixture.requestContext.codeIntelligenceIndex();
  const method = index.symbols.find(
    (symbol) =>
      symbol.scopePath === "src/implementation.ts" &&
      symbol.name === "scopeAdmissionBudgetAndPromptFittingBudget",
  );
  expect(method).toBeDefined();
  if (method === undefined) throw new TypeError("fixture requires the actual indexed method");
  const entries = fixture.trace.routeCoverage?.entries ?? [];
  const helpers = entries.filter((entry) =>
    /^helper\d+$/u.test(entry.atom.edge?.target.symbol ?? ""),
  );
  expect(helpers).toHaveLength(18);
  expect(helpers.every((entry) => fixture.trace.routeCoverage?.isCurrent(entry.atom))).toBe(true);
  expect(
    entries.some((entry) => entry.atom.lineRange?.startLine === method.lineRange.startLine),
  ).toBe(false);
  expect(index.calls.some((call) => call.targetName === method.name)).toBe(false);
  expect(
    fixture.ordinaryAtoms.some(
      (atom) =>
        atom.scopePath === method.scopePath &&
        (atom.lineRange?.startLine ?? Infinity) <= method.lineRange.startLine &&
        (atom.lineRange?.endLine ?? 0) >= method.lineRange.startLine,
    ),
  ).toBe(true);
  return method.lineRange;
}

function expectOrdinaryMethodViews(
  fixture: CoverageFixture,
  reads: ExcerptReadSummary,
  pack: ConnectedContextPack,
  prompt: string,
  range: NonNullable<EvidenceAtom["lineRange"]>,
): void {
  const lines = (fixture.files["src/implementation.ts"] ?? "")
    .split("\n")
    .slice(range.startLine - 1, range.endLine);
  const body = lines.join("\n");
  expect(readContent(reads, "src/implementation.ts")).toContain(body);
  expect(
    pack.files
      .find((file) => file.scopePath === "src/implementation.ts")
      ?.excerpts.some((excerpt) => excerpt.content.includes(body)),
  ).toBe(true);
  for (const [index, line] of lines.entries())
    expect(prompt).toContain(`${String(range.startLine + index)} | ${line}`);
}

function bulkyConnectorFiles(): Readonly<Record<string, string>> {
  const files: Record<string, string> = {
    "src/routes.ts": ['import { handleItem } from "./implementation.js";', REGISTRATION_FACT].join(
      "\n",
    ),
    "src/implementation.ts": [
      'import { stage0 } from "./stage-0.js";',
      "export function handleItem() { return () => stage0(selectedRoot); }",
    ].join("\n"),
  };
  for (let index = 0; index < 8; index += 1)
    files[`src/stage-${String(index)}.ts`] = [
      `import { stage${String(index + 1)} } from "./stage-${String(index + 1)}.js";`,
      `export function stage${String(index)}(selectedRoot) {`,
      ...Array.from({ length: 28 }, () => "  // unrelated bookkeeping for the existing ledger"),
      `  return stage${String(index + 1)}(selectedRoot);`,
      "}",
    ].join("\n");
  files["src/stage-8.ts"] = [
    "export function stage8(selectedRoot) {",
    "  // Scope admission recursive candidate discovery and prompt fitting.",
    `  ${DESCENT_FACT}`,
    "  return selectedRoot;",
    "}",
  ].join("\n");
  return files;
}

function bulkySameFileConnectorFiles(): Readonly<Record<string, string>> {
  const files = { ...bulkyConnectorFiles() };
  const bodies = Object.entries(files)
    .filter(([path]) => path.startsWith("src/stage-"))
    .map(([_path, body]) => body.replace(/^import[^\n]*\n/u, ""));
  files["src/implementation.ts"] = [
    (files["src/implementation.ts"] ?? "").replace(/^import[^\n]*\n/u, ""),
    ...bodies,
  ].join("\n");
  return {
    "src/routes.ts": files["src/routes.ts"] ?? "",
    "src/implementation.ts": files["src/implementation.ts"],
  };
}

function expectFullTerminalView(
  fixture: CoverageFixture,
  reads: ExcerptReadSummary,
  pack: ConnectedContextPack,
  prompt: string,
): void {
  const target = fixture.trace.routeCoverage?.entries.find((entry) =>
    fixture.files[entry.atom.scopePath]
      ?.split("\n")
      [(entry.atom.lineRange?.startLine ?? 1) - 1]?.includes("export function stage8("),
  );
  const range = target?.atom.lineRange;
  expect(target).toBeDefined();
  if (target === undefined || range === undefined)
    throw new TypeError("fixture requires the actual terminal declaration range");
  const lines = (fixture.files[target.atom.scopePath] ?? "")
    .split("\n")
    .slice(range.startLine - 1, range.endLine);
  const body = lines.join("\n");
  expect(readContent(reads, target.atom.scopePath)).toContain(body);
  const excerpt = pack.files
    .find((file) => file.scopePath === target.atom.scopePath)
    ?.excerpts.find(
      (view) =>
        view.atom.lineRange?.startLine === range.startLine &&
        view.atom.lineRange.endLine === range.endLine,
    );
  expect(excerpt?.content).toBe(body);
  for (const [index, line] of lines.entries())
    expect(prompt).toContain(`${String(range.startLine + index)} | ${line}`);
}

describe("current route trace excerpt coverage", () => {
  it("retains a delayed file head and its lower-scored same-file continuation", async () => {
    const fixture = await coverageFixture(undefined, delayedFileHeadCoverageFiles());
    const atoms = await allocationAtoms(fixture);
    const originalAtoms = JSON.stringify(atoms);
    const entries = fixture.trace.routeCoverage?.entries ?? [];
    const head = entries.find(
      (entry) =>
        entry.atom.scopePath === "src/scope-admission.ts" && entry.atom.lineRange?.startLine === 1,
    );
    if (head === undefined) throw new TypeError("fixture requires the actual file head");
    const terminal = entries.find((entry) => entry.parentIdentity === head.definitionIdentity);
    const caller = entries.find((entry) => entry.definitionIdentity === head.parentIdentity);
    const later = entries.find((entry) => entry.atom.scopePath === "src/z-processing.ts");
    if (terminal === undefined || caller === undefined || later === undefined)
      throw new TypeError("fixture requires the returned continuation and common caller");
    expect(terminal.atom.scopePath).toBe(head.atom.scopePath);
    expect(terminal.atom.score).toBeLessThan(head.atom.score);
    expect(terminal.parentWitness?.parentIdentity).toBe(head.definitionIdentity);
    expect(terminal.parentWitness?.targetIdentity).toBe(terminal.definitionIdentity);
    expect(head.parentWitness?.parentIdentity).toBe(caller.definitionIdentity);
    const prefix = entries.filter((entry) =>
      /^function scopeAdmissionAndPromptFitting\d+\(/u.test(
        fixture.files[entry.atom.scopePath]?.split("\n")[
          (entry.atom.lineRange?.startLine ?? 1) - 1
        ] ?? "",
      ),
    );
    const weak = entries.filter((entry) => entry.atom.scopePath.startsWith("src/record-"));
    expect(prefix).toHaveLength(6);
    expect(weak).toHaveLength(9);
    expect(prefix.every((entry) => entry.atom.score >= head.atom.score)).toBe(true);
    expect(weak.every((entry) => entry.atom.score < head.atom.score)).toBe(true);
    const selected = new Set(coverageRanking(atoms).kept.map((entry) => entry.scopePath));
    const watched = [caller, ...prefix, later, head, terminal].map((entry) => {
      const range = entry.atom.lineRange;
      if (range === undefined) throw new TypeError("fixture requires current declaration ranges");
      const lines = (fixture.files[entry.atom.scopePath] ?? "")
        .split("\n")
        .slice(range.startLine - 1, range.endLine);
      const body = lines.join("\n");
      expect(fixture.trace.routeCoverage?.isCurrent(entry.atom)).toBe(true);
      expect(selected.has(entry.atom.scopePath)).toBe(true);
      expect(entry.observedBytes).toBe(Buffer.byteLength(body));
      expect(entry.observedBytes).toBeLessThan(4096);
      return { entry, range, lines, body };
    });
    const budget = { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 24576 };
    for (const paths of [
      ["src/routes.ts", "src/implementation.ts", later.atom.scopePath, head.atom.scopePath],
      undefined,
    ]) {
      const { reads, requests } = await observedCoverageRead(fixture, {
        paths,
        atoms,
        inputs: { budget },
      });
      const pack = await assembledCoveragePack(fixture, reads, atoms, budget);
      const messages = await sentPrompt(fixture, reads, atoms, budget);
      expect(readBytes(reads)).toBeLessThanOrEqual(budget.excerptBytesMax);
      expect(requests.every((request) => request.maxBytes <= 8192)).toBe(true);
      const metadata = JSON.stringify({
        restricted: paths !== undefined,
        watched: watched.map(({ entry, range, body }) => ({
          path: entry.atom.scopePath,
          range,
          score: entry.atom.score,
          bytes: Buffer.byteLength(body),
          read: readContent(reads, entry.atom.scopePath).includes(body),
        })),
        returnedBytes: readBytes(reads),
        requests: requests.map((request) => ({
          path: request.scopePath,
          funded: request.ranges,
          grant: request.maxTotalBytes,
          first: request.firstRoundOnly,
        })),
      });
      for (const { entry, range, lines, body } of watched) {
        if (paths !== undefined)
          expect(
            requests.some(
              (request) =>
                request.scopePath === entry.atom.scopePath &&
                request.ranges?.some(
                  (window) =>
                    window.startLine <= range.startLine && window.endLine >= range.endLine,
                ),
            ),
            metadata,
          ).toBe(true);
        expect(readContent(reads, entry.atom.scopePath).includes(body), metadata).toBe(true);
        expect(
          pack.files
            .find((file) => file.scopePath === entry.atom.scopePath)
            ?.excerpts.some((view) => view.content.includes(body)),
          metadata,
        ).toBe(true);
        for (const [index, line] of lines.entries())
          expect(messages, metadata).toContain(`${String(range.startLine + index)} | ${line}`);
      }
      if (paths === undefined)
        expectTargetCoverageFunding(fixture, requests, head.atom.scopePath, true);
    }
    expect(JSON.stringify(atoms)).toBe(originalAtoms);
  });

  it("nominates competing whole bodies in canonical relevance order before a lower owned continuation", async () => {
    const fixture = await coverageFixture(undefined, canonicalCompetingCoverageFiles());
    const atoms = await allocationAtoms(fixture);
    const originalAtoms = JSON.stringify(atoms);
    const entries = fixture.trace.routeCoverage?.entries ?? [];
    const index = await fixture.requestContext.codeIntelligenceIndex();
    const prefix = entries.filter((entry) =>
      /^export function scopeAdmissionAndPromptFitting\d+\(/u.test(
        fixture.files[entry.atom.scopePath]?.split("\n")[
          (entry.atom.lineRange?.startLine ?? 1) - 1
        ] ?? "",
      ),
    );
    const branch = ["retainRecord0", "walkLedger", "finishLedger"].map((name) =>
      finiteOwnedContinuationEntry(fixture, entries, index, name),
    );
    const seed = requirePendingBodyFixtureEntry(branch[0], "the actual borrowed file head");
    const continuation = requirePendingBodyFixtureEntry(branch[1], "its actual owned branch seed");
    const terminal = requirePendingBodyFixtureEntry(branch[2], "its actual owned terminal");
    expect(continuation.atom.score).toBeGreaterThanOrEqual(seed.atom.score);
    expect(continuation.parentWitness?.ownedSourceCall).toBe(true);
    expect(terminal.atom.score).toBeLessThan(seed.atom.score);
    expect(terminal.parentWitness?.ownedSourceCall).toBe(true);
    const earlier = entries.filter((entry) =>
      /^src\/record-[1-8]\.ts$/u.test(entry.atom.scopePath),
    );
    expect(earlier).toHaveLength(8);
    expect(earlier.every((entry) => entry.atom.score >= seed.atom.score)).toBe(true);
    expect(
      prefix.every((entry) => earlier.every((other) => entry.atom.score > other.atom.score)),
    ).toBe(true);
    expect(
      earlier.every((entry) =>
        prefix.every((other) => entries.indexOf(entry) < entries.indexOf(other)),
      ),
    ).toBe(true);
    const watched = finiteOwnedContinuationViews(fixture, entries, prefix, branch);
    const paths = [
      ...new Set(["src/routes.ts", ...watched.map(({ entry }) => entry.atom.scopePath)]),
    ];
    const budget = { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 24576 };
    for (const restricted of [paths, undefined])
      await expectFiniteOwnedContinuationRead(fixture, atoms, budget, watched, restricted);
    expect(JSON.stringify(atoms)).toBe(originalAtoms);
  });

  it("retains a newly guarded canonical head and prefix while admitting a pending physical file", async () => {
    const fixture = await coverageFixture(undefined, provisionalHeadPendingCoverageFiles());
    const atoms = await allocationAtoms(fixture);
    const originalAtoms = JSON.stringify(atoms);
    const entries = fixture.trace.routeCoverage?.entries ?? [];
    const index = await fixture.requestContext.codeIntelligenceIndex();
    const prefix = entries.filter((entry) =>
      /^export function scopeAdmissionAndPromptFitting\d+\(/u.test(
        fixture.files[entry.atom.scopePath]?.split("\n")[
          (entry.atom.lineRange?.startLine ?? 1) - 1
        ] ?? "",
      ),
    );
    const branch = ["retainRecord0", "walkLedger", "finishLedger"].map((name) =>
      finiteOwnedContinuationEntry(fixture, entries, index, name),
    );
    const seed = requirePendingBodyFixtureEntry(branch[0], "the actual external borrowed head");
    const target = requirePendingBodyFixtureEntry(
      entries.find((entry) => entry.atom.scopePath === "src/scope-admission.ts"),
      "the actual pending physical file",
    );
    expect(target.atom.score).toBeGreaterThanOrEqual(seed.atom.score);
    expect(prefix.every((entry) => entry.atom.score >= target.atom.score)).toBe(true);
    expect(prefix.every((entry) => entry.observedBytes > 200)).toBe(true);
    const watched = [...finiteOwnedContinuationViews(fixture, entries, prefix, branch)];
    const range = requirePendingBodyFixtureEntry(target.atom.lineRange, "the pending whole body");
    const lines = (fixture.files[target.atom.scopePath] ?? "")
      .split("\n")
      .slice(range.startLine - 1, range.endLine);
    const body = lines.join("\n");
    expect(fixture.trace.routeCoverage?.isCurrent(target.atom)).toBe(true);
    expect(target.observedBytes).toBe(Buffer.byteLength(body));
    watched.push({ entry: target, range, lines, body });
    const paths = [
      ...new Set(["src/routes.ts", ...watched.map(({ entry }) => entry.atom.scopePath)]),
    ];
    const requiredFunding = new Set(
      [...prefix, ...branch.slice(0, 2), target].map((entry) => entry.definitionIdentity),
    );
    const wholeConsumers = new Set(
      watched
        .filter(
          ({ entry }) => entry !== branch[2] && entry.atom.scopePath !== "src/z-processing.ts",
        )
        .map(({ entry }) => entry.definitionIdentity),
    );
    const budget = { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 24576 };
    for (const restricted of [paths, undefined])
      await expectPendingFairCompetingRead(
        fixture,
        atoms,
        budget,
        watched,
        requiredFunding,
        wholeConsumers,
        restricted,
      );
    expect(JSON.stringify(atoms)).toBe(originalAtoms);
  });

  it("gives an unfunded physical file its pending turn before a canonical body in a paid file", async () => {
    const fixture = await coverageFixture(undefined, pendingFairCompetingCoverageFiles());
    const atoms = await allocationAtoms(fixture);
    const originalAtoms = JSON.stringify(atoms);
    const entries = fixture.trace.routeCoverage?.entries ?? [];
    const index = await fixture.requestContext.codeIntelligenceIndex();
    const prefix = entries.filter((entry) =>
      /^export function scopeAdmissionAndPromptFitting\d+\(/u.test(
        fixture.files[entry.atom.scopePath]?.split("\n")[
          (entry.atom.lineRange?.startLine ?? 1) - 1
        ] ?? "",
      ),
    );
    expect(prefix).toHaveLength(6);
    const branch = [
      "scopeAdmissionAndPromptFittingLedger",
      "scopeAdmissionAndPromptFittingWalk",
      "finishLedger",
    ].map((name) => finiteOwnedContinuationEntry(fixture, entries, index, name));
    const seed = requirePendingBodyFixtureEntry(branch[0], "the actual borrowed file head");
    const terminal = requirePendingBodyFixtureEntry(
      branch[2],
      "the actual lower-score owned child",
    );
    const target = requirePendingBodyFixtureEntry(
      entries.find((entry) => entry.atom.scopePath === "src/scope-admission.ts"),
      "the pending physical file",
    );
    const caller = requirePendingBodyFixtureEntry(
      entries.find((entry) => entry.definitionIdentity === seed.parentIdentity),
      "the actual common caller",
    );
    const head = requirePendingBodyFixtureEntry(
      entries.find(
        (entry) =>
          entry.atom.scopePath === "src/implementation.ts" && entry.atom.score > caller.atom.score,
      ),
      "the physical caller-file head",
    );
    const later = requirePendingBodyFixtureEntry(
      entries.find((entry) => entry.atom.scopePath === "src/z-processing.ts"),
      "the usable later body",
    );
    expect(target.atom.score).toBeGreaterThanOrEqual(seed.atom.score);
    expect(
      prefix.every(
        (entry) =>
          entry.atom.scopePath === caller.atom.scopePath && entry.atom.score >= seed.atom.score,
      ),
    ).toBe(true);
    expect(terminal.atom.score).toBeLessThan(seed.atom.score);
    expect(terminal.parentWitness?.ownedSourceCall).toBe(true);
    for (let number = 0; number < 3; number += 1) {
      const quota = finiteOwnedContinuationEntry(
        fixture,
        entries,
        index,
        `retainQuota${String(number)}`,
      );
      expect(quota.atom.score).toBeGreaterThanOrEqual(seed.atom.score);
      const quotaHead = finiteOwnedContinuationEntry(
        fixture,
        entries,
        index,
        `scopeAdmissionAndPromptFittingQuota${String(number)}`,
      );
      expect(quotaHead.parentIdentity).toBe(target.parentIdentity);
      expect(quotaHead.parentWitness?.lineRange.startLine).toBeLessThan(
        target.parentWitness?.lineRange.startLine ?? 0,
      );
    }
    const watched = [head, caller, ...prefix, ...branch.slice(0, 2), target, later, terminal].map(
      (entry) => {
        const range = requirePendingBodyFixtureEntry(
          entry.atom.lineRange,
          "the actual complete body range",
        );
        const lines = (fixture.files[entry.atom.scopePath] ?? "")
          .split("\n")
          .slice(range.startLine - 1, range.endLine);
        const body = lines.join("\n");
        expect(fixture.trace.routeCoverage?.isCurrent(entry.atom)).toBe(true);
        expect(entry.observedBytes).toBe(Buffer.byteLength(body));
        return { entry, range, lines, body };
      },
    );
    const paths = [
      ...new Set(["src/routes.ts", ...watched.map(({ entry }) => entry.atom.scopePath)]),
    ];
    const requiredFunding = new Set(
      [head, target, ...branch.slice(0, 2)].map((entry) => entry.definitionIdentity),
    );
    const wholeConsumers = new Set(
      [head, caller, ...prefix, ...branch.slice(0, 2), target].map(
        (entry) => entry.definitionIdentity,
      ),
    );
    const budget = { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 24576 };
    for (const restricted of [paths, undefined]) {
      await expectPendingFairCompetingRead(
        fixture,
        atoms,
        budget,
        watched,
        requiredFunding,
        wholeConsumers,
        restricted,
      );
    }
    expect(JSON.stringify(atoms)).toBe(originalAtoms);
  });

  it("orders pending physical files by their actual stronger queue heads", async () => {
    const fixture = await coverageFixture(undefined, pendingFileRelevanceCoverageFiles());
    const atoms = await allocationAtoms(fixture);
    const originalAtoms = JSON.stringify(atoms);
    const entries = fixture.trace.routeCoverage?.entries ?? [];
    const prefix = entries.filter((entry) =>
      /^export function scopeAdmissionAndPromptFitting\d+\(/u.test(
        fixture.files[entry.atom.scopePath]?.split("\n")[
          (entry.atom.lineRange?.startLine ?? 1) - 1
        ] ?? "",
      ),
    );
    const target = entries.find((entry) => entry.atom.scopePath === "src/scope-admission.ts");
    const later = entries.find((entry) => entry.atom.scopePath === "src/z-processing.ts");
    const weak = entries.filter((entry) => entry.atom.scopePath.startsWith("src/record-"));
    expect(prefix).toHaveLength(6);
    expect(weak).toHaveLength(9);
    if (target === undefined || later === undefined)
      throw new TypeError("fixture requires both actual selected file targets");
    expect(weak.every((entry) => entry.atom.score < target.atom.score)).toBe(true);
    expect(prefix.every((entry) => entry.atom.score >= target.atom.score)).toBe(true);
    expect(weak.every((entry) => entries.indexOf(entry) < entries.indexOf(target))).toBe(true);
    expect(entries.filter((entry) => entry.atom.scopePath === target.atom.scopePath)).toEqual([
      target,
    ]);
    const parent = entries.find((entry) => entry.definitionIdentity === target.parentIdentity);
    if (parent === undefined) throw new TypeError("fixture requires the actual common caller");
    const watched = [parent, ...prefix, later, target].map((entry) => {
      const range = entry.atom.lineRange;
      if (range === undefined)
        throw new TypeError("fixture requires actual complete declaration ranges");
      const lines = (fixture.files[entry.atom.scopePath] ?? "")
        .split("\n")
        .slice(range.startLine - 1, range.endLine);
      const body = lines.join("\n");
      expect(fixture.trace.routeCoverage?.isCurrent(entry.atom)).toBe(true);
      expect(entry.observedBytes).toBe(Buffer.byteLength(body));
      expect(entry.observedBytes).toBeLessThan(4096);
      if (entry !== parent) {
        expect(entry.parentWitness?.parentIdentity).toBe(parent.definitionIdentity);
        expect(entry.parentWitness?.targetIdentity).toBe(entry.definitionIdentity);
      }
      return { entry, range, lines, body };
    });
    const selected = new Set(coverageRanking(atoms).kept.map((candidate) => candidate.scopePath));
    expect(watched.every(({ entry }) => selected.has(entry.atom.scopePath))).toBe(true);
    expect(weak.every((entry) => selected.has(entry.atom.scopePath))).toBe(true);
    const budget = { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 24576 };
    for (const paths of [
      [
        "src/routes.ts",
        "src/implementation.ts",
        ...prefix.map((entry) => entry.atom.scopePath),
        later.atom.scopePath,
        target.atom.scopePath,
      ],
      undefined,
    ]) {
      const { reads, requests } = await observedCoverageRead(fixture, {
        paths,
        atoms,
        inputs: { budget },
      });
      const pack = await assembledCoveragePack(fixture, reads, atoms, budget);
      const messages = await sentPrompt(fixture, reads, atoms, budget);
      expect(readBytes(reads)).toBeLessThanOrEqual(budget.excerptBytesMax);
      expect(requests.every((request) => request.maxBytes <= 8192)).toBe(true);
      const metadata = JSON.stringify({
        restricted: paths !== undefined,
        watched: watched.map(({ entry, range, body }) => ({
          path: entry.atom.scopePath,
          range,
          score: entry.atom.score,
          bytes: Buffer.byteLength(body),
          read: readContent(reads, entry.atom.scopePath).includes(body),
        })),
        weakScores: weak.map((entry) => entry.atom.score),
        bytesReturned: readBytes(reads),
        requests: requests.map((request) => ({
          path: request.scopePath,
          funded: request.ranges,
          grant: request.maxTotalBytes,
          first: request.firstRoundOnly,
        })),
      });
      for (const { entry, range, lines, body } of watched) {
        if (paths !== undefined)
          expect(
            requests.some(
              (request) =>
                request.scopePath === entry.atom.scopePath &&
                request.ranges?.some(
                  (window) =>
                    window.startLine <= range.startLine && window.endLine >= range.endLine,
                ),
            ),
            metadata,
          ).toBe(true);
        expect(readContent(reads, entry.atom.scopePath).includes(body), metadata).toBe(true);
        expect(
          pack.files
            .find((file) => file.scopePath === entry.atom.scopePath)
            ?.excerpts.some((view) => view.content.includes(body)),
          metadata,
        ).toBe(true);
        for (const [index, line] of lines.entries())
          expect(messages, metadata).toContain(`${String(range.startLine + index)} | ${line}`);
      }
    }
    expect(JSON.stringify(atoms)).toBe(originalAtoms);
  });

  it("retains a competing pending same-file body after its physical head is fully funded", async () => {
    const fixture = await coverageFixture(undefined, pendingSameFileBodyCoverageFiles());
    const atoms = await allocationAtoms(fixture);
    const originalAtoms = JSON.stringify(atoms);
    const entries = fixture.trace.routeCoverage?.entries ?? [];
    const prefix = entries.filter((entry) =>
      /^function scopeAdmissionAndPromptFitting\d+\(/u.test(
        fixture.files[entry.atom.scopePath]?.split("\n")[
          (entry.atom.lineRange?.startLine ?? 1) - 1
        ] ?? "",
      ),
    );
    const target = entries.find((entry) =>
      /^export function admitScope\(/u.test(
        fixture.files[entry.atom.scopePath]?.split("\n")[
          (entry.atom.lineRange?.startLine ?? 1) - 1
        ] ?? "",
      ),
    );
    const later = entries.find((entry) => entry.atom.scopePath === "src/z-processing.ts");
    const weak = entries.filter((entry) => entry.atom.scopePath.startsWith("src/record-"));
    expect(prefix).toHaveLength(6);
    expect(weak).toHaveLength(9);
    const pending = requirePendingBodyFixtureEntry(target, "the actual pending same-file target");
    const continuation = requirePendingBodyFixtureEntry(later, "the actual usable later file");
    expect(weak.every((entry) => entry.atom.score <= pending.atom.score)).toBe(true);
    expect(pending.atom.score).toBeGreaterThanOrEqual(continuation.atom.score);
    expect(prefix.every((entry) => entry.atom.score >= pending.atom.score)).toBe(true);
    const parent = entries.find((entry) => entry.definitionIdentity === pending.parentIdentity);
    const caller = requirePendingBodyFixtureEntry(parent, "the actual common caller");
    const head = [...entries]
      .filter((entry) => entry.atom.scopePath === pending.atom.scopePath)
      .sort((left, right) => right.atom.score - left.atom.score)[0];
    const physicalHead = requirePendingBodyFixtureEntry(head, "the actual physical file head");
    expect(pending.atom.scopePath).toBe("src/implementation.ts");
    expect(physicalHead.atom.score).toBeGreaterThan(pending.atom.score);
    expect(physicalHead.definitionIdentity).not.toBe(pending.definitionIdentity);
    const watched = [physicalHead, caller, ...prefix, continuation, pending].map((entry) => {
      const range = entry.atom.lineRange;
      if (range === undefined)
        throw new TypeError("fixture requires actual complete declaration ranges");
      const lines = (fixture.files[entry.atom.scopePath] ?? "")
        .split("\n")
        .slice(range.startLine - 1, range.endLine);
      const body = lines.join("\n");
      expect(fixture.trace.routeCoverage?.isCurrent(entry.atom)).toBe(true);
      expect(entry.observedBytes).toBe(Buffer.byteLength(body));
      expect(entry.observedBytes).toBeLessThan(4096);
      if (entry !== caller && entry !== physicalHead) {
        expect(entry.parentWitness?.parentIdentity).toBe(caller.definitionIdentity);
        expect(entry.parentWitness?.targetIdentity).toBe(entry.definitionIdentity);
      }
      return { entry, range, lines, body };
    });
    const selected = new Set(coverageRanking(atoms).kept.map((candidate) => candidate.scopePath));
    expect(watched.every(({ entry }) => selected.has(entry.atom.scopePath))).toBe(true);
    expect(weak.every((entry) => selected.has(entry.atom.scopePath))).toBe(true);
    const targetRange = pending.atom.lineRange;
    if (targetRange === undefined)
      throw new TypeError("fixture requires the actual pending whole target range");
    const budget = { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 24576 };
    for (const paths of [
      ["src/routes.ts", "src/implementation.ts", continuation.atom.scopePath],
      undefined,
    ]) {
      const { reads, requests } = await observedCoverageRead(fixture, {
        paths,
        atoms,
        inputs: { budget },
      });
      const pack = await assembledCoveragePack(fixture, reads, atoms, budget);
      const messages = await sentPrompt(fixture, reads, atoms, budget);
      expect(readBytes(reads)).toBeLessThanOrEqual(budget.excerptBytesMax);
      expect(requests.every((request) => request.maxBytes <= 8192)).toBe(true);
      const borrowed = weak.filter((entry) =>
        requests.some(
          (request) =>
            request.scopePath === entry.atom.scopePath &&
            request.ranges?.some(
              (window) =>
                window.startLine <= (entry.atom.lineRange?.startLine ?? Infinity) &&
                window.endLine >= (entry.atom.lineRange?.endLine ?? Infinity),
            ),
        ),
      );
      const metadata = JSON.stringify({
        restricted: paths !== undefined,
        watched: watched.map(({ entry, range, body }) => ({
          path: entry.atom.scopePath,
          range,
          score: entry.atom.score,
          bytes: Buffer.byteLength(body),
          read: readContent(reads, entry.atom.scopePath).includes(body),
        })),
        head: {
          identity: physicalHead.definitionIdentity,
          score: physicalHead.atom.score,
          range: physicalHead.atom.lineRange,
        },
        target: { identity: pending.definitionIdentity, score: pending.atom.score },
        actualFullyFundedCompetitorHeads: borrowed.map((entry) => ({
          path: entry.atom.scopePath,
          range: entry.atom.lineRange,
          score: entry.atom.score,
        })),
        weakScores: weak.map((entry) => entry.atom.score),
        bytesReturned: readBytes(reads),
        requests: requests.map((request) => ({
          path: request.scopePath,
          funded: request.ranges,
          grant: request.maxTotalBytes,
          first: request.firstRoundOnly,
        })),
      });
      const headRange = physicalHead.atom.lineRange;
      if (headRange === undefined) throw new TypeError("fixture requires the actual head range");
      expect(
        requests.some(
          (request) =>
            request.scopePath === physicalHead.atom.scopePath &&
            request.ranges?.some(
              (window) =>
                window.startLine <= headRange.startLine && window.endLine >= headRange.endLine,
            ),
        ),
        metadata,
      ).toBe(true);
      for (const { entry, range, lines, body } of watched) {
        expect(readContent(reads, entry.atom.scopePath).includes(body), metadata).toBe(true);
        expect(
          pack.files
            .find((file) => file.scopePath === entry.atom.scopePath)
            ?.excerpts.some((view) => view.content.includes(body)),
          metadata,
        ).toBe(true);
        for (const [index, line] of lines.entries())
          expect(messages, metadata).toContain(`${String(range.startLine + index)} | ${line}`);
      }
      expect(
        requests.some(
          (request) =>
            request.scopePath === pending.atom.scopePath &&
            request.ranges?.some(
              (window) =>
                window.startLine <= targetRange.startLine && window.endLine >= targetRange.endLine,
            ),
        ),
        metadata,
      ).toBe(true);
    }
    expect(JSON.stringify(atoms)).toBe(originalAtoms);
  });

  it("retains a later stronger file after earlier useful same-file prefix targets were committed", async () => {
    const fixture = await coverageFixture(undefined, delayedStrongFileCoverageFiles());
    const atoms = await allocationAtoms(fixture);
    const originalAtoms = JSON.stringify(atoms);
    const entries = fixture.trace.routeCoverage?.entries ?? [];
    const prefix = entries.filter((entry) =>
      /^function scopeAdmissionAndPromptFitting\d+\(/u.test(
        fixture.files[entry.atom.scopePath]?.split("\n")[
          (entry.atom.lineRange?.startLine ?? 1) - 1
        ] ?? "",
      ),
    );
    const target = entries.find((entry) => entry.atom.scopePath === "src/scope-admission.ts");
    const later = entries.find((entry) => entry.atom.scopePath === "src/z-processing.ts");
    const weak = entries.filter((entry) => entry.atom.scopePath.startsWith("src/record-"));
    expect(prefix).toHaveLength(6);
    expect(weak).toHaveLength(9);
    if (target === undefined || later === undefined)
      throw new TypeError("fixture requires both actual selected file targets");
    expect(weak.every((entry) => entry.atom.score < target.atom.score)).toBe(true);
    expect(prefix.every((entry) => entry.atom.score >= target.atom.score)).toBe(true);
    const parent = entries.find((entry) => entry.definitionIdentity === target.parentIdentity);
    if (parent === undefined) throw new TypeError("fixture requires the actual common caller");
    const watched = [parent, ...prefix, later, target].map((entry) => {
      const range = entry.atom.lineRange;
      if (range === undefined)
        throw new TypeError("fixture requires actual complete declaration ranges");
      const lines = (fixture.files[entry.atom.scopePath] ?? "")
        .split("\n")
        .slice(range.startLine - 1, range.endLine);
      const body = lines.join("\n");
      expect(fixture.trace.routeCoverage?.isCurrent(entry.atom)).toBe(true);
      expect(entry.observedBytes).toBe(Buffer.byteLength(body));
      expect(entry.observedBytes).toBeLessThan(4096);
      if (entry !== parent) {
        expect(entry.parentWitness?.parentIdentity).toBe(parent.definitionIdentity);
        expect(entry.parentWitness?.targetIdentity).toBe(entry.definitionIdentity);
      }
      return { entry, range, lines, body };
    });
    const selected = new Set(coverageRanking(atoms).kept.map((candidate) => candidate.scopePath));
    expect(watched.every(({ entry }) => selected.has(entry.atom.scopePath))).toBe(true);
    expect(weak.every((entry) => selected.has(entry.atom.scopePath))).toBe(true);
    const budget = { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 24576 };
    for (const paths of [
      ["src/routes.ts", "src/implementation.ts", later.atom.scopePath, target.atom.scopePath],
      undefined,
    ]) {
      const { reads, requests } = await observedCoverageRead(fixture, {
        paths,
        atoms,
        inputs: { budget },
      });
      const pack = await assembledCoveragePack(fixture, reads, atoms, budget);
      const messages = await sentPrompt(fixture, reads, atoms, budget);
      expect(readBytes(reads)).toBeLessThanOrEqual(budget.excerptBytesMax);
      expect(requests.every((request) => request.maxBytes <= 8192)).toBe(true);
      const metadata = JSON.stringify({
        restricted: paths !== undefined,
        watched: watched.map(({ entry, range, body }) => ({
          path: entry.atom.scopePath,
          range,
          score: entry.atom.score,
          bytes: Buffer.byteLength(body),
          read: readContent(reads, entry.atom.scopePath).includes(body),
        })),
        weakScores: weak.map((entry) => entry.atom.score),
        bytesReturned: readBytes(reads),
        requests: requests.map((request) => ({
          path: request.scopePath,
          funded: request.ranges,
          grant: request.maxTotalBytes,
          first: request.firstRoundOnly,
        })),
      });
      for (const { entry, range, lines, body } of watched) {
        expect(readContent(reads, entry.atom.scopePath).includes(body), metadata).toBe(true);
        expect(
          pack.files
            .find((file) => file.scopePath === entry.atom.scopePath)
            ?.excerpts.some((view) => view.content.includes(body)),
          metadata,
        ).toBe(true);
        for (const [index, line] of lines.entries())
          expect(messages, metadata).toContain(`${String(range.startLine + index)} | ${line}`);
      }
    }
    expect(JSON.stringify(atoms)).toBe(originalAtoms);
  });

  it("retains the complete useful same-file prefix and a usable later file under shared competition", async () => {
    const fixture = await coverageFixture(undefined, sharedPrefixCoverageFiles());
    const atoms = await allocationAtoms(fixture);
    const originalAtoms = JSON.stringify(atoms);
    const entries = fixture.trace.routeCoverage?.entries ?? [];
    const prefix = entries.filter((entry) =>
      /^function scopeAdmissionAndPromptFitting\d+\(/u.test(
        fixture.files[entry.atom.scopePath]?.split("\n")[
          (entry.atom.lineRange?.startLine ?? 1) - 1
        ] ?? "",
      ),
    );
    const weak = entries.filter((entry) => entry.atom.scopePath.startsWith("src/record-"));
    const later = entries.find((entry) => entry.atom.scopePath === "src/z-processing.ts");
    expect(prefix).toHaveLength(6);
    expect(weak).toHaveLength(9);
    if (later === undefined) throw new TypeError("fixture requires the actual later file target");
    expect(
      prefix.every((target) => weak.every((entry) => entry.atom.score < target.atom.score)),
    ).toBe(true);
    const parent = entries.find((entry) => entry.definitionIdentity === later.parentIdentity);
    if (parent === undefined) throw new TypeError("fixture requires the actual common caller");
    const watched = [parent, ...prefix, later].map((entry) => {
      const range = entry.atom.lineRange;
      if (range === undefined)
        throw new TypeError("fixture requires complete current target ranges");
      const lines = (fixture.files[entry.atom.scopePath] ?? "")
        .split("\n")
        .slice(range.startLine - 1, range.endLine);
      const body = lines.join("\n");
      expect(fixture.trace.routeCoverage?.isCurrent(entry.atom)).toBe(true);
      expect(entry.observedBytes).toBe(Buffer.byteLength(body));
      expect(entry.observedBytes).toBeLessThan(4096);
      if (entry !== parent) {
        expect(entry.parentWitness?.parentIdentity).toBe(parent.definitionIdentity);
        expect(entry.parentWitness?.targetIdentity).toBe(entry.definitionIdentity);
      }
      return { entry, range, lines, body };
    });
    const selected = new Set(coverageRanking(atoms).kept.map((candidate) => candidate.scopePath));
    expect(watched.every(({ entry }) => selected.has(entry.atom.scopePath))).toBe(true);
    expect(weak.every((entry) => selected.has(entry.atom.scopePath))).toBe(true);
    const budget = { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 24576 };
    for (const paths of [
      ["src/routes.ts", "src/implementation.ts", later.atom.scopePath],
      undefined,
    ]) {
      const { reads, requests } = await observedCoverageRead(fixture, {
        paths,
        atoms,
        inputs: { budget },
      });
      const pack = await assembledCoveragePack(fixture, reads, atoms, budget);
      const messages = await sentPrompt(fixture, reads, atoms, budget);
      expect(readBytes(reads)).toBeLessThanOrEqual(budget.excerptBytesMax);
      expect(requests.every((request) => request.maxBytes <= 8192)).toBe(true);
      const metadata = JSON.stringify({
        restricted: paths !== undefined,
        watched: watched.map(({ entry, range, body }) => ({
          path: entry.atom.scopePath,
          range,
          score: entry.atom.score,
          bytes: Buffer.byteLength(body),
          read: readContent(reads, entry.atom.scopePath).includes(body),
        })),
        weakScores: weak.map((entry) => entry.atom.score),
        bytesReturned: readBytes(reads),
        requests: requests.map((request) => ({
          path: request.scopePath,
          funded: request.ranges,
          grant: request.maxTotalBytes,
          first: request.firstRoundOnly,
        })),
      });
      for (const { entry, range, lines, body } of watched) {
        expect(readContent(reads, entry.atom.scopePath).includes(body), metadata).toBe(true);
        expect(
          pack.files
            .find((file) => file.scopePath === entry.atom.scopePath)
            ?.excerpts.some((view) => view.content.includes(body)),
          metadata,
        ).toBe(true);
        for (const [index, line] of lines.entries())
          expect(messages, metadata).toContain(`${String(range.startLine + index)} | ${line}`);
      }
    }
    expect(JSON.stringify(atoms)).toBe(originalAtoms);
  });

  it("retains a usable first file branch when crowded higher-scoring targets consume shared bytes", async () => {
    const fixture = await coverageFixture(undefined, crowdedInitialOpportunityFiles());
    const atoms = await allocationAtoms(fixture);
    const originalAtoms = JSON.stringify(atoms);
    const entries = fixture.trace.routeCoverage?.entries ?? [];
    const target = entries.find((entry) => entry.atom.scopePath === "src/z-processing.ts");
    const range = target?.atom.lineRange;
    if (target === undefined || range === undefined)
      throw new TypeError("fixture requires the actual current directory target");
    const competitors = entries.filter(
      (entry) =>
        entry.atom.scopePath.startsWith("src/helper-") ||
        fixture.files[entry.atom.scopePath]
          ?.split("\n")
          [(entry.atom.lineRange?.startLine ?? 1) - 1]?.includes("function bookkeeping"),
    );
    expect(competitors.length).toBe(18);
    expect(competitors.every((entry) => entry.atom.score > target.atom.score)).toBe(true);
    expect(fixture.trace.routeCoverage?.isCurrent(target.atom)).toBe(true);
    expect(target.atom.edge?.kind).toBe("reference");
    const parent = entries.find((entry) => entry.definitionIdentity === target.parentIdentity);
    if (parent === undefined || parent.atom.lineRange === undefined)
      throw new TypeError("fixture requires the observed caller body");
    expect(fixture.trace.routeCoverage?.isCurrent(parent.atom)).toBe(true);
    expect(target.parentWitness?.parentIdentity).toBe(parent.definitionIdentity);
    expect(target.parentWitness?.targetIdentity).toBe(target.definitionIdentity);
    expect(
      coverageRanking(atoms).kept.some(
        (candidate) => candidate.scopePath === target.atom.scopePath,
      ),
    ).toBe(true);
    const lines = (fixture.files[target.atom.scopePath] ?? "")
      .split("\n")
      .slice(range.startLine - 1, range.endLine);
    const body = lines.join("\n");
    expect(target.observedBytes).toBe(Buffer.byteLength(body));
    expect(target.observedBytes).toBeLessThan(4096);
    const budget = { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 8192 };
    for (const paths of [
      ["src/routes.ts", "src/implementation.ts", target.atom.scopePath],
      undefined,
    ]) {
      const { reads, requests } = await observedCoverageRead(fixture, {
        paths,
        atoms,
        inputs: { budget },
      });
      const pack = await assembledCoveragePack(fixture, reads, atoms, budget);
      const messages = await sentPrompt(fixture, reads, atoms, budget);
      expect(readBytes(reads)).toBeLessThanOrEqual(budget.excerptBytesMax);
      expect(requests.every((request) => request.maxBytes <= 8192)).toBe(true);
      const parentRange = parent.atom.lineRange;
      const parentBody = (fixture.files[parent.atom.scopePath] ?? "")
        .split("\n")
        .slice(parentRange.startLine - 1, parentRange.endLine)
        .join("\n");
      expect(readContent(reads, parent.atom.scopePath)).toContain(parentBody);
      const retained = competitors[0];
      if (retained?.atom.lineRange === undefined)
        throw new TypeError("fixture requires the first higher-scoring current competitor");
      const retainedBody = (fixture.files[retained.atom.scopePath] ?? "")
        .split("\n")
        .slice(retained.atom.lineRange.startLine - 1, retained.atom.lineRange.endLine)
        .join("\n");
      expect(readContent(reads, retained.atom.scopePath)).toContain(retainedBody);
      expect(
        readContent(reads, target.atom.scopePath).includes(body),
        JSON.stringify({
          restricted: paths !== undefined,
          targetBytes: target.observedBytes,
          targetScore: target.atom.score,
          competitorScores: competitors.map((entry) => entry.atom.score),
          bytesReturned: readBytes(reads),
          nativeRequests: requests.map((request) => ({
            path: request.scopePath,
            funded: request.ranges,
            grant: request.maxTotalBytes,
            first: request.firstRoundOnly,
          })),
        }),
      ).toBe(true);
      if (paths === undefined)
        expectTargetCoverageFunding(fixture, requests, target.atom.scopePath, true);
      expect(
        pack.files
          .find((file) => file.scopePath === target.atom.scopePath)
          ?.excerpts.some((view) => view.content === body),
      ).toBe(true);
      for (const [index, line] of lines.entries())
        expect(messages).toContain(`${String(range.startLine + index)} | ${line}`);
    }
    expect(JSON.stringify(atoms)).toBe(originalAtoms);
  });

  it("retains multiple safe same-file target windows beyond one physical window's byte cap", async () => {
    const fixture = await coverageFixture(
      "Trace POST /api/items and explain scopeAdmissionBudget and promptFittingBudget",
      multiWindowCoverageFiles(),
    );
    const atoms = await allocationAtoms(fixture);
    const targets =
      fixture.trace.routeCoverage?.entries.filter(
        (entry) => entry.atom.scopePath === "src/implementation.ts",
      ) ?? [];
    expect(targets).toHaveLength(3);
    expect(targets.every((entry) => fixture.trace.routeCoverage?.isCurrent(entry.atom))).toBe(true);
    const ranges = targets.map((entry) => {
      if (entry.atom.lineRange === undefined)
        throw new TypeError("fixture requires actual complete target ranges");
      expect(entry.observedBytes).toBeLessThan(4096);
      return entry.atom.lineRange;
    });
    const budget = { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 24576 };
    const native = await readExcerpt(
      fixture.searchScope,
      {
        scopePath: "src/implementation.ts",
        startLine: Math.min(...ranges.map((range) => range.startLine)),
        endLine: Math.max(...ranges.map((range) => range.endLine)),
        ranges,
        maxBytes: 8192,
        maxTotalBytes: budget.excerptBytesMax,
        maxWindows: ranges.length,
      },
      { fs: fixture.fs, nowMs: () => NOW },
    );
    expect(native.windows).toHaveLength(3);
    const calibrated: ExcerptReadSummary = {
      excerpts: new Map([
        [
          "src/implementation.ts",
          (native.windows ?? []).map((window) => {
            const range = window.atom.lineRange;
            if (range === undefined)
              throw new TypeError("native view requires actual source range");
            expect(window.truncated).toBe(false);
            expect(Buffer.byteLength(window.content)).toBeLessThanOrEqual(8192);
            return { ...range, content: window.content, identity: window.atom.stableId };
          }),
        ],
      ]),
      uncertainty: [],
      elapsedBudgetBlocked: false,
    };
    expect(readBytes(calibrated)).toBeGreaterThan(8192);
    const current = await observedCoverageRead(fixture, { atoms, inputs: { budget } });
    const ordinary = atoms.filter((atom) => atom.scopePath.startsWith("src/ordinary-"));
    expect(new Set(ordinary.map((atom) => atom.scopePath)).size).toBe(9);
    expect(coverageRanking(atoms).kept).toHaveLength(11);
    for (const target of targets.filter((entry) => entry.parentIdentity !== undefined)) {
      const parent = targets.find((entry) => entry.definitionIdentity === target.parentIdentity);
      expect(parent).toBeDefined();
      expect(target.parentWitness?.parentIdentity).toBe(parent?.definitionIdentity);
      expect(target.parentWitness?.targetIdentity).toBe(target.definitionIdentity);
    }
    expect(current.requests.every((request) => request.maxBytes <= 8192)).toBe(true);
    for (const reads of [calibrated, current.reads]) {
      const pack = await assembledCoveragePack(fixture, reads, atoms, budget);
      const messages = await sentPrompt(fixture, reads, atoms, budget);
      expect(readBytes(reads)).toBeLessThanOrEqual(budget.excerptBytesMax);
      for (const target of targets) {
        const range = target.atom.lineRange;
        if (range === undefined) throw new TypeError("fixture requires actual target range");
        const lines = (fixture.files[target.atom.scopePath] ?? "")
          .split("\n")
          .slice(range.startLine - 1, range.endLine);
        const body = lines.join("\n");
        expect(
          readContent(reads, target.atom.scopePath).includes(body),
          JSON.stringify({
            calibration: reads === calibrated,
            targetRange: range,
            bodyBytes: Buffer.byteLength(body),
            returnedBytes: readBytes(reads),
            nativeRequests: current.requests.map((request) => ({
              path: request.scopePath,
              funded: request.ranges,
              grant: request.maxTotalBytes,
              maxBytes: request.maxBytes,
              first: request.firstRoundOnly,
            })),
          }),
        ).toBe(true);
        expect(
          pack.files
            .find((file) => file.scopePath === target.atom.scopePath)
            ?.excerpts.some((excerpt) => excerpt.content === body),
        ).toBe(true);
        for (const [index, line] of lines.entries())
          expect(messages).toContain(`${String(range.startLine + index)} | ${line}`);
      }
    }
  });

  it("retains the exact endpoint registration inside a crowded ordinary window", async () => {
    const nearby = "// Trace route pipeline and explain neighboring evidence.";
    const registration =
      'const routes = [{ method: "POST", path: "/api/items", handler: handleRecord }];';
    const source = {
      "src/routes.ts": [
        ...Array.from({ length: 40 }, () => nearby),
        registration,
        ...Array.from({ length: 20 }, () => nearby),
      ].join("\n"),
    };
    const fixture = await coverageFixture(
      "Trace POST /api/items route pipeline and explain neighboring evidence",
      source,
    );
    const atoms = await allocationAtoms(fixture);
    const endpoint = atoms.find(
      (atom) => atom.provenance.tool === "endpoint-contract-server-route",
    );
    expect(endpoint).toBeDefined();
    expect(endpoint?.lineRange).toEqual({ startLine: 41, endLine: 41 });
    expect(endpoint?.edge).toBeUndefined();
    expect(fixture.trace.routeCoverage?.entries ?? []).toHaveLength(0);
    expect(fixture.ordinaryAtoms.some((atom) => atom.provenance.tool === "repo.searchText")).toBe(
      true,
    );
    expect(coverageRanking(atoms).kept.map((entry) => entry.scopePath)).toContain("src/routes.ts");
    const fullBudget = { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 8192 };
    const full = await observedCoverageRead(fixture, { atoms, inputs: { budget: fullBudget } });
    expect(readContent(full.reads, "src/routes.ts")).toContain(registration);
    expect(await sentPrompt(fixture, full.reads, atoms, fullBudget)).toContain(
      `41 | ${registration}`,
    );
    expect(await sentPrompt(fixture, full.reads, atoms, fullBudget)).toContain(`1 | ${nearby}`);
    const budget = { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 256 };
    expect(Buffer.byteLength(registration)).toBeLessThan(budget.excerptBytesMax);
    const result = await observedCoverageRead(fixture, { atoms, inputs: { budget } });
    expect(readBytes(result.reads)).toBeLessThanOrEqual(budget.excerptBytesMax);
    expect(result.requests.every((request) => request.ranges?.length === 0)).toBe(true);
    expect(readContent(result.reads, "src/routes.ts")).toContain(registration);
    const pack = await assembledCoveragePack(fixture, result.reads, atoms, budget);
    expect(
      pack.files
        .flatMap((file) => file.excerpts)
        .some((view) => view.content.includes(registration)),
    ).toBe(true);
    expect(await sentPrompt(fixture, result.reads, atoms, budget)).toContain(
      `41 | ${registration}`,
    );
    expect(readContent(result.reads, "src/routes.ts")).toContain(nearby);
  });

  it("keeps adjacent actual endpoint registrations independently readable", async () => {
    const registrations = [
      '  { method: "POST", path: "/api/items", handler: firstHandler },',
      '  { method: "POST", path: "/api/items", handler: secondHandler },',
    ];
    const fixture = await coverageFixture("Trace POST /api/items route pipeline", {
      "src/routes.ts": [
        ...Array.from({ length: 40 }, () => "// Trace route pipeline context."),
        "const routes = [",
        ...registrations,
        "];",
      ].join("\n"),
    });
    const atoms = await allocationAtoms(fixture);
    expect(
      atoms
        .filter((atom) => atom.provenance.tool === "endpoint-contract-server-route")
        .map((atom) => atom.lineRange),
    ).toEqual([
      { startLine: 42, endLine: 42 },
      { startLine: 43, endLine: 43 },
    ]);
    const budget = { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 256 };
    const reads = await coverageRead(fixture, { atoms, inputs: { budget } });
    const prompt = await sentPrompt(fixture, reads, atoms, budget);
    for (const [index, line] of registrations.entries()) {
      expect(readContent(reads, "src/routes.ts")).toContain(line);
      expect(prompt).toContain(`${String(42 + index)} | ${line}`);
    }
    expect(readBytes(reads)).toBeLessThanOrEqual(budget.excerptBytesMax);
  });

  it("retains ordinary opportunity for a selected definition when route coverage is absent", async () => {
    const fixture = await coverageFixture(undefined, disconnectedDefinitionFiles());
    const atoms = await allocationAtoms(fixture);
    const target = fixture.trace.routeCoverage?.entries.find(
      (entry) => entry.atom.scopePath === "src/z-handler.ts",
    );
    const range = target?.atom.lineRange;
    if (target === undefined || range === undefined)
      throw new TypeError("fixture requires the current registered handler definition");
    expect(fixture.trace.routeCoverage?.isCurrent(target.atom)).toBe(true);
    expect(target.atom.provenance.tool).toBe("discovered-symbol-definition");
    const targetAtoms = atoms.filter((atom) => atom.scopePath === target.atom.scopePath);
    expect(targetAtoms.length).toBeGreaterThan(0);
    expect(
      targetAtoms.every((atom) => atom.provenance.tool === "discovered-symbol-definition"),
    ).toBe(true);
    expect(
      coverageRanking(atoms).kept.some(
        (candidate) => candidate.scopePath === target.atom.scopePath,
      ),
    ).toBe(true);
    const body = (fixture.files[target.atom.scopePath] ?? "")
      .split("\n")
      .slice(range.startLine - 1, range.endLine)
      .join("\n");
    expect(target.observedBytes).toBe(Buffer.byteLength(body));
    const budget = { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 1536 };
    for (const coverage of [fixture.trace.routeCoverage, undefined]) {
      const reads = await coverageRead(fixture, {
        atoms,
        inputs: { routeCoverage: coverage, budget },
      });
      const pack = await assembledCoveragePack(fixture, reads, atoms, budget);
      const prompt = await sentPrompt(fixture, reads, atoms, budget);
      expect(readBytes(reads)).toBeLessThanOrEqual(budget.excerptBytesMax);
      expect(prompt).toContain(REGISTRATION_FACT);
      expect(
        reads.excerpts.get(target.atom.scopePath)?.some((view) => view.content.includes(body)),
      ).toBe(true);
      expect(
        pack.files
          .find((file) => file.scopePath === target.atom.scopePath)
          ?.excerpts.some((excerpt) => excerpt.content.includes(body)),
      ).toBe(true);
      for (const [offset, line] of body.split("\n").entries())
        expect(prompt).toContain(`${String(range.startLine + offset)} | ${line}`);
    }
  });

  it.each([false, true])(
    "preserves the selected ordinary body across later reader waves (coverage=%s)",
    async (coverage) => {
      const fixture = await coverageFixture(
        "Trace POST /api/items and explain scopeAdmissionBudget and promptFittingBudget",
        crossWaveCoverageFiles(),
      );
      const range = await crossWaveOrdinaryRange(fixture);
      const atoms = await allocationAtoms(fixture);
      expect(coverageRanking(atoms).kept.some((item) => item.scopePath === "src/ordinary.ts")).toBe(
        true,
      );
      expect(
        fixture.trace.routeCoverage?.entries.every((entry) =>
          fixture.trace.routeCoverage?.isCurrent(entry.atom),
        ),
      ).toBe(true);
      const budget = { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 24576 };
      const positive = await coverageRead(fixture, {
        paths: ["src/routes.ts", "src/implementation.ts", "src/stage-8.ts", "src/ordinary.ts"],
        atoms,
        inputs: { routeCoverage: undefined, budget },
      });
      const positivePack = await assembledCoveragePack(fixture, positive, atoms, budget);
      const positivePrompt = await sentPrompt(fixture, positive, atoms, budget);
      expectCrossWaveOrdinaryViews(fixture, positive, positivePack, positivePrompt, range);
      expectFullTerminalView(fixture, positive, positivePack, positivePrompt);
      expect(positivePrompt).toContain(REGISTRATION_FACT);
      expect(readBytes(positive)).toBeLessThanOrEqual(budget.excerptBytesMax);
      const reads = await coverageRead(fixture, {
        atoms,
        inputs: { routeCoverage: coverage ? fixture.trace.routeCoverage : undefined, budget },
      });
      const pack = await assembledCoveragePack(fixture, reads, atoms, budget);
      const prompt = await sentPrompt(fixture, reads, atoms, budget);
      expect(prompt).toContain(REGISTRATION_FACT);
      expect(prompt).toContain(
        "export function handleItem() { return () => stage0(selectedRoot); }",
      );
      expectFullTerminalView(fixture, reads, pack, prompt);
      expect(readBytes(reads)).toBeLessThanOrEqual(budget.excerptBytesMax);
      expectCrossWaveOrdinaryViews(fixture, reads, pack, prompt, range);
    },
  );
  it("retries a deferred selected ordinary body before served paths expand", async () => {
    const fixture = await coverageFixture(
      "Trace POST /api/items and explain scopeAdmissionBudget and promptFittingBudget",
      deferredCrossWaveFiles(),
    );
    const range = await crossWaveOrdinaryRange(fixture);
    const atoms = await allocationAtoms(fixture);
    expect(coverageRanking(atoms).kept.some((item) => item.scopePath === "src/ordinary.ts")).toBe(
      true,
    );
    const body = (fixture.files["src/ordinary.ts"] ?? "")
      .split("\n")
      .slice(range.startLine - 1, range.endLine)
      .join("\n");
    const budget = { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 24576 };
    const positive = await coverageRead(fixture, {
      paths: ["src/routes.ts", "src/implementation.ts", "src/stage-8.ts", "src/ordinary.ts"],
      atoms,
      inputs: { routeCoverage: undefined, budget },
    });
    const positivePack = await assembledCoveragePack(fixture, positive, atoms, budget);
    const positivePrompt = await sentPrompt(fixture, positive, atoms, budget);
    expectCrossWaveOrdinaryViews(fixture, positive, positivePack, positivePrompt, range);
    expectFullTerminalView(fixture, positive, positivePack, positivePrompt);
    const native = workspace.readExcerpt;
    const observed: { request: ReadExcerptRequest; bytes: number }[] = [];
    const spy = vi.spyOn(workspace, "readExcerpt").mockImplementation(async (...args) => {
      const row = { request: args[1], bytes: 0 };
      observed.push(row);
      const result = await native(...args);
      row.bytes = (result.windows ?? [result]).reduce(
        (sum, view) => sum + Buffer.byteLength(view.content),
        0,
      );
      return result;
    });
    let reads: ExcerptReadSummary;
    try {
      reads = await coverageRead(fixture, {
        atoms,
        inputs: { routeCoverage: fixture.trace.routeCoverage, budget },
      });
    } finally {
      spy.mockRestore();
    }
    const initial = observed.filter((row) => row.request.firstRoundOnly === true);
    const target = initial.find((row) => row.request.scopePath === "src/ordinary.ts");
    expect(target).toBeDefined();
    expect(
      target?.bytes,
      JSON.stringify(
        observed.map((row) => ({
          path: row.request.scopePath,
          first: row.request.firstRoundOnly,
          grant: row.request.maxTotalBytes,
          bytes: row.bytes,
        })),
      ),
    ).toBe(0);
    expect(Buffer.byteLength(body)).toBeGreaterThan(target?.request.maxTotalBytes ?? Infinity);
    const initialBytes = initial.reduce((sum, row) => sum + row.bytes, 0);
    expect(initialBytes).toBeGreaterThan(0);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(budget.excerptBytesMax - initialBytes);
    const pack = await assembledCoveragePack(fixture, reads, atoms, budget);
    const prompt = await sentPrompt(fixture, reads, atoms, budget);
    expect(readBytes(reads)).toBeLessThanOrEqual(budget.excerptBytesMax);
    expect(
      readContent(reads, "src/ordinary.ts").includes(body),
      JSON.stringify({
        bodyBytes: Buffer.byteLength(body),
        initialBytes,
        requests: observed.map((row) => ({
          path: row.request.scopePath,
          firstRound: row.request.firstRoundOnly,
          grant: row.request.maxTotalBytes,
          bytes: row.bytes,
        })),
      }),
    ).toBe(true);
    expectCrossWaveOrdinaryViews(fixture, reads, pack, prompt, range);
    expectFullTerminalView(fixture, reads, pack, prompt);
  });

  it("retains a stronger same-file target when weaker files compete for shared connected bytes", async () => {
    const fixture = await coverageFixture(undefined, sharedRelevanceFiles());
    const originalAtoms = JSON.stringify(fixture.trace.atoms);
    const entries = fixture.trace.routeCoverage?.entries ?? [];
    const target = entries.find((entry) =>
      fixture.files[entry.atom.scopePath]
        ?.split("\n")
        [(entry.atom.lineRange?.startLine ?? 1) - 1]?.includes(
          "function scopeAdmissionAndPromptFitting(",
        ),
    );
    const range = target?.atom.lineRange;
    if (target === undefined || range === undefined)
      throw new TypeError("fixture requires the actual current terminal definition");
    const weak = entries.filter((entry) => entry.atom.scopePath.startsWith("src/record-"));
    expect(weak.length).toBe(9);
    expect(weak.every((entry) => entry.atom.score < target.atom.score)).toBe(true);
    expect(fixture.trace.routeCoverage?.isCurrent(target.atom)).toBe(true);
    const parent = entries.find((entry) => entry.definitionIdentity === target.parentIdentity);
    if (parent === undefined) throw new TypeError("fixture requires the actual current parent");
    expect(target.parentWitness?.parentIdentity).toBe(parent.definitionIdentity);
    expect(target.parentWitness?.targetIdentity).toBe(target.definitionIdentity);
    expect(fixture.trace.routeCoverage?.isCurrent(parent.atom)).toBe(true);
    expect(
      fixture.files[target.atom.scopePath]?.split("\n")[
        (target.parentWitness?.lineRange.startLine ?? 1) - 1
      ],
    ).toBe("  return scopeAdmissionAndPromptFitting(value);");
    const atoms = await allocationAtoms(fixture);
    expect(
      coverageRanking(atoms).kept.some((item) => item.scopePath === target.atom.scopePath),
    ).toBe(true);
    const lines = (fixture.files[target.atom.scopePath] ?? "")
      .split("\n")
      .slice(range.startLine - 1, range.endLine);
    const body = lines.join("\n");
    expect(target.observedBytes).toBe(Buffer.byteLength(body));
    const budget = { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 8192 };
    for (const paths of [["src/routes.ts", "src/implementation.ts"], undefined]) {
      const { reads, requests } = await observedCoverageRead(fixture, {
        paths,
        atoms,
        inputs: { budget },
      });
      const pack = await assembledCoveragePack(fixture, reads, atoms, budget);
      const messages = await sentPrompt(fixture, reads, atoms, budget);
      expect(readBytes(reads)).toBeLessThanOrEqual(budget.excerptBytesMax);
      expect(
        readContent(reads, target.atom.scopePath).includes(body),
        JSON.stringify({
          restricted: paths !== undefined,
          targetScore: target.atom.score,
          targetRange: range,
          targetBytes: target.observedBytes,
          weakScores: weak.map((entry) => entry.atom.score),
          nativeRequests: requests.map((request) => ({
            path: request.scopePath,
            funded: request.ranges,
            grant: request.maxTotalBytes,
            first: request.firstRoundOnly,
          })),
        }),
      ).toBe(true);
      expect(
        pack.files
          .find((file) => file.scopePath === target.atom.scopePath)
          ?.excerpts.some((excerpt) => excerpt.content.includes(body)),
      ).toBe(true);
      for (const [index, line] of lines.entries())
        expect(messages).toContain(`${String(range.startLine + index)} | ${line}`);
    }
    expect(JSON.stringify(fixture.trace.atoms)).toBe(originalAtoms);
  });

  it("conserves invalidated returned code and retained document grants together", async () => {
    const fixture = await coverageFixture(
      "Trace POST /api/items and explain scopeAdmissionBudget and promptFittingBudget; inspect docs/manual.pdf",
      mixedAccountingFiles(),
    );
    const budget = {
      ...DEFAULT_EXPLORATION_BUDGET,
      excerptBytesMax: 24576,
      filesReadMax: 13,
      elapsedMsMax: 1000,
    };
    const consumedByPath = new Map<string, number>();
    const nativeRead = workspace.readExcerpt;
    let now = NOW;
    const spy = vi.spyOn(workspace, "readExcerpt").mockImplementation(async (...args) => {
      const result = await nativeRead(...args);
      if (args[1].rangeQueues === undefined) return result;
      const returned = (result.windows ?? [result]).reduce(
        (bytes, view) => bytes + Buffer.byteLength(view.content),
        0,
      );
      if (returned > 0) {
        const path = args[1].scopePath;
        consumedByPath.set(path, (consumedByPath.get(path) ?? 0) + returned);
        now = NOW + (budget.elapsedMsMax ?? 0);
      }
      return result;
    });
    const activityLog = createBufferedServerLogSink();
    const result = await retrieveConnectedContextPack(
      {
        scope: fixture.scope,
        query: fixture.query,
        workspaceRoot: fixture.searchScope.workspace.root,
        budget,
      },
      {
        correlationId: undefined,
        fs: fixture.fs,
        nowMs: () => now,
        detectWorkspace: () => fixture.searchScope.workspace,
        answerer: { answer: () => Promise.resolve("No synthesis was requested") },
        activityLog,
      },
    ).finally(() => spy.mockRestore());
    const codeConsumed = [...consumedByPath.values()].reduce((bytes, value) => bytes + value, 0);
    expect(codeConsumed).toBeGreaterThan(0);
    for (const path of consumedByPath.keys()) {
      expect(result.pack.files.some((file) => file.scopePath === path)).toBe(false);
      expect(result.pack.omitted.some((entry) => entry.scopePath === path)).toBe(true);
    }
    const document = result.pack.files.find((file) => file.scopePath === "docs/manual.pdf");
    expect(document).toBeDefined();
    if (document === undefined) throw new TypeError("fixture requires a retained real document");
    expect(document.excerpts.map((view) => view.content).join("\n")).toContain("Hello PDF");
    expect(
      document.excerpts.every((view) => view.atom.provenance.kind === "document-extract"),
    ).toBe(true);
    const documentBytes = document.excerpts.reduce((bytes, view) => bytes + view.contentBytes, 0);
    expect(documentBytes).toBeGreaterThan(0);
    const consumed = codeConsumed + documentBytes;
    expect(consumed).toBeLessThanOrEqual(budget.excerptBytesMax);
    expect(validateConnectedContextPack(result.pack).ok).toBe(true);
    const remaining = remainingPublicReadGrant(fixture, result);
    const consumedFiles = consumedByPath.size + 1;
    const values = JSON.stringify({
      codeConsumed,
      documentBytes,
      consumed,
      consumedFiles,
      usageBytes: result.pack.usage.excerptBytes,
      usageFiles: result.pack.usage.filesRead,
      remainingBytes: remaining.excerptBytesMax,
      remainingFiles: remaining.filesReadMax,
    });
    expect(result.pack.usage.excerptBytes, values).toBeGreaterThanOrEqual(codeConsumed);
    expect(result.pack.usage.filesRead, values).toBeGreaterThanOrEqual(consumedByPath.size);
    expect(result.pack.usage.excerptBytes, values).toBeGreaterThanOrEqual(consumed);
    expect(result.pack.usage.filesRead, values).toBeGreaterThanOrEqual(consumedFiles);
    expect(remaining.excerptBytesMax, values).toBeLessThanOrEqual(
      budget.excerptBytesMax - consumed,
    );
    expect(remaining.filesReadMax, values).toBeLessThanOrEqual(budget.filesReadMax - consumedFiles);
  });

  it.each([
    { dimension: "files", excerptBytesMax: 24576, filesReadMax: 1 },
    { dimension: "bytes", excerptBytesMax: 9, filesReadMax: 13 },
    { dimension: "healthy", excerptBytesMax: 24576, filesReadMax: 2 },
  ])(
    "enforces finite shared document projection capacity ($dimension)",
    async ({ dimension, excerptBytesMax, filesReadMax }) => {
      const pdf = mixedAccountingFiles()["docs/manual.pdf"];
      if (pdf === undefined) throw new TypeError("fixture requires the real bounded PDF");
      const fixture = await coverageFixture("Read docs/first.pdf and docs/second.pdf", {
        "docs/first.pdf": pdf,
        "docs/second.pdf": pdf,
      });
      const scope = {
        ...fixture.scope,
        kind: "files" as const,
        relativePaths: ["docs/first.pdf", "docs/second.pdf"],
        explicitConnection: true,
      };
      const budget = { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax, filesReadMax };
      let projections = 0;
      let projectedBytes = 0;
      const projectedPaths: string[] = [];
      let documentOmissions: readonly { readonly scopePath: string; readonly reason: string }[] =
        [];
      let nativeCalls = 0;
      const native = documentLane.collectConnectedDocumentEvidence;
      const observer = vi
        .spyOn(documentLane, "collectConnectedDocumentEvidence")
        .mockImplementation(async (...args) => {
          const documents = await native(...args);
          nativeCalls += 1;
          projections += documents.excerpts.size;
          projectedPaths.push(...documents.excerpts.keys());
          documentOmissions = documents.omitted.map((entry) => ({
            scopePath: entry.scopePath,
            reason: entry.reason,
          }));
          projectedBytes += [...documents.excerpts.values()].reduce(
            (bytes, windows) =>
              bytes + windows.reduce((sum, view) => sum + Buffer.byteLength(view.content), 0),
            0,
          );
          return documents;
        });
      const result = await retrieveConnectedContextPack(
        { scope, query: fixture.query, workspaceRoot: fixture.searchScope.workspace.root, budget },
        {
          correlationId: undefined,
          fs: fixture.fs,
          nowMs: () => NOW,
          detectWorkspace: () => fixture.searchScope.workspace,
          answerer: { answer: () => Promise.resolve("No synthesis was requested") },
          activityLog: createBufferedServerLogSink(),
        },
      ).finally(() => observer.mockRestore());
      expect(nativeCalls).toBe(1);
      expect(
        result.pack.files.some((file) =>
          file.excerpts.some(
            (view) =>
              view.atom.provenance.kind === "document-extract" &&
              view.content.includes("Hello PDF"),
          ),
        ),
      ).toBe(true);
      const validation = validateConnectedContextPack(result.pack);
      expect(validation.ok).toBe(true);
      const remaining = remainingPublicReadGrant(fixture, result);
      const values = JSON.stringify({
        nativeCalls,
        projections,
        projectedBytes,
        projectedPaths,
        documentOmissions,
        usageFiles: result.pack.usage.filesRead,
        usageBytes: result.pack.usage.excerptBytes,
        selectedFiles: result.pack.files.length,
        fileGrant: budget.filesReadMax,
        byteGrant: budget.excerptBytesMax,
        validatorOk: validation.ok,
        remainingFiles: remaining.filesReadMax,
        remainingBytes: remaining.excerptBytesMax,
      });
      expect(projections, values).toBeLessThanOrEqual(budget.filesReadMax);
      expect(projectedBytes, values).toBeLessThanOrEqual(budget.excerptBytesMax);
      if (dimension === "healthy") {
        expect([...projectedPaths].sort(), values).toEqual([...scope.relativePaths].sort());
        expect(result.pack.files.map((file) => file.scopePath).sort(), values).toEqual(
          [...scope.relativePaths].sort(),
        );
        for (const path of scope.relativePaths) {
          expect(
            result.pack.files
              .find((file) => file.scopePath === path)
              ?.excerpts.map((view) => view.content)
              .join("\n"),
            values,
          ).toContain("Hello PDF");
        }
      } else {
        const unprojected = scope.relativePaths.filter((path) => !projectedPaths.includes(path));
        expect(unprojected, values).toHaveLength(1);
        for (const path of unprojected) {
          expect(documentOmissions, values).toContainEqual({
            scopePath: path,
            reason: "budget-exhausted",
          });
        }
      }
      expect(result.pack.usage.filesRead, values).toBeGreaterThanOrEqual(projections);
      expect(result.pack.usage.excerptBytes, values).toBeGreaterThanOrEqual(projectedBytes);
      expect(remaining.filesReadMax, values).toBeLessThanOrEqual(budget.filesReadMax - projections);
      expect(remaining.excerptBytesMax, values).toBeLessThanOrEqual(
        budget.excerptBytesMax - projectedBytes,
      );
    },
  );

  it("preserves the finite shared grant when invalidated code saturates it beside a retained document", async () => {
    const fixture = await coverageFixture(
      "Trace POST /api/items and explain scopeAdmissionBudget and promptFittingBudget; inspect docs/manual.pdf",
      mixedAccountingFiles(),
    );
    const budget = { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 24576, filesReadMax: 13 };
    const observation = invalidatingExpansionRead(fixture);
    const result = await actualPublicRetrieval(fixture, budget).finally(observation.restore);
    const invalidated = observation.invalidatedPath();
    expect(invalidated).toBeDefined();
    if (invalidated === undefined) throw new TypeError("fixture requires a genuine expansion read");
    expect(observation.bytes.get(invalidated)).toBeGreaterThan(0);
    expect(result.pack.files.some((file) => file.scopePath === invalidated)).toBe(false);
    expect(result.pack.omitted.some((entry) => entry.scopePath === invalidated)).toBe(true);
    const codeConsumed = [...observation.bytes.values()].reduce((bytes, value) => bytes + value, 0);
    expect(codeConsumed).toBeGreaterThan(0);
    const document = result.pack.files.find((file) => file.scopePath === "docs/manual.pdf");
    expect(document).toBeDefined();
    if (document === undefined) throw new TypeError("fixture requires a real retained document");
    expect(document.excerpts.map((view) => view.content).join("\n")).toContain("Hello PDF");
    expect(
      document.excerpts.every((view) => view.atom.provenance.kind === "document-extract"),
    ).toBe(true);
    const documentBytes = document.excerpts.reduce((bytes, view) => bytes + view.contentBytes, 0);
    expect(documentBytes).toBeGreaterThan(0);
    const packedBytes = result.pack.files
      .flatMap((file) => file.excerpts)
      .reduce((bytes, view) => bytes + view.contentBytes, 0);
    const validation = validateConnectedContextPack(result.pack);
    const remaining = remainingPublicReadGrant(fixture, result);
    const values = JSON.stringify({
      codeConsumed,
      documentBytes,
      combined: codeConsumed + documentBytes,
      packedBytes,
      usageBytes: result.pack.usage.excerptBytes,
      codeFiles: [...observation.bytes.values()].filter((bytes) => bytes > 0).length,
      usageFiles: result.pack.usage.filesRead,
      byteGrant: budget.excerptBytesMax,
      fileGrant: budget.filesReadMax,
      validatorOk: validation.ok,
      remainingBytes: remaining.excerptBytesMax,
      remainingFiles: remaining.filesReadMax,
    });
    expect(result.pack.usage.excerptBytes, values).toBeGreaterThanOrEqual(
      codeConsumed + documentBytes,
    );
    expect(result.pack.usage.filesRead, values).toBeGreaterThanOrEqual(
      [...observation.bytes.values()].filter((bytes) => bytes > 0).length + 1,
    );
    expect(validation.ok, values).toBe(true);
    expect(result.pack.usage.excerptBytes, values).toBeLessThanOrEqual(budget.excerptBytesMax);
    expect(codeConsumed + documentBytes, values).toBeLessThanOrEqual(budget.excerptBytesMax);
  });

  it("keeps disjoint document and discarded code within a nine-byte original excerpt grant", async () => {
    const fixture = await coverageFixture(
      "Trace POST /api/items and explain scopeAdmissionBudget and promptFittingBudget; inspect docs/manual.pdf",
      mixedAccountingFiles(),
    );
    const budget = {
      ...DEFAULT_EXPLORATION_BUDGET,
      excerptBytesMax: 9,
      filesReadMax: 13,
      elapsedMsMax: 1000,
    };
    const consumedByPath = new Map<string, number>();
    const nativeRead = workspace.readExcerpt;
    let now = NOW;
    const spy = vi.spyOn(workspace, "readExcerpt").mockImplementation(async (...args) => {
      const result = await nativeRead(...args);
      if (args[1].rangeQueues === undefined) return result;
      const returned = (result.windows ?? [result]).reduce(
        (bytes, view) => bytes + Buffer.byteLength(view.content),
        0,
      );
      if (returned > 0) {
        const path = args[1].scopePath;
        consumedByPath.set(path, (consumedByPath.get(path) ?? 0) + returned);
        now = NOW + (budget.elapsedMsMax ?? 0);
      }
      return result;
    });
    const activityLog = createBufferedServerLogSink();
    const result = await retrieveConnectedContextPack(
      {
        scope: fixture.scope,
        query: fixture.query,
        workspaceRoot: fixture.searchScope.workspace.root,
        budget,
      },
      {
        correlationId: undefined,
        fs: fixture.fs,
        nowMs: () => now,
        detectWorkspace: () => fixture.searchScope.workspace,
        answerer: { answer: () => Promise.resolve("No synthesis was requested") },
        activityLog,
      },
    ).finally(() => spy.mockRestore());
    const codeConsumed = [...consumedByPath.values()].reduce((bytes, value) => bytes + value, 0);
    for (const path of consumedByPath.keys()) {
      expect(result.pack.files.some((file) => file.scopePath === path)).toBe(false);
      expect(result.pack.omitted.some((entry) => entry.scopePath === path)).toBe(true);
    }
    const document = result.pack.files.find((file) => file.scopePath === "docs/manual.pdf");
    expect(document).toBeDefined();
    if (document === undefined) throw new TypeError("fixture requires a retained real document");
    expect(document.excerpts.map((view) => view.content).join("\n")).toContain("Hello PDF");
    expect(
      document.excerpts.every((view) => view.atom.provenance.kind === "document-extract"),
    ).toBe(true);
    const documentBytes = document.excerpts.reduce((bytes, view) => bytes + view.contentBytes, 0);
    expect(documentBytes).toBe(9);
    const consumed = codeConsumed + documentBytes;
    const validation = validateConnectedContextPack(result.pack);
    const remaining = remainingPublicReadGrant(fixture, result);
    const consumedFiles = consumedByPath.size + 1;
    const values = JSON.stringify({
      codeConsumed,
      documentBytes,
      consumed,
      consumedFiles,
      usageBytes: result.pack.usage.excerptBytes,
      usageFiles: result.pack.usage.filesRead,
      remainingBytes: remaining.excerptBytesMax,
      remainingFiles: remaining.filesReadMax,
      validatorOk: validation.ok,
    });
    expect(consumed, values).toBeLessThanOrEqual(budget.excerptBytesMax);
    expect(validation.ok, values).toBe(true);
    expect(result.pack.usage.excerptBytes, values).toBeLessThanOrEqual(budget.excerptBytesMax);
    expect(result.pack.usage.excerptBytes, values).toBeGreaterThanOrEqual(codeConsumed);
    expect(result.pack.usage.filesRead, values).toBeGreaterThanOrEqual(consumedByPath.size);
    expect(result.pack.usage.excerptBytes, values).toBeGreaterThanOrEqual(consumed);
    expect(result.pack.usage.filesRead, values).toBeGreaterThanOrEqual(consumedFiles);
    expect(remaining.excerptBytesMax, values).toBeLessThanOrEqual(
      budget.excerptBytesMax - consumed,
    );
    expect(remaining.filesReadMax, values).toBeLessThanOrEqual(budget.filesReadMax - consumedFiles);
  });

  it("keeps guarded read charges after expansion invalidates the returned source", async () => {
    const fixture = await coverageFixture(
      "Trace POST /api/items and explain scopeAdmissionBudget and promptFittingBudget",
      crossWaveCoverageFiles(),
    );
    const budget = { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 24576, filesReadMax: 12 };
    const observation = invalidatingExpansionRead(fixture);
    const activityLog = createBufferedServerLogSink();
    const result = await actualPublicRetrieval(fixture, budget, activityLog).finally(
      observation.restore,
    );
    const invalidated = observation.invalidatedPath();
    expect(invalidated).toBeDefined();
    if (invalidated === undefined) throw new TypeError("fixture requires a real expansion read");
    expect(observation.bytes.get(invalidated)).toBeGreaterThan(0);
    expect(result.pack.files.some((file) => file.scopePath === invalidated)).toBe(false);
    expect(result.pack.omitted.some((entry) => entry.scopePath === invalidated)).toBe(true);
    const messages = buildGroundedGatewayMessages(
      fixture.query.text,
      result.pack,
      (value) => value,
    );
    expect(JSON.stringify(messages)).not.toContain(
      "replacement source after the initial guarded read",
    );
    const consumed = [...observation.bytes.values()].reduce((total, bytes) => total + bytes, 0);
    const packed = result.pack.files
      .flatMap((file) => file.excerpts)
      .reduce((total, excerpt) => total + excerpt.contentBytes, 0);
    expect(consumed).toBeGreaterThan(packed);
    expect(consumed).toBeLessThanOrEqual(budget.excerptBytesMax);
    expect(validateConnectedContextPack(result.pack).ok).toBe(true);
    const remaining = remainingPublicReadGrant(fixture, result);
    const filesRead = [...observation.bytes.values()].filter((bytes) => bytes > 0).length;
    expect(
      result.pack.usage.filesRead,
      JSON.stringify({ filesRead, selected: result.pack.files.length }),
    ).toBeGreaterThanOrEqual(filesRead);
    expect(
      result.pack.usage.excerptBytes,
      JSON.stringify({
        consumed,
        packed,
        remaining: remaining.excerptBytesMax,
        invalidatedBytes: observation.bytes.get(invalidated),
      }),
    ).toBeGreaterThanOrEqual(consumed);
    expect(
      activityLog.events.find((event) => event.op === "search.connected-context.completed")?.extra,
    ).toMatchObject({
      usageExcerptBytes: result.pack.usage.excerptBytes,
      usageFilesRead: result.pack.usage.filesRead,
    });
    expect(remaining.excerptBytesMax).toBeLessThanOrEqual(budget.excerptBytesMax - consumed);
    expect(remaining.filesReadMax).toBeLessThanOrEqual(budget.filesReadMax - filesRead);
  });

  it("keeps an initial ordinary body when later expansion exhausts its shared grant", async () => {
    const fixture = await coverageFixture(
      "Trace POST /api/items and explain scopeAdmissionBudget and promptFittingBudget",
      crossWaveCoverageFiles(),
    );
    const range = await crossWaveOrdinaryRange(fixture);
    const atoms = await allocationAtoms(fixture);
    const budget = { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 24576 };
    const reads = await coverageRead(fixture, { atoms, inputs: { budget } });
    const readPack = await assembledCoveragePack(fixture, reads, atoms, budget);
    const readPrompt = await sentPrompt(fixture, reads, atoms, budget);
    expectCrossWaveOrdinaryViews(fixture, reads, readPack, readPrompt, range);
    expect(reads.observation?.stopReasons).toContain("byte-grant");
    const { pack } = await actualPublicRetrieval(fixture, budget);
    const prompt = buildGroundedGatewayMessages(fixture.query.text, pack, (value) => value)
      .map((message) => message.content)
      .join("\n");
    expectCrossWaveOrdinaryViews(fixture, reads, pack, prompt, range);
    expect(pack.usage.excerptBytes).toBeLessThanOrEqual(budget.excerptBytesMax);
  });

  it("retains a useful unfunded definition beside the independent ordinary method", async () => {
    const fixture = await coverageFixture(
      "Trace POST /api/items and explain scopeAdmissionBudget and promptFittingBudget",
      busyUnfundedDefinitionFiles(),
    );
    const methodRange = await busyOrdinaryMethodRange(fixture);
    const target = fixture.trace.routeCoverage?.entries.find((entry) =>
      fixture.files[entry.atom.scopePath]
        ?.split("\n")
        [(entry.atom.lineRange?.startLine ?? 1) - 1]?.includes("export function governRequest("),
    );
    expect(target).toBeDefined();
    const targetRange = target?.atom.lineRange;
    if (target === undefined || targetRange === undefined)
      throw new TypeError("fixture requires the actual current target definition");
    expect(fixture.trace.routeCoverage?.isCurrent(target.atom)).toBe(true);
    expect(target.atom.edge?.kind).toBe("reference");
    const body = (fixture.files[target.atom.scopePath] ?? "")
      .split("\n")
      .slice(targetRange.startLine - 1, targetRange.endLine)
      .join("\n");
    expect(target.observedBytes).toBe(Buffer.byteLength(body));
    const atoms = await allocationAtoms(fixture);
    const budget = { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 24576 };
    const methodBody = (fixture.files[target.atom.scopePath] ?? "")
      .split("\n")
      .slice(methodRange.startLine - 1, methodRange.endLine)
      .join("\n");
    expect(Buffer.byteLength(body) + Buffer.byteLength(methodBody)).toBeLessThan(4096);
    expect(
      coverageRanking(atoms).kept.some(
        (candidate) => candidate.scopePath === target.atom.scopePath,
      ),
    ).toBe(true);
    const reads = await coverageRead(fixture, { atoms, inputs: { budget } });
    const pack = await assembledCoveragePack(fixture, reads, atoms, budget);
    const prompt = await sentPrompt(fixture, reads, atoms, budget);
    expect(readBytes(reads)).toBeLessThanOrEqual(budget.excerptBytesMax);
    expectOrdinaryMethodViews(fixture, reads, pack, prompt, methodRange);
    expectOrdinaryMethodViews(fixture, reads, pack, prompt, targetRange);
  });

  it("counts a nonempty partial ordinary view without claiming the entire method was read", async () => {
    const fixture = await coverageFixture(
      "Trace POST /api/items and explain scopeAdmissionBudget and promptFittingBudget",
      busyOrdinaryMethodFiles(),
    );
    const range = await busyOrdinaryMethodRange(fixture);
    const reads = await coverageRead(fixture, {
      atoms: await allocationAtoms(fixture),
      inputs: { budget: { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 1024 } },
    });
    const returned = reads.excerpts.get("src/implementation.ts") ?? [];
    expect(
      returned.some(
        (view) =>
          view.content.length > 0 &&
          view.startLine <= range.endLine &&
          view.endLine >= range.startLine,
      ),
    ).toBe(true);
    const body = (fixture.files["src/implementation.ts"] ?? "")
      .split("\n")
      .slice(range.startLine - 1, range.endLine)
      .join("\n");
    expect(readContent(reads, "src/implementation.ts")).not.toContain(body);
    expect(reads.observation?.ordinaryServedRangeCount).toBeGreaterThan(0);
    expect(reads.observation?.truncatedWindowCount).toBeGreaterThan(0);
    expect(readBytes(reads)).toBeLessThanOrEqual(1024);
  });

  it("preserves the ordinary lexical method beside current same-file definitions", async () => {
    const fixture = await coverageFixture(
      "Trace POST /api/items and explain scopeAdmissionBudget and promptFittingBudget",
      busyOrdinaryMethodFiles(),
    );
    const range = await busyOrdinaryMethodRange(fixture);
    const atoms = await allocationAtoms(fixture);
    expect(
      coverageRanking(atoms).kept.some((item) => item.scopePath === "src/implementation.ts"),
    ).toBe(true);
    const budget = { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 24576 };
    const normal = await coverageRead(fixture, {
      atoms,
      inputs: { routeCoverage: undefined, budget },
    });
    const normalPack = await assembledCoveragePack(fixture, normal, atoms, budget);
    const normalPrompt = await sentPrompt(fixture, normal, atoms, budget);
    expectOrdinaryMethodViews(fixture, normal, normalPack, normalPrompt, range);
    expect(readBytes(normal)).toBeLessThanOrEqual(budget.excerptBytesMax);
    const reads = await coverageRead(fixture, { atoms, inputs: { budget } });
    const pack = await assembledCoveragePack(fixture, reads, atoms, budget);
    const prompt = await sentPrompt(fixture, reads, atoms, budget);
    expect(prompt).toContain("export function handleItem() { return () => processItem(); }");
    expect(readBytes(reads)).toBeLessThanOrEqual(budget.excerptBytesMax);
    expectOrdinaryMethodViews(fixture, reads, pack, prompt, range);
  });

  it("retains complete assigned and statement-call traversal bodies beside useful file opportunities", async () => {
    const fixture = await coverageFixture(undefined, finiteOwnedContinuationFiles());
    const atoms = await allocationAtoms(fixture);
    const originalAtoms = JSON.stringify(atoms);
    const originalUncertainty = JSON.stringify(fixture.trace.uncertainty);
    const entries = fixture.trace.routeCoverage?.entries ?? [];
    const index = await fixture.requestContext.codeIntelligenceIndex();
    const prefix = entries.filter((entry) =>
      /^function scopeAdmissionAndPromptFitting\d+\(/u.test(
        fixture.files[entry.atom.scopePath]?.split("\n")[
          (entry.atom.lineRange?.startLine ?? 1) - 1
        ] ?? "",
      ),
    );
    const names = ["collectInventory", "discoverEntries", "descend", "handleEntry"];
    const branch = names.map((name) => finiteOwnedContinuationEntry(fixture, entries, index, name));
    const watched = finiteOwnedContinuationViews(fixture, entries, prefix, branch);
    const selected = new Set(coverageRanking(atoms).kept.map((candidate) => candidate.scopePath));
    expect(watched.every(({ entry }) => selected.has(entry.atom.scopePath))).toBe(true);
    const paths = [
      ...new Set(["src/routes.ts", ...watched.map(({ entry }) => entry.atom.scopePath)]),
    ];
    const budget = { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 24576 };
    for (const restricted of [paths, undefined])
      await expectFiniteOwnedContinuationRead(fixture, atoms, budget, watched, restricted);
    expect(JSON.stringify(atoms)).toBe(originalAtoms);
    expect(JSON.stringify(fixture.trace.uncertainty)).toBe(originalUncertainty);
  });

  it("borrows an external file head threshold for a pending owned branch beneath a funded head", async () => {
    const fixture = await coverageFixture(undefined, fundedHeadContinuationFiles());
    const atoms = await allocationAtoms(fixture);
    const originalAtoms = JSON.stringify(atoms);
    const entries = fixture.trace.routeCoverage?.entries ?? [];
    const index = await fixture.requestContext.codeIntelligenceIndex();
    const branch = ["collectInventory", "discoverEntries", "descend", "handleEntry"].map((name) =>
      finiteOwnedContinuationEntry(fixture, entries, index, name),
    );
    const seed = requirePendingBodyFixtureEntry(branch[0], "the actual owned branch seed");
    const prefix = entries.filter((entry) =>
      /^function scopeAdmissionAndPromptFitting\d+\(/u.test(
        fixture.files[entry.atom.scopePath]?.split("\n")[
          (entry.atom.lineRange?.startLine ?? 1) - 1
        ] ?? "",
      ),
    );
    const head = requirePendingBodyFixtureEntry(
      entries.find(
        (entry) =>
          entry.atom.scopePath === seed.atom.scopePath && entry.parentIdentity === undefined,
      ),
      "the selected physical root head",
    );
    const borrowers = entries.filter((entry) =>
      /^src\/record-\d+\.ts$/u.test(entry.atom.scopePath),
    );
    expect(borrowers).toHaveLength(9);
    expect(seed.atom.score).toBeLessThan(head.atom.score);
    expect(borrowers.every((entry) => seed.atom.score >= entry.atom.score)).toBe(true);
    expect(branch.every((entry) => entry.parentWitness?.ownedSourceCall === true)).toBe(true);
    const watched = finiteOwnedContinuationViews(fixture, entries, prefix, branch);
    const headRange = requirePendingBodyFixtureEntry(head.atom.lineRange, "the complete root head");
    const headLines = (fixture.files[head.atom.scopePath] ?? "")
      .split("\n")
      .slice(headRange.startLine - 1, headRange.endLine);
    const protectedViews = [
      { entry: head, range: headRange, lines: headLines, body: headLines.join("\n") },
      ...watched,
    ];
    const paths = [
      ...new Set(["src/routes.ts", ...watched.map(({ entry }) => entry.atom.scopePath)]),
    ];
    const budget = { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 24576 };
    const requiredFunding = new Set([head, ...branch].map((entry) => entry.definitionIdentity));
    for (const restricted of [paths, undefined])
      await expectBorrowedHeadContinuationRead(
        fixture,
        atoms,
        budget,
        protectedViews,
        requiredFunding,
        restricted,
      );
    expect(JSON.stringify(atoms)).toBe(originalAtoms);
  });

  it("keeps a returned continuation before higher-scoring shallow called targets", async () => {
    const fixture = await coverageFixture(undefined, returnedContinuationFiles());
    const target = fixture.trace.routeCoverage?.entries.find(
      (entry) => entry.atom.scopePath === "src/z-processing.ts",
    );
    expect(target).toBeDefined();
    if (target === undefined) throw new TypeError("fixture requires the current continuation");
    expect(fixture.trace.routeCoverage?.isCurrent(target.atom)).toBe(true);
    expect(target.atom.edge?.kind).toBe("reference");
    expect(target.observedBytes).toBe(
      Buffer.byteLength(fixture.files["src/z-processing.ts"] ?? ""),
    );
    const shallow = fixture.trace.routeCoverage?.entries.filter((entry) =>
      entry.atom.scopePath.startsWith("src/helper-"),
    );
    expect(shallow?.length).toBe(9);
    expect(shallow?.every((entry) => entry.atom.score > target.atom.score)).toBe(true);
    const reads = await coverageRead(fixture);
    const pack = await assembledCoveragePack(fixture, reads);
    const prompt = await sentPrompt(fixture, reads);
    expectFullTerminalView(fixture, reads, pack, prompt);
    expect(prompt).toContain(DESCENT_FACT);
    expect(readBytes(reads)).toBeLessThanOrEqual(8192);
    expect(pack.uncertainty.some((item) => item.claim.includes("source-graph-incomplete"))).toBe(
      true,
    );
  });

  it("keeps separately returned same-file connector views through Grounded assembly", async () => {
    const fixture = await coverageFixture(undefined, bulkySameFileConnectorFiles());
    const reads = await coverageRead(fixture);
    const content = readContent(reads, "src/implementation.ts");
    for (let index = 0; index < 8; index += 1)
      expect(content).toContain(`return stage${String(index + 1)}(selectedRoot);`);
    expect(content).toContain(DESCENT_FACT);
    const prompt = await sentPrompt(fixture, reads);
    for (let index = 0; index < 8; index += 1)
      expect(prompt).toContain(`return stage${String(index + 1)}(selectedRoot);`);
    expect(prompt).toContain(DESCENT_FACT);
    expect(readBytes(reads)).toBeLessThanOrEqual(8192);
    const pack = await assembledCoveragePack(fixture, reads);
    expectFullTerminalView(fixture, reads, pack, prompt);
    const excerpts = pack.files.flatMap((file) => file.excerpts);
    expect(excerpts.some((excerpt) => excerpt.atom.edge?.kind === "reference")).toBe(true);
    expect(
      excerpts.every((excerpt) => fixture.trace.routeCoverage?.isCurrent(excerpt.atom) !== true),
    ).toBe(true);
    expect(
      pack.uncertainty.some((marker) => marker.claim.includes("cited ranges unavailable")),
    ).toBe(true);
    expect(
      pack.uncertainty.some((marker) => marker.claim.includes("source-graph-incomplete")),
    ).toBe(true);
    expect(
      fixture.trace.routeCoverage?.entries.every(
        (entry) => fixture.trace.routeCoverage?.isCurrent(entry.atom) === true,
      ),
    ).toBe(true);
  });

  it("sends the full relevant target and observed connectors without funding unrelated ancestor bodies", async () => {
    const fixture = await coverageFixture(undefined, bulkyConnectorFiles());
    const entries = fixture.trace.routeCoverage?.entries ?? [];
    const target = entries.find((entry) => entry.atom.scopePath === "src/stage-8.ts");
    expect(target).toBeDefined();
    if (target === undefined) throw new TypeError("fixture requires a current observed target");
    expect(target.atom.edge?.kind).toBe("reference");
    expect(
      entries.every((entry) => fixture.trace.routeCoverage?.isCurrent(entry.atom) === true),
    ).toBe(true);
    expect(
      entries.every(
        (entry) =>
          entry.observedBytes >=
          Buffer.byteLength(
            (fixture.files[entry.atom.scopePath] ?? "")
              .split("\n")
              .slice((entry.atom.lineRange?.startLine ?? 1) - 1, entry.atom.lineRange?.endLine)
              .join("\n")
              .trim(),
          ),
      ),
    ).toBe(true);
    expect(entries.reduce((sum, entry) => sum + entry.observedBytes, 0)).toBeGreaterThan(8192);
    expect(
      coverageRanking(fixture.trace.atoms).kept.some(
        (entry) => entry.scopePath === target.atom.scopePath,
      ),
    ).toBe(true);
    const reads = await coverageRead(fixture);
    const prompt = await sentPrompt(fixture, reads);
    expect(readContent(reads, "src/stage-8.ts")).toContain(fixture.files["src/stage-8.ts"]);
    expect(prompt).toContain(DESCENT_FACT);
    for (let index = 0; index < 8; index += 1)
      expect(prompt).toContain(`return stage${String(index + 1)}(selectedRoot);`);
    expect(prompt).toContain("return () => stage0(selectedRoot);");
    expect(readBytes(reads)).toBeLessThanOrEqual(8192);
  });

  it("shares the connected grant between two actual registered handler roots", async () => {
    const files = { ...branchCoverageFiles() };
    const secondFact = "return scopeAdmissionCompleted(selectedRoot);";
    files["src/second.ts"] = [
      "export function handleSecond() { return secondTraversal(); }",
      `function secondTraversal() { ${secondFact} }`,
      "function scopeAdmissionCompleted(selectedRoot) { return selectedRoot; }",
    ].join("\n");
    files["src/routes.ts"] += [
      "",
      'import { handleSecond } from "./second.js";',
      'const additionalRoutes = [{ method: "POST", path: "/api/items", handler: handleSecond }];',
    ].join("\n");
    const fixture = await coverageFixture(undefined, files);
    expect(
      fixture.trace.routeCoverage?.entries.filter((entry) => entry.parentIdentity === undefined)
        .length,
    ).toBe(2);
    const reads = await coverageRead(fixture);
    expect(readContent(reads, "src/second.ts")).toContain(secondFact);
    expect(await sentPrompt(fixture, reads)).toContain(secondFact);
    expect(readBytes(reads)).toBeLessThanOrEqual(8192);
  });

  it("gives selected ordinary source without a route certificate a physical read opportunity", async () => {
    const ordinaryFact = "return scopeAdmissionBudget + promptFittingBudget;";
    const fixture = await coverageFixture(undefined, ordinaryCoverageFiles());
    const atoms = [...fixture.ordinaryAtoms, ...fixture.trace.atoms];
    expect(coverageRanking(atoms).kept.some((entry) => entry.scopePath === "src/ordinary.ts")).toBe(
      true,
    );
    expect(
      fixture.trace.routeCoverage?.entries.some(
        (entry) => entry.atom.scopePath === "src/ordinary.ts",
      ),
    ).toBe(false);
    const budget = { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 65536 };
    const normal = await coverageRead(fixture, {
      atoms,
      inputs: { routeCoverage: undefined, budget },
    });
    expect(await sentPrompt(fixture, normal, atoms, budget)).toContain(ordinaryFact);
    const reads = await coverageRead(fixture, { atoms, inputs: { budget } });
    expect(readContent(reads, "src/ordinary.ts")).toContain(ordinaryFact);
    expect(await sentPrompt(fixture, reads, atoms, budget)).toContain(ordinaryFact);
    expect(readBytes(reads)).toBeLessThanOrEqual(budget.excerptBytesMax);
  });

  it("preserves an actually sent ordinary method body under a smaller unchanged byte grant", async () => {
    const ordinaryFact = "return scopeAdmissionBudget + promptFittingBudget;";
    const source = ordinaryCoverageFiles();
    const connected = Object.fromEntries(
      Object.entries(bulkyConnectorFiles()).map(([path, content]) => [
        path,
        content.replace(
          Array.from(
            { length: 28 },
            () => "  // unrelated bookkeeping for the existing ledger",
          ).join("\n"),
          Array.from(
            { length: 12 },
            () => "  // unrelated bookkeeping for the existing ledger",
          ).join("\n"),
        ),
      ]),
    );
    const fixture = await coverageFixture(undefined, {
      ...connected,
      "src/ordinary.ts": source["src/ordinary.ts"] ?? "",
    });
    const atoms = [...fixture.ordinaryAtoms, ...fixture.trace.atoms];
    expect(coverageRanking(atoms).kept.some((entry) => entry.scopePath === "src/ordinary.ts")).toBe(
      true,
    );
    expect(
      fixture.trace.routeCoverage?.entries.some(
        (entry) => entry.atom.scopePath === "src/ordinary.ts",
      ),
    ).toBe(false);
    const normal = await coverageRead(fixture, { atoms, inputs: { routeCoverage: undefined } });
    expect(await sentPrompt(fixture, normal, atoms)).toContain(ordinaryFact);
    const reads = await coverageRead(fixture, { atoms });
    expect(readContent(reads, "src/ordinary.ts")).toContain(ordinaryFact);
    expect(await sentPrompt(fixture, reads, atoms)).toContain(ordinaryFact);
    expect(readBytes(reads)).toBeLessThanOrEqual(8192);
  });

  it("sends a later relevant complete branch before called bookkeeping exhausts its share", async () => {
    const fixture = await coverageFixture(
      "Trace POST /api/items through scope admission recursive candidate discovery and prompt fitting",
      branchCoverageFiles(),
    );
    const target = fixture.trace.routeCoverage?.entries.find((entry) =>
      fixture.files[entry.atom.scopePath]
        ?.split("\n")
        .slice((entry.atom.lineRange?.startLine ?? 1) - 1, entry.atom.lineRange?.endLine)
        .join("\n")
        .includes(DESCENT_FACT),
    );
    expect(target).toBeDefined();
    expect(target?.atom.edge?.kind).toBe("reference");
    if (target === undefined) throw new TypeError("fixture requires an observed target");
    expect(fixture.trace.routeCoverage?.isCurrent(target.atom)).toBe(true);
    const body =
      fixture.files[target.atom.scopePath]
        ?.split("\n")
        .slice((target.atom.lineRange?.startLine ?? 1) - 1, target.atom.lineRange?.endLine)
        .join("\n")
        .trim() ?? "";
    expect(target.observedBytes).toBeGreaterThanOrEqual(Buffer.byteLength(body));
    const reads = await coverageRead(fixture);
    expect(readContent(reads, "src/implementation.ts")).toContain(TERMINAL_FACT);
    expect(await sentPrompt(fixture, reads)).toContain(DESCENT_FACT);
    expect(readBytes(reads)).toBe(8192);
    const windows = reads.excerpts.get("src/implementation.ts") ?? [];
    expect(
      windows.some((window) => windows.some((other) => other.startLine === window.endLine + 1)),
    ).toBe(true);
    expect(windows.every((window) => window.identity !== undefined)).toBe(true);
  });

  it("retains two separate same-file targets sharing the actually observed parent chain", async () => {
    const files = { ...branchCoverageFiles() };
    files["src/implementation.ts"] = (files["src/implementation.ts"] ?? "").replace(
      "function stageTwo() { return selectedTraversal(); }",
      "function stageTwo() { latePromptFitting(); return selectedTraversal(); }",
    );
    const fixture = await coverageFixture(
      "Trace POST /api/items through scope admission recursive candidate discovery and prompt fitting",
      files,
    );
    const reads = await coverageRead(fixture);
    const prompt = await sentPrompt(fixture, reads);
    expect(prompt).toContain(TERMINAL_FACT);
    expect(prompt).toContain(SECOND_TERMINAL_FACT);
    expect(prompt).toContain(DESCENT_FACT);
    expect(readBytes(reads)).toBeLessThanOrEqual(8192);
  });

  it("shares one root's connected grant across files before repeated same-file targets", async () => {
    const fixture = await coverageFixture(undefined, repeatedFileCoverageFiles());
    const entries = fixture.trace.routeCoverage?.entries ?? [];
    const target = entries.find((entry) => entry.atom.scopePath === "src/z-processing.ts");
    const helpers = entries.filter(
      (entry) =>
        entry.atom.scopePath === "src/implementation.ts" &&
        fixture.files[entry.atom.scopePath]
          ?.split("\n")
          .slice((entry.atom.lineRange?.startLine ?? 1) - 1, entry.atom.lineRange?.endLine)
          .join("\n")
          .includes("return false;"),
    );
    expect(target).toBeDefined();
    if (target === undefined) throw new TypeError("fixture requires a connected target");
    expect(target.atom.edge?.kind).toBe("reference");
    expect(fixture.trace.routeCoverage?.isCurrent(target.atom)).toBe(true);
    expect(target.observedBytes).toBeGreaterThanOrEqual(
      Buffer.byteLength(fixture.files["src/z-processing.ts"] ?? ""),
    );
    expect(helpers.length).toBe(9);
    expect(helpers.every((entry) => entry.atom.score > target.atom.score)).toBe(true);
    expect(
      coverageRanking(fixture.trace.atoms).kept.some(
        (entry) => entry.scopePath === target.atom.scopePath,
      ),
    ).toBe(true);
    const reads = await coverageRead(fixture);
    expect(readContent(reads, "src/implementation.ts")).toContain(CONNECTOR_FACT);
    expect(await sentPrompt(fixture, reads)).toContain(DESCENT_FACT);
    expect(readBytes(reads)).toBeLessThanOrEqual(8192);
  });

  it("sends the actual route registration through public retrieval under the existing byte grant", async () => {
    const fixture = await coverageFixture(undefined, sameFileCoverageFiles());
    const result = await actualPublicRetrieval(fixture);
    const prompt = buildGroundedGatewayMessages(fixture.query.text, result.pack, (value) => value)
      .map((message) => message.content)
      .join("\n");
    expect(result.pack.usage.excerptBytes).toBeLessThanOrEqual(8192);
    expect(prompt).toContain('router.post("/api/items", handleItem);');
  });

  it("retains the actual connector and continuation when both bodies share a selected file", async () => {
    const fixture = await coverageFixture(undefined, sameFileCoverageFiles());
    expect(fixture.files["src/z-processing.ts"]).toBeUndefined();
    const reads = await coverageRead(fixture);
    expect(readContent(reads, "src/implementation.ts")).toContain(CONNECTOR_FACT);
    expect(readContent(reads, "src/implementation.ts")).toContain(DESCENT_FACT);
    const prompt = await sentPrompt(fixture, reads);
    expect(prompt).toContain(CONNECTOR_FACT);
    expect(prompt).toContain(DESCENT_FACT);
    expect(readBytes(reads)).toBeLessThanOrEqual(8192);
  });

  it("preserves the ordinary first-ranked registration under the same one-file grant", async () => {
    const fixture = await coverageFixture("Trace POST /api/items", configuredCoverageFiles());
    const atoms = await allocationAtoms(fixture);
    const budget = { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 8192, filesReadMax: 1 };
    const normal = await coverageRead(fixture, {
      atoms,
      inputs: { routeCoverage: undefined, budget },
    });
    expect(readContent(normal, "src/routes.ts")).toContain(REGISTRATION_FACT);
    const reads = await coverageRead(fixture, { atoms, inputs: { budget } });
    expect(readContent(reads, "src/routes.ts")).toContain(REGISTRATION_FACT);
    expect(await sentPrompt(fixture, reads, atoms, budget)).toContain(REGISTRATION_FACT);
    expect(reads.excerpts.size).toBe(1);
  });

  it("preserves the normally ranked same-file fitting and scope body under the same byte grant", async () => {
    const fixture = await coverageFixture(
      "Trace POST /api/items and explain promptFittingBudget and scopeAdmissionBudget",
      allocationFiles(),
    );
    const atoms = [...fixture.ordinaryAtoms, ...fixture.trace.atoms];
    const budget = { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 8192 };
    const normal = await coverageRead(fixture, {
      atoms,
      inputs: { routeCoverage: undefined, budget },
    });
    expect(await sentPrompt(fixture, normal, atoms, budget)).toContain(FITTING_FACT);
    const reads = await coverageRead(fixture, { atoms, inputs: { budget } });
    expect(readContent(reads, "src/implementation.ts")).toContain(FITTING_FACT);
    expect(await sentPrompt(fixture, reads, atoms, budget)).toContain(FITTING_FACT);
    expect(readBytes(reads)).toBeLessThanOrEqual(budget.excerptBytesMax);
  });

  it("retains registration and the later connected cross-file body within the existing byte grant", async () => {
    const fixture = await coverageFixture("Trace POST /api/items", configuredCoverageFiles());
    const atoms = await allocationAtoms(fixture);
    const reads = await coverageRead(fixture, { atoms });
    const prompt = await sentPrompt(fixture, reads, atoms);
    expect(prompt).toContain(REGISTRATION_FACT);
    expect(prompt).toContain(CONNECTOR_FACT);
    expect(prompt).toContain(DESCENT_FACT);
    expect(readBytes(reads)).toBeLessThanOrEqual(8192);
  });

  it("retains the actual low-relevance parent connector within a crowded selected file", async () => {
    const fixture = await coverageFixture();
    const connectorLine =
      (coverageFiles()["src/implementation.ts"] ?? "")
        .split("\n")
        .findIndex((line) => line.includes(CONNECTOR_FACT)) + 1;
    expect(
      fixture.trace.atoms.some(
        (atom) =>
          atom.scopePath === "src/implementation.ts" && atom.lineRange?.startLine === connectorLine,
      ),
    ).toBe(true);
    const reads = await coverageRead(fixture);
    expect(readContent(reads, "src/implementation.ts")).toContain(CONNECTOR_FACT);
    expect(await sentPrompt(fixture, reads)).toContain(CONNECTOR_FACT);
  });

  it("reads the actual recursive body across files before bookkeeping consumes the byte grant", async () => {
    const fixture = await coverageFixture();
    expect(fixture.trace.atoms.some((atom) => atom.scopePath === "src/z-processing.ts")).toBe(true);
    await readExcerpt(
      fixture.searchScope,
      {
        scopePath: "src/z-processing.ts",
        startLine: 1,
        endLine: 4,
        maxBytes: 8192,
      },
      { fs: fixture.fs, nowMs: () => NOW },
    );
    const singleReadCount = fixture.reads.get("/workspace/src/z-processing.ts");
    expect(singleReadCount).toBeGreaterThan(0);
    fixture.reads.clear();
    const { reads, requests } = await observedCoverageRead(fixture);
    expectTargetCoverageFunding(fixture, requests, "src/z-processing.ts", true);
    expect(readContent(reads, "src/z-processing.ts")).toContain(DESCENT_FACT);
    expect(await sentPrompt(fixture, reads)).toContain(DESCENT_FACT);
    expect(fixture.reads.size).toBeGreaterThan(0);
    // Expansion uses at most one fresh, fingerprint-checked batch after the initial portions.
    const readsPerBatch = singleReadCount ?? 0;
    expect(
      [...fixture.reads.values()].every(
        (count) => count === readsPerBatch || count === 2 * readsPerBatch,
      ),
    ).toBe(true);
    expect(
      fixture.trace.uncertainty.some((marker) => marker.claim.includes("source-graph-incomplete")),
    ).toBe(true);
  });

  it.each(["scope", "filesystem", "query identity", "no certificate"])(
    "does not apply route coverage through a foreign %s binding",
    async (binding) => {
      const fixture = await coverageFixture();
      const inputs: Partial<ExcerptInputs> =
        binding === "scope"
          ? { searchScope: { ...fixture.searchScope } }
          : binding === "filesystem"
            ? { fs: memFs(fixture.searchScope.workspace.root, fixture.files) }
            : binding === "no certificate"
              ? { routeCoverage: undefined }
              : {};
      const atoms =
        binding === "query identity"
          ? fixture.trace.atoms.map((atom) => ({
              ...atom,
              provenance: { ...atom.provenance, queryFingerprint: "foreign-query" },
            }))
          : fixture.trace.atoms;
      const { reads, requests } = await observedCoverageRead(fixture, { atoms, inputs });
      expectTargetCoverageFunding(fixture, requests, "src/z-processing.ts", false);
      expect(readContent(reads, "src/z-processing.ts")).toContain(DESCENT_FACT);
      expect(readBytes(reads)).toBeLessThanOrEqual(8192);
    },
  );

  it("cannot append an unselected path or reconnect a target whose selected parent was removed", async () => {
    const fixture = await coverageFixture();
    const paths = ["src/implementation.ts"];
    const limited = await coverageRead(fixture, { paths });
    expect([...limited.excerpts.keys()]).toEqual(paths);
    const target = fixture.trace.routeCoverage?.entries.find(
      (entry) => entry.atom.scopePath === "src/z-processing.ts",
    );
    const parent = fixture.trace.routeCoverage?.entries.find(
      (entry) => entry.definitionIdentity === target?.parentIdentity,
    );
    expect(parent).toBeDefined();
    const atoms = fixture.trace.atoms.filter((atom) => atom.stableId !== parent?.atom.stableId);
    expect(atoms.length).toBeLessThan(fixture.trace.atoms.length);
    const { reads: disconnected, requests } = await observedCoverageRead(fixture, { atoms });
    expectTargetCoverageFunding(fixture, requests, "src/z-processing.ts", false);
    expect(readContent(disconnected, "src/z-processing.ts")).toContain(DESCENT_FACT);
  });

  it("does not retain the priority of an indexed definition after its source changes", async () => {
    const fixture = await coverageFixture();
    fixture.files["src/implementation.ts"] =
      (fixture.files["src/implementation.ts"] ?? "") + "\n// changed after trace admission";
    const { reads, requests } = await observedCoverageRead(fixture);
    expectTargetCoverageFunding(fixture, requests, "src/z-processing.ts", false);
    expect(readContent(reads, "src/z-processing.ts")).toContain(DESCENT_FACT);
    expect(readBytes(reads)).toBeLessThanOrEqual(8192);
  });

  it("retains exact source scores and reference uncertainty while applying a finite file grant", async () => {
    const fixture = await coverageFixture();
    const before = JSON.stringify(fixture.trace.atoms);
    const reads = await coverageRead(fixture, {
      inputs: { budget: { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 8192, filesReadMax: 1 } },
    });
    expect(reads.excerpts.size).toBe(1);
    expect(fixture.reads.size).toBe(1);
    expect(reads.observation?.stopReasons).toContain("file-grant");
    expect(JSON.stringify(fixture.trace.atoms)).toBe(before);
    expect(readContent(reads, "src/z-processing.ts")).not.toContain(DESCENT_FACT);
  });

  it("charges prior bytes and preserves omissions under a tight remaining byte grant", async () => {
    const fixture = await coverageFixture();
    const reads = await coverageRead(fixture, {
      inputs: {
        budget: { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 8192 },
        initialUsage: { ...USAGE, excerptBytes: 8064 },
      },
    });
    expect(readBytes(reads)).toBeLessThanOrEqual(128);
    expect(reads.observation?.stopReasons).toContain("byte-grant");
    expect(
      (reads.observation?.omittedRangeCount ?? 0) + (reads.observation?.unreadFileCount ?? 0),
    ).toBeGreaterThan(0);
    expect(readContent(reads, "src/z-processing.ts")).not.toContain(DESCENT_FACT);
  });

  it("does no excerpt reads after the deadline or cancellation", async () => {
    const fixture = await coverageFixture();
    const deadline = await coverageRead(fixture, { inputs: { deadlineAtMs: NOW } });
    expect(deadline.excerpts.size).toBe(0);
    expect(deadline.observation?.stopReasons).toContain("deadline");
    expect(fixture.reads.size).toBe(0);
    expect(fixture.checks).toEqual({ stat: 0, realPath: 0 });
    const controller = new AbortController();
    controller.abort();
    await expect(coverageRead(fixture, { inputs: { signal: controller.signal } })).rejects.toThrow(
      /cancel/iu,
    );
    expect(fixture.reads.size).toBe(0);
    expect(fixture.checks).toEqual({ stat: 0, realPath: 0 });
  });

  it("requires the exact request-local declaration certificate even for a same-location clone", async () => {
    const fixture = await coverageFixture();
    const entry = fixture.trace.routeCoverage?.entries[0];
    expect(entry).toBeDefined();
    if (entry === undefined) throw new TypeError("fixture requires an observed route definition");
    expect(fixture.trace.routeCoverage?.isCurrent(entry.atom)).toBe(true);
    expect(fixture.trace.routeCoverage?.isCurrent({ ...entry.atom })).toBe(false);
  });

  it("retains the actual human path:line selection before route coverage under a one-file grant", async () => {
    const fixture = await coverageFixture(
      "Trace POST /api/items through scope admission recursive candidate discovery and prompt fitting; inspect src/helper-8.ts:1",
    );
    const explicit = await actualExplicitAtoms(fixture);
    expect(explicit.some((atom) => atom.scopePath === "src/helper-8.ts")).toBe(true);
    fixture.reads.clear();
    const reads = await coverageRead(fixture, {
      atoms: [...fixture.trace.atoms, ...explicit],
      inputs: { budget: { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 8192, filesReadMax: 1 } },
    });
    expect([...reads.excerpts.keys()]).toEqual(["src/helper-8.ts"]);
    expect(readContent(reads, "src/helper-8.ts")).toContain("export function bookkeeping8()");
    expect(fixture.reads.size).toBe(1);
    expect(reads.anchoredWindowCount).toBeGreaterThan(0);
    expect(reads.observation?.stopReasons).toContain("file-grant");
    fixture.files["src/helper-8.ts"] =
      (fixture.files["src/helper-8.ts"] ?? "") + "\n// changed after trace admission";
    const changed = await coverageRead(fixture, {
      paths: ["src/helper-8.ts"],
      atoms: [...fixture.trace.atoms, ...explicit],
      inputs: { budget: { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 8192, filesReadMax: 1 } },
    });
    expect(readContent(changed, "src/helper-8.ts")).toContain("export function bookkeeping8()");
    expect(changed.anchoredWindowCount).toBeGreaterThan(0);
  });
});
