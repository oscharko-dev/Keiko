// The review model policy as the server composes it (ADR-0182 D8, Issue #4137): the policy context
// over the live gateway catalog, the admission child 6's model port runs at every run start and dry
// run, the rules-path port child 5's rules reader reads, and the startup report of invalid
// operator values. Each refusal is recorded once, with its closed reason, where it is decided.

import {
  findConfiguredCapability,
  listConfiguredCapabilities,
} from "@oscharko-dev/keiko-model-gateway";
import {
  REVIEW_RULES_FILE_DEFAULT_PATH,
  type ReviewOperatorConfig,
  type ReviewSettingsDocument,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import { correlationIdOrUnknown } from "../../correlation.js";
import type { UiHandlerDeps } from "../../deps.js";
import type { ServerLogSink } from "../../observability/index.js";
import { deriveRepositoryId } from "../../task-workspace/naming.js";
import type { ReviewRulesSettingsPort } from "../runtime/rulesFile.js";
import { logReviewModelPolicyRefused, type ReviewModelPolicyRefusalStage } from "./activity-log.js";
import { reviewGatewayConfig, reviewOperatorConfig } from "./operator.js";
import {
  admitReviewRoleModels,
  type ReviewPolicyCheck,
  type ReviewPolicyContext,
  type ReviewRoleModels,
} from "./resolution.js";
import type { ReviewSettingsStore } from "./settingsStore.js";
import type { ReviewPairStatusRegistry } from "../qualification/pairStatus.js";
import type { PairQualificationService } from "../qualification/service.js";

/**
 * The review model-policy services of one handler graph (Issue #4137): the per-repository settings
 * documents, the in-process pair status and the local pair qualification. The settings store and
 * the qualification exist only over production persistence.
 */
export interface ReviewPolicyServices {
  readonly settings: ReviewSettingsStore | undefined;
  readonly pairStatus: ReviewPairStatusRegistry;
  readonly qualifications: PairQualificationService | undefined;
}

export type ReviewPolicyDeps = Pick<UiHandlerDeps, "config" | "gatewayConfig" | "env">;

/** The policy context over the gateway's current catalog. */
export function reviewPolicyContext(
  deps: ReviewPolicyDeps,
  nowMs: number = Date.now(),
): ReviewPolicyContext {
  const config = reviewGatewayConfig(deps);
  return {
    operator: reviewOperatorConfig(deps),
    capabilities: config === undefined ? [] : listConfiguredCapabilities(config),
    capability: (modelId) =>
      config === undefined ? undefined : findConfiguredCapability(config, modelId),
    nowMs,
  };
}

/** Records one refusal; an invalid operator value names its first key and source. */
export function recordReviewPolicyRefusal(
  log: ServerLogSink,
  correlationId: string | undefined,
  operator: ReviewOperatorConfig,
  refusal: Extract<ReviewPolicyCheck, { readonly ok: false }>,
  stage: ReviewModelPolicyRefusalStage,
): void {
  const operatorIssue =
    refusal.reason === "invalid-operator-value" ? operator.issues[0] : undefined;
  logReviewModelPolicyRefused(log, correlationIdOrUnknown(correlationId), {
    reason: refusal.reason,
    role: refusal.role,
    stage,
    operatorIssue,
  });
}

/** Child 6's `ReviewModelPort.admit`: the operator and user policy at every run start. */
export function reviewRunAdmission(
  deps: () => ReviewPolicyDeps,
  log: ServerLogSink,
): (models: ReviewRoleModels, correlationId: string | undefined) => boolean {
  return (models, correlationId) => {
    const ctx = reviewPolicyContext(deps());
    const check = admitReviewRoleModels(ctx, models);
    if (!check.ok) recordReviewPolicyRefusal(log, correlationId, ctx.operator, check, "run-start");
    return check.ok;
  };
}

export interface EffectiveRulesFilePath {
  readonly path: string;
  readonly source: "operator" | "user" | "default";
}

/**
 * The rules path a repository's review reads: the user's saved value, unless the policy is locked,
 * in which case the operator preset (the repository's own, else the deployment-wide one) wins.
 */
export function effectiveRulesFilePath(
  operator: ReviewOperatorConfig,
  settings: ReviewSettingsDocument | undefined,
  repositoryId: string,
): EffectiveRulesFilePath {
  const preset = operator.repositories[repositoryId]?.rulesFilePath ?? operator.rulesFilePath;
  const user = settings?.rulesFilePath;
  const first = operator.lockModelPolicy ? preset : user;
  const second = operator.lockModelPolicy ? user : preset;
  if (first !== undefined)
    return { path: first, source: operator.lockModelPolicy ? "operator" : "user" };
  if (second !== undefined)
    return { path: second, source: operator.lockModelPolicy ? "user" : "operator" };
  return { path: REVIEW_RULES_FILE_DEFAULT_PATH, source: "default" };
}

/** The stored settings document, or `undefined` when none (or no valid one) is stored. */
function storedReviewSettings(
  store: ReviewSettingsStore | undefined,
  repositoryId: string,
): ReviewSettingsDocument | undefined {
  const stored = store?.read(repositoryId);
  return stored?.kind === "stored" ? stored.document : undefined;
}

/** Child 5's rules-path port over the per-repository settings and the operator presets. */
export function reviewRulesSettingsPort(
  deps: () => ReviewPolicyDeps,
  store: () => ReviewSettingsStore | undefined,
): ReviewRulesSettingsPort {
  return {
    rulesPath: (repositoryRoot): string => {
      const repositoryId = deriveRepositoryId(repositoryRoot);
      const settings = storedReviewSettings(store(), repositoryId);
      return effectiveRulesFilePath(reviewOperatorConfig(deps()), settings, repositoryId).path;
    },
  };
}

/** The startup report: one refusal line per invalid operator value, naming its key and source. */
export function reportReviewOperatorConfig(
  deps: ReviewPolicyDeps,
  log: ServerLogSink,
  correlationId: string,
): void {
  const operator = reviewOperatorConfig(deps);
  for (const issue of operator.issues) {
    logReviewModelPolicyRefused(log, correlationId, {
      reason: "invalid-operator-value",
      role: "none",
      stage: "startup",
      operatorIssue: issue,
    });
  }
}
