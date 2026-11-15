import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { emitSecurityLogEvent, type SecurityLogSink } from "@oscharko-dev/keiko-security";
import type { LaunchFailureReason } from "./launch-failure-note.js";

/**
 * One line for every `portable launch` that ends non-zero (#4358): the closed reason of the failure,
 * body-free. A start that gave up used to leave a line only for the few causes that had their own
 * event (the health wait, the native-runtime refusals); a busy port, a pid that could not be
 * published, a busy setup lock or a refused registration ended with a text on a stream nobody reads
 * under a double-click and no line at all. The command emits it once, when it returns, through the
 * invocation's own sink; the deferred Windows collector is flushed before the process can end.
 */
const PORTABLE_LAUNCH_FAILED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "portable.launch.failed",
  category: "diagnostic",
  owner: "keiko-cli",
  emitter: "portable-launch-failure.emitPortableLaunchFailed",
  fields: {
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      // Literal: the registry generator reads the values statically. A test keeps this list equal to
      // LAUNCH_FAILURE_REASONS (portable-launch-failure.activity-log-proof.test.ts).
      values: [
        "port-in-use",
        "stale-shutdown-request",
        "invalid-launch-id",
        "missing-child-pid",
        "pid-publication",
        "state-dir",
        "spawn-refused",
        "health-timeout",
        "process-exited",
        "identity-mismatch",
        "stop-failed",
        "browser-handoff",
        "native-runtime-unverified",
        "native-ownership",
        "lifecycle-busy",
        "setup-busy",
        "setup-failed",
        "recovery-required",
        "registration-invalid",
        "upgrade-failed",
        "macos-activation",
        "launch-error",
        "fatal",
      ],
    },
    // Whether the failure note for the native launcher's box was left (Windows double-click only).
    launcherBox: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["written", "not-requested", "failed"],
    },
  },
  causal: "none",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["portable-launch-failure"],
  proofIds: ["portable.launch.failed.emitted-line"],
  releaseImpact: "patch",
});

function errorKindFor(reason: LaunchFailureReason): ActivityLogErrorKind {
  if (reason === "health-timeout") return "timeout";
  if (reason === "port-in-use" || reason === "setup-busy" || reason === "identity-mismatch") {
    return "conflict";
  }
  if (reason === "state-dir") return "permission-denied";
  return "unavailable";
}

export function emitPortableLaunchFailed(
  sink: SecurityLogSink | undefined,
  reason: LaunchFailureReason,
  note: "written" | "not-requested" | "failed",
): void {
  emitSecurityLogEvent(
    sink,
    activityLogEvent(
      PORTABLE_LAUNCH_FAILED_OPERATION,
      { level: "error", errorKind: errorKindFor(reason) },
      { reason, launcherBox: note },
    ),
  );
}

/** The first reason a start recorded: the earliest cause is the most specific one. */
export class LaunchFailureRecorder {
  private first: LaunchFailureReason | undefined;

  public record(reason: LaunchFailureReason): void {
    this.first ??= reason;
  }

  public get reason(): LaunchFailureReason | undefined {
    return this.first;
  }
}

/** A refusal of the launch itself, with the closed reason the person's box and the log carry. */
export class PortableLaunchRefusal extends Error {
  public constructor(
    message: string,
    public readonly reason: LaunchFailureReason,
  ) {
    super(message);
    this.name = "PortableLaunchRefusal";
  }
}
