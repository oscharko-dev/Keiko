import { causeChain, keikoStackFrames } from "@oscharko-dev/keiko-activity-log";

/**
 * The shared shape of a body-free state line: the closed outcome decides its level, the optional
 * fields carry only the values a producer set, and a failure adds its Keiko frames and cause chain.
 */
export interface ActivityStateLine {
  readonly outcome: string;
  readonly error?: unknown;
}

/** A state line that names its closed action and reason and may carry its duration. */
export interface ActivityActionLine<
  Action extends string,
  Outcome extends string,
  Reason extends string,
> extends ActivityStateLine {
  readonly action: Action;
  readonly outcome: Outcome;
  readonly reason?: Reason | undefined;
  readonly durationMs?: number | undefined;
}

/** A refusal or failure is a warning; a failure is also an internal error. */
export function activityStateLevel(outcome: string): {
  readonly level?: "warn";
  readonly errorKind?: "internal";
} {
  if (outcome === "failed") return { level: "warn", errorKind: "internal" };
  return outcome === "refused" ? { level: "warn" } : {};
}

/** The listed fields a line actually carries; an absent value never becomes a key. */
export function definedActivityFields<Line>(
  line: Line,
  keys: readonly (keyof Line & string)[],
): Readonly<Record<string, number | string>> {
  const fields: Record<string, number | string> = {};
  for (const key of keys) {
    const value = line[key];
    if (typeof value === "number" || typeof value === "string") fields[key] = value;
  }
  return fields;
}

/** The Keiko stack frames and cause chain of a line's failure, or nothing without one. */
export function activityErrorFields(line: ActivityStateLine): {
  readonly frames?: readonly string[];
  readonly causeChain?: readonly string[];
} {
  return line.error === undefined
    ? {}
    : { frames: keikoStackFrames(line.error), causeChain: causeChain(line.error) };
}
