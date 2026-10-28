// Pure field construction shared by producer declarations and the generated runtime registry.
// Keep key order and omission exact; each call owns its descriptor, while enum input aliases stay.
interface ActivityLogFieldContractBase {
  readonly required: boolean;
  readonly maxLength?: number | undefined;
  readonly maxItems?: number | undefined;
  readonly values?: readonly string[] | undefined;
}

// Keep the declared primitive and semantic class coupled. The generated-registry program consumes
// TypeScript diagnostics, so an impossible pair is rejected at generation time rather than becoming
// a runtime contract whose data class can never be enforced coherently.
export type ActivityLogFieldContract = ActivityLogFieldContractBase &
  (
    | { readonly type: "boolean"; readonly dataClass: "closed-enum" }
    | {
        readonly type: "integer";
        readonly dataClass: "count" | "duration" | "safe-version";
      }
    | { readonly type: "number"; readonly dataClass: "count" | "duration" }
    | {
        readonly type: "string";
        readonly dataClass:
          | "closed-enum"
          | "completeness-state"
          | "digest"
          | "error-kind"
          | "loss-state"
          | "opaque-id"
          | "safe-platform-class"
          | "safe-version";
      }
    | {
        readonly type: "string-array";
        readonly dataClass:
          "closed-enum" | "digest" | "error-kind" | "opaque-id" | "safe-platform-class";
      }
  );

type BoundedStringDataClass = Exclude<
  Extract<ActivityLogFieldContract, { readonly type: "string" }>["dataClass"],
  "closed-enum" | "completeness-state" | "loss-state"
>;
type BoundedStringArrayDataClass = Exclude<
  Extract<ActivityLogFieldContract, { readonly type: "string-array" }>["dataClass"],
  "closed-enum"
>;

export interface ActivityLogBoundedStringFieldContract<
  Required extends boolean,
  DataClass extends BoundedStringDataClass,
  MaxLength extends number,
> {
  readonly type: "string";
  readonly dataClass: DataClass;
  readonly required: Required;
  readonly maxLength: MaxLength;
}

export interface ActivityLogBoundedStringArrayFieldContract<
  Required extends boolean,
  DataClass extends BoundedStringArrayDataClass,
  MaxLength extends number,
  MaxItems extends number,
> {
  readonly type: "string-array";
  readonly dataClass: DataClass;
  readonly required: Required;
  readonly maxLength: MaxLength;
  readonly maxItems: MaxItems;
}

export function activityLogBoundedStringField<
  const Required extends boolean,
  const DataClass extends BoundedStringDataClass,
  const MaxLength extends number,
>(
  required: Required,
  dataClass: DataClass,
  maxLength: MaxLength,
): Readonly<ActivityLogBoundedStringFieldContract<Required, DataClass, MaxLength>> {
  return { type: "string", dataClass, required, maxLength };
}

export function activityLogBoundedStringArrayField<
  const Required extends boolean,
  const DataClass extends BoundedStringArrayDataClass,
  const MaxLength extends number,
  const MaxItems extends number,
>(
  required: Required,
  dataClass: DataClass,
  maxLength: MaxLength,
  maxItems: MaxItems,
): Readonly<ActivityLogBoundedStringArrayFieldContract<Required, DataClass, MaxLength, MaxItems>> {
  return { type: "string-array", dataClass, required, maxLength, maxItems };
}

export interface ActivityLogCountFieldContract<Required extends boolean> {
  readonly type: "integer";
  readonly dataClass: "count";
  readonly required: Required;
}

export interface ActivityLogDurationFieldContract<Required extends boolean> {
  readonly type: "integer";
  readonly dataClass: "duration";
  readonly required: Required;
}

export interface ActivityLogBooleanFieldContract<Required extends boolean> {
  readonly type: "boolean";
  readonly dataClass: "closed-enum";
  readonly required: Required;
}

export interface ActivityLogStringEnumFieldContract<
  Required extends boolean,
  Values extends readonly string[],
> {
  readonly type: "string";
  readonly dataClass: "closed-enum";
  readonly required: Required;
  readonly values: Values;
}

export function activityLogCountField<const Required extends boolean>(
  required: Required,
): Readonly<ActivityLogCountFieldContract<Required>> {
  return { type: "integer", dataClass: "count", required };
}

export function activityLogDurationField<const Required extends boolean>(
  required: Required,
): Readonly<ActivityLogDurationFieldContract<Required>> {
  return { type: "integer", dataClass: "duration", required };
}

export function activityLogBooleanField<const Required extends boolean>(
  required: Required,
): Readonly<ActivityLogBooleanFieldContract<Required>> {
  return { type: "boolean", dataClass: "closed-enum", required };
}

export function activityLogStringEnumField<
  const Required extends boolean,
  const Values extends readonly string[],
>(
  required: Required,
  values: Values,
): Readonly<ActivityLogStringEnumFieldContract<Required, Values>> {
  return { type: "string", dataClass: "closed-enum", required, values };
}

interface AutomaticCatalogFields {
  readonly outcome: Readonly<
    ActivityLogStringEnumFieldContract<
      true,
      readonly ["applied", "unchanged", "stale", "cancelled", "failed", "retry-decision"]
    >
  >;
  readonly phase: Readonly<
    ActivityLogStringEnumFieldContract<false, readonly ["catalog", "retry-decision"]>
  >;
  readonly backgroundAttempt: Readonly<ActivityLogCountFieldContract<false>>;
  readonly configurationGeneration: Readonly<ActivityLogCountFieldContract<false>>;
  readonly retryDisposition: Readonly<
    ActivityLogStringEnumFieldContract<
      false,
      readonly [
        "scheduled",
        "exhausted",
        "coalesced",
        "in-flight",
        "backoff",
        "conclusive",
        "complete",
      ]
    >
  >;
  readonly retryDelayMs: Readonly<ActivityLogDurationFieldContract<false>>;
  readonly retryDeadlineMs: Readonly<ActivityLogCountFieldContract<false>>;
  readonly configuredModelCount: Readonly<ActivityLogCountFieldContract<true>>;
  readonly updatedModelCount: Readonly<ActivityLogCountFieldContract<true>>;
  readonly addedModelCount: Readonly<ActivityLogCountFieldContract<true>>;
  readonly removedModelCount: Readonly<ActivityLogCountFieldContract<true>>;
  readonly deploymentChangedModelCount: Readonly<ActivityLogCountFieldContract<true>>;
  readonly elapsedMs: Readonly<ActivityLogDurationFieldContract<true>>;
  readonly retryable: Readonly<ActivityLogBooleanFieldContract<true>>;
}

// The automatic catalog completion owns this closed, ordered field policy. Every call
// allocates its own ordinary field graph, including each inline enum vocabulary.
export function activityLogAutomaticCatalogFields(): Readonly<AutomaticCatalogFields> {
  return {
    outcome: activityLogStringEnumField(true, [
      "applied",
      "unchanged",
      "stale",
      "cancelled",
      "failed",
      "retry-decision",
    ]),
    phase: activityLogStringEnumField(false, ["catalog", "retry-decision"]),
    backgroundAttempt: activityLogCountField(false),
    configurationGeneration: activityLogCountField(false),
    retryDisposition: activityLogStringEnumField(false, [
      "scheduled",
      "exhausted",
      "coalesced",
      "in-flight",
      "backoff",
      "conclusive",
      "complete",
    ]),
    retryDelayMs: activityLogDurationField(false),
    // Absolute epoch milliseconds observed by the existing timer/cache owner, not a timeout bound.
    retryDeadlineMs: activityLogCountField(false),
    configuredModelCount: activityLogCountField(true),
    // Every model whose record differs after the reconciliation, the added and removed included.
    updatedModelCount: activityLogCountField(true),
    // Models the catalog listed that were not configured, and configured ones it no longer lists.
    addedModelCount: activityLogCountField(true),
    removedModelCount: activityLogCountField(true),
    // Models whose observed deployment identity was first recorded or replaced (#3905); each one
    // withdrew the tool-calling proof it carried until the readiness queue renews it.
    deploymentChangedModelCount: activityLogCountField(true),
    elapsedMs: activityLogDurationField(true),
    retryable: activityLogBooleanField(true),
  };
}

export interface ActivityLogCompletenessFieldContract {
  readonly type: "string";
  readonly dataClass: "completeness-state";
  readonly required: true;
}

export interface ActivityLogLossFieldContract {
  readonly type: "string";
  readonly dataClass: "loss-state";
  readonly required: true;
}

export function activityLogCompletenessField(): Readonly<ActivityLogCompletenessFieldContract> {
  return { type: "string", dataClass: "completeness-state", required: true };
}

export function activityLogLossField(): Readonly<ActivityLogLossFieldContract> {
  return { type: "string", dataClass: "loss-state", required: true };
}

export interface ActivityLogEmbeddingBatchRetryFields {
  readonly capsuleIdDigest: {
    readonly type: "string";
    readonly dataClass: "digest";
    readonly required: false;
    readonly maxLength: 64;
  };
  readonly documentIdDigest: {
    readonly type: "string";
    readonly dataClass: "digest";
    readonly required: false;
    readonly maxLength: 64;
  };
  readonly attempt: {
    readonly type: "integer";
    readonly dataClass: "count";
    readonly required: true;
  };
  readonly zeroProgressRetries: {
    readonly type: "integer";
    readonly dataClass: "count";
    readonly required: true;
  };
  readonly maxRetries: {
    readonly type: "integer";
    readonly dataClass: "count";
    readonly required: true;
  };
  readonly delayMs: {
    readonly type: "number";
    readonly dataClass: "duration";
    readonly required: true;
  };
  readonly remainingCount: {
    readonly type: "integer";
    readonly dataClass: "count";
    readonly required: true;
  };
  readonly completedCount: {
    readonly type: "integer";
    readonly dataClass: "count";
    readonly required: true;
  };
  readonly transport: {
    readonly type: "string";
    readonly dataClass: "closed-enum";
    readonly required: true;
    readonly values: readonly ["array-batch"];
  };
  readonly endpointDigest: {
    readonly type: "string";
    readonly dataClass: "digest";
    readonly required: false;
    readonly maxLength: 16;
  };
  readonly failureKind: {
    readonly type: "string";
    readonly dataClass: "error-kind";
    readonly required: true;
    readonly maxLength: 64;
  };
}

export function activityLogEmbeddingBatchRetryFields(): Readonly<ActivityLogEmbeddingBatchRetryFields> {
  return {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    documentIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    attempt: { type: "integer", dataClass: "count", required: true },
    zeroProgressRetries: { type: "integer", dataClass: "count", required: true },
    maxRetries: { type: "integer", dataClass: "count", required: true },
    delayMs: { type: "number", dataClass: "duration", required: true },
    remainingCount: { type: "integer", dataClass: "count", required: true },
    completedCount: { type: "integer", dataClass: "count", required: true },
    transport: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["array-batch"],
    },
    endpointDigest: { type: "string", dataClass: "digest", required: false, maxLength: 16 },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
  };
}

export interface ActivityLogCommitDraftModelFields {
  readonly outcome: Readonly<
    ActivityLogStringEnumFieldContract<true, readonly ["succeeded", "failed"]>
  >;
  readonly failureCode: Readonly<
    ActivityLogStringEnumFieldContract<
      false,
      readonly [
        "GIT_DELIVERY_COMMIT_BAD_REQUEST",
        "GIT_DELIVERY_COMMIT_PAYLOAD_TOO_LARGE",
        "GIT_DELIVERY_COMMIT_FORBIDDEN_PAYLOAD",
        "GIT_DELIVERY_COMMIT_DRAFT_CONTEXT_TOO_LARGE",
        "GIT_DELIVERY_COMMIT_DRAFT_FAILED",
        "GIT_DELIVERY_COMMIT_DRAFT_INVALID_OUTPUT",
        "GIT_DELIVERY_COMMIT_DRAFT_OUTPUT_EXHAUSTED",
        "GIT_DELIVERY_COMMIT_DRAFT_TIMED_OUT",
        "GIT_DELIVERY_COMMIT_DRAFT_CANCELLED",
        "GIT_DELIVERY_COMMIT_DRAFT_MODEL_UNAVAILABLE",
        "GIT_DELIVERY_COMMIT_DRAFT_NO_CHANGES",
        "GIT_DELIVERY_COMMIT_UNKNOWN_PROJECT",
        "GIT_DELIVERY_COMMIT_WORKTREE_UNAVAILABLE",
      ]
    >
  >;
  readonly maxOutputTokens: Readonly<ActivityLogCountFieldContract<false>>;
  readonly deadlineMs: Readonly<ActivityLogDurationFieldContract<false>>;
  readonly promptTokens: Readonly<ActivityLogCountFieldContract<false>>;
  readonly maxPromptTokens: Readonly<ActivityLogCountFieldContract<false>>;
  readonly diffCompacted: Readonly<ActivityLogBooleanFieldContract<false>>;
  readonly generationAttempts: Readonly<ActivityLogCountFieldContract<false>>;
  readonly reused: Readonly<ActivityLogBooleanFieldContract<false>>;
  readonly draftKeyDigest: {
    readonly type: "string";
    readonly dataClass: "digest";
    readonly required: false;
    readonly maxLength: 64;
  };
  readonly normalizationVersion: Readonly<
    ActivityLogStringEnumFieldContract<false, readonly ["1"]>
  >;
  readonly normalizationRule: Readonly<
    ActivityLogStringEnumFieldContract<
      false,
      readonly ["body-only", "terminal-trailers", "explicit-trailers"]
    >
  >;
  readonly normalizationChanged: Readonly<ActivityLogBooleanFieldContract<false>>;
  readonly bodyBulletCount: Readonly<ActivityLogCountFieldContract<false>>;
  readonly trailerLikeLineCount: Readonly<ActivityLogCountFieldContract<false>>;
  readonly trailerCount: Readonly<ActivityLogCountFieldContract<false>>;
  readonly trailerContinuationCount: Readonly<ActivityLogCountFieldContract<false>>;
  readonly trailerParagraphBreakCount: Readonly<ActivityLogCountFieldContract<false>>;
  readonly referenceTrailerCount: Readonly<ActivityLogCountFieldContract<false>>;
  readonly breakingTrailerCount: Readonly<ActivityLogCountFieldContract<false>>;
}

export function activityLogCommitDraftModelFields(): Readonly<ActivityLogCommitDraftModelFields> {
  return {
    outcome: activityLogStringEnumField(true, ["succeeded", "failed"]),
    failureCode: activityLogStringEnumField(false, [
      "GIT_DELIVERY_COMMIT_BAD_REQUEST",
      "GIT_DELIVERY_COMMIT_PAYLOAD_TOO_LARGE",
      "GIT_DELIVERY_COMMIT_FORBIDDEN_PAYLOAD",
      "GIT_DELIVERY_COMMIT_DRAFT_CONTEXT_TOO_LARGE",
      "GIT_DELIVERY_COMMIT_DRAFT_FAILED",
      "GIT_DELIVERY_COMMIT_DRAFT_INVALID_OUTPUT",
      "GIT_DELIVERY_COMMIT_DRAFT_OUTPUT_EXHAUSTED",
      "GIT_DELIVERY_COMMIT_DRAFT_TIMED_OUT",
      "GIT_DELIVERY_COMMIT_DRAFT_CANCELLED",
      "GIT_DELIVERY_COMMIT_DRAFT_MODEL_UNAVAILABLE",
      "GIT_DELIVERY_COMMIT_DRAFT_NO_CHANGES",
      "GIT_DELIVERY_COMMIT_UNKNOWN_PROJECT",
      "GIT_DELIVERY_COMMIT_WORKTREE_UNAVAILABLE",
    ]),
    // #3591 (1.1.7): the bounds the model call ran under, present once a model was resolved — the
    // output allowance sent (the raised draft budget, clamped to the model's declared limit) and
    // the route's own deadline behind the gateway's floors — so an exhausted or timed-out draft
    // can be reconstructed from this line alone.
    maxOutputTokens: activityLogCountField(false),
    deadlineMs: activityLogDurationField(false),
    promptTokens: activityLogCountField(false),
    maxPromptTokens: activityLogCountField(false),
    diffCompacted: activityLogBooleanField(false),
    generationAttempts: activityLogCountField(false),
    reused: activityLogBooleanField(false),
    draftKeyDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    normalizationVersion: activityLogStringEnumField(false, ["1"]),
    normalizationRule: activityLogStringEnumField(false, [
      "body-only",
      "terminal-trailers",
      "explicit-trailers",
    ]),
    normalizationChanged: activityLogBooleanField(false),
    bodyBulletCount: activityLogCountField(false),
    trailerLikeLineCount: activityLogCountField(false),
    trailerCount: activityLogCountField(false),
    trailerContinuationCount: activityLogCountField(false),
    trailerParagraphBreakCount: activityLogCountField(false),
    referenceTrailerCount: activityLogCountField(false),
    breakingTrailerCount: activityLogCountField(false),
  };
}
