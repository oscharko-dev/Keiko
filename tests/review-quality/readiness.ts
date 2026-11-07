// Readiness probes of the offline review gate (Issue #4138). A replay probes both models through
// the composition's readiness route at its start and again once its pull requests are prepared,
// because preparing the holdout takes minutes and the gateway closes idle connections in that time.
// After preparation it stops before its first review when a model still fails. A re-scored replay
// (`--rescore`) calls no model at all, so it probes nothing and records `null` (resume.ts).

import type { GateArguments } from "./cli.js";

const READINESS_TIMEOUT_MS = 900_000;
const READINESS_ATTEMPTS = 5;
const READINESS_RETRY_MS = 30_000;
const PROBE_PASSED = /^200\/(ready|partial)$/;

/** Each model's probe outcome as `<http status>/<overall status>`. */
export type ReadinessOutcomes = Readonly<Record<string, string>>;

export type ReadinessProbe = (args: GateArguments) => Promise<ReadinessOutcomes>;

/** Probes both models through the composition's readiness route, as an operator's start would. */
async function probeReadiness(args: GateArguments): Promise<ReadinessOutcomes> {
  const outcomes: Record<string, string> = {};
  for (const modelId of [args.reviewerModelId, args.counterCheckerModelId]) {
    const response = await fetch(`http://127.0.0.1:${String(args.port)}/api/gateway/readiness`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-keiko-csrf": "1" },
      body: JSON.stringify({ modelId }),
      signal: AbortSignal.timeout(READINESS_TIMEOUT_MS),
    });
    const body = (await response.json()) as { readonly overallStatus?: string };
    outcomes[modelId] = `${String(response.status)}/${body.overallStatus ?? "unknown"}`;
  }
  return outcomes;
}

function allPassed(outcomes: ReadinessOutcomes): boolean {
  return Object.values(outcomes).every((outcome) => PROBE_PASSED.test(outcome));
}

/** Probes until every model passes; throws after the final failed attempt. */
export async function probeUntilReady(
  args: GateArguments,
  probe: ReadinessProbe = probeReadiness,
  retryMs: number = READINESS_RETRY_MS,
): Promise<ReadinessOutcomes> {
  for (let attempt = 1; attempt < READINESS_ATTEMPTS; attempt += 1) {
    const outcomes = await probe(args);
    if (allPassed(outcomes)) return outcomes;
    await new Promise((settle) => setTimeout(settle, retryMs));
  }
  const outcomes = await probe(args);
  if (!allPassed(outcomes)) {
    throw new Error(
      `a model failed readiness after preparation (${Object.values(outcomes).join(", ")}); no review ran`,
    );
  }
  return outcomes;
}

/** The start probe, or `null` for a re-scored replay, which reaches no model. */
export async function startReadiness(
  args: GateArguments,
  probe: ReadinessProbe = probeReadiness,
): Promise<ReadinessOutcomes | null> {
  return args.rescore ? null : probe(args);
}

/** The probe after preparation, or `null` for a re-scored replay, which reaches no model. */
export async function preparedReadiness(
  args: GateArguments,
  probe: ReadinessProbe = probeReadiness,
  retryMs: number = READINESS_RETRY_MS,
): Promise<ReadinessOutcomes | null> {
  return args.rescore ? null : probeUntilReady(args, probe, retryMs);
}
