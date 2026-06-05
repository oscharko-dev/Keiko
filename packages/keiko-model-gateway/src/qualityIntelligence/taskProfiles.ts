// Quality Intelligence task profiles (Epic #270, Issue #279).
//
// Each profile describes the structural requirements for a class of model calls inside the
// QI workflows: the required model capabilities, the soft token budget hint, the per-call
// timeout, the retry ceiling, whether the result is cacheable, and the temperature hint.
//
// Profiles are deeply frozen at module load so callers cannot mutate the registry. The set of
// known profile ids is exhaustive at the type level so a future profile addition is a compile
// error in routing/dispatcher code, not a silent fall-through.

export type QualityIntelligenceCapability =
  | "text"
  | "vision"
  | "structured-output"
  | "function-calling";

export type QualityIntelligenceTaskProfileId =
  | "qi:test-design"
  | "qi:judge-logic"
  | "qi:judge-faithfulness"
  | "qi:judge-semantic"
  | "qi:judge-mutation"
  | "qi:coverage-relevance"
  | "qi:self-check"
  | "qi:summarize";

export interface QualityIntelligenceTaskProfile {
  readonly id: QualityIntelligenceTaskProfileId;
  readonly requiredCapabilities: readonly QualityIntelligenceCapability[];
  readonly tokenBudgetHint: number;
  readonly timeoutMsHint: number;
  readonly retriesMax: number;
  readonly cacheable: boolean;
  readonly temperatureHint: number;
}

function freezeProfile(profile: QualityIntelligenceTaskProfile): QualityIntelligenceTaskProfile {
  return Object.freeze({
    ...profile,
    requiredCapabilities: Object.freeze([...profile.requiredCapabilities]),
  });
}

const PROFILES: readonly QualityIntelligenceTaskProfile[] = Object.freeze([
  freezeProfile({
    id: "qi:test-design",
    requiredCapabilities: ["text", "structured-output"],
    tokenBudgetHint: 4096,
    timeoutMsHint: 45_000,
    retriesMax: 2,
    cacheable: true,
    temperatureHint: 0.2,
  }),
  freezeProfile({
    id: "qi:judge-logic",
    requiredCapabilities: ["text", "structured-output"],
    tokenBudgetHint: 2048,
    timeoutMsHint: 30_000,
    retriesMax: 1,
    cacheable: true,
    temperatureHint: 0,
  }),
  freezeProfile({
    id: "qi:judge-faithfulness",
    requiredCapabilities: ["text", "structured-output"],
    tokenBudgetHint: 2048,
    timeoutMsHint: 30_000,
    retriesMax: 1,
    cacheable: true,
    temperatureHint: 0,
  }),
  freezeProfile({
    id: "qi:judge-semantic",
    requiredCapabilities: ["text", "structured-output"],
    tokenBudgetHint: 2048,
    timeoutMsHint: 30_000,
    retriesMax: 1,
    cacheable: true,
    temperatureHint: 0,
  }),
  freezeProfile({
    id: "qi:judge-mutation",
    requiredCapabilities: ["text", "structured-output"],
    tokenBudgetHint: 2048,
    timeoutMsHint: 30_000,
    retriesMax: 1,
    cacheable: true,
    temperatureHint: 0,
  }),
  freezeProfile({
    id: "qi:coverage-relevance",
    requiredCapabilities: ["text", "structured-output"],
    tokenBudgetHint: 2048,
    timeoutMsHint: 30_000,
    retriesMax: 1,
    cacheable: true,
    temperatureHint: 0.1,
  }),
  freezeProfile({
    id: "qi:self-check",
    requiredCapabilities: ["text"],
    tokenBudgetHint: 1024,
    timeoutMsHint: 20_000,
    retriesMax: 0,
    cacheable: false,
    temperatureHint: 0,
  }),
  freezeProfile({
    id: "qi:summarize",
    requiredCapabilities: ["text"],
    tokenBudgetHint: 1024,
    timeoutMsHint: 20_000,
    retriesMax: 0,
    cacheable: true,
    temperatureHint: 0.2,
  }),
]);

export const QUALITY_INTELLIGENCE_TASK_PROFILES: readonly QualityIntelligenceTaskProfile[] =
  PROFILES;

export function listQualityIntelligenceTaskProfiles(): readonly QualityIntelligenceTaskProfile[] {
  return QUALITY_INTELLIGENCE_TASK_PROFILES;
}

export function getQualityIntelligenceTaskProfile(
  id: QualityIntelligenceTaskProfileId,
): QualityIntelligenceTaskProfile {
  const found = QUALITY_INTELLIGENCE_TASK_PROFILES.find((p) => p.id === id);
  if (found === undefined) {
    // Unreachable by the type system; throwing keeps the function total at runtime.
    throw new Error("Unknown Quality Intelligence task profile id.");
  }
  return found;
}
