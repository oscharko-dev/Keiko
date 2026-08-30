// The termination-evidence contract shared across package boundaries: keiko-tools PRODUCES it,
// keiko-server logs it onto the activity log, and keiko-verification forwards it. It lives here
// because ADR-0019 makes keiko-contracts the leaf that owns cross-package types — a shape three
// packages depend on must not be owned by one of them (PR #3355 review).
//
// Deliberately pure: no imports, no IO, no Node types, no runtime values. The PRODUCING side's own
// function shape (`WindowsTreeKill`, which takes a `NodeJS.ProcessEnv`) deliberately stays in
// keiko-tools — that is an implementation seam, not a wire contract, and moving it would drag a
// Node type into this leaf.

// The VERIFIED result of one Windows tree-kill invocation. "succeeded" and "failed" are taskkill's
// own exit status, observed after it completed; "unknown" is the bounded wait expiring before
// taskkill finished — the one case where completion genuinely cannot be confirmed. There is no
// silent success: a taskkill that could not run reports "failed", never "succeeded".
//
// "blocked-untrusted-system-root" is kept DISTINCT from "failed" on purpose. Both mean the tree was
// not bounded, but they are different facts about the machine: "failed" is taskkill.exe missing or
// reporting an error, while this one is the trusted-System32 resolver refusing a malformed or
// hostile SystemRoot/WINDIR — a security-relevant property of the environment, not an operational
// hiccup. Collapsed into one value, an operator reading a customer's activity log could not tell a
// stripped-down Windows image apart from a tampered environment variable.
export type WindowsTreeKillResult =
  | "succeeded"
  | "failed"
  | "unknown"
  | "blocked-untrusted-system-root"
  // The pid handed in was this process or its parent, so nothing was signalled. Distinct from every
  // other member because it is not an environment fact at all — it means a stale or recycled pid
  // reached the kill path, and signalling it would have been suicide (`taskkill /T` takes the whole
  // tree). Recorded so the near-miss is visible in a customer's log instead of silent.
  | "refused-self-pid"
  // taskkill exited 128: "the specified process was not found". The tree was ALREADY GONE, which on
  // a termination path is a benign outcome — the goal was reached before we asked. Collapsing it
  // into "failed" told an operator the tree may still be running when it demonstrably was not, and
  // it is the most common non-zero status this call produces: the child exits during the grace
  // window between the guard check and taskkill actually running. Same reasoning as
  // "blocked-untrusted-system-root": two different facts must not share one word.
  | "already-gone";

// Everything a termination line can truthfully say about the tree-kill step: the four verified
// results above, or "not-attempted" (POSIX, no pid to signal, or a child already known to have
// exited — signalling a raw pid then risks hitting a REUSED one).
export type WindowsTreeKillDisposition = WindowsTreeKillResult | "not-attempted";

/** Why a run was terminated. Closed vocabulary — never free text on a log line. */
export type CommandTerminationReason = "timeout" | "abort" | "output-cap" | "spawn-callback-error";

/**
 * Body-free evidence for one termination step. Every field is a count, an id, or a closed-vocabulary
 * enum — never command text, args, cwd, env or output (AGENTS.md §8 / ADR-0173 D4).
 */
export interface CommandTerminationEvidence {
  // The terminal trigger. `terminate()` is single-flight, so one run has exactly one reason, and a
  // later competing trigger can neither re-kill nor re-report.
  readonly reason: CommandTerminationReason;
  // Deliberately NOT named `pid`: that is a reserved envelope field in the server's activity-log
  // redaction (`log-redaction.ts` RESERVED_FIELD_NAMES), so an `extra.pid` would be silently
  // dropped and the line would carry only the SERVER's own pid — exactly the identity loss this
  // evidence exists to prevent. `childPid` survives redaction and joins the line to the
  // cmd.exe/node.exe tree in host-side evidence.
  readonly childPid: number;
  // The VERIFIED tree-kill outcome: taskkill's own completed exit status, "unknown" only when the
  // bounded wait expired, "not-attempted" when no signal was sent. Never a
  // dispatched-therefore-succeeded tautology.
  readonly windowsTreeKill: WindowsTreeKillDisposition;
  // PRESENT ONLY on the escalation line, and it is what makes the two lines tell themselves apart.
  //
  // A run that ignores SIGTERM gets a SIGKILL after the grace period. That second step runs its own
  // tree-kill, and it is exactly the case where a failed taskkill matters most — the child has
  // already proved it will not leave on request. The first line carries no `escalation`; the second
  // carries the escalation's own verified disposition, so an operator can tell "SIGTERM was enough"
  // from "we escalated and the tree-kill still failed" instead of seeing one line for both.
  readonly escalation?: WindowsTreeKillDisposition;
}
