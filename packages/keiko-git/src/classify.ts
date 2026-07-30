// Failure classification for git process results. One phrase table, one precedence order —
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

// ─── Remote-facing classification (clone / fetch / pull / push) ──────────────────────────────
//
// A remote-facing git run can stop for reasons a local run cannot: the host is unreachable, the
// credentials are refused, the repository does not exist, the host key is untrusted. It can ALSO be
// stopped by Keiko itself, in two ways the runner reports through two different flags:
//
//   * `timedOut` — the wall-clock budget fired. Keiko stopped waiting.
//   * `truncated` — set for the timeout AND for the byte cap (see GitProcessResult). On its own it
//     means the output cap was hit and the child was killed; it does NOT mean the run timed out.
//
// Reading `truncated` alone therefore reports every over-cap run as a timeout, which is the exact
// defect this single classifier exists to prevent: the two stops are distinct members here, so no
// consumer can conflate them and no new stop can silently inherit an existing one.

export type GitRemoteFailureReason =
  // No Keiko stop and no recognized remote failure: the run completed (exit 0).
  | "none"
  | "git-missing"
  // Keiko's own wall-clock budget fired.
  | "timeout"
  // Keiko's own byte cap cut the output and killed the child. NOT a timeout.
  | "output-truncated"
  | "unsafe-repository"
  | "untrusted-host-key"
  // Authentication: the remote did not accept (or could not obtain) an identity.
  | "auth-failed"
  // Authorization: the identity is known but not permitted.
  | "permission-denied"
  | "repository-not-found"
  // The remote could not be reached at all (DNS, refused connection, network down, host timeout).
  | "remote-unavailable"
  | "not-a-repository"
  | "git-error";

export const GIT_REMOTE_FAILURE_REASONS: readonly GitRemoteFailureReason[] = [
  "none",
  "git-missing",
  "timeout",
  "output-truncated",
  "unsafe-repository",
  "untrusted-host-key",
  "auth-failed",
  "permission-denied",
  "repository-not-found",
  "remote-unavailable",
  "not-a-repository",
  "git-error",
] as const;

// Ordered phrase table: the FIRST reason whose any-phrase appears in the lower-cased output wins, so
// specific causes are matched before generic ones. The generic epilogue git prints for most remote
// failures ("could not read from remote repository", "unable to access") is deliberately ranked LAST,
// under remote-unavailable — it is not a discriminator, and treating it as an authentication marker
// is what made an unreachable host look like a rejected credential.
const REMOTE_FAILURE_PHRASES: readonly (readonly [GitRemoteFailureReason, readonly string[]])[] = [
  ["unsafe-repository", ["dubious ownership", "safe.directory"]],
  [
    "untrusted-host-key",
    [
      "host key verification failed",
      "remote host identification has changed",
      "strict host key checking",
      "offending key",
    ],
  ],
  // Authentication markers precede the generic "permission denied": an SSH
  // "Permission denied (publickey)" is an AUTHENTICATION failure, whereas
  // "remote: Permission to repo denied to user" is the authorization failure matched just below.
  [
    "auth-failed",
    [
      "authentication failed",
      "could not read username",
      "could not read password",
      "publickey",
      "invalid username",
      "terminal prompts disabled",
      "error: 401",
    ],
  ],
  // Missing-repository markers precede the authorization phrases: hosts that refuse to confirm a
  // private repository's existence answer with a combined "could not be found or you don't have
  // permission" line, and "the repository is not there" is the actionable half for the user.
  [
    "repository-not-found",
    [
      "repository not found",
      "project you were looking for could not be found",
      "does not appear to be a git repository",
      "no such remote",
    ],
  ],
  [
    "permission-denied",
    ["permission denied", "permission to", "error: 403", "403 forbidden", "access denied"],
  ],
  [
    "remote-unavailable",
    [
      "could not resolve host",
      "could not resolve hostname",
      "connection refused",
      "connection timed out",
      "operation timed out",
      "network is unreachable",
      "no route to host",
      "temporary failure in name resolution",
      "unable to access",
      "could not read from remote",
    ],
  ],
  ["not-a-repository", ["not a git repository"]],
] as const;

function remoteFailurePhraseMatch(text: string): GitRemoteFailureReason | undefined {
  return REMOTE_FAILURE_PHRASES.find(([, phrases]) =>
    phrases.some((phrase) => text.includes(phrase)),
  )?.[0];
}

/**
 * Classifies ONE remote-facing git run. Deterministic: the same result always yields the same reason.
 * Precedence: spawn failure, Keiko's wall-clock stop, the recognized cause phrases, success, Keiko's
 * byte-cap stop, then the unrecognized-failure fallback.
 */
export function classifyGitRemoteFailure(result: GitProcessResult): GitRemoteFailureReason {
  if (result.exitCode === 127) return "git-missing";
  if (result.timedOut === true) return "timeout";
  const matched = remoteFailurePhraseMatch(`${result.stdout}\n${result.stderr}`.toLowerCase());
  if (matched !== undefined) return matched;
  if (result.exitCode === 0) return "none";
  return result.truncated ? "output-truncated" : "git-error";
}
