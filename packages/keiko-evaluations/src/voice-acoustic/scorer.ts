// Pure scorer for the offline acoustic-quality gate. All functions operate on harness fixtures and
// return numeric / enum / boolean facts only; no audio, provider event bodies, credentials, or network.

import {
  VOICE_ACOUSTIC_METRICS,
  type VoiceAcousticBudgets,
  type VoiceAcousticFixture,
  type VoiceAcousticFixtureResult,
  type VoiceAcousticMetric,
  type VoiceAcousticMetricCheck,
  type VoiceAcousticMetrics,
  type VoiceAcousticMetricSummary,
  type VoiceAcousticTraceEvent,
  type VoiceAcousticTraceEventKind,
} from "./types.js";

export const DEFAULT_VOICE_ACOUSTIC_BUDGETS: VoiceAcousticBudgets = {
  maxWer: 0.08,
  maxCer: 0.04,
  maxFirstPartialMs: 1200,
  maxFinalTranscriptMs: 4000,
  maxTtfaMs: 4000,
  maxLocalDuckMs: 80,
  maxInterruptAckMs: 500,
} as const;

const NOISY_ECHO_BUDGETS: Pick<VoiceAcousticBudgets, "maxWer" | "maxCer" | "maxFirstPartialMs"> = {
  maxWer: 0.15,
  maxCer: 0.08,
  maxFirstPartialMs: 1800,
} as const;

export function resolveVoiceAcousticBudgets(fixture: VoiceAcousticFixture): VoiceAcousticBudgets {
  const scenarioDefaults =
    fixture.scenario === "noisy-room" || fixture.scenario === "laptop-echo"
      ? NOISY_ECHO_BUDGETS
      : {};
  return {
    ...DEFAULT_VOICE_ACOUSTIC_BUDGETS,
    ...scenarioDefaults,
    ...(fixture.budgets ?? {}),
  };
}

function wordTokens(text: string): readonly string[] {
  return text.toLowerCase().match(/[a-z0-9]+(?:[-'][a-z0-9]+)*/gu) ?? [];
}

function charTokens(text: string): readonly string[] {
  return Array.from(text.toLowerCase().replace(/\s+/gu, ""));
}

function editDistance<T>(a: readonly T[], b: readonly T[]): number {
  const previous = Array.from({ length: b.length + 1 }, (_value, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = Object.is(a[i - 1], b[j - 1]) ? 0 : 1;
      const deletion = (previous[j] ?? Number.POSITIVE_INFINITY) + 1;
      const insertion = (current[j - 1] ?? Number.POSITIVE_INFINITY) + 1;
      const replace = (previous[j - 1] ?? Number.POSITIVE_INFINITY) + substitution;
      current[j] = Math.min(deletion, insertion, replace);
    }
    for (let j = 0; j < current.length; j += 1) {
      previous[j] = current[j] ?? 0;
    }
  }
  return previous[b.length] ?? 0;
}

export function wordErrorRate(reference: string, hypothesis: string): number {
  const ref = wordTokens(reference);
  const hyp = wordTokens(hypothesis);
  if (ref.length === 0) {
    return hyp.length === 0 ? 0 : 1;
  }
  return editDistance(ref, hyp) / ref.length;
}

export function characterErrorRate(reference: string, hypothesis: string): number {
  const ref = charTokens(reference);
  const hyp = charTokens(hypothesis);
  if (ref.length === 0) {
    return hyp.length === 0 ? 0 : 1;
  }
  return editDistance(ref, hyp) / ref.length;
}

function firstEvent(
  trace: readonly VoiceAcousticTraceEvent[],
  kind: VoiceAcousticTraceEventKind,
): VoiceAcousticTraceEvent | undefined {
  return trace.find((event) => event.kind === kind);
}

function latency(
  trace: readonly VoiceAcousticTraceEvent[],
  from: VoiceAcousticTraceEventKind,
  to: VoiceAcousticTraceEventKind,
): number | null {
  const start = firstEvent(trace, from);
  const end = firstEvent(trace, to);
  if (start === undefined || end === undefined) {
    return null;
  }
  return end.atMs - start.atMs;
}

function firstTokenRetained(reference: string, hypothesis: string): boolean {
  const ref = wordTokens(reference);
  const hyp = wordTokens(hypothesis);
  return ref.length === 0 ? hyp.length === 0 : ref[0] === hyp[0];
}

function lastTokenRetained(reference: string, hypothesis: string): boolean {
  const ref = wordTokens(reference);
  const hyp = wordTokens(hypothesis);
  return ref.length === 0 ? hyp.length === 0 : ref.at(-1) === hyp.at(-1);
}

function requiredTermsExact(hypothesis: string, requiredTerms: readonly string[]): boolean {
  return requiredTerms.every((term) => hypothesis.includes(term));
}

function derivesPrematureFinalization(trace: readonly VoiceAcousticTraceEvent[]): boolean {
  if (trace.some((event) => event.kind === "endpoint.premature-final")) {
    return true;
  }
  const speechEnd = firstEvent(trace, "speech.end");
  const final = firstEvent(trace, "transcript.final");
  return speechEnd !== undefined && final !== undefined && final.atMs < speechEnd.atMs;
}

function groundedToolBeforeAnswer(fixture: VoiceAcousticFixture): boolean | null {
  if (fixture.expectGroundedToolBeforeAnswer !== true) {
    return null;
  }
  const tool = firstEvent(fixture.trace, "grounding.tool.result");
  const answer = firstEvent(fixture.trace, "assistant.audio.start");
  return tool !== undefined && answer !== undefined && tool.atMs <= answer.atMs;
}

export function deriveVoiceAcousticMetrics(fixture: VoiceAcousticFixture): VoiceAcousticMetrics {
  return {
    wer: wordErrorRate(fixture.referenceTranscript, fixture.hypothesisTranscript),
    cer: characterErrorRate(fixture.referenceTranscript, fixture.hypothesisTranscript),
    firstTokenRetained: firstTokenRetained(
      fixture.referenceTranscript,
      fixture.hypothesisTranscript,
    ),
    lastTokenRetained: lastTokenRetained(fixture.referenceTranscript, fixture.hypothesisTranscript),
    requiredIdentifierExactMatch: requiredTermsExact(
      fixture.hypothesisTranscript,
      fixture.requiredTerms,
    ),
    firstPartialLatencyMs: latency(fixture.trace, "speech.start", "transcript.partial"),
    finalTranscriptLatencyMs: latency(fixture.trace, "speech.end", "transcript.final"),
    timeToFirstAssistantAudioMs: latency(fixture.trace, "speech.end", "assistant.audio.start"),
    localDuckLatencyMs: latency(fixture.trace, "barge-in.start", "local.duck"),
    interruptAckLatencyMs: latency(fixture.trace, "barge-in.start", "interrupt.ack"),
    prematureFinalization: derivesPrematureFinalization(fixture.trace),
    groundedToolBeforeAnswer: groundedToolBeforeAnswer(fixture),
  };
}

function numericCheck(
  metric: VoiceAcousticMetric,
  actual: number | null,
  budget: number,
): VoiceAcousticMetricCheck {
  return {
    metric,
    actual,
    budget,
    passed: actual !== null && actual >= 0 && actual <= budget,
  };
}

function booleanCheck(
  metric: VoiceAcousticMetric,
  actual: boolean | null,
  expected: boolean,
): VoiceAcousticMetricCheck {
  return {
    metric,
    actual,
    budget: expected,
    passed: actual === expected,
  };
}

function baseChecks(
  metrics: VoiceAcousticMetrics,
  budgets: VoiceAcousticBudgets,
): VoiceAcousticMetricCheck[] {
  return [
    numericCheck("wer", metrics.wer, budgets.maxWer),
    numericCheck("cer", metrics.cer, budgets.maxCer),
    booleanCheck("first-token-retained", metrics.firstTokenRetained, true),
    booleanCheck("last-token-retained", metrics.lastTokenRetained, true),
    booleanCheck("required-identifier-exact-match", metrics.requiredIdentifierExactMatch, true),
    numericCheck("first-partial-latency", metrics.firstPartialLatencyMs, budgets.maxFirstPartialMs),
    numericCheck(
      "final-transcript-latency",
      metrics.finalTranscriptLatencyMs,
      budgets.maxFinalTranscriptMs,
    ),
    numericCheck(
      "time-to-first-assistant-audio",
      metrics.timeToFirstAssistantAudioMs,
      budgets.maxTtfaMs,
    ),
    booleanCheck("premature-finalization", metrics.prematureFinalization, false),
  ];
}

function appendInterruptChecks(
  checks: VoiceAcousticMetricCheck[],
  fixture: VoiceAcousticFixture,
  metrics: VoiceAcousticMetrics,
  budgets: VoiceAcousticBudgets,
): void {
  if (fixture.scenario === "fast-interrupt" || metrics.localDuckLatencyMs !== null) {
    checks.push(
      numericCheck(
        "local-barge-in-duck-latency",
        metrics.localDuckLatencyMs,
        budgets.maxLocalDuckMs,
      ),
    );
  }
  if (fixture.scenario === "fast-interrupt" || metrics.interruptAckLatencyMs !== null) {
    checks.push(
      numericCheck(
        "interrupt-ack-latency",
        metrics.interruptAckLatencyMs,
        budgets.maxInterruptAckMs,
      ),
    );
  }
}

function buildChecks(
  fixture: VoiceAcousticFixture,
  metrics: VoiceAcousticMetrics,
  budgets: VoiceAcousticBudgets,
): readonly VoiceAcousticMetricCheck[] {
  const checks = baseChecks(metrics, budgets);
  appendInterruptChecks(checks, fixture, metrics, budgets);
  if (fixture.expectGroundedToolBeforeAnswer === true) {
    checks.push(
      booleanCheck("grounded-tool-before-answer", metrics.groundedToolBeforeAnswer, true),
    );
  }
  return checks;
}

export function scoreVoiceAcousticFixture(
  fixture: VoiceAcousticFixture,
): VoiceAcousticFixtureResult {
  const metrics = deriveVoiceAcousticMetrics(fixture);
  const checks = buildChecks(fixture, metrics, resolveVoiceAcousticBudgets(fixture));
  const qualityPassed = checks.every((check) => check.passed);
  const gatePassed = fixture.polarity === "positive" ? qualityPassed : !qualityPassed;
  return {
    fixtureName: fixture.name,
    scenario: fixture.scenario,
    polarity: fixture.polarity,
    acousticProfile: fixture.acousticProfile,
    metrics,
    checks,
    qualityPassed,
    gatePassed,
  };
}

function summarizeMetric(
  metric: VoiceAcousticMetric,
  results: readonly VoiceAcousticFixtureResult[],
): VoiceAcousticMetricSummary {
  let passCount = 0;
  let failCount = 0;
  let notApplicableCount = 0;
  for (const result of results) {
    const check = result.checks.find((candidate) => candidate.metric === metric);
    if (check === undefined) {
      notApplicableCount += 1;
    } else if (check.passed) {
      passCount += 1;
    } else {
      failCount += 1;
    }
  }
  return { metric, passCount, failCount, notApplicableCount };
}

export function aggregateVoiceAcousticMetrics(
  results: readonly VoiceAcousticFixtureResult[],
): readonly VoiceAcousticMetricSummary[] {
  return VOICE_ACOUSTIC_METRICS.map((metric) => summarizeMetric(metric, results));
}
