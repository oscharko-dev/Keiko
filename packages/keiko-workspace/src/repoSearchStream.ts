import type { CandidateFile, EvidenceAtom } from "@oscharko-dev/keiko-contracts/connected-context";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import { visitWorkspaceFiles } from "./discovery.js";
import {
  extraIgnoreLinesForSearch,
  orderCandidatesForSearch,
  candidateBucketForPath,
  policyOmissionReason,
  type SearchDiagnostics,
  type CandidateBucket,
  type RankedCandidateDiagnostic,
} from "./repoSearchPolicy.js";
import {
  collectFileMatches,
  emitFileMatches,
  fileListingTextIsReadable,
  buildAtom,
  type RunState,
  type SearchTextRunner,
  type FileMatches,
} from "./repoSearchScan.js";
import {
  StructuralExecutionStoppedError,
  type StructuralExecutionControl,
} from "./structuralExecution.js";
import type { DiscoveredFile } from "./types.js";

interface RankedStreamAtom {
  readonly atom: EvidenceAtom;
  readonly definition: boolean;
  readonly pathScore: number;
}

export interface StreamedSearchCollection {
  readonly atoms: readonly EvidenceAtom[];
  readonly candidates: readonly CandidateFile[];
  readonly state: RunState;
  readonly filesDiscovered: number;
  readonly filesAfterPolicy: number;
  readonly filesSkipped: number;
  readonly ignored: number;
  readonly denied: number;
  readonly diagnostics: SearchDiagnostics;
}

function compareRanked(left: RankedStreamAtom, right: RankedStreamAtom): number {
  return (
    Number(right.definition) - Number(left.definition) ||
    right.pathScore - left.pathScore ||
    right.atom.score - left.atom.score ||
    compareStrings(left.atom.scopePath, right.atom.scopePath) ||
    (left.atom.lineRange?.startLine ?? 0) - (right.atom.lineRange?.startLine ?? 0)
  );
}

function retainBest(best: RankedStreamAtom[], entry: RankedStreamAtom, limit: number): void {
  let low = 0;
  let high = best.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = best[middle];
    if (candidate !== undefined && compareRanked(candidate, entry) <= 0) low = middle + 1;
    else high = middle;
  }
  if (low >= limit) return;
  best.splice(low, 0, entry);
  if (best.length > limit) best.pop();
}

class StreamingSearchCollector {
  public readonly state: RunState = {
    filesScanned: 0,
    matchesReturned: 0,
    oversizedFilesScanned: 0,
    truncated: false,
    truncationReasons: new Set(),
  };
  public ignoredByPolicy = 0;
  public filesDiscovered = 0;
  public filesAfterPolicy = 0;
  public filesSkipped = 0;
  public readonly candidates: CandidateFile[] = [];
  private readonly best: RankedStreamAtom[] = [];
  private matchesFound = 0;
  private readonly pending = new Set<Promise<void>>();
  private failure: unknown;
  private readonly bucketCounts: Record<CandidateBucket, number> = {
    "canonical-metadata": 0,
    "overview-doc": 0,
    "exact-path": 0,
    "symbol-source": 0,
    config: 0,
    source: 0,
    test: 0,
    docs: 0,
    lockfile: 0,
    "low-value": 0,
    other: 0,
  };
  private readonly rankedCandidates: RankedCandidateDiagnostic[] = [];

  public constructor(
    private readonly runner: SearchTextRunner,
    private readonly pathPattern?: RegExp,
  ) {}

  public async enqueue(file: DiscoveredFile): Promise<void> {
    const pending = this.visit(file)
      .catch((error: unknown): void => {
        this.failure ??= error;
      })
      .finally((): void => {
        this.pending.delete(pending);
      });
    this.pending.add(pending);
    if (this.pending.size >= 8) await Promise.race(this.pending);
    if (this.failure !== undefined) throw this.failure;
  }

  public async settle(): Promise<void> {
    await Promise.all(this.pending);
    if (this.failure !== undefined) throw this.failure;
  }

  public async visit(file: DiscoveredFile): Promise<void> {
    if (policyOmissionReason(file.relativePath, this.runner.policy) !== undefined) {
      this.ignoredByPolicy += 1;
      return;
    }
    this.filesDiscovered += 1;
    if (this.runner.candidatePathPredicate?.(file.relativePath) === false) return;
    this.filesAfterPolicy += 1;
    this.bucketCounts[candidateBucketForPath(file.relativePath)] += 1;
    if (this.pathPattern !== undefined && !this.pathPattern.test(file.relativePath)) {
      this.state.filesScanned += 1;
      return;
    }
    const omitted: CandidateFile[] = [];
    const matches =
      this.pathPattern === undefined
        ? await collectFileMatches(this.runner, file, this.state, omitted, 0)
        : undefined;
    if (this.pathPattern !== undefined) {
      const readable = await fileListingTextIsReadable(this.runner, file, this.state, omitted);
      if (readable && this.pathPattern.test(file.relativePath)) this.retainListing(file);
    }
    this.filesSkipped += omitted.length;
    if (this.candidates.length < this.runner.limits.maxMatchesReturned)
      this.candidates.push(...omitted);
    if (matches === undefined) return;
    this.retainMatches(file, matches);
  }

  private retainMatches(file: DiscoveredFile, matches: FileMatches): void {
    this.matchesFound += matches.best.length;
    const emitted: EvidenceAtom[] = [];
    emitFileMatches(
      this.runner,
      { filesScanned: 0, matchesReturned: 0, truncated: false },
      emitted,
      matches,
    );
    const pathScore = this.recordRanking(file, matches.contentScore);
    for (const atom of emitted)
      retainBest(
        this.best,
        { atom, pathScore, definition: matches.definitionMatch === true },
        this.runner.limits.maxMatchesReturned,
      );
  }

  private retainListing(file: DiscoveredFile): void {
    this.matchesFound += 1;
    const atom = buildAtom({
      scopeId: this.runner.scope.scopeId,
      scopePath: file.relativePath,
      lineRange: undefined,
      score: 1,
      provenanceKind: "file-listing",
      tool: "repo.findFiles",
      queryFingerprint: this.runner.fingerprint,
      emittedAtMs: this.runner.nowMs(),
    });
    const pathScore = this.recordRanking(file);
    retainBest(
      this.best,
      { atom, pathScore, definition: false },
      this.runner.limits.maxMatchesReturned,
    );
  }

  private recordRanking(file: DiscoveredFile, contentScore = 0): number {
    const entry = orderCandidatesForSearch({
      files: [file],
      query: this.runner.query,
      policy: this.runner.policy,
      contentScores: new Map([[file.relativePath, contentScore]]),
      ignoredByDiscovery: 0,
      deniedByDiscovery: 0,
    }).diagnostics.rankedCandidates[0];
    if (entry === undefined) return 0;
    this.rankedCandidates.push(entry);
    this.rankedCandidates.sort(
      (a, b) => b.score - a.score || compareStrings(a.scopePath, b.scopePath),
    );
    if (this.rankedCandidates.length > 25) this.rankedCandidates.pop();
    return entry.score;
  }

  public diagnostics(ignored: number, denied: number): SearchDiagnostics {
    return {
      policyMode: this.runner.policy.mode,
      intent: this.runner.policy.intent,
      filesDiscovered: this.filesDiscovered,
      filesAfterPolicy: this.filesAfterPolicy,
      ignoredByDiscovery: ignored,
      deniedByDiscovery: denied,
      depthPrunedByDiscovery: 0,
      maxFilesPrunedByDiscovery: 0,
      candidateBuckets: this.bucketCounts,
      rankedCandidates: this.rankedCandidates,
    };
  }

  public atoms(): readonly EvidenceAtom[] {
    const grouped = new Map<string, EvidenceAtom[]>();
    for (const entry of this.best) {
      const atoms = grouped.get(entry.atom.scopePath) ?? [];
      atoms.push(entry.atom);
      grouped.set(entry.atom.scopePath, atoms);
    }
    const atoms = [...grouped.values()].flatMap((group) =>
      group.sort(
        (left, right) => (left.lineRange?.startLine ?? 0) - (right.lineRange?.startLine ?? 0),
      ),
    );
    this.state.matchesReturned = atoms.length;
    if (this.matchesFound > atoms.length) {
      this.state.truncated = true;
      this.state.truncationReasons?.add("match-cap");
    }
    return atoms;
  }
}

function collectionResult(
  collector: StreamingSearchCollector,
  ignored: number,
  denied: number,
): StreamedSearchCollection {
  return {
    atoms: collector.atoms(),
    candidates: collector.candidates,
    state: collector.state,
    filesDiscovered: collector.filesDiscovered,
    filesAfterPolicy: collector.filesAfterPolicy,
    filesSkipped: collector.filesSkipped,
    ignored,
    denied,
    diagnostics: collector.diagnostics(ignored, denied),
  };
}

async function collectPrimaryStream(
  runner: SearchTextRunner,
  control: StructuralExecutionControl,
  collector: StreamingSearchCollector,
): Promise<StreamedSearchCollection> {
  const ignoreLines = extraIgnoreLinesForSearch(runner.policy);
  const workspace = {
    ...runner.scope.workspace,
    ignoreLines: [...runner.scope.workspace.ignoreLines, ...ignoreLines],
  };
  let ignored = 0;
  let denied = 0;
  try {
    const discovered = await visitWorkspaceFiles(
      workspace,
      runner.scope.relativePaths,
      runner.policy.applyGitignore,
      runner.fs,
      control,
      (file) => collector.enqueue(file),
      (stats): void => {
        ignored = stats.ignored;
        denied = stats.denied;
      },
    );
    await collector.settle();
    ignored = discovered.ignored;
    denied = discovered.denied;
  } catch (error) {
    await collector.settle().catch(() => undefined);
    if (!(error instanceof StructuralExecutionStoppedError)) throw error;
    collector.state.truncated = true;
    collector.state.truncationReasons?.add(error.reason);
  }
  return collectionResult(collector, ignored + collector.ignoredByPolicy, denied);
}

async function collectRescueStream(
  runner: SearchTextRunner,
  control: StructuralExecutionControl,
  pathPattern: RegExp | undefined,
): Promise<StreamingSearchCollector> {
  const rescue = new StreamingSearchCollector(
    { ...runner, policy: { ...runner.policy, omitLowValueWorkspaceFiles: false } },
    pathPattern,
  );
  try {
    await visitWorkspaceFiles(
      runner.scope.workspace,
      runner.scope.relativePaths,
      runner.policy.applyGitignore,
      runner.fs,
      control,
      async (file): Promise<void> => {
        if (policyOmissionReason(file.relativePath, runner.policy) !== undefined)
          await rescue.enqueue(file);
      },
    );
    await rescue.settle();
  } catch (error) {
    await rescue.settle().catch(() => undefined);
    if (!(error instanceof StructuralExecutionStoppedError)) throw error;
    rescue.state.truncated = true;
    rescue.state.truncationReasons?.add(error.reason);
  }
  return rescue;
}

function rescuedResult(
  primary: StreamedSearchCollection,
  rescue: StreamingSearchCollector,
  runner: SearchTextRunner,
): StreamedSearchCollection {
  const atoms = rescue.atoms();
  return {
    ...primary,
    atoms,
    state: {
      ...rescue.state,
      filesScanned: primary.state.filesScanned + rescue.state.filesScanned,
    },
    candidates: [
      ...primary.candidates.filter(
        (file) => policyOmissionReason(file.scopePath, runner.policy) === undefined,
      ),
      ...rescue.candidates,
    ].slice(0, runner.limits.maxMatchesReturned),
    filesDiscovered: primary.filesDiscovered + rescue.filesDiscovered,
    filesAfterPolicy: primary.filesAfterPolicy + rescue.filesAfterPolicy,
    filesSkipped: primary.filesSkipped + rescue.filesSkipped,
    diagnostics: {
      ...primary.diagnostics,
      lowValueRescueFilesDiscovered: rescue.filesDiscovered,
      lowValueRescueFilesScanned: rescue.state.filesScanned,
    },
  };
}

/** Reuses admitted discovery and matching without retaining every path or any source body. */
export async function collectStreamedSearchText(
  runner: SearchTextRunner,
  control: StructuralExecutionControl,
  pathPattern?: RegExp,
): Promise<StreamedSearchCollection> {
  const collector = new StreamingSearchCollector(runner, pathPattern);
  const primary = await collectPrimaryStream(runner, control, collector);
  if (
    primary.atoms.length > 0 ||
    !runner.policy.omitLowValueWorkspaceFiles ||
    primary.state.truncated
  )
    return primary;
  return rescuedResult(primary, await collectRescueStream(runner, control, pathPattern), runner);
}
