import { lstatSync } from "node:fs";
import { join } from "node:path";

import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";

import { inspectManagedGitdirIdentity } from "../task-workspace/gitdir-identity.js";
import type { WorkspaceRootAccess } from "../task-workspace/workspace-root-access.js";

/**
 * Where a native run's Git metadata lives (#3897 review). Keiko's managed task workspaces are
 * linked worktrees: their `.git` file names `<repository>/.git/worktrees/<name>`, outside the
 * workspace, and native Git reads the repository's common directory from there. The kernel profile
 * opens that directory read-only only after the canonical proof of the reciprocal worktree
 * registration (`inspectManagedGitdirIdentity`), bound to the task's own repository when the
 * workspace is a managed one.
 */
export type NativeGitMetadataLayout = "linked-worktree" | "repository" | "none" | "unproven";

export interface NativeGitMetadataResolution {
  readonly layout: NativeGitMetadataLayout;
  readonly binding: WorkspaceRootAccess["kind"] | "unresolved";
  /** The proven common Git directory, for the kernel profile only. Never logged. */
  readonly readRoots: readonly string[];
  /** The Git metadata the run's tree may not write, for the kernel profile only. Never logged. */
  readonly protectedWriteRoots: readonly string[];
}

/**
 * What decides which programs and which files Keiko's own Git runs and reads. Keiko runs Git outside
 * the sandbox on the run's workspace, so a filter driver or `core.worktree` a shell child wrote here
 * would execute or read with Keiko's authority (#4271 audit, reproduced). Ordinary repository work
 * (refs, objects, the index, hooks, which Keiko's Git never runs) stays writable, and Keiko's own
 * delivery tools change this configuration from outside the sandbox.
 */
const REPOSITORY_PROTECTED_METADATA = [
  "config",
  "config.worktree",
  "commondir",
  "gitdir",
  "worktrees",
  "modules",
  "objects/info/alternates",
] as const;

/**
 * Inside a repository the named metadata is protected, and the rule's intermediate directories keep
 * `.git` itself from being swapped. Any other workspace has no `.git` directory of its own to work
 * in: a `.git` file could point Keiko's Git at a configuration the run wrote, and a new `.git`
 * directory at the workspace root would become that configuration. A repository in a subfolder is
 * the run's own; Keiko's Git only reaches it when a person opens that folder.
 */
function protectedGitMetadata(
  workspaceRoot: string,
  layout: NativeGitMetadataLayout,
): readonly string[] {
  const git = join(workspaceRoot, ".git");
  return layout === "repository"
    ? REPOSITORY_PROTECTED_METADATA.map((path) => join(git, path))
    : [git];
}

const GIT_METADATA_RESOLVED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.git-metadata.resolved",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.opencodeNativeGitMetadata.recordNativeGitMetadataResolution",
  fields: {
    layout: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["linked-worktree", "repository", "none", "unproven"],
    },
    binding: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["managed-task", "ordinary", "unresolved"],
    },
    readRootCount: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "capability",
  diagnosticWhen: [{ field: "layout", values: ["unproven"] }],
  failureClasses: ["coding-runtime-git-metadata-unproven"],
  proofIds: ["coding-runtime.git-metadata.resolved.emitted-line"],
  releaseImpact: "patch",
});

/**
 * Resolves the read roots native Git needs beyond the workspace. A workspace with its own `.git`
 * directory or none needs nothing; a `.git` file whose registration cannot be proven (a stale,
 * forged or misdirected pointer) names nothing, so native Git keeps failing closed there.
 */
export function resolveNativeGitMetadata(
  workspaceRoot: string,
  access: WorkspaceRootAccess | undefined,
): NativeGitMetadataResolution {
  const binding = access?.kind ?? "unresolved";
  const resolved = (
    layout: NativeGitMetadataLayout,
    readRoots: readonly string[] = [],
  ): NativeGitMetadataResolution => ({
    layout,
    binding,
    readRoots,
    protectedWriteRoots: protectedGitMetadata(workspaceRoot, layout),
  });
  const entry = lstatSync(join(workspaceRoot, ".git"), { throwIfNoEntry: false });
  if (entry === undefined) return resolved("none");
  if (entry.isDirectory()) return resolved("repository");
  if (!entry.isFile()) return resolved("unproven");
  // A managed task proves against the repository it was bound from; any other linked worktree
  // proves against the repository its own pointer names, which the proof then checks back.
  const repositoryRoot = access?.kind === "managed-task" ? access.repositoryRoot : workspaceRoot;
  const proof = inspectManagedGitdirIdentity(workspaceRoot, repositoryRoot);
  return proof === undefined
    ? resolved("unproven")
    : resolved("linked-worktree", [proof.commonDirectory]);
}

export function recordNativeGitMetadataResolution(
  sink: ServerLogSink,
  runId: string,
  resolution: NativeGitMetadataResolution,
): void {
  const unproven = resolution.layout === "unproven";
  sink.write(
    activityLogEvent(
      GIT_METADATA_RESOLVED_OPERATION,
      unproven
        ? { level: "warn", correlationId: runId, errorKind: "conflict" }
        : { level: "info", correlationId: runId },
      {
        layout: resolution.layout,
        binding: resolution.binding,
        readRootCount: resolution.readRoots.length,
      },
    ),
  );
}
