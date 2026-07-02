// Optional structural exploration adapter contract + default registry (Epic #177, Issue #180).
// Adapters surface structural signals (test/source pairing, import graph, git history) and
// degrade gracefully when their data sources are missing. Output is normalized to EvidenceAtom
// from @oscharko-dev/keiko-contracts; the runner merges, dedupes, and caps adapter output so
// one broken adapter never blocks the rest. Stays within ADR-0019 rule 3b.

import type { EvidenceAtom, RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { RepoSearchInvalidQueryError, RepoSearchInvalidRangeError } from "./errors.js";
import type { WorkspaceFs } from "./fs.js";
import type { SearchLimits, SearchScope } from "./repoSearch.js";
import { testSourcePairingAdapter } from "./testSourcePairing.js";
import { symbolGraphAdapter } from "./symbolGraph.js";
import { importGraphAdapter } from "./importGraph.js";
import { endpointContractAdapter } from "./endpointContractAdapter.js";
import { gitHistoryAdapter } from "./gitHistory.js";
import { ECOSYSTEMS, type Ecosystem } from "./ecosystems.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface StructuralAdapterDeps {
  readonly nowMs?: () => number;
}

export interface StructuralAdapter {
  readonly name: string;
  // Cheap availability probe. Must never throw; return false on any internal error.
  readonly isAvailable: (scope: SearchScope, fs: WorkspaceFs) => Promise<boolean>;
  // Produces zero or more EvidenceAtoms. May throw only typed query/range errors; any other
  // failure is caught by the runner and surfaced as an `errored` entry.
  readonly lookup: (
    scope: SearchScope,
    query: RetrievalQuery,
    limits: SearchLimits,
    fs: WorkspaceFs,
    deps?: StructuralAdapterDeps,
  ) => Promise<readonly EvidenceAtom[]>;
  readonly coverage?: (
    scope: SearchScope,
    limits: SearchLimits,
    fs: WorkspaceFs,
    deps?: StructuralAdapterDeps,
  ) => Promise<StructuralCoverageDiagnostics | undefined>;
}

export interface StructuralAdapterRegistry {
  readonly adapters: readonly StructuralAdapter[];
}

export interface StructuralAdapterRegistryOptions {
  readonly ecosystems?: readonly Ecosystem[];
}

export interface AdapterError {
  readonly name: string;
  readonly message: string;
}

export interface StructuralParserCoverage {
  readonly parser: string;
  readonly filesIndexed: number;
}

export interface StructuralCoverageDiagnostics {
  readonly name: string;
  readonly filesIndexed: number;
  readonly filesSkipped: number;
  readonly filesPartiallyIndexed?: number | undefined;
  readonly parserCoverage: readonly StructuralParserCoverage[];
}

export interface RunAllResult {
  readonly atoms: readonly EvidenceAtom[];
  readonly unavailable: readonly string[];
  readonly errored: readonly AdapterError[];
  readonly coverage: readonly StructuralCoverageDiagnostics[];
  readonly elapsedMs: number;
}

// ─── Default registry ─────────────────────────────────────────────────────────

function createEcosystemStructureAdapter(ecosystem: Ecosystem): StructuralAdapter | undefined {
  const extractor = ecosystem.structure?.extractor;
  if (extractor === undefined) {
    return undefined;
  }
  return {
    name: `ecosystem-structure:${ecosystem.id}:${extractor.name}`,
    isAvailable: (scope, fs): Promise<boolean> =>
      Promise.resolve(extractor.isAvailable?.({ ecosystem, scope, fs }) ?? true).catch(() => false),
    lookup: (scope, query, limits, fs, deps): Promise<readonly EvidenceAtom[]> =>
      extractor.extract(
        deps === undefined
          ? { ecosystem, scope, query, limits, fs }
          : { ecosystem, scope, query, limits, fs, deps },
      ),
  };
}

export function createEcosystemStructureAdapters(
  ecosystems: readonly Ecosystem[] = ECOSYSTEMS,
): readonly StructuralAdapter[] {
  return ecosystems
    .map((ecosystem) => createEcosystemStructureAdapter(ecosystem))
    .filter((adapter): adapter is StructuralAdapter => adapter !== undefined);
}

export function createDefaultStructuralRegistry(
  options: StructuralAdapterRegistryOptions = {},
): StructuralAdapterRegistry {
  const ecosystemAdapters = createEcosystemStructureAdapters(options.ecosystems ?? ECOSYSTEMS);
  return {
    adapters: [
      testSourcePairingAdapter,
      symbolGraphAdapter,
      importGraphAdapter,
      endpointContractAdapter,
      ...ecosystemAdapters,
      gitHistoryAdapter,
    ],
  };
}

// ─── Runner ───────────────────────────────────────────────────────────────────

interface AvailabilityRow {
  readonly adapter: StructuralAdapter;
  readonly available: boolean;
}

async function probeAvailability(
  adapters: readonly StructuralAdapter[],
  scope: SearchScope,
  fs: WorkspaceFs,
): Promise<readonly AvailabilityRow[]> {
  return Promise.all(
    adapters.map(async (adapter) => ({
      adapter,
      available: await adapter.isAvailable(scope, fs).catch(() => false),
    })),
  );
}

function isTypedAdapterError(error: unknown): boolean {
  return (
    error instanceof RepoSearchInvalidQueryError || error instanceof RepoSearchInvalidRangeError
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface LookupOutcome {
  readonly name: string;
  readonly atoms: readonly EvidenceAtom[];
  readonly error: AdapterError | undefined;
  readonly coverage: StructuralCoverageDiagnostics | undefined;
}

async function coverageFor(
  adapter: StructuralAdapter,
  scope: SearchScope,
  limits: SearchLimits,
  fs: WorkspaceFs,
  deps: StructuralAdapterDeps | undefined,
): Promise<StructuralCoverageDiagnostics | undefined> {
  if (adapter.coverage === undefined) {
    return undefined;
  }
  try {
    return await adapter.coverage(scope, limits, fs, deps);
  } catch {
    return undefined;
  }
}

async function runOne(
  adapter: StructuralAdapter,
  scope: SearchScope,
  query: RetrievalQuery,
  limits: SearchLimits,
  fs: WorkspaceFs,
  deps: StructuralAdapterDeps | undefined,
): Promise<LookupOutcome> {
  try {
    const atoms = await adapter.lookup(scope, query, limits, fs, deps);
    const coverage = await coverageFor(adapter, scope, limits, fs, deps);
    return { name: adapter.name, atoms, error: undefined, coverage };
  } catch (error) {
    if (isTypedAdapterError(error)) {
      throw error;
    }
    return {
      name: adapter.name,
      atoms: [],
      error: { name: adapter.name, message: describeError(error) },
      coverage: undefined,
    };
  }
}

function mergeAtoms(outcomes: readonly LookupOutcome[], cap: number): readonly EvidenceAtom[] {
  const seen = new Set<string>();
  const merged: EvidenceAtom[] = [];
  for (const outcome of outcomes) {
    for (const atom of outcome.atoms) {
      if (merged.length >= cap) {
        return merged;
      }
      if (seen.has(atom.stableId)) {
        continue;
      }
      seen.add(atom.stableId);
      merged.push(atom);
    }
  }
  return merged;
}

export async function runStructuralAdapters(
  registry: StructuralAdapterRegistry,
  scope: SearchScope,
  query: RetrievalQuery,
  limits: SearchLimits,
  fs: WorkspaceFs,
  deps?: StructuralAdapterDeps,
): Promise<RunAllResult> {
  const nowMs = deps?.nowMs ?? Date.now;
  const startMs = nowMs();
  const availability = await probeAvailability(registry.adapters, scope, fs);
  const unavailable: string[] = [];
  const available: StructuralAdapter[] = [];
  for (const row of availability) {
    if (row.available) {
      available.push(row.adapter);
    } else {
      unavailable.push(row.adapter.name);
    }
  }
  const outcomes = await Promise.all(
    available.map((adapter) => runOne(adapter, scope, query, limits, fs, deps)),
  );
  const errored = outcomes
    .map((outcome) => outcome.error)
    .filter((error): error is AdapterError => error !== undefined);
  const coverage = outcomes
    .map((outcome) => outcome.coverage)
    .filter((diagnostics): diagnostics is StructuralCoverageDiagnostics => diagnostics !== undefined);
  const cap = Math.min(limits.maxMatchesReturned, query.maxResults);
  const atoms = mergeAtoms(outcomes, cap);
  return {
    atoms,
    unavailable,
    errored,
    coverage,
    elapsedMs: nowMs() - startMs,
  };
}
