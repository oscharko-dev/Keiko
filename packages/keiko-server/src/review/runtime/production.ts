// Production composition of the Keiko for Quality review runtime service (ADR-0182 D1, #4135).
//
// The server's deps graph supplies what the Coding Workbench's runtime is composed from -- the
// OpenCode activation, the verification runner, the model admission, the gateway evidence recorder
// -- and this module composes review instances from the same pieces, with the review instance's
// state root (`<stateDir>/review-runtime`), its sidecar route prefix, its tool profile and its
// budgets. It also builds the startup self-check's inputs from the same code paths a review run's
// launch uses.

import { isAbsolute, join } from "node:path";

import {
  REVIEW_RUN_DEFAULT_DURATION_MINUTES,
  REVIEW_RUN_DEFAULT_PROMPT_TOKENS,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { GitProcessRunner } from "@oscharko-dev/keiko-git";

import { buildOpenCodeLaunchProfile } from "../../coding-runtime/opencodeLaunchProfile.js";
import { createGeneratedOpenCodeV2Plugins } from "../../coding-runtime/opencodeRuntimeAdapter.js";
import type { ServerLogSink } from "../../observability/index.js";
import {
  composeReviewRuntime,
  type ReviewRuntimeComposition,
  type ReviewRuntimeCompositionInput,
} from "./composition.js";
import { createReviewRuntimeService, type ReviewRuntimeService } from "./instance.js";
import type { ReviewRulesSettingsPort } from "./rulesFile.js";
import type { ReviewRuntimeLayers } from "./selfCheck.js";

/** The review instances' state root under the server state directory. */
const REVIEW_RUNTIME_STATE_DIR_NAME = "review-runtime";

export const KEIKO_REVIEW_RUN_MAX_PROMPT_TOKENS_ENV = "KEIKO_REVIEW_RUN_MAX_PROMPT_TOKENS";
export const KEIKO_REVIEW_RUN_MAX_DURATION_MINUTES_ENV = "KEIKO_REVIEW_RUN_MAX_DURATION_MINUTES";

const POSITIVE_DECIMAL_INTEGER = /^[1-9]\d*$/u;

// The self-check builds the configuration a run would launch with; the geometry only sizes the
// provider limits and compaction, which the check does not read.
const SELF_CHECK_GEOMETRY = {
  contextWindowTokens: 32_768,
  maxInputTokens: 28_672,
  maxOutputTokens: 4_096,
} as const;

export interface ReviewRunBudget {
  readonly promptTokenBudget: number;
  readonly maxDurationMinutes: number;
}

function boundedSetting(
  value: string | undefined,
  fallback: number,
  ceiling: number,
  name: string,
): number {
  if (value === undefined) return Math.min(fallback, ceiling);
  if (!POSITIVE_DECIMAL_INTEGER.test(value) || Number(value) > ceiling) {
    throw new RangeError(`${name} must be a positive integer within the coding envelope.`);
  }
  return Number(value);
}

/**
 * The Reviewer run's budgets: 600,000 prompt tokens and 20 minutes by default, operator-configurable
 * but never above the coding runtime's configured envelope (ADR-0182 D1). Out of range fails closed.
 */
export function configuredReviewRunBudget(
  env: NodeJS.ProcessEnv,
  envelope: ReviewRunBudget,
): ReviewRunBudget {
  return {
    promptTokenBudget: boundedSetting(
      env[KEIKO_REVIEW_RUN_MAX_PROMPT_TOKENS_ENV],
      REVIEW_RUN_DEFAULT_PROMPT_TOKENS,
      envelope.promptTokenBudget,
      KEIKO_REVIEW_RUN_MAX_PROMPT_TOKENS_ENV,
    ),
    maxDurationMinutes: boundedSetting(
      env[KEIKO_REVIEW_RUN_MAX_DURATION_MINUTES_ENV],
      REVIEW_RUN_DEFAULT_DURATION_MINUTES,
      envelope.maxDurationMinutes,
      KEIKO_REVIEW_RUN_MAX_DURATION_MINUTES_ENV,
    ),
  };
}

/**
 * The self-check's view of a composed instance: the profile the instance's readiness serves, the
 * configuration and plugins that profile generates, and the authority a run would be minted with.
 * The facade purpose is the purpose the resolver hands the run's facade, which is the minted
 * context's own.
 */
export function productionReviewRuntimeLayers(
  composition: ReviewRuntimeComposition,
  modelId: string,
  stateRoot: string,
): ReviewRuntimeLayers {
  const toolProfile = composition.readiness.toolProfile ?? "direct";
  const profile = buildOpenCodeLaunchProfile({
    executable: join(stateRoot, "self-check", "opencode"),
    stateRoot: join(stateRoot, "self-check"),
    contextGeometry: SELF_CHECK_GEOMETRY,
    toolProfile,
  });
  const authority = composition.authorityProbe(modelId);
  return {
    toolProfile,
    configValue: profile.ok ? profile.configValue : undefined,
    pluginSources: createGeneratedOpenCodeV2Plugins(toolProfile),
    authority,
    facadePurpose: authority?.runtimePurpose,
  };
}

export interface ProductionReviewRuntimeInput extends Omit<
  ReviewRuntimeCompositionInput,
  | "instanceId"
  | "runtimeStateDir"
  | "evidenceStore"
  | "reviewReportPort"
  | "promptTokenBudget"
  | "maxDurationMinutes"
> {
  readonly stateDir: string;
  readonly budget: ReviewRunBudget;
  readonly runner: () => GitProcessRunner;
  readonly rulesSettings?: ReviewRulesSettingsPort | undefined;
  readonly activityLog: ServerLogSink;
}

/** The server's review runtime service; one per deps graph, instances composed on demand. */
export function createProductionReviewRuntimeService(
  input: ProductionReviewRuntimeInput,
): ReviewRuntimeService {
  if (!isAbsolute(input.stateDir))
    throw new RangeError("review runtime state dir must be absolute");
  const runtimeStateDir = join(input.stateDir, REVIEW_RUNTIME_STATE_DIR_NAME);
  return createReviewRuntimeService({
    compose: (instanceId, reviewReportPort) =>
      composeReviewRuntime({
        ...input,
        instanceId,
        runtimeStateDir,
        evidenceStore: createInMemoryEvidenceStore(),
        reviewReportPort,
        promptTokenBudget: input.budget.promptTokenBudget,
        maxDurationMinutes: input.budget.maxDurationMinutes,
      }),
    layersFor: (composition, modelId) =>
      productionReviewRuntimeLayers(composition, modelId, runtimeStateDir),
    runner: input.runner,
    rulesSettings: input.rulesSettings,
    activityLog: input.activityLog,
  });
}
