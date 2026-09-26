// Severity levels for the server activity log.
//
// Four levels only, ranked, plus a threshold-only `silent` so an operator can turn the log off
// without the code growing a second "enabled" switch. The threshold is read from
// `KEIKO_LOG_LEVEL`; an unset or unrecognised value falls back to `info` rather than failing —
// a typo in an environment variable must never silence the log the operator is trying to read,
// and must never crash the process either.

export type ServerLogLevel = "debug" | "info" | "warn" | "error";

// `silent` is a threshold, never an event level: nothing is ever emitted AT silent.
export type ServerLogThreshold = ServerLogLevel | "silent";

export const SERVER_LOG_LEVELS: readonly ServerLogLevel[] = ["debug", "info", "warn", "error"];

export const DEFAULT_SERVER_LOG_LEVEL: ServerLogLevel = "info";

export const SERVER_LOG_LEVEL_ENV = "KEIKO_LOG_LEVEL";

// Ranks are spaced so a future level can be inserted without renumbering.
const LEVEL_RANK: Readonly<Record<ServerLogThreshold, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const LEVEL_NAMES = new Set<string>(["debug", "info", "warn", "error"]);
const THRESHOLD_NAMES = new Set<string>(["debug", "info", "warn", "error", "silent"]);

export function isServerLogLevel(value: unknown): value is ServerLogLevel {
  return typeof value === "string" && LEVEL_NAMES.has(value);
}

export function isServerLogThreshold(value: unknown): value is ServerLogThreshold {
  return typeof value === "string" && THRESHOLD_NAMES.has(value);
}

export function serverLogLevelRank(level: ServerLogThreshold): number {
  return LEVEL_RANK[level];
}

// True when an event at `level` passes a sink configured at `threshold`.
export function serverLogLevelEnabled(
  level: ServerLogLevel,
  threshold: ServerLogThreshold,
): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[threshold];
}

// The names operators reach for that are not one of ours. A table rather than a branch chain so
// adding one never moves this function's complexity.
const THRESHOLD_ALIASES = new Map<string, ServerLogThreshold>([
  ["trace", "debug"],
  ["verbose", "debug"],
  ["warning", "warn"],
  ["fatal", "error"],
  ["critical", "error"],
  ["off", "silent"],
  ["none", "silent"],
]);

// Accepts the level names case-insensitively and tolerates surrounding whitespace, plus the
// aliases above. Anything else returns the supplied fallback.
export function parseServerLogThreshold(
  value: string | undefined,
  fallback: ServerLogThreshold = DEFAULT_SERVER_LOG_LEVEL,
): ServerLogThreshold {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (isServerLogThreshold(normalized)) return normalized;
  return THRESHOLD_ALIASES.get(normalized) ?? fallback;
}

export type ServerLogEnv = Readonly<Record<string, string | undefined>>;

export function resolveServerLogThreshold(
  env: ServerLogEnv,
  fallback: ServerLogThreshold = DEFAULT_SERVER_LOG_LEVEL,
): ServerLogThreshold {
  return parseServerLogThreshold(env[SERVER_LOG_LEVEL_ENV], fallback);
}
