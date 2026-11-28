// The closed cause behind a commit proof that could not be formed because the raw worktree read
// failed (#4491). Until now every such failure reached the model as `proof-unavailable` with
// `nextAction: "verify-again"`, so a PERMANENT cause (an unborn HEAD, a path the workspace refuses)
// sent it into a loop that could never end. The cause is derived from the error's closed `code` or
// its fixed message tokens, never from free text, and is body-free by construction.
import {
  COMMIT_PROOF_PERMANENT_CAUSES,
  type CommitProofUnavailableCause,
} from "./codingToolIpc.js";

function property(error: unknown, name: "code" | "message"): string {
  if (typeof error !== "object" || error === null) return "";
  const value: unknown = Reflect.get(error, name);
  return typeof value === "string" ? value : "";
}

// Ordered: the first matching rule names the cause. `token` matches an error code or a message that
// is exactly a fixed token, or a fixed prefix of one.
const RULES: readonly (readonly [RegExp, CommitProofUnavailableCause])[] = [
  [/^git-raw-unborn-head$/u, "unborn-head"],
  [/^git-raw-snapshot-incomplete$/u, "snapshot-incomplete"],
  [/^(?:git-raw-snapshot-drift|git-stage-file-changed)$/u, "snapshot-drift"],
  [
    /^(?:git-raw-read-cancelled|git-stage-read-cancelled|TOOL_COMMAND_CANCELLED)$/u,
    "read-cancelled",
  ],
  [/^TOOL_COMMAND_TIMEOUT$/u, "read-timeout"],
  [/^git-stage-link-denied$/u, "link-denied"],
  [/^(?:git-stage-path-denied|WORKSPACE_PATH_ESCAPE|WORKSPACE_PATH_DENIED)$/u, "path-denied"],
  [/^(?:git-stage-|workspace-descriptor-read-)/u, "entry-unreadable"],
];

export function classifyCommitProofFailure(error: unknown): CommitProofUnavailableCause {
  const tokens = [property(error, "code"), property(error, "message")];
  for (const [pattern, cause] of RULES) {
    if (tokens.some((token) => pattern.test(token))) return cause;
  }
  return "read-failed";
}

/** A permanent cause cannot be cured by reading again: the model must change the repository first. */
export function isPermanentCommitProofCause(cause: CommitProofUnavailableCause): boolean {
  return COMMIT_PROOF_PERMANENT_CAUSES.includes(cause);
}
