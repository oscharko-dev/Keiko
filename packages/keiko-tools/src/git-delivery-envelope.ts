import type {
  GitDeliveryActionEnvelopeFor,
  GitDeliveryActionKind,
  GitDeliveryActionPreview,
  GitDeliveryApprovalRequirement,
  GitDeliveryExecutionResult,
  GitDeliveryPolicyDecision,
  GitDeliveryResolvedInputs,
} from "@oscharko-dev/keiko-contracts";
import { GIT_DELIVERY_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/git-delivery";

/** Each action kind's own resolved-inputs member. */
export type GitDeliveryInputsByKind = {
  readonly [K in GitDeliveryActionKind]: Extract<GitDeliveryResolvedInputs, { kind: K }>;
};

/**
 * The envelope of one kind. For a union of kinds this is the union of the per-kind envelopes, so
 * an envelope built from any resolved inputs is a GitDeliveryActionEnvelope member.
 */
type GitDeliveryEnvelopeByKind<K extends GitDeliveryActionKind> = {
  readonly [P in K]: Omit<GitDeliveryActionEnvelopeFor<GitDeliveryInputsByKind[P]>, "kind"> & {
    readonly kind: P;
  };
}[K];

/** The envelope fields that do not depend on the action kind. */
export interface GitDeliveryEnvelopeFields {
  readonly actionId: string;
  readonly policyDecision: GitDeliveryPolicyDecision;
  readonly approvalRequirement: GitDeliveryApprovalRequirement;
  readonly preview: GitDeliveryActionPreview;
  readonly executionResult: GitDeliveryExecutionResult | undefined;
}

/** The envelope of resolved inputs; its kind is always the inputs' own kind. */
export function gitDeliveryActionEnvelope<K extends GitDeliveryActionKind>(
  inputs: GitDeliveryInputsByKind[K],
  fields: GitDeliveryEnvelopeFields,
): GitDeliveryEnvelopeByKind<K> {
  const envelope = {
    schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
    actionId: fields.actionId,
    kind: inputs.kind,
    resolvedInputs: inputs,
    policyDecision: fields.policyDecision,
    approvalRequirement: fields.approvalRequirement,
    preview: fields.preview,
  };
  const { executionResult } = fields;
  return executionResult === undefined ? envelope : { ...envelope, executionResult };
}
