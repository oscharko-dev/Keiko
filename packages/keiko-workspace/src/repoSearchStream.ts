import type { CandidateFile, EvidenceAtom } from "@oscharko-dev/keiko-contracts/connected-context";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import { visitWorkspaceFiles } from "./discovery.js";
import { RetainedAtomHeap } from "./repoSearchRetention.js";
import {
  extraIgnoreLinesForSearch,
  orderCandidatesForSearch,
  candidateBucketForPath,
  policyOmissionReason,
  querySupportsLowValueRescue,
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
  readonly primary: boolean;
  readonly atom: EvidenceAtom;
  readonly definition: boolean;
  readonly pathScore: number;
}

export interface StreamedFilePatternGroups {
  readonly patterns: readonly RegExp[];
  readonly maxMatchesPerPattern: number;
}

class GroupedListingAtoms {
  private readonly groups: {
    readonly pattern: RegExp;
    readonly best: RetainedAtomHeap<RankedStreamAtom>;
  }[];

  public constructor(private readonly options: StreamedFilePatternGroups) {
    this.groups = options.patterns.map((pattern) => ({
      pattern,
      best: new RetainedAtomHeap(options.maxMatchesPerPattern, compareRanked),
    }));
  }

  public matchesPath(scopePath: string): boolean {
    return this.groups.some((group) => group.pattern.test(scopePath));
  }

  public retain(entry: RankedStreamAtom): void {
    for (const group of this.groups) {
      if (group.pattern.test(entry.atom.scopePath)) {
        group.best.retain(entry);
      }
    }
  }

  public entries(limit: number): readonly RankedStreamAtom[] {
    const result: RankedStreamAtom[] = [];
    const seen = new Set<string>();
    const groups = this.groups.map((group) => group.best.sorted());
    for (let index = 0; index < this.options.maxMatchesPerPattern; index += 1) {
      for (const group of groups) {
        const entry = group[index];
        if (entry === undefined || seen.has(entry.atom.stableId)) continue;
        seen.add(entry.atom.stableId);
        result.push(entry);
        if (result.length === limit) return result;
      }
    }
    return result;
  }
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
    Number(right.primary) - Number(left.primary) ||
    Number(right.definition) - Number(left.definition) ||
    right.pathScore - left.pathScore ||
    right.atom.score - left.atom.score ||
    compareStrings(left.atom.scopePath, right.atom.scopePath) ||
    (left.atom.lineRange?.startLine ?? 0) - (right.atom.lineRange?.startLine ?? 0)
  );
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
  private readonly best: RetainedAtomHeap<RankedStreamAtom>;
  private readonly omissions: RetainedAtomHeap<CandidateFile>;
  private matchesFound = 0;
  private readonly pending = new Set<Promise<void>>();
  private failure: Error | undefined;
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
  private readonly fileExclusionCounts = { binary: 0, oversized: 0, unreadable: 0 };

  private readonly groups: GroupedListingAtoms | undefined;

  public constructor(
    private readonly runner: SearchTextRunner,
    private readonly pathPattern?: RegExp,
    filePatternGroups?: StreamedFilePatternGroups,
  ) {
    this.best = new RetainedAtomHeap(runner.limits.maxMatchesReturned, compareRanked);
    this.omissions = new RetainedAtomHeap(runner.limits.maxMatchesReturned, (a, b) =>
      compareStrings(a.scopePath, b.scopePath),
    );
    this.groups =
      filePatternGroups === undefined ? undefined : new GroupedListingAtoms(filePatternGroups);
  }

  public async enqueue(file: DiscoveredFile): Promise<void> {
    const pending = this.visit(file)
      .catch((error: unknown): void => {
        this.failure ??=
          error instanceof Error ? error : new Error("unknown error", { cause: error });
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

  private admit(file: DiscoveredFile): boolean {
    if (policyOmissionReason(file.relativePath, this.runner.policy) !== undefined) {
      this.ignoredByPolicy += 1;
      return false;
    }
    this.filesDiscovered += 1;
    if (this.runner.candidatePathPredicate?.(file.relativePath) === false) return false;
    this.filesAfterPolicy += 1;
    this.bucketCounts[candidateBucketForPath(file.relativePath)] += 1;
    if (
      this.pathPattern !== undefined &&
      (!this.pathPattern.test(file.relativePath) ||
        this.groups?.matchesPath(file.relativePath) === false)
    ) {
      this.state.filesScanned += 1;
      return false;
    }
    return true;
  }

  public async visit(file: DiscoveredFile): Promise<void> {
    if (!this.admit(file)) return;
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
    this.retainOmissions(omitted);
    if (matches === undefined) return;
    this.retainMatches(file, matches);
  }

  public candidates(): readonly CandidateFile[] {
    return this.omissions.sorted();
  }

  private retainOmissions(omitted: readonly CandidateFile[]): void {
    for (const candidate of omitted) {
      this.omissions.retain(candidate);
      if (candidate.omitted === "binary") this.fileExclusionCounts.binary += 1;
      if (candidate.omitted === "size-exceeded") this.fileExclusionCounts.oversized += 1;
      if (candidate.omitted === "tool-unavailable") this.fileExclusionCounts.unreadable += 1;
    }
  }

  private retainMatches(file: DiscoveredFile, matches: FileMatches): void {
    const emitted: EvidenceAtom[] = [];
    // The heap owns aggregate retention; emission owns this file's stop checks. Share its reasons
    // with the actual run without treating previously emitted atoms as a corpus scan limit.
    const emissionState = { ...this.state, matchesReturned: 0 };
    emitFileMatches(this.runner, emissionState, emitted, matches);
    this.state.truncated ||= emissionState.truncated;
    this.matchesFound += emitted.length;
    const pathScore = this.recordRanking(file, matches.contentScore);
    const primary = [...emitted].sort(
      (a, b) => b.score - a.score || (a.lineRange?.startLine ?? 0) - (b.lineRange?.startLine ?? 0),
    )[0];
    for (const atom of emitted)
      this.best.retain({
        atom,
        pathScore,
        definition: matches.definitionMatch === true,
        primary: atom === primary,
      });
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
    const entry = { atom, pathScore, definition: false, primary: true };
    if (this.groups === undefined) this.best.retain(entry);
    else this.groups.retain(entry);
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
      fileExclusionCounts: { ...this.fileExclusionCounts },
      lowValuePolicyApplied: this.runner.policy.omitLowValueWorkspaceFiles,
    };
  }

  public atoms(): readonly EvidenceAtom[] {
    const grouped = new Map<string, EvidenceAtom[]>();
    for (const entry of this.groups?.entries(this.runner.limits.maxMatchesReturned) ??
      this.best.sorted()) {
      const atoms = grouped.get(entry.atom.scopePath) ?? [];
      atoms.push(entry.atom);
      grouped.set(entry.atom.scopePath, atoms);
    }
    const atoms = [...grouped.values()].flatMap((group) => {
      group.sort(
        (left, right) => (left.lineRange?.startLine ?? 0) - (right.lineRange?.startLine ?? 0),
      );
      return group;
    });
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
    candidates: collector.candidates(),
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
        if (stats.ioErrors > 0) {
          collector.state.truncated = true;
          collector.state.truncationReasons?.add("io-error");
        }
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
  filePatternGroups?: StreamedFilePatternGroups,
): Promise<StreamingSearchCollector> {
  const rescue = new StreamingSearchCollector(
    {
      ...runner,
      policy: { ...runner.policy, omitLowValueWorkspaceFiles: false },
      eligibleTextObserver: undefined,
    },
    pathPattern,
    filePatternGroups,
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
      (stats): void => {
        if (stats.ioErrors > 0) {
          rescue.state.truncated = true;
          rescue.state.truncationReasons?.add("io-error");
        }
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
      ...rescue.candidates(),
    ].slice(0, runner.limits.maxMatchesReturned),
    filesDiscovered: primary.filesDiscovered + rescue.filesDiscovered,
    filesAfterPolicy: primary.filesAfterPolicy + rescue.filesAfterPolicy,
    filesSkipped: primary.filesSkipped + rescue.filesSkipped,
    diagnostics: {
      ...primary.diagnostics,
      lowValueRescueFilesDiscovered: rescue.filesDiscovered,
      lowValueRescueFilesScanned: rescue.state.filesScanned,
      fileExclusionCounts: combinedExclusionCounts(primary.diagnostics, rescue.diagnostics(0, 0)),
    },
  };
}

function combinedExclusionCounts(
  primary: SearchDiagnostics,
  rescue: SearchDiagnostics,
): NonNullable<SearchDiagnostics["fileExclusionCounts"]> {
  const before = primary.fileExclusionCounts ?? { binary: 0, oversized: 0, unreadable: 0 };
  const after = rescue.fileExclusionCounts ?? { binary: 0, oversized: 0, unreadable: 0 };
  return {
    binary: before.binary + after.binary,
    oversized: before.oversized + after.oversized,
    unreadable: before.unreadable + after.unreadable,
  };
}

/** Reuses admitted discovery and matching without retaining every path or any source body. */
export async function collectStreamedSearchText(
  runner: SearchTextRunner,
  control: StructuralExecutionControl,
  pathPattern?: RegExp,
  filePatternGroups?: StreamedFilePatternGroups,
): Promise<StreamedSearchCollection> {
  const collector = new StreamingSearchCollector(runner, pathPattern, filePatternGroups);
  const primary = await collectPrimaryStream(runner, control, collector);
  if (
    primary.atoms.length > 0 ||
    !runner.policy.omitLowValueWorkspaceFiles ||
    primary.state.truncated ||
    !querySupportsLowValueRescue(runner.query, runner.policy, pathPattern !== undefined) ||
    (primary.ignored === 0 &&
      !primary.candidates.some((candidate) => candidate.omitted === "generated"))
  )
    return primary;
  return rescuedResult(
    primary,
    await collectRescueStream(runner, control, pathPattern, filePatternGroups),
    runner,
  );
}
