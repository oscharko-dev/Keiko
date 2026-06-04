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
import { importGraphAdapter } from "./importGraph.js";
import { gitHistoryAdapter } from "./gitHistory.js";

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
}

export interface StructuralAdapterRegistry {
  readonly adapters: readonly StructuralAdapter[];
}

export interface AdapterError {
  readonly name: string;
  readonly message: string;
}

export interface RunAllResult {
  readonly atoms: readonly EvidenceAtom[];
  readonly unavailable: readonly string[];
  readonly errored: readonly AdapterError[];
  readonly elapsedMs: number;
}

// ─── Default registry ─────────────────────────────────────────────────────────

export function createDefaultStructuralRegistry(): StructuralAdapterRegistry {
  return {
    adapters: [testSourcePairingAdapter, importGraphAdapter, gitHistoryAdapter],
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
    return { name: adapter.name, atoms, error: undefined };
  } catch (error) {
    if (isTypedAdapterError(error)) {
      throw error;
    }
    return {
      name: adapter.name,
      atoms: [],
      error: { name: adapter.name, message: describeError(error) },
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
  const cap = Math.min(limits.maxMatchesReturned, query.maxResults);
  const atoms = mergeAtoms(outcomes, cap);
  return {
    atoms,
    unavailable,
    errored,
    elapsedMs: nowMs() - startMs,
  };
}
