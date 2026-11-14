// The Vitest worker count every capped config shares (GEN-TEST-FLAKE-001/002).
//
// The repository's integration tests start servers, parse PDFs, spawn launcher processes and build
// large temporary trees. Letting Vitest fan out over every core starves them into false-red
// failures, so the suites are capped. The cap used to be a literal 2 in each config; that is right
// for a small shared CI runner and far too low for a development machine, where a gate job then
// used about two cores of sixteen. This module is the one place the number is decided:
//
//   1. `KEIKO_VITEST_MAX_WORKERS`, an integer from 1 to 16, wins. Anything else is ignored.
//   2. Otherwise 2 when `CI` is set: CI behaviour is exactly what it was.
//   3. Otherwise 4 on a development machine.
//
// To go back to two locally, for a full-suite run that shows a starvation flake, set
// `KEIKO_VITEST_MAX_WORKERS=2`.

export const CI_MAX_WORKERS = 2;
export const LOCAL_MAX_WORKERS = 4;
const MIN_MAX_WORKERS = 1;
const MAX_MAX_WORKERS = 16;

const OVERRIDE_VARIABLE = "KEIKO_VITEST_MAX_WORKERS";

function explicitOverride(env) {
  const raw = env[OVERRIDE_VARIABLE];
  if (typeof raw !== "string" || !/^[0-9]{1,2}$/u.test(raw.trim())) return undefined;
  const count = Number(raw.trim());
  return count >= MIN_MAX_WORKERS && count <= MAX_MAX_WORKERS ? count : undefined;
}

/** The worker count for the given environment (the process environment by default). */
export function vitestMaxWorkers(env = process.env) {
  const override = explicitOverride(env);
  if (override !== undefined) return override;
  const ci = env.CI;
  return typeof ci === "string" && ci.length > 0 ? CI_MAX_WORKERS : LOCAL_MAX_WORKERS;
}
