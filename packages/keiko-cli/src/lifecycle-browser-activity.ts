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
      values: ["requested", "delegated", "headless", "failed", "refused", "restart-required"],
    },
    attestationProvided: { type: "boolean", dataClass: "closed-enum", required: true },
    failureKind: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "unsafe-request",
        "invalid-request",
        "identity-mismatch",
        "launch-id-missing",
        "identity-unverified",
        "channel-unsupported",
      ],
    },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "process-lifecycle",
  diagnosticWhen: [{ field: "outcome", values: ["failed", "refused"] }],
  failureClasses: ["browser-handoff"],
  proofIds: ["cli.lifecycle.browser-handoff.outcome"],
  releaseImpact: "patch",
});

type BrowserHandoffResult =
  | {
      readonly outcome: "requested" | "delegated" | "headless";
      readonly attestationProvided: boolean;
    }
  | { readonly outcome: "failed"; readonly attestationProvided: boolean; readonly error: unknown }
  | {
      readonly outcome: "refused";
      readonly attestationProvided: false;
      readonly reason: "unsafe-request" | "invalid-request" | "identity-mismatch";
      readonly error?: unknown;
    }
  | {
      readonly outcome: "restart-required";
      readonly attestationProvided: false;
      readonly reason: "launch-id-missing" | "identity-unverified" | "channel-unsupported";
    };

/** Record the launcher decision without retaining the boot URL, attestation, or process secret. */
export function emitBrowserHandoff(
  sink: SecurityLogSink | undefined,
  result: BrowserHandoffResult,
): void {
  const failureKind = "error" in result ? securityErrorKind(result.error) : undefined;
  emitSecurityLogEvent(
    sink,
    activityLogEvent(
      BROWSER_HANDOFF_OPERATION,
      result.outcome === "failed" ? { level: "warn", errorKind: "unavailable" } : { level: "info" },
      {
        outcome: result.outcome,
        attestationProvided: result.attestationProvided,
        ...(failureKind === undefined ? {} : { failureKind }),
        ...("reason" in result ? { reason: result.reason } : {}),
      },
    ),
  );
}
