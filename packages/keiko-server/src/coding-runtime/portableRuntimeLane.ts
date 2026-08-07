import type { UpdatePortableTarget } from "@oscharko-dev/keiko-contracts";

/**
 * The two platform-assurance lanes a PACKAGED portable artifact may declare for itself
 * (ADR-0163 D9).
 *
 * `release-qualified` is the signed, notarized/Authenticode-attested production artifact.
 * `evaluation-unqualified` is the explicitly declared, unsigned evaluation artifact: it waives the
 * platform signature, notarization and attestation gates and NOTHING else. Every digest, size,
 * containment, license/SBOM and provenance predicate is applied identically on both lanes, and the
 * evaluation lane additionally ASSERTS that every platform boolean is present and false.
 *
 * This module is the single place the words "evaluation" and "evaluation-unqualified" appear in
 * keiko-server. Four independent verified-production checkpoints consume it; restating the lane
 * predicate at any of them would let a future edit widen one waiver without the others.
 */
export type PortableRuntimeLane = "release-qualified" | "evaluation-unqualified";

const EVALUATION_POLICY = "evaluation";
const EVALUATION_STATUS = "evaluation-unqualified";
const PRODUCTION_POLICY = "production";
const PRODUCTION_STATUS = "verified-production";

const EVALUATION_REASON_CODES = ["evaluation-artifact", "evaluation-unsigned-allowed"] as const;

const WINDOWS_CHECK_KEYS = ["publisherChainVerified", "timestampVerified"] as const;
const MACOS_CHECK_KEYS = [
  "developerIdVerified",
  "notarizationVerified",
  "stapleVerified",
  "assessmentVerified",
] as const;

/** The one copy of the per-target platform-check key list. */
export function platformCheckKeys(target: UpdatePortableTarget): readonly string[] {
  return target === "windows-x64" ? WINDOWS_CHECK_KEYS : MACOS_CHECK_KEYS;
}

/**
 * Resolves the lane a security/signing block DECLARES. Only the two exact declared pairs resolve;
 * everything else — a staging artifact (`staging`/`unverified-staging`), a pull-request artifact
 * (`development`/`unsigned-non-production`), an absent block, a valid policy with a mismatched
 * status — resolves to `undefined` and is refused before any other predicate runs.
 */
export function declaredPortableRuntimeLane(
  security: Record<string, unknown> | undefined,
): PortableRuntimeLane | undefined {
  if (security === undefined) return undefined;
  const policy = security.verificationPolicy;
  const status = security.verificationStatus;
  if (policy === PRODUCTION_POLICY && status === PRODUCTION_STATUS) return "release-qualified";
  if (policy === EVALUATION_POLICY && status === EVALUATION_STATUS) {
    return "evaluation-unqualified";
  }
  return undefined;
}

export interface EvaluationAttestationOptions {
  /** Assert both evaluation reason codes are present. False for the 5-key helper signing shape. */
  readonly requireReasonCodes: boolean;
  /**
   * Assert the declared policy/status pair and the per-target `verificationChecks`. False for the
   * native-helper signing block, which carries `verificationStatus` but no `verificationPolicy`,
   * no reason codes and no `verificationChecks`.
   */
  readonly requirePolicy: boolean;
}

/**
 * Asserts the platform proof is declared NEGATIVE — present and false — never absent and never
 * skipped. A block that omits the platform booleans, or asserts any single one of them, is not the
 * evaluation lane: a half-truthful mix must be refused rather than partially waived.
 */
export function evaluationAttestationDeclaredNegative(
  block: Record<string, unknown> | undefined,
  target: UpdatePortableTarget,
  options: EvaluationAttestationOptions,
): boolean {
  if (block === undefined) return false;
  if (block.signatureVerified !== false || block.notarizationVerified !== false) return false;
  if (!options.requirePolicy) return block.verificationStatus === EVALUATION_STATUS;
  return (
    declaredPortableRuntimeLane(block) === "evaluation-unqualified" &&
    platformChecksDeclaredNegative(block.verificationChecks, target) &&
    (!options.requireReasonCodes || evaluationReasonCodesPresent(block.verificationReasonCodes))
  );
}

function platformChecksDeclaredNegative(checks: unknown, target: UpdatePortableTarget): boolean {
  if (typeof checks !== "object" || checks === null || Array.isArray(checks)) return false;
  const record = checks as Record<string, unknown>;
  return platformCheckKeys(target).every((key) => record[key] === false);
}

function evaluationReasonCodesPresent(reasonCodes: unknown): boolean {
  if (!Array.isArray(reasonCodes)) return false;
  return EVALUATION_REASON_CODES.every((code) => reasonCodes.includes(code));
}
