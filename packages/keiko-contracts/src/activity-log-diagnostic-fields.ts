import type { ActivityLogFieldContract } from "./observability.js";

/** Opt-in diagnostic fields. Operations with different classifications or bounds declare their own. */
export const ACTIVITY_LOG_DIAGNOSTIC_FIELDS = {
  frames: {
    type: "string-array",
    dataClass: "opaque-id",
    required: false,
    maxLength: 512,
    maxItems: 8,
  },
  causeChain: {
    type: "string-array",
    dataClass: "error-kind",
    required: false,
    maxLength: 128,
    maxItems: 5,
  },
} as const satisfies Readonly<Record<string, ActivityLogFieldContract>>;
