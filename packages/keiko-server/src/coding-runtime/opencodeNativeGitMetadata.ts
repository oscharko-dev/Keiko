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
  const entry = lstatSync(join(workspaceRoot, ".git"), { throwIfNoEntry: false });
  if (entry === undefined) return { layout: "none", binding, readRoots: [] };
  if (entry.isDirectory()) return { layout: "repository", binding, readRoots: [] };
  if (!entry.isFile()) return { layout: "unproven", binding, readRoots: [] };
  // A managed task proves against the repository it was bound from; any other linked worktree
  // proves against the repository its own pointer names, which the proof then checks back.
  const repositoryRoot = access?.kind === "managed-task" ? access.repositoryRoot : workspaceRoot;
  const proof = inspectManagedGitdirIdentity(workspaceRoot, repositoryRoot);
  return proof === undefined
    ? { layout: "unproven", binding, readRoots: [] }
    : { layout: "linked-worktree", binding, readRoots: [proof.commonDirectory] };
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
