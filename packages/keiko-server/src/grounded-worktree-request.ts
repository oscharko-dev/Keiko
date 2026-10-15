import { createHash } from "node:crypto";
import {
  observeWorktreeRecency,
  type WorktreeRecencyInputs,
  type WorktreeRecencyResult,
} from "./grounded-worktree-recency.js";

export type WorktreeRecencySnapshot = (
  input: WorktreeRecencyInputs,
) => Promise<WorktreeRecencyResult>;

/** One request owns its observation; no status or scope cache survives into another request. */
export function createWorktreeRecencySnapshot(): WorktreeRecencySnapshot {
  const snapshots = new Map<string, Promise<WorktreeRecencyResult>>();
  return (input): Promise<WorktreeRecencyResult> => {
    if (input.observationAllowed === false) return observeWorktreeRecency(input);
    const key = createHash("sha256")
      .update(
        JSON.stringify([input.scope.workspaceRoot, input.scope.kind, input.scope.relativePaths]),
      )
      .digest("hex");
    const existing = snapshots.get(key);
    if (existing !== undefined) return existing;
    const pending = observeWorktreeRecency(input);
    snapshots.set(key, pending);
    return pending;
  };
}
