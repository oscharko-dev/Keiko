// Gateway verification vocabulary — the single answer to "has a live probe confirmed this
// gateway?" for every surface that would otherwise infer readiness from stored configuration.
//
// A configured gateway is not a reachable gateway. Before this module existed, the editor
// AI-assist badge, the Settings gateway summary and the Coding Workbench source projection each
// derived "ready"/"allowed"/"healthy" from config presence alone, so a configured-but-unreachable
// deployment read as green on all three. The only live evidence in the product is the operator-run
// gateway readiness probe (`POST /api/gateway/readiness`), whose report carries an overall status;
// this module turns that outcome into the one state word those surfaces project, with
// `"unverified"` — never a healthy value — as the fail-closed default when no probe has run.
//
// Deliberately dependency-free: `bff-wire.ts` (which owns the readiness report) imports
// `coding-workbench.ts`, and `coding-workbench.ts` needs this vocabulary for its sidecar-gateway
// projection, so this module must not import either of them. `gatewayVerificationFromProbeOutcome`
// therefore takes the report's `overallStatus` value rather than the report type.

/**
 * What a live probe last said about the configured gateway.
 *
 * - `verified` — the last probe passed every requested check.
 * - `partial` — basic chat answered, but at least one requested capability did not verify.
 * - `failed` — the last probe could not confirm basic chat.
 * - `unverified` — no probe outcome is known for the current configuration (fail-closed default).
 */
export type GatewayVerificationState = "verified" | "partial" | "failed" | "unverified";

const GATEWAY_VERIFICATION_STATES: ReadonlySet<string> = new Set([
  "verified",
  "partial",
  "failed",
  "unverified",
]);

/** The fail-closed state: what every surface must project until a probe says otherwise. */
export const UNVERIFIED_GATEWAY = "unverified";

export function isGatewayVerificationState(value: unknown): value is GatewayVerificationState {
  return typeof value === "string" && GATEWAY_VERIFICATION_STATES.has(value);
}

/**
 * Projects a readiness probe's overall status onto the verification state. Takes the status value
 * (`GatewayReadinessReport["overallStatus"]`) structurally, so the readiness report keeps living in
 * `bff-wire.ts` without an import cycle.
 */
export function gatewayVerificationFromProbeOutcome(
  overallStatus: "ready" | "partial" | "failed",
): GatewayVerificationState {
  if (overallStatus === "ready") return "verified";
  return overallStatus === "partial" ? "partial" : "failed";
}

/**
 * True when the last probe actively contradicted the configuration, so a surface must demote a
 * readiness claim rather than merely label it unconfirmed. `unverified` is NOT a contradiction: it
 * is an absence of evidence, which surfaces label honestly instead of treating as a failure.
 */
export function gatewayVerificationContradictsReadiness(state: GatewayVerificationState): boolean {
  return state === "failed";
}
