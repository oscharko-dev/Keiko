// GET /api/git-review/pull-requests and GET /api/git-review/pull-requests/{number} (Issue #4133).
//
// The repository is addressed by `root`, exactly like every other Git window read: the selected
// root is resolved through the registered-project and managed-root authority of `resolveRepository`
// and Git's own membership answer, so no request can name a repository Keiko has not been given.
// Every outcome is a 200 with a closed availability state; pull request text is untrusted display
// data and passes the live-payload redactor like every other Git read.

import type {
  ReviewPullRequestAvailability,
  ReviewPullRequestDetailResponse,
  ReviewPullRequestListResponse,
} from "@oscharko-dev/keiko-contracts";
import {
  REVIEW_CONTRACT_VERSION,
  REVIEW_PULL_REQUEST_NUMBER_MAX,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import type { UiHandlerDeps } from "../../deps.js";
import { runFilesHandler } from "../../files.js";
import { optionsWithDefaults, resolveRepository } from "../../gitRoutes.js";
import { errorBody } from "../../route-error.js";
import type { RouteContext, RouteResult } from "../../routes.js";

const PULL_REQUEST_NUMBER = /^[1-9]\d{0,9}$/u;

function unavailableList(
  availability: ReviewPullRequestAvailability,
): ReviewPullRequestListResponse {
  return {
    schemaVersion: REVIEW_CONTRACT_VERSION,
    availability,
    pullRequests: [],
    truncated: false,
  };
}

function unavailableDetail(
  availability: ReviewPullRequestAvailability,
): ReviewPullRequestDetailResponse {
  return { schemaVersion: REVIEW_CONTRACT_VERSION, availability, pullRequest: null };
}

async function repositoryRoot(ctx: RouteContext, deps: UiHandlerDeps): Promise<string | undefined> {
  const options = optionsWithDefaults(deps.gitRouteOptions, ctx.correlationId);
  const repository = await resolveRepository(ctx, deps, options);
  return "available" in repository ? undefined : repository.repositoryRoot;
}

function servicesUnavailable(ctx: RouteContext): RouteResult {
  return {
    status: 503,
    body: errorBody(
      "REVIEW_UNAVAILABLE",
      "Pull request reads are not available.",
      ctx.correlationId,
    ),
  };
}

export async function handleReviewPullRequestList(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const services = deps.reviewServices;
  if (services === undefined) return servicesUnavailable(ctx);
  return runFilesHandler(async () => {
    const root = await repositoryRoot(ctx, deps);
    const body =
      root === undefined
        ? unavailableList("failed")
        : await services.pullRequests.list(root, ctx.correlationId);
    return { status: 200, body: deps.redactor(body) };
  });
}

export async function handleReviewPullRequestDetail(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const services = deps.reviewServices;
  if (services === undefined) return servicesUnavailable(ctx);
  const raw = ctx.params.number ?? "";
  const number = PULL_REQUEST_NUMBER.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(number) || number > REVIEW_PULL_REQUEST_NUMBER_MAX) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "The pull request number is invalid.", ctx.correlationId),
    };
  }
  return runFilesHandler(async () => {
    const root = await repositoryRoot(ctx, deps);
    const body =
      root === undefined
        ? unavailableDetail("failed")
        : await services.pullRequests.detail(root, number, ctx.correlationId);
    return { status: 200, body: deps.redactor(body) };
  });
}
