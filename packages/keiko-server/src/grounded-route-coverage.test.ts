import { describe, expect, it } from "vitest";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
  type ConnectedContextPack,
  type EvidenceAtom,
  type ExplorationUsage,
  type RetrievalQuery,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { assembleContextPack, rankCandidates } from "@oscharko-dev/keiko-workflows";
import { readExcerpt, type SearchScope, type WorkspaceFs } from "@oscharko-dev/keiko-workspace";
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
  readonly paths?: readonly string[];
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
): ReturnType<typeof retrieveConnectedContextPack> {
  return retrieveConnectedContextPack(
    {
      scope: fixture.scope,
      query: fixture.query,
      workspaceRoot: fixture.searchScope.workspace.root,
      budget: { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 8192 },
    },
    {
      correlationId: undefined,
      fs: fixture.fs,
      nowMs: () => NOW,
      detectWorkspace: () => fixture.searchScope.workspace,
      answerer: { answer: () => Promise.resolve("observed source") },
      activityLog: createBufferedServerLogSink(),
    },
  );
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

describe("current route trace excerpt coverage", () => {
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
    const reads = await coverageRead(fixture);
    expect(readContent(reads, "src/z-processing.ts")).toContain(DESCENT_FACT);
    expect(await sentPrompt(fixture, reads)).toContain(DESCENT_FACT);
    expect(fixture.reads.size).toBeGreaterThan(0);
    expect([...fixture.reads.values()].every((count) => count === singleReadCount)).toBe(true);
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
      const reads = await coverageRead(fixture, { atoms, inputs });
      expect(readContent(reads, "src/z-processing.ts")).not.toContain(DESCENT_FACT);
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
    const disconnected = await coverageRead(fixture, { atoms });
    expect(readContent(disconnected, "src/z-processing.ts")).not.toContain(DESCENT_FACT);
  });

  it("does not retain the priority of an indexed definition after its source changes", async () => {
    const fixture = await coverageFixture();
    fixture.files["src/implementation.ts"] =
      (fixture.files["src/implementation.ts"] ?? "") + "\n// changed after trace admission";
    const reads = await coverageRead(fixture);
    expect(readContent(reads, "src/z-processing.ts")).not.toContain(DESCENT_FACT);
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
