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
import {
  createStructuralAdapterRequestContext,
  type StructuralAdapterRequestContext,
} from "./structuralAdapterRequestContext.js";
import {
  createStructuralExecutionControl,
  executionControlledWorkspaceFs,
  structuralExecutionStopped,
  type StructuralExecutionControl,
} from "./structuralExecution.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface StructuralAdapterDeps {
  readonly nowMs?: () => number;
  readonly deadlineAtMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly requestContext?: StructuralAdapterRequestContext | undefined;
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
  readonly candidateLimitReached?: boolean | undefined;
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

type StructuralStageResult<T> =
  { readonly status: "completed"; readonly value: T } | { readonly status: "stopped" };

interface StructuralStopWait {
  readonly promise: Promise<StructuralStageResult<never>>;
  readonly removeListener: () => void;
}

interface StructuralRunnerExecution {
  readonly control: StructuralExecutionControl;
  readonly finish: () => void;
}

function structuralStopWait(signal: AbortSignal): StructuralStopWait {
  let removeListener = (): void => undefined;
  const promise = new Promise<StructuralStageResult<never>>((resolve) => {
    const onAbort = (): void => {
      resolve({ status: "stopped" });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    removeListener = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    if (signal.aborted) onAbort();
  });
  return { promise, removeListener };
}

async function awaitStructuralStage<T>(
  control: StructuralExecutionControl,
  operation: () => Promise<T>,
): Promise<StructuralStageResult<T>> {
  if (structuralExecutionStopped(control)) return { status: "stopped" };
  const signal = control.signal;
  if (signal === undefined) throw new TypeError("structural runner signal is unavailable");
  const stopped = structuralStopWait(signal);
  const completed = Promise.resolve()
    .then(operation)
    .then((value): StructuralStageResult<T> => ({ status: "completed", value }));
  try {
    const result = await Promise.race([completed, stopped.promise]);
    return structuralExecutionStopped(control) ? { status: "stopped" } : result;
  } finally {
    stopped.removeListener();
  }
}

function createStructuralRunnerExecution(
  elapsedMsMax: number,
  nowMs: () => number,
  signal: AbortSignal | undefined,
  deadlineAtMs: number | undefined,
): StructuralRunnerExecution {
  const deadlineController = new AbortController();
  const effectiveSignal =
    signal === undefined
      ? deadlineController.signal
      : AbortSignal.any([signal, deadlineController.signal]);
  const control = createStructuralExecutionControl(
    elapsedMsMax,
    nowMs,
    effectiveSignal,
    deadlineAtMs,
  );
  const remainingMs = control.deadlineAtMs - control.nowMs();
  if (remainingMs <= 0) deadlineController.abort();
  const timeout =
    remainingMs <= 0
      ? undefined
      : setTimeout(
          () => {
            deadlineController.abort();
          },
          Math.min(Math.ceil(remainingMs), 2_147_483_647),
        );
  timeout?.unref();
  return {
    control,
    finish: (): void => {
      if (timeout !== undefined) clearTimeout(timeout);
      deadlineController.abort();
    },
  };
}

async function adapterAvailable(
  adapter: StructuralAdapter,
  scope: SearchScope,
  fs: WorkspaceFs,
): Promise<boolean> {
  try {
    return await adapter.isAvailable(scope, fs);
  } catch {
    return false;
  }
}

async function probeAvailability(
  adapters: readonly StructuralAdapter[],
  scope: SearchScope,
  fs: WorkspaceFs,
  control: StructuralExecutionControl,
): Promise<readonly AvailabilityRow[]> {
  const rows = await Promise.all(
    adapters.map(async (adapter): Promise<AvailabilityRow | undefined> => {
      if (structuralExecutionStopped(control)) return undefined;
      const result = await awaitStructuralStage(control, () =>
        adapterAvailable(adapter, scope, fs),
      );
      return result.status === "stopped" ? undefined : { adapter, available: result.value };
    }),
  );
  return rows.filter((row): row is AvailabilityRow => row !== undefined);
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

function stoppedLookupOutcome(name: string): LookupOutcome {
  return { name, atoms: [], error: undefined, coverage: undefined };
}

async function coverageFor(
  adapter: StructuralAdapter,
  scope: SearchScope,
  limits: SearchLimits,
  fs: WorkspaceFs,
  deps: StructuralAdapterDeps | undefined,
  control: StructuralExecutionControl,
): Promise<StructuralCoverageDiagnostics | undefined> {
  const coverage = adapter.coverage;
  if (coverage === undefined || structuralExecutionStopped(control)) {
    return undefined;
  }
  try {
    const result = await awaitStructuralStage(control, () => coverage(scope, limits, fs, deps));
    return result.status === "stopped" ? undefined : result.value;
  } catch {
    deps?.requestContext?.assertGraphBinding(scope, limits, fs);
    return undefined;
  }
}

async function completedLookupOutcome(
  adapter: StructuralAdapter,
  scope: SearchScope,
  query: RetrievalQuery,
  limits: SearchLimits,
  fs: WorkspaceFs,
  deps: StructuralAdapterDeps | undefined,
  control: StructuralExecutionControl,
): Promise<LookupOutcome> {
  const lookup = await awaitStructuralStage(control, () =>
    adapter.lookup(scope, query, limits, fs, deps),
  );
  if (lookup.status === "stopped") return stoppedLookupOutcome(adapter.name);
  const atoms = lookup.value;
  deps?.requestContext?.assertGraphBinding(scope, limits, fs);
  if (structuralExecutionStopped(control)) return stoppedLookupOutcome(adapter.name);
  const coverage = await coverageFor(adapter, scope, limits, fs, deps, control);
  deps?.requestContext?.assertGraphBinding(scope, limits, fs);
  return structuralExecutionStopped(control)
    ? stoppedLookupOutcome(adapter.name)
    : { name: adapter.name, atoms, error: undefined, coverage };
}

function failedLookupOutcome(adapter: StructuralAdapter, error: unknown): LookupOutcome {
  return {
    name: adapter.name,
    atoms: [],
    error: { name: adapter.name, message: describeError(error) },
    coverage: undefined,
  };
}

async function runOne(
  adapter: StructuralAdapter,
  scope: SearchScope,
  query: RetrievalQuery,
  limits: SearchLimits,
  fs: WorkspaceFs,
  deps: StructuralAdapterDeps | undefined,
  control: StructuralExecutionControl,
): Promise<LookupOutcome> {
  if (structuralExecutionStopped(control)) return stoppedLookupOutcome(adapter.name);
  try {
    return await completedLookupOutcome(adapter, scope, query, limits, fs, deps, control);
  } catch (error) {
    deps?.requestContext?.assertGraphBinding(scope, limits, fs);
    if (structuralExecutionStopped(control)) return stoppedLookupOutcome(adapter.name);
    if (isTypedAdapterError(error)) throw error;
    return failedLookupOutcome(adapter, error);
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

function effectiveStructuralDeps(
  scope: SearchScope,
  limits: SearchLimits,
  fs: WorkspaceFs,
  deps: StructuralAdapterDeps | undefined,
  control: StructuralExecutionControl,
): StructuralAdapterDeps {
  return {
    ...deps,
    nowMs: control.nowMs,
    deadlineAtMs: control.deadlineAtMs,
    ...(control.signal === undefined ? {} : { signal: control.signal }),
    requestContext:
      deps?.requestContext ??
      createStructuralAdapterRequestContext(scope, limits, fs, {
        nowMs: control.nowMs,
        deadlineAtMs: control.deadlineAtMs,
        ...(control.signal === undefined ? {} : { signal: control.signal }),
      }),
  };
}

interface AvailableAdapters {
  readonly available: readonly StructuralAdapter[];
  readonly unavailable: readonly string[];
}

function availableAdapters(rows: readonly AvailabilityRow[]): AvailableAdapters {
  const available: StructuralAdapter[] = [];
  const unavailable: string[] = [];
  for (const row of rows) {
    if (row.available) available.push(row.adapter);
    else unavailable.push(row.adapter.name);
  }
  return { available, unavailable };
}

function outcomeErrors(outcomes: readonly LookupOutcome[]): readonly AdapterError[] {
  return outcomes
    .map((outcome) => outcome.error)
    .filter((error): error is AdapterError => error !== undefined);
}

function outcomeCoverage(
  outcomes: readonly LookupOutcome[],
): readonly StructuralCoverageDiagnostics[] {
  return outcomes
    .map((outcome) => outcome.coverage)
    .filter(
      (diagnostics): diagnostics is StructuralCoverageDiagnostics => diagnostics !== undefined,
    );
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
  const execution = createStructuralRunnerExecution(
    limits.elapsedMsMax,
    nowMs,
    deps?.signal,
    deps?.deadlineAtMs,
  );
  const { control } = execution;
  const controlledFs = executionControlledWorkspaceFs(fs, control);
  const effectiveDeps = effectiveStructuralDeps(scope, limits, controlledFs, deps, control);
  try {
    // A request context contains scope-bound filesystem evidence. Validate once at the runner
    // boundary so no adapter can accidentally re-label cached atoms for another scope or limit set.
    effectiveDeps.requestContext?.assertGraphBinding(scope, limits, controlledFs);
    const startMs = nowMs();
    const availability = await probeAvailability(registry.adapters, scope, controlledFs, control);
    effectiveDeps.requestContext?.assertGraphBinding(scope, limits, controlledFs);
    const partitioned = availableAdapters(availability);
    const outcomes = await Promise.all(
      partitioned.available.map((adapter) =>
        runOne(adapter, scope, query, limits, controlledFs, effectiveDeps, control),
      ),
    );
    effectiveDeps.requestContext?.assertGraphBinding(scope, limits, controlledFs);
    const cap = Math.min(limits.maxMatchesReturned, query.maxResults);
    return {
      atoms: mergeAtoms(outcomes, cap),
      unavailable: partitioned.unavailable,
      errored: outcomeErrors(outcomes),
      coverage: outcomeCoverage(outcomes),
      elapsedMs: nowMs() - startMs,
    };
  } finally {
    execution.finish();
  }
}
