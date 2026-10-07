import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  emitSecurityLogEvent,
  securityErrorKind,
  type SecurityLogSink,
} from "@oscharko-dev/keiko-security";

const BROWSER_HANDOFF_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "cli.lifecycle.browser-handoff",
  category: "diagnostic",
  owner: "keiko-cli",
  emitter: "lifecycle-browser-activity.emitBrowserHandoff",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["requested", "delegated", "headless", "failed"],
    },
    attestationProvided: { type: "boolean", dataClass: "closed-enum", required: true },
    failureKind: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "process-lifecycle",
  diagnosticWhen: [{ field: "outcome", values: ["failed"] }],
  failureClasses: ["browser-handoff"],
  proofIds: ["cli.lifecycle.browser-handoff.outcome"],
  releaseImpact: "patch",
});

type BrowserHandoffResult =
  | {
      readonly outcome: "requested" | "delegated" | "headless";
      readonly attestationProvided: boolean;
    }
  | { readonly outcome: "failed"; readonly attestationProvided: boolean; readonly error: unknown };

/** Record the launcher decision without retaining the boot URL, attestation, or process secret. */
export function emitBrowserHandoff(
  sink: SecurityLogSink | undefined,
  result: BrowserHandoffResult,
): void {
  emitSecurityLogEvent(
    sink,
    activityLogEvent(
      BROWSER_HANDOFF_OPERATION,
      result.outcome === "failed" ? { level: "warn", errorKind: "unavailable" } : { level: "info" },
      {
        outcome: result.outcome,
        attestationProvided: result.attestationProvided,
        ...(result.outcome === "failed" ? { failureKind: securityErrorKind(result.error) } : {}),
      },
    ),
  );
}
