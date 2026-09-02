// Operational health + drift evaluation and orphan detection for managed task workspaces (Issue #448,
// Epic #443).
//
// This is the READ-ONLY observation surface. For each persisted instance it gathers the SAME
// content-free facts the #447 reconciler uses — realpath containment, the `.git` pointer/HEAD/branch
// identity, and lock liveness (delegated to gatherInstanceReconciliationFacts, no second engine) — then
// adds the two #448-specific LIVE signals the narrow #445 adapter could not provide before: a
// `git status --porcelain` dirty probe (through the read-only `status` verb added in #448) and the
// managed-root ownership proof. Every classification decision is deferred to the pure contract
// (classifyWorkspaceHealth), so health stays deterministic and 100%-testable.
//
// It additionally detects ORPHANED managed worktrees: directories under the Keiko-owned managed root
// that no persisted record references. Each candidate is realpath-contained before it is reported, and
// it is surfaced with a content-free `orphanId` (a hash of its managed-root-relative location) so the
// report carries no path. The service performs NO store writes and emits NO evidence — reconciliation
// (#447) owns the persisted health columns and their events; health is pure observation.

import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { detectWorkspaceAt } from "@oscharko-dev/keiko-workspace";
import type {
  GitWorktreeAdapter,
  WorktreeListEntry,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type {
  WorkspaceHealthEntry,
  WorkspaceHealthReport,
  WorkspaceInfo,
  WorkspaceInstance,
} from "@oscharko-dev/keiko-contracts";
import {
  TASK_WORKSPACE_SCHEMA_VERSION,
  classifyWorkspaceHealth,
  deriveOrphanWorktreeHealthEntry,
  deriveWorkspaceHealthEntry,
  evaluateWorkspaceCleanupSafety,
} from "@oscharko-dev/keiko-contracts/runtime/task-workspace";
import { deriveRepositoryId } from "./naming.js";
import { isManagedRootOwned, isManagedTargetContained } from "./managed-root.js";
import { gatherInstanceReconciliationFacts } from "./reconciliation.js";
import { correlationIdOrUnknown } from "../correlation.js";
import type { WorkspaceHealthService, WorkspaceHealthServiceDeps } from "./types.js";
import { resolveLifecycleManagedWorkspaceRootAccess } from "./workspace-root-access.js";
import { runWithWorkspaceLifecycleFailureLogging } from "./activity-log.js";
import { TaskWorkspaceError } from "./errors.js";

const ORPHAN_ID_PREFIX = "orph_";

function isoFrom(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

// Content-free identity for an orphaned managed directory: a hash of its managed-root-relative
// `<repositoryId>/<leaf>` location, so the report references the orphan without leaking any path.
// Exported so the cleanup service references the SAME id when it acts on or refuses an orphan.
export function deriveOrphanId(repositoryId: string, leaf: string): string {
  return (
    ORPHAN_ID_PREFIX +
    createHash("sha256").update(`${repositoryId}/${leaf}`, "utf8").digest("hex").slice(0, 24)
  );
}

// `probed` is false only when the status adapter itself threw: the report then cannot claim to know
// the tree, so the entry is held as ownership-unproven rather than as clean.
interface DirtyProbe {
  readonly worktreeDirty: boolean;
  readonly probed: boolean;
}

// A live dirty probe through a worktree-bound adapter. Only meaningful when the worktree exists and is
// contained. Ordinary git-status failure reports not-dirty because the structural classification
// already surfaces a broken/missing worktree. Failure to re-prove a registered managed root is
// different: it is returned explicitly so the caller cannot classify that workspace as healthy.
async function probeDirty(
  deps: WorkspaceHealthServiceDeps,
  worktreePath: string,
  probeable: boolean,
  registered: boolean,
  correlationId: string,
): Promise<DirtyProbe> {
  if (!probeable) return { worktreeDirty: false, probed: true };
  const access = registered
    ? resolveLifecycleManagedWorkspaceRootAccess(deps, worktreePath, {
        activityLog: deps.activityLog,
        correlationId,
      })
    : undefined;
  // A denied identity proof is evidence (logged above under this report's correlation), not a
  // containment or ownership finding: the probe falls back to the orphan-style contained path so
  // the report predicts what governed cleanup will actually decide (#3376 review P1/P2).
  const workspace =
    access === undefined
      ? workspaceInfo(worktreePath)
      : detectWorkspaceAt(access.canonicalRoot, access.fs);
  try {
    const adapter = deps.createAdapter(workspace, correlationId, access?.fs);
    const status = await adapter.worktreeStatus();
    return { worktreeDirty: status.ok && status.dirty, probed: true };
  } catch {
    return { worktreeDirty: false, probed: false };
  }
}

function workspaceInfo(root: string): WorkspaceInfo {
  return {
    root,
    selectedRoot: root,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

// Classifies ONE persisted instance against pre-fetched repository worktree state, layering the live
// dirty + ownership signals onto the reused reconciliation facts. Pure decisioning is delegated to the
// contract; this only does the IO.
async function evaluateInstance(
  deps: WorkspaceHealthServiceDeps,
  adapter: GitWorktreeAdapter,
  worktrees: readonly WorktreeListEntry[],
  instance: WorkspaceInstance,
  ownershipProven: boolean,
  nowMs: number,
  correlationId: string,
): Promise<WorkspaceHealthEntry> {
  const { facts } = await gatherInstanceReconciliationFacts(
    deps,
    adapter,
    worktrees,
    instance,
    nowMs,
    undefined,
    correlationId,
  );
  const dirtyProbe = await probeDirty(
    deps,
    instance.managedWorktreePath,
    facts.worktreeDirExists && facts.pathContained,
    true,
    correlationId,
  );
  // A managed-access denial is an ownership finding, never a containment one: `pathContained` was
  // proven from the real path by reconciliation, and the identity markers already ride in `facts`.
  // Rewriting it to `false` here reported a path escape that had not happened (#3376 review).
  const evaluation = classifyWorkspaceHealth({
    reconciliation: facts,
    worktreeDirty: dirtyProbe.worktreeDirty,
    ownershipProven: ownershipProven && dirtyProbe.probed,
  });
  return deriveWorkspaceHealthEntry({
    workspaceId: instance.workspaceId,
    taskId: instance.taskId,
    lifecycleState: instance.lifecycleState,
    health: instance.health,
    evaluation,
    ...(instance.lastVerifiedAt !== undefined ? { lastVerifiedAt: instance.lastVerifiedAt } : {}),
  });
}

// A proof that could not run (EIO, EACCES) is not a verdict on the worktree, and it must not abort
// the report for every other workspace. The failure is logged with its frames under this report's
// correlation, and the entry carries the persisted row forward as UNVERIFIED: health `unknown`,
// `recovery-required` because an operator has to look at a worktree the product cannot read, and
// never cleanup-eligible (Cursor review on f50133b95).
async function evaluateInstanceOrCarryForward(
  deps: WorkspaceHealthServiceDeps,
  adapter: GitWorktreeAdapter,
  worktrees: readonly WorktreeListEntry[],
  instance: WorkspaceInstance,
  ownershipProven: boolean,
  correlationId: string,
): Promise<WorkspaceHealthEntry> {
  try {
    return await runWithWorkspaceLifecycleFailureLogging(
      deps,
      { operation: "reconcile", workspaceIdentitySeed: instance.workspaceId, correlationId },
      () =>
        evaluateInstance(
          deps,
          adapter,
          worktrees,
          instance,
          ownershipProven,
          deps.now(),
          correlationId,
        ),
    );
  } catch (error) {
    if (!(error instanceof TaskWorkspaceError) || error.code !== "IDENTITY_PROOF_FAILED") {
      throw error;
    }
    return deriveWorkspaceHealthEntry({
      workspaceId: instance.workspaceId,
      taskId: instance.taskId,
      lifecycleState: instance.lifecycleState,
      health: "unknown",
      evaluation: {
        classification: "recovery-required",
        driftMarkers: instance.driftMarkers,
        recoveryHints: instance.recoveryHints,
        cleanupEligible: false,
      },
      ...(instance.lastVerifiedAt !== undefined ? { lastVerifiedAt: instance.lastVerifiedAt } : {}),
    });
  }
}

// Detects orphaned managed worktrees for one repository: directories under `<managedRoot>/<repoId>`
// that no persisted instance references. Each candidate is realpath-contained before it is reported,
// and its live cleanup-eligibility is evaluated (owned + contained + clean; orphans hold no lock).
async function detectOrphans(
  deps: WorkspaceHealthServiceDeps,
  repositoryId: string,
  knownPaths: ReadonlySet<string>,
  ownershipProven: boolean,
  correlationId: string,
): Promise<WorkspaceHealthEntry[]> {
  const repoDir = join(deps.managedRoot, repositoryId);
  if (!existsSync(repoDir)) return [];
  let leaves: readonly string[];
  try {
    leaves = readdirSync(repoDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const entries: WorkspaceHealthEntry[] = [];
  for (const leaf of leaves) {
    const candidate = join(repoDir, leaf);
    if (knownPaths.has(candidate)) continue;
    const contained = isManagedTargetContained(deps.managedRoot, candidate);
    if (!contained) {
      // An uncontained directory (e.g. a symlink escape) is reported as an orphan but NEVER
      // cleanup-eligible — the live safety gate refuses it.
      entries.push(
        deriveOrphanWorktreeHealthEntry({
          orphanId: deriveOrphanId(repositoryId, leaf),
          cleanupEligible: false,
        }),
      );
      continue;
    }
    const dirtyProbe = await probeDirty(deps, candidate, ownershipProven, false, correlationId);
    const decision = evaluateWorkspaceCleanupSafety({
      lifecycleState: "abandoned",
      hasRecord: false,
      pathContained: true,
      ownershipProven: ownershipProven && dirtyProbe.probed,
      worktreeDirty: dirtyProbe.worktreeDirty,
      lockLive: false,
    });
    entries.push(
      deriveOrphanWorktreeHealthEntry({
        orphanId: deriveOrphanId(repositoryId, leaf),
        cleanupEligible: decision.allowed,
      }),
    );
  }
  return entries;
}

// Groups the in-scope instances by repository root so each repository's worktree list is fetched once.
function groupByRepositoryRoot(
  instances: readonly WorkspaceInstance[],
): ReadonlyMap<string, WorkspaceInstance[]> {
  const byRepo = new Map<string, WorkspaceInstance[]>();
  for (const instance of instances) {
    const group = byRepo.get(instance.repositoryRoot) ?? [];
    group.push(instance);
    byRepo.set(instance.repositoryRoot, group);
  }
  return byRepo;
}

function instancesFor(
  deps: WorkspaceHealthServiceDeps,
  repositoryRoot: string | undefined,
): readonly WorkspaceInstance[] {
  if (repositoryRoot === undefined || repositoryRoot.length === 0) return deps.store.listAll();
  return deps.store.listByRepository(deriveRepositoryId(repositoryRoot));
}

async function reportImpl(
  deps: WorkspaceHealthServiceDeps,
  repositoryRoot: string | undefined,
  // Threaded rather than defaulted inside: health is read-only but still SPAWNS git, so its
  // termination evidence has an operation to join like every other lane (AGENTS.md §8).
  correlationId: string,
): Promise<WorkspaceHealthReport> {
  const instances = instancesFor(deps, repositoryRoot);
  const ownershipProven = isManagedRootOwned(deps.managedRoot);
  const byRepo = groupByRepositoryRoot(instances);
  const entries: WorkspaceHealthEntry[] = [];
  const seenRepoIds = new Set<string>();
  for (const [root, group] of byRepo) {
    const repositoryId = deriveRepositoryId(root);
    seenRepoIds.add(repositoryId);
    const adapter = deps.createAdapter(detectWorkspaceAt(root), correlationId);
    const worktrees = await adapter.listWorktrees();
    const knownPaths = new Set(group.map((instance) => instance.managedWorktreePath));
    for (const instance of group) {
      entries.push(
        await evaluateInstanceOrCarryForward(
          deps,
          adapter,
          worktrees,
          instance,
          ownershipProven,
          correlationId,
        ),
      );
    }
    entries.push(
      ...(await detectOrphans(deps, repositoryId, knownPaths, ownershipProven, correlationId)),
    );
  }
  // A scoped report whose repository has no persisted instances still surfaces its orphans.
  if (repositoryRoot !== undefined && repositoryRoot.length > 0) {
    const repositoryId = deriveRepositoryId(repositoryRoot);
    if (!seenRepoIds.has(repositoryId)) {
      entries.push(
        ...(await detectOrphans(deps, repositoryId, new Set(), ownershipProven, correlationId)),
      );
    }
  }
  return {
    schemaVersion: TASK_WORKSPACE_SCHEMA_VERSION,
    generatedAt: isoFrom(deps.now()),
    entries,
  };
}

export function createWorkspaceHealthService(
  deps: WorkspaceHealthServiceDeps,
): WorkspaceHealthService {
  return {
    report: (repositoryRoot?: string, correlationId?: string): Promise<WorkspaceHealthReport> =>
      reportImpl(deps, repositoryRoot, correlationIdOrUnknown(correlationId)),
  };
}
