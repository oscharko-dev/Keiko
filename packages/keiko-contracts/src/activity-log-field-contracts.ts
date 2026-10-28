// Pure field construction shared by producer declarations and the generated runtime registry.
// Keep key order and omission exact; each call owns its descriptor, while enum input aliases stay.
export function activityLogCountField<const Required extends boolean>(
  required: Required,
): { readonly type: "integer"; readonly dataClass: "count"; readonly required: Required } {
  return { type: "integer", dataClass: "count", required };
}

export function activityLogDurationField<const Required extends boolean>(
  required: Required,
): { readonly type: "integer"; readonly dataClass: "duration"; readonly required: Required } {
  return { type: "integer", dataClass: "duration", required };
}

export function activityLogBooleanField<const Required extends boolean>(
  required: Required,
): { readonly type: "boolean"; readonly dataClass: "closed-enum"; readonly required: Required } {
  return { type: "boolean", dataClass: "closed-enum", required };
}

export function activityLogStringEnumField<
  const Required extends boolean,
  const Values extends readonly string[],
>(
  required: Required,
  values: Values,
): {
  readonly type: "string";
  readonly dataClass: "closed-enum";
  readonly required: Required;
  readonly values: Values;
} {
  return { type: "string", dataClass: "closed-enum", required, values };
}

interface AutomaticCatalogFields {
  readonly outcome: ReturnType<
    typeof activityLogStringEnumField<
      true,
      readonly ["applied", "unchanged", "stale", "cancelled", "failed", "retry-decision"]
    >
  >;
  readonly phase: ReturnType<
    typeof activityLogStringEnumField<false, readonly ["catalog", "retry-decision"]>
  >;
  readonly backgroundAttempt: ReturnType<typeof activityLogCountField<false>>;
  readonly configurationGeneration: ReturnType<typeof activityLogCountField<false>>;
  readonly retryDisposition: ReturnType<
    typeof activityLogStringEnumField<
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
  readonly retryDelayMs: ReturnType<typeof activityLogDurationField<false>>;
  readonly retryDeadlineMs: ReturnType<typeof activityLogCountField<false>>;
  readonly configuredModelCount: ReturnType<typeof activityLogCountField<true>>;
  readonly updatedModelCount: ReturnType<typeof activityLogCountField<true>>;
  readonly addedModelCount: ReturnType<typeof activityLogCountField<true>>;
  readonly removedModelCount: ReturnType<typeof activityLogCountField<true>>;
  readonly deploymentChangedModelCount: ReturnType<typeof activityLogCountField<true>>;
  readonly elapsedMs: ReturnType<typeof activityLogDurationField<true>>;
  readonly retryable: ReturnType<typeof activityLogBooleanField<true>>;
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
