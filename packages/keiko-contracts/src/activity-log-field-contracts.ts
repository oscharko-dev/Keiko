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
