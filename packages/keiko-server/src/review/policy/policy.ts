// The review model policy as the server composes it (ADR-0184 D8, Issue #4137): the policy context
// over the live gateway catalog, the admission child 6's model port runs at every run start and dry
// run, the rules-path port child 5's rules reader reads, and the startup report of invalid
// operator values. Each refusal is recorded once, with its closed reason, where it is decided.

import type { ModelCapability } from "@oscharko-dev/keiko-contracts";
import { isToolCallingVerificationFresh } from "@oscharko-dev/keiko-contracts/runtime/gateway";
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
import { reportReviewFailure } from "../diagnostics.js";
import type { ReviewRulesSettingsPort } from "../runtime/rulesFile.js";
import { logReviewModelPolicyRefused, type ReviewModelPolicyRefusalStage } from "./activity-log.js";
import { reviewGatewayConfig, reviewOperatorConfig } from "./operator.js";
import {
  admitReviewRoleModels,
  isAllowedReviewModel,
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
  /**
   * Asks the gateway for one model's forced tool-call proof again and awaits the answer
   * (R4130-058); production wires `ensureReviewModelReady`. Absent: nothing is renewed.
   */
  readonly renewToolProof?:
    ((modelId: string, correlationId: string | undefined) => Promise<void>) | undefined;
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

/** A proof that was verified once and has aged past its lifetime: a probe can renew it. */
function toolProofLapsed(capability: ModelCapability | undefined, nowMs: number): boolean {
  const verification = capability?.toolCallingVerification;
  return (
    verification?.status === "verified" && !isToolCallingVerificationFresh(verification, { nowMs })
  );
}

/**
 * How long a request waits for a renewal before its own check runs (review round 2 of #4386). A
 * renewal goes through the gateway's probe queue and can take minutes on a slow local gateway,
 * longer than a client keeps a request open. After this wait the request is judged on the stored
 * proof; the renewal goes on, so the next attempt finds its answer.
 */
export const REVIEW_TOOL_PROOF_RENEWAL_WAIT_MS = 30_000;

type RenewToolProof = NonNullable<ReviewPolicyServices["renewToolProof"]>;

/** The renewals running now, by policy services and model: concurrent askers share one. */
const renewalsInFlight = new WeakMap<ReviewPolicyServices, Map<string, Promise<void>>>();

/** One renewal per model at a time; a failure is reported and never rejects. */
function renewOnce(
  services: ReviewPolicyServices,
  renew: RenewToolProof,
  modelId: string,
  correlationId: string | undefined,
): Promise<void> {
  const running = renewalsInFlight.get(services) ?? new Map<string, Promise<void>>();
  renewalsInFlight.set(services, running);
  const shared = running.get(modelId);
  if (shared !== undefined) return shared;
  const started = Promise.resolve()
    .then(() => renew(modelId, correlationId))
    .catch((error: unknown) => {
      reportReviewFailure("review.run.model-readiness", correlationId, error);
    })
    .finally(() => {
      running.delete(modelId);
    });
  running.set(modelId, started);
  return started;
}

async function renewEachLapsedProof(
  deps: ReviewPolicyDeps & Pick<UiHandlerDeps, "reviewPolicy">,
  modelIds: readonly unknown[],
  correlationId: string | undefined,
): Promise<void> {
  const services = deps.reviewPolicy;
  const renew = services?.renewToolProof;
  const ctx = reviewPolicyContext(deps);
  if (services === undefined || renew === undefined) return;
  if (!ctx.operator.enabled || ctx.operator.issues.length > 0) return;
  const named = modelIds.filter((modelId): modelId is string => typeof modelId === "string");
  for (const modelId of new Set(named)) {
    if (!isAllowedReviewModel(ctx.operator, modelId)) continue;
    if (!toolProofLapsed(ctx.capability(modelId), ctx.nowMs)) continue;
    await renewOnce(services, renew, modelId, correlationId); // NOSONAR typescript:S9382 -- a renewal is a model call: the role models are asked one after the other, so two calls never meet on a single-slot provider
  }
}

/**
 * Renews the lapsed forced tool-call proof of role models before an entry point judges them
 * (R4130-058). The proof expires after 24 hours, and a run start renews it at its launch. The dry
 * run, the pair qualification start, the settings write and the model-policy view judge the same
 * stored proof, so without this they refused a pair that a real start would have run.
 *
 * Only a model the operator policy allows is asked, so a refused model still receives no traffic
 * (R4130-003), and only one whose proof lapsed: a current proof costs no request, and a model that
 * was never proven or was refuted is left to its verdict. A renewal that fails is reported and
 * leaves the decision to the check that follows. This never rejects.
 *
 * With `waitMs` the returned promise settles after that time at the latest, and the renewal goes
 * on; an elapsed wait is reported. Without it the promise settles when every renewal has.
 */
export async function renewLapsedReviewToolProofs(
  deps: ReviewPolicyDeps & Pick<UiHandlerDeps, "reviewPolicy">,
  modelIds: readonly unknown[],
  correlationId: string | undefined,
  waitMs?: number,
): Promise<void> {
  const renewal = renewEachLapsedProof(deps, modelIds, correlationId).then(
    () => "settled" as const,
    (error: unknown) => {
      reportReviewFailure("review.run.model-readiness", correlationId, error);
      return "settled" as const;
    },
  );
  if (waitMs === undefined) {
    await renewal;
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<"elapsed">((resolve) => {
    timer = setTimeout(() => {
      resolve("elapsed");
    }, waitMs);
  });
  const first = await Promise.race([renewal, elapsed]);
  clearTimeout(timer);
  if (first === "elapsed") {
    const error = new Error("the tool-call proof renewal outlasted the request's wait");
    reportReviewFailure("review.run.model-readiness", correlationId, error);
  }
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

/**
 * The stored settings document, or `undefined` when none (or no valid one) is stored. An invalid
 * document is reported under the run's correlation, as the settings routes report it, so a run that
 * read the preset or default rules path instead of the person's setting is traceable (R4130-023).
 */
function storedReviewSettings(
  store: ReviewSettingsStore | undefined,
  repositoryId: string,
  correlationId: string | undefined,
): ReviewSettingsDocument | undefined {
  const stored = store?.read(repositoryId);
  if (stored?.kind === "invalid") {
    reportReviewFailure("review.settings.read", correlationId, new TypeError("invalid settings"));
  }
  return stored?.kind === "stored" ? stored.document : undefined;
}

/** Child 5's rules-path port over the per-repository settings and the operator presets. */
export function reviewRulesSettingsPort(
  deps: () => ReviewPolicyDeps,
  store: () => ReviewSettingsStore | undefined,
): ReviewRulesSettingsPort {
  return {
    rulesPath: (repositoryRoot, correlationId): string => {
      const repositoryId = deriveRepositoryId(repositoryRoot);
      const settings = storedReviewSettings(store(), repositoryId, correlationId);
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
