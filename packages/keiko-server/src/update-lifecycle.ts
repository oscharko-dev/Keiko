import type {
  UpdateCancellationCutoff,
  UpdateLifecyclePhase,
  UpdateLifecycleProgress,
  UpdateLifecycleState,
  UpdateSession,
  UpdateSessionPhase,
} from "@oscharko-dev/keiko-contracts";

const TERMINAL_PHASES: ReadonlySet<UpdateLifecyclePhase> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);
const RESTART_COMPATIBILITY_PHASES: ReadonlySet<UpdateLifecyclePhase> = new Set([
  "handoff-pending",
  "verifying-relaunch",
  "cleanup-pending",
  "remediation-required",
  "recovery-required",
]);

const ALLOWED_TRANSITIONS: Readonly<Record<UpdateLifecyclePhase, readonly UpdateLifecyclePhase[]>> =
  {
    confirmed: ["preparing", "cancelled", "failed"],
    preparing: ["downloading", "activating", "cancelled", "failed"],
    downloading: ["verifying", "staging", "activating", "cancelled", "failed"],
    verifying: ["staging", "activating", "cancelled", "failed"],
    staging: ["verifying", "handoff-pending", "activating", "cancelled", "failed"],
    "handoff-pending": ["activating", "verifying-relaunch", "failed", "recovery-required"],
    activating: ["handoff-pending", "verifying-relaunch", "failed", "recovery-required"],
    "verifying-relaunch": [
      "cleanup-pending",
      "remediation-required",
      "succeeded",
      "failed",
      "recovery-required",
    ],
    "cleanup-pending": ["succeeded", "remediation-required", "recovery-required", "failed"],
    "remediation-required": ["succeeded", "failed", "recovery-required"],
    "recovery-required": [
      "preparing",
      "verifying-relaunch",
      "cleanup-pending",
      "succeeded",
      "failed",
    ],
    succeeded: [],
    failed: [],
    cancelled: [],
  };

function legacyPhase(phase: UpdateLifecyclePhase): UpdateSessionPhase {
  if (phase === "succeeded" || phase === "failed" || phase === "cancelled") return phase;
  if (RESTART_COMPATIBILITY_PHASES.has(phase)) return "restart-required";
  return phase === "confirmed" || phase === "preparing" ? "preparing" : "running";
}

function cutoffFor(
  current: UpdateCancellationCutoff,
  next: UpdateLifecyclePhase,
): UpdateCancellationCutoff {
  if (current === "handoff-committed") return current;
  if (
    next === "handoff-pending" ||
    next === "verifying-relaunch" ||
    next === "cleanup-pending" ||
    next === "remediation-required" ||
    next === "recovery-required" ||
    next === "succeeded"
  ) {
    return "handoff-committed";
  }
  return next === "activating" ? "mutation-started" : current;
}

export function initialUpdateLifecycle(): UpdateLifecycleState {
  return {
    phase: "preparing",
    progress: { completedBytes: 0 },
    cancellationCutoff: "not-reached",
  };
}

export interface UpdateLifecycleTransition {
  readonly phase: UpdateLifecyclePhase;
  readonly progress?: UpdateLifecycleProgress | undefined;
}

function assertTransitionAllowed(
  current: UpdateLifecyclePhase,
  transition: UpdateLifecycleTransition,
): void {
  if (transition.phase === current && TERMINAL_PHASES.has(current)) {
    throw new TypeError(`Terminal update lifecycle phase cannot be repeated: ${current}`);
  }
  if (transition.phase === current && transition.progress === undefined) {
    throw new TypeError(`Same-phase update lifecycle changes require progress: ${current}`);
  }
  if (transition.phase !== current && !ALLOWED_TRANSITIONS[current].includes(transition.phase)) {
    throw new TypeError(`Invalid update lifecycle transition: ${current} -> ${transition.phase}`);
  }
}

// Independent byte invariants stay explicit so partial progress cannot bypass a comparison.
// eslint-disable-next-line complexity
function assertProgressValid(
  current: UpdateLifecycleState,
  transition: UpdateLifecycleTransition,
): void {
  const progress = transition.progress;
  if (progress === undefined) return;
  if (
    !Number.isSafeInteger(progress.completedBytes) ||
    progress.completedBytes < 0 ||
    (progress.totalBytes !== undefined &&
      (!Number.isSafeInteger(progress.totalBytes) || progress.totalBytes < progress.completedBytes))
  ) {
    throw new TypeError("Update lifecycle progress must be bounded non-negative byte counts.");
  }
  if (transition.phase !== current.phase) return;
  if (progress.completedBytes < current.progress.completedBytes) {
    throw new TypeError("Same-phase update lifecycle progress cannot regress.");
  }
  if (
    current.progress.totalBytes !== undefined &&
    progress.totalBytes !== current.progress.totalBytes
  ) {
    throw new TypeError("Same-phase update lifecycle total bytes cannot change.");
  }
}

export function transitionUpdateSession(
  session: UpdateSession,
  transition: UpdateLifecycleTransition,
): Pick<UpdateSession, "phase" | "lifecycle" | "cancelable" | "restartRequired"> {
  const current = session.lifecycle.phase;
  assertTransitionAllowed(current, transition);
  assertProgressValid(session.lifecycle, transition);
  const cutoff = cutoffFor(session.lifecycle.cancellationCutoff, transition.phase);
  const phase = legacyPhase(transition.phase);
  return {
    phase,
    lifecycle: {
      phase: transition.phase,
      progress: transition.progress ?? session.lifecycle.progress,
      cancellationCutoff: cutoff,
    },
    cancelable: !TERMINAL_PHASES.has(transition.phase) && cutoff === "not-reached",
    restartRequired:
      transition.phase === "handoff-pending" ||
      transition.phase === "verifying-relaunch" ||
      transition.phase === "recovery-required",
  };
}
