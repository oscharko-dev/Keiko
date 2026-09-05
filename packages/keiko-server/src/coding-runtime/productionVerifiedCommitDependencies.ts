import { validateGitCommitMessage } from "@oscharko-dev/keiko-contracts/runtime/git-commit-policy";
import type { EditorAgentSessionSnapshot } from "@oscharko-dev/keiko-contracts";
import { isWithinWorkspace } from "@oscharko-dev/keiko-workspace";
import type { UiHandlerDeps } from "../deps.js";
import { resolveEditorAgentSessionRoot } from "../editor/agentRootBoundary.js";
import { editorAgentRegistry } from "../editor/agentSessionRegistry.js";
import { resolveGovernedCommitMessagePolicy } from "../gitDelivery/commitPolicySettings.js";
import { resolveProjectWorkspace } from "../gitDelivery/execution.js";
import { processServerLogSink } from "../process-log-sink.js";
import type { CodingRuntimeSnapshotStore } from "./codingRuntimeSnapshotStore.js";
import type { VerifiedCommitRuntimeDependencies } from "./productionVerifiedCommitRuntime.js";

export type VerifiedCommitCompositionDeps = Pick<
  UiHandlerDeps,
  | "store"
  | "evidenceStore"
  | "redactor"
  | "managedTaskWorkspaceRoot"
  | "workspaceProvisioning"
  | "editorSettingsControl"
  | "env"
  | "activityLog"
>;

/** Reuses the registered workspace, settings, editor and delivery owners of the composed server. */
export function createProductionVerifiedCommitDependencies(
  deps: VerifiedCommitCompositionDeps,
  snapshots: CodingRuntimeSnapshotStore | undefined,
): VerifiedCommitRuntimeDependencies | undefined {
  if (snapshots === undefined) return undefined;
  return {
    snapshots,
    mutationDeps: deps,
    execution: { processEnv: deps.env, activityLog: deps.activityLog ?? processServerLogSink() },
    resolveWorkspace: (root) => resolveProjectWorkspace(deps, root),
    buffersClean: (root, runId) => verifiedCommitBuffersClean(deps, root, runId),
    messageAllowed: async (message, workspace): Promise<boolean> =>
      validateGitCommitMessage(
        message,
        await resolveGovernedCommitMessagePolicy(deps, workspace.root),
      ).ok,
  };
}

function dirtySessionIsOutside(
  deps: VerifiedCommitCompositionDeps,
  snapshot: EditorAgentSessionSnapshot,
  root: string,
): boolean {
  const bound = resolveEditorAgentSessionRoot(snapshot, deps.store);
  if (!bound.ok) return false;
  const workspace = resolveProjectWorkspace(deps, bound.root.workspaceRoot);
  return (
    workspace !== undefined &&
    !isWithinWorkspace(root, workspace.root) &&
    !isWithinWorkspace(workspace.root, root)
  );
}

export function verifiedCommitBuffersClean(
  deps: VerifiedCommitCompositionDeps,
  root: string,
  runId: string,
): boolean {
  const sessions = editorAgentRegistry.listSessions();
  const dirty = sessions.filter((session) => session.dirtyFiles.length > 0);
  const clean = dirty.every((session) => dirtySessionIsOutside(deps, session, root));
  (deps.activityLog ?? processServerLogSink()).write({
    level: clean ? "info" : "warn",
    category: "security",
    op: "git.delivery.buffers.checked",
    correlationId: runId,
    extra: {
      state: clean ? "clean" : "blocked",
      editorSessionCount: sessions.length,
      dirtySessionCount: dirty.length,
    },
  });
  return clean;
}
