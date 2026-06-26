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
import {
  TASK_WORKSPACE_SCHEMA_VERSION,
  classifyWorkspaceHealth,
  deriveOrphanWorktreeHealthEntry,
  deriveWorkspaceHealthEntry,
  evaluateWorkspaceCleanupSafety,
  type WorkspaceHealthEntry,
  type WorkspaceHealthReport,
  type WorkspaceInstance,
} from "@oscharko-dev/keiko-contracts";
import { deriveRepositoryId } from "./naming.js";
import { isManagedRootOwned, isManagedTargetContained } from "./managed-root.js";
import { gatherInstanceReconciliationFacts } from "./reconciliation.js";
import type { WorkspaceHealthService, WorkspaceHealthServiceDeps } from "./types.js";

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

// A live dirty probe through a worktree-bound adapter. Only meaningful when the worktree exists and is
// contained; an inconclusive probe (broken pointer, unreadable tree) reports not-dirty — the structural
// classification already surfaces a broken/missing worktree, and containment + ownership remain the
// authoritative cleanup guards.
async function probeDirty(
  deps: WorkspaceHealthServiceDeps,
  worktreePath: string,
  probeable: boolean,
): Promise<boolean> {
  if (!probeable) return false;
  const adapter = deps.createAdapter(detectWorkspaceAt(worktreePath));
  const status = await adapter.worktreeStatus();
  return status.ok && status.dirty;
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
): Promise<WorkspaceHealthEntry> {
  const { facts } = await gatherInstanceReconciliationFacts(
    deps,
    adapter,
    worktrees,
    instance,
    nowMs,
  );
  const worktreeDirty = await probeDirty(
    deps,
    instance.managedWorktreePath,
    facts.worktreeDirExists && facts.pathContained,
  );
  const evaluation = classifyWorkspaceHealth({
    reconciliation: facts,
    worktreeDirty,
    ownershipProven,
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

// Detects orphaned managed worktrees for one repository: directories under `<managedRoot>/<repoId>`
// that no persisted instance references. Each candidate is realpath-contained before it is reported,
// and its live cleanup-eligibility is evaluated (owned + contained + clean; orphans hold no lock).
async function detectOrphans(
  deps: WorkspaceHealthServiceDeps,
  repositoryId: string,
  knownPaths: ReadonlySet<string>,
  ownershipProven: boolean,
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
    const worktreeDirty = await probeDirty(deps, candidate, true);
    const decision = evaluateWorkspaceCleanupSafety({
      lifecycleState: "abandoned",
      hasRecord: false,
      pathContained: true,
      ownershipProven,
      worktreeDirty,
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
): Promise<WorkspaceHealthReport> {
  const instances = instancesFor(deps, repositoryRoot);
  const ownershipProven = isManagedRootOwned(deps.managedRoot);
  const byRepo = groupByRepositoryRoot(instances);
  const entries: WorkspaceHealthEntry[] = [];
  const seenRepoIds = new Set<string>();
  for (const [root, group] of byRepo) {
    const repositoryId = deriveRepositoryId(root);
    seenRepoIds.add(repositoryId);
    const adapter = deps.createAdapter(detectWorkspaceAt(root));
    const worktrees = await adapter.listWorktrees();
    const knownPaths = new Set(group.map((instance) => instance.managedWorktreePath));
    for (const instance of group) {
      entries.push(
        await evaluateInstance(deps, adapter, worktrees, instance, ownershipProven, deps.now()),
      );
    }
    entries.push(...(await detectOrphans(deps, repositoryId, knownPaths, ownershipProven)));
  }
  // A scoped report whose repository has no persisted instances still surfaces its orphans.
  if (repositoryRoot !== undefined && repositoryRoot.length > 0) {
    const repositoryId = deriveRepositoryId(repositoryRoot);
    if (!seenRepoIds.has(repositoryId)) {
      entries.push(...(await detectOrphans(deps, repositoryId, new Set(), ownershipProven)));
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
    report: (repositoryRoot?: string): Promise<WorkspaceHealthReport> =>
      reportImpl(deps, repositoryRoot),
  };
}
