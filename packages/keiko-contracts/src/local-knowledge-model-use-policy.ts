import type { LocalKnowledgeValidation } from "./local-knowledge-validation.js";

export const KNOWLEDGE_POD_MODEL_USE_POLICY_SCHEMA_VERSION = "1" as const;

export const KNOWLEDGE_POD_MODEL_USE_POLICY_MODES = ["sealed-local", "standard", "custom"] as const;
export type KnowledgePodModelUsePolicyMode = (typeof KNOWLEDGE_POD_MODEL_USE_POLICY_MODES)[number];

export const KNOWLEDGE_POD_MODEL_USE_POLICY_DECISIONS = ["allow", "deny", "inherit"] as const;
export type KnowledgePodModelUsePolicyDecision =
  (typeof KNOWLEDGE_POD_MODEL_USE_POLICY_DECISIONS)[number];

export const KNOWLEDGE_POD_MODEL_USE_POLICY_RESOLVED_DECISIONS = ["allow", "deny"] as const;
export type KnowledgePodModelUsePolicyResolvedDecision =
  (typeof KNOWLEDGE_POD_MODEL_USE_POLICY_RESOLVED_DECISIONS)[number];

export const KNOWLEDGE_POD_MODEL_USE_OPERATIONS = [
  "externalEmbeddings",
  "localEmbeddings",
  "externalReranking",
  "localReranking",
  "answerSynthesis",
  "rawContentRelease",
  "evidencePersistence",
] as const;
export type KnowledgePodModelUseOperation = (typeof KNOWLEDGE_POD_MODEL_USE_OPERATIONS)[number];

export type KnowledgePodModelUsePolicyOperations = Readonly<
  Record<KnowledgePodModelUseOperation, KnowledgePodModelUsePolicyDecision>
>;

export type KnowledgePodResolvedModelUsePolicyOperations = Readonly<
  Record<KnowledgePodModelUseOperation, KnowledgePodModelUsePolicyResolvedDecision>
>;

export type KnowledgePodModelUsePolicySource = "explicit" | "legacy-default";

export interface KnowledgePodModelUsePolicy {
  readonly schemaVersion: typeof KNOWLEDGE_POD_MODEL_USE_POLICY_SCHEMA_VERSION;
  readonly mode: KnowledgePodModelUsePolicyMode;
  readonly operations: KnowledgePodModelUsePolicyOperations;
}

export interface KnowledgePodResolvedModelUsePolicy {
  readonly source: KnowledgePodModelUsePolicySource;
  readonly mode: KnowledgePodModelUsePolicyMode;
  readonly operations: KnowledgePodResolvedModelUsePolicyOperations;
}

const POLICY_KEYS = ["schemaVersion", "mode", "operations"] as const;
const OPERATIONS_KEYS = KNOWLEDGE_POD_MODEL_USE_OPERATIONS;

const SEALED_LOCAL_OPERATIONS: KnowledgePodResolvedModelUsePolicyOperations = {
  externalEmbeddings: "deny",
  localEmbeddings: "allow",
  externalReranking: "deny",
  localReranking: "allow",
  answerSynthesis: "deny",
  rawContentRelease: "deny",
  evidencePersistence: "allow",
} as const;

const STANDARD_OPERATIONS: KnowledgePodResolvedModelUsePolicyOperations = {
  externalEmbeddings: "allow",
  localEmbeddings: "allow",
  externalReranking: "allow",
  localReranking: "allow",
  answerSynthesis: "allow",
  rawContentRelease: "allow",
  evidencePersistence: "allow",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
  errors: string[],
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      errors.push(`${field} must not include ${key}`);
      return;
    }
  }
}

function validateOperations(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("modelUsePolicy.operations must be an object");
    return;
  }
  onlyKeys(value, OPERATIONS_KEYS, "modelUsePolicy.operations", errors);
  for (const operation of OPERATIONS_KEYS) {
    if (!KNOWLEDGE_POD_MODEL_USE_POLICY_DECISIONS.includes(value[operation] as never)) {
      errors.push(`modelUsePolicy.operations.${operation} is invalid`);
      return;
    }
  }
}

function resolvedDefaultForMode(
  mode: KnowledgePodModelUsePolicyMode,
): KnowledgePodResolvedModelUsePolicyOperations {
  return mode === "standard" ? STANDARD_OPERATIONS : SEALED_LOCAL_OPERATIONS;
}

function resolveOperations(
  policy: KnowledgePodModelUsePolicy,
): KnowledgePodResolvedModelUsePolicyOperations {
  const defaults = resolvedDefaultForMode(policy.mode);
  return {
    externalEmbeddings:
      policy.operations.externalEmbeddings === "inherit"
        ? defaults.externalEmbeddings
        : policy.operations.externalEmbeddings,
    localEmbeddings:
      policy.operations.localEmbeddings === "inherit"
        ? defaults.localEmbeddings
        : policy.operations.localEmbeddings,
    externalReranking:
      policy.operations.externalReranking === "inherit"
        ? defaults.externalReranking
        : policy.operations.externalReranking,
    localReranking:
      policy.operations.localReranking === "inherit"
        ? defaults.localReranking
        : policy.operations.localReranking,
    answerSynthesis:
      policy.operations.answerSynthesis === "inherit"
        ? defaults.answerSynthesis
        : policy.operations.answerSynthesis,
    rawContentRelease:
      policy.operations.rawContentRelease === "inherit"
        ? defaults.rawContentRelease
        : policy.operations.rawContentRelease,
    evidencePersistence:
      policy.operations.evidencePersistence === "inherit"
        ? defaults.evidencePersistence
        : policy.operations.evidencePersistence,
  };
}

export function sealedLocalPodModelUsePolicy(): KnowledgePodModelUsePolicy {
  return {
    schemaVersion: KNOWLEDGE_POD_MODEL_USE_POLICY_SCHEMA_VERSION,
    mode: "sealed-local",
    operations: SEALED_LOCAL_OPERATIONS,
  };
}

export function standardPodModelUsePolicy(): KnowledgePodModelUsePolicy {
  return {
    schemaVersion: KNOWLEDGE_POD_MODEL_USE_POLICY_SCHEMA_VERSION,
    mode: "standard",
    operations: STANDARD_OPERATIONS,
  };
}

export function validateKnowledgePodModelUsePolicy(
  input: unknown,
): LocalKnowledgeValidation<KnowledgePodModelUsePolicy> {
  if (!isRecord(input)) return { ok: false, errors: ["modelUsePolicy must be an object"] };
  const errors: string[] = [];
  onlyKeys(input, POLICY_KEYS, "modelUsePolicy", errors);
  if (input.schemaVersion !== KNOWLEDGE_POD_MODEL_USE_POLICY_SCHEMA_VERSION) {
    errors.push("modelUsePolicy.schemaVersion is invalid");
  }
  if (!KNOWLEDGE_POD_MODEL_USE_POLICY_MODES.includes(input.mode as never)) {
    errors.push("modelUsePolicy.mode is invalid");
  }
  validateOperations(input.operations, errors);
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: input as unknown as KnowledgePodModelUsePolicy };
}

export function resolveKnowledgePodModelUsePolicy(
  policy: KnowledgePodModelUsePolicy | undefined,
): KnowledgePodResolvedModelUsePolicy {
  if (policy === undefined) {
    return {
      source: "legacy-default",
      mode: "sealed-local",
      operations: SEALED_LOCAL_OPERATIONS,
    };
  }
  return {
    source: "explicit",
    mode: policy.mode,
    operations: resolveOperations(policy),
  };
}

export function isKnowledgePodModelUseOperationAllowed(
  policy: KnowledgePodResolvedModelUsePolicy,
  operation: KnowledgePodModelUseOperation,
): boolean {
  return policy.operations[operation] === "allow";
}
