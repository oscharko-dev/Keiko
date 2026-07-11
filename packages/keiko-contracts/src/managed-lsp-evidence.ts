// Content-free managed-LSP activation and lifecycle evidence (Issue #2271, Epic #2094, ADR-0131).
// Every string is a closed enum/literal. Raw paths, environment values, source, stderr, command
// lines, endpoints, and credentials are unrepresentable by these interfaces.

import {
  MANAGED_LSP_ACTIVATION_SCHEMA_VERSION,
  MANAGED_LSP_EFFECTIVE_STATES,
  MANAGED_LSP_LANGUAGES,
  type ManagedLspActivationReasonCode,
  type ManagedLspEffectiveState,
  type ManagedLspLanguage,
  type ManagedLspPolicyResult,
  parseManagedLspActivationStatus,
} from "./managed-lsp-activation.js";

export const MANAGED_LSP_EVIDENCE_SCHEMA_VERSION = "1" as const;

export type ManagedLspEvidenceActorClass = "localHuman" | "operator" | "policyEngine" | "system";

export const MANAGED_LSP_EVIDENCE_ACTOR_CLASSES: readonly ManagedLspEvidenceActorClass[] =
  Object.freeze([
    "localHuman",
    "operator",
    "policyEngine",
    "system",
  ] as const satisfies readonly ManagedLspEvidenceActorClass[]);

export type ManagedLspEvidenceKind = "activationChange" | "lifecycle";

export type ManagedLspEvidenceAction =
  "activate" | "deactivate" | "configure" | "reset" | "rollback" | "restart" | "lifecycle";

export const MANAGED_LSP_EVIDENCE_ACTIONS: readonly ManagedLspEvidenceAction[] = Object.freeze([
  "activate",
  "deactivate",
  "configure",
  "reset",
  "rollback",
  "restart",
  "lifecycle",
] as const satisfies readonly ManagedLspEvidenceAction[]);

export type ManagedLspEvidenceOutcome = "accepted" | "denied" | "noOp" | "failed" | "conflict";

export const MANAGED_LSP_EVIDENCE_OUTCOMES: readonly ManagedLspEvidenceOutcome[] = Object.freeze([
  "accepted",
  "denied",
  "noOp",
  "failed",
  "conflict",
] as const satisfies readonly ManagedLspEvidenceOutcome[]);

interface ManagedLspEvidenceBase {
  readonly schemaVersion: typeof MANAGED_LSP_EVIDENCE_SCHEMA_VERSION;
  readonly kind: ManagedLspEvidenceKind;
  readonly action: ManagedLspEvidenceAction;
  readonly outcome: ManagedLspEvidenceOutcome;
  readonly actorClass: ManagedLspEvidenceActorClass;
  readonly language: ManagedLspLanguage;
  readonly priorState: ManagedLspEffectiveState;
  readonly effectiveState: ManagedLspEffectiveState;
  readonly reasonCode: ManagedLspActivationReasonCode;
  readonly revision: number;
  readonly timestampMs: number;
  readonly policyResult: ManagedLspPolicyResult;
}

export interface ManagedLspActivationEvidence extends ManagedLspEvidenceBase {
  readonly kind: "activationChange";
}

export interface ManagedLspLifecycleEvidence extends ManagedLspEvidenceBase {
  readonly kind: "lifecycle";
}

export type ManagedLspEvidence = ManagedLspActivationEvidence | ManagedLspLifecycleEvidence;

export type ManagedLspEvidenceParseResult =
  | { readonly ok: true; readonly value: ManagedLspEvidence }
  | { readonly ok: false; readonly errors: readonly string[] };

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isActorClass(value: unknown): value is ManagedLspEvidenceActorClass {
  return (
    typeof value === "string" &&
    MANAGED_LSP_EVIDENCE_ACTOR_CLASSES.includes(value as ManagedLspEvidenceActorClass)
  );
}

function isManagedLanguage(value: unknown): value is ManagedLspLanguage {
  return typeof value === "string" && MANAGED_LSP_LANGUAGES.includes(value as ManagedLspLanguage);
}

function isAction(value: unknown): value is ManagedLspEvidenceAction {
  return (
    typeof value === "string" &&
    MANAGED_LSP_EVIDENCE_ACTIONS.includes(value as ManagedLspEvidenceAction)
  );
}

function isOutcome(value: unknown): value is ManagedLspEvidenceOutcome {
  return (
    typeof value === "string" &&
    MANAGED_LSP_EVIDENCE_OUTCOMES.includes(value as ManagedLspEvidenceOutcome)
  );
}

function isKindActionConsistent(value: UnknownRecord): boolean {
  return value.kind === "lifecycle"
    ? value.action === "lifecycle"
    : value.kind === "activationChange" && value.action !== "lifecycle";
}

function isEffectiveState(value: unknown): value is ManagedLspEffectiveState {
  return (
    typeof value === "string" &&
    MANAGED_LSP_EFFECTIVE_STATES.includes(value as ManagedLspEffectiveState)
  );
}

function hasConsistentEffectiveStatus(value: UnknownRecord): boolean {
  return parseManagedLspActivationStatus({
    ok: true,
    schemaVersion: MANAGED_LSP_ACTIVATION_SCHEMA_VERSION,
    language: value.language,
    configurationRevision: value.revision,
    state: value.effectiveState,
    reasonCode: value.reasonCode,
    policyResult: value.policyResult,
  }).ok;
}

function parseEvidenceUnsafe(value: unknown): ManagedLspEvidenceParseResult {
  if (!isRecord(value)) return { ok: false, errors: ["managed LSP evidence must be an object"] };
  const valid = [
    hasOnlyKeys(value, [
      "schemaVersion",
      "kind",
      "action",
      "outcome",
      "actorClass",
      "language",
      "priorState",
      "effectiveState",
      "reasonCode",
      "revision",
      "timestampMs",
      "policyResult",
    ]),
    value.schemaVersion === MANAGED_LSP_EVIDENCE_SCHEMA_VERSION,
    ["activationChange", "lifecycle"].includes(value.kind as string),
    isAction(value.action),
    isOutcome(value.outcome),
    isKindActionConsistent(value),
    isActorClass(value.actorClass),
    isManagedLanguage(value.language),
    isEffectiveState(value.priorState),
    isNonNegativeInteger(value.revision),
    isNonNegativeInteger(value.timestampMs),
    hasConsistentEffectiveStatus(value),
  ].every(Boolean);
  return valid
    ? { ok: true, value: value as unknown as ManagedLspEvidence }
    : { ok: false, errors: ["managed LSP evidence is invalid or contains unknown fields"] };
}

export function parseManagedLspEvidence(value: unknown): ManagedLspEvidenceParseResult {
  try {
    return parseEvidenceUnsafe(value);
  } catch (error: unknown) {
    return {
      ok: false,
      errors: [
        `payload could not be inspected: ${error instanceof Error ? error.name : "unknown"}`,
      ],
    };
  }
}
