import { validateGitCommitMessage } from "@oscharko-dev/keiko-contracts/runtime/git-commit-policy";
import type { EditorAgentSessionSnapshot } from "@oscharko-dev/keiko-contracts";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { isWithinWorkspace } from "@oscharko-dev/keiko-workspace";
import type { UiHandlerDeps } from "../deps.js";
import { resolveEditorAgentSessionRoot } from "../editor/agentRootBoundary.js";
import { editorAgentRegistry } from "../editor/agentSessionRegistry.js";
import { resolveGovernedCommitMessagePolicy } from "../gitDelivery/commitPolicySettings.js";
import { resolveProjectWorkspace } from "../gitDelivery/execution.js";
import { processServerLogSink } from "../process-log-sink.js";
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

const GIT_DELIVERY_BUFFERS_CHECKED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "git.delivery.buffers.checked",
  category: "security",
  owner: "keiko-server",
  emitter: "coding-runtime.productionVerifiedCommitDependencies.verifiedCommitBuffersClean",
  fields: {
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["clean", "blocked"],
    },
    editorSessionCount: { type: "integer", dataClass: "count", required: true },
    dirtySessionCount: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "capability",
  failureClasses: ["git-delivery-dirty-buffer"],
  proofIds: ["git.delivery.buffers.checked.emitted-line"],
  releaseImpact: "patch",
});

/** Reuses the registered workspace, settings, editor and delivery owners of the composed server. */
export function createProductionVerifiedCommitDependencies(
  deps: VerifiedCommitCompositionDeps,
  // Only the members the verified-commit service reads (verifiedCommitTypes.ts) are required, so a
  // caller may pass the full store or a narrower port without a cast.
  snapshots: VerifiedCommitRuntimeDependencies["snapshots"] | undefined,
): VerifiedCommitRuntimeDependencies | undefined {
  if (snapshots === undefined) return undefined;
  return {
    snapshots,
    mutationDeps: deps,
    execution: { processEnv: deps.env, activityLog: deps.activityLog ?? processServerLogSink() },
    resolveWorkspace: (root) => resolveProjectWorkspace(deps, root),
    buffersClean: (root, runId) => verifiedCommitBuffersClean(deps, root, runId),
    // #3390: return the full validation (not just `.ok`) so a "blocked"/"message-policy" result
    // carries the closed violation codes end to end into the live OpenCode/sidecar commit-proposal
    // path — see VerifiedCommitServiceOptions["messageAllowed"] and VerifiedCommitResult["violations"].
    messageAllowed: async (message, workspace) =>
      validateGitCommitMessage(
        message,
        await resolveGovernedCommitMessagePolicy(deps, workspace.root),
      ),
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
  (deps.activityLog ?? processServerLogSink()).write(
    activityLogEvent(
      GIT_DELIVERY_BUFFERS_CHECKED_OPERATION,
      {
        level: clean ? "info" : "warn",
        correlationId: runId,
        ...(clean ? {} : { errorKind: "conflict" }),
      },
      {
        state: clean ? "clean" : "blocked",
        editorSessionCount: sessions.length,
        dirtySessionCount: dirty.length,
      },
    ),
  );
  return clean;
}
