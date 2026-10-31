// A review settings write (Issue #4137): validated, then admitted strictest first — an invalid
// operator value refuses every write, a locked policy refuses every model change, the stored
// revision must match `expectedRevision` — and, when a role changes, both roles of the resulting
// policy are preflighted with the shared role-policy preflight before anything is saved. A refusal
// names one closed reason and the role it concerns; a saved change grows the revision by one.

import type {
  ReviewModelPolicyRefusalReason,
  ReviewModelRole,
  ReviewSettingsDocument,
  ReviewSettingsUpdateRequest,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { validateReviewSettingsUpdateRequest } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review-validation";

import { preflightRoles } from "../../modelRolePolicy/preflight.js";
import {
  isAllowedReviewModel,
  resolveReviewPolicy,
  reviewRoleEligibility,
  type ResolvedReviewPolicy,
  type ReviewPolicyContext,
} from "./resolution.js";

export type ReviewSettingsUpdateOutcome =
  | {
      readonly kind: "saved";
      readonly document: ReviewSettingsDocument;
      readonly policy: ResolvedReviewPolicy;
      readonly modelsChanged: boolean;
      readonly rulesPathChanged: boolean;
    }
  | {
      readonly kind: "refused";
      readonly reason: ReviewModelPolicyRefusalReason;
      readonly role: ReviewModelRole | "none";
    };

type Refusal = Extract<ReviewSettingsUpdateOutcome, { readonly kind: "refused" }>;

const FIELDS = {
  reviewer: "reviewerModelId",
  "counter-checker": "counterCheckerModelId",
} as const;

function refuse(reason: ReviewModelPolicyRefusalReason, role: Refusal["role"] = "none"): Refusal {
  return { kind: "refused", reason, role };
}

function validated(body: unknown): ReviewSettingsUpdateRequest | Refusal {
  const result = validateReviewSettingsUpdateRequest(body);
  if (result.ok) return result.value;
  const rulesPath = result.issues.some((issue) => issue.path === "rulesFilePath");
  return refuse(rulesPath ? "rules-path-invalid" : "request-invalid");
}

/** The request's value when it states one (`null` clears it), else the stored value. */
function chosen(
  requested: string | null | undefined,
  stored: string | undefined,
): string | undefined {
  return requested === undefined ? stored : (requested ?? undefined);
}

function nextDocument(
  current: ReviewSettingsDocument,
  request: ReviewSettingsUpdateRequest,
): ReviewSettingsDocument {
  const reviewerModelId = chosen(request.reviewerModelId, current.reviewerModelId);
  const counterCheckerModelId = chosen(
    request.counterCheckerModelId,
    current.counterCheckerModelId,
  );
  const rulesFilePath = chosen(request.rulesFilePath, current.rulesFilePath);
  return {
    schemaVersion: current.schemaVersion,
    repositoryId: current.repositoryId,
    revision: current.revision,
    ...(reviewerModelId === undefined ? {} : { reviewerModelId }),
    ...(counterCheckerModelId === undefined ? {} : { counterCheckerModelId }),
    ...(rulesFilePath === undefined ? {} : { rulesFilePath }),
    ...(current.updatedAt === undefined ? {} : { updatedAt: current.updatedAt }),
  };
}

/** A changed role must be allowed and eligible; a temporarily unavailable model may be saved. */
function changedRoleRefusal(
  ctx: ReviewPolicyContext,
  request: ReviewSettingsUpdateRequest,
): Refusal | undefined {
  for (const role of ["reviewer", "counter-checker"] as const) {
    const modelId = request[FIELDS[role]];
    if (typeof modelId !== "string") continue;
    if (!isAllowedReviewModel(ctx.operator, modelId)) return refuse("outside-allowlist", role);
    const eligibility = reviewRoleEligibility(ctx, role, modelId);
    if (eligibility.status === "ineligible") return refuse(eligibility.reason, role);
  }
  return undefined;
}

/** Both roles of the policy the write would produce, in role order (shared preflight). */
async function preflightRefusal(policy: ResolvedReviewPolicy): Promise<Refusal | undefined> {
  const results = await preflightRoles(["reviewer", "counter-checker"] as const, (role) => {
    const resolved = role === "reviewer" ? policy.reviewer : policy.counterChecker;
    return resolved.state.status === "refused" ? refuse(resolved.state.reason, role) : undefined;
  });
  return results.get("reviewer") ?? results.get("counter-checker");
}

function admissionRefusal(
  ctx: ReviewPolicyContext,
  current: ReviewSettingsDocument,
  request: ReviewSettingsUpdateRequest,
): Refusal | undefined {
  if (ctx.operator.issues.length > 0) return refuse("invalid-operator-value");
  const modelsTouched =
    request.reviewerModelId !== undefined || request.counterCheckerModelId !== undefined;
  if (ctx.operator.lockModelPolicy && modelsTouched) return refuse("policy-locked");
  const expected = request.expectedRevision;
  if (expected !== undefined && expected !== current.revision) return refuse("revision-conflict");
  return modelsTouched ? changedRoleRefusal(ctx, request) : undefined;
}

function sameModels(left: ReviewSettingsDocument, right: ReviewSettingsDocument): boolean {
  return (
    left.reviewerModelId === right.reviewerModelId &&
    left.counterCheckerModelId === right.counterCheckerModelId
  );
}

/**
 * Decides one write. `save` publishes the next document (revision + 1); it runs only when the write
 * changes something and every check passed.
 */
export async function updateReviewSettings(input: {
  readonly ctx: ReviewPolicyContext;
  readonly current: ReviewSettingsDocument;
  readonly body: unknown;
  readonly nowIso: string;
  readonly save: (document: ReviewSettingsDocument) => void;
}): Promise<ReviewSettingsUpdateOutcome> {
  const request = validated(input.body);
  if ("kind" in request) return request;
  const refusal = admissionRefusal(input.ctx, input.current, request);
  if (refusal !== undefined) return refusal;
  const next = nextDocument(input.current, request);
  const modelsChanged = !sameModels(input.current, next);
  const rulesPathChanged = input.current.rulesFilePath !== next.rulesFilePath;
  const policy = resolveReviewPolicy(input.ctx, next);
  const preflight = modelsChanged ? await preflightRefusal(policy) : undefined;
  if (preflight !== undefined) return preflight;
  if (!modelsChanged && !rulesPathChanged) {
    return { kind: "saved", document: input.current, policy, modelsChanged, rulesPathChanged };
  }
  const document = { ...next, revision: input.current.revision + 1, updatedAt: input.nowIso };
  input.save(document);
  return { kind: "saved", document, policy, modelsChanged, rulesPathChanged };
}
