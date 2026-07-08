// Failure classification for local git process results. One phrase table, one precedence order —
// consumed by the server routes and any other surface that must turn a failed git invocation into
// a typed, content-free reason. Git messages are guaranteed English because both process
// environments pin LC_ALL=C (see env.ts); a localized message must never defeat this table.

import type { GitProcessResult } from "./types.js";

export type GitFailureReason =
  "git-missing" | "timeout" | "unsafe-repository" | "not-a-repository" | "git-error";

export function classifyGitFailure(result: GitProcessResult): GitFailureReason {
  if (result.exitCode === 127) return "git-missing";
  if (result.timedOut) return "timeout";
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (text.includes("dubious ownership") || text.includes("safe.directory")) {
    return "unsafe-repository";
  }
  if (text.includes("not a git repository")) {
    return "not-a-repository";
  }
  return "git-error";
}
