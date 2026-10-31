// The routes of the review model policy (Issue #4137) and the `enabled` guard of the whole Pull
// requests area (`/api/git-review/*`, ADR-0182): `API_ROUTES` passes every route through
// `guardReviewRoute`, so while the area is off each one answers 404 with the closed code
// `REVIEW_DISABLED` before its handler runs, wherever it is registered. The one exception is
// `model-policy`, which reports `enabled: false` so the UI knows not to mount the area.

import {
  REVIEW_MODEL_POLICY_ROUTE,
  REVIEW_PAIR_QUALIFICATION_CANCEL_ROUTE,
  REVIEW_PAIR_QUALIFICATION_EVENTS_ROUTE,
  REVIEW_PAIR_QUALIFICATION_ROUTE,
  REVIEW_PAIR_QUALIFICATIONS_ROUTE,
  REVIEW_ROUTE_PREFIX,
  REVIEW_SETTINGS_ROUTE,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import { errorBody } from "../route-error.js";
import type { RouteDefinition } from "../routes.js";
import { isReviewAreaEnabled } from "./policy/operator.js";
import {
  handleReviewModelPolicy,
  handleReviewSettingsGet,
  handleReviewSettingsPut,
} from "./policy/routes.js";
import {
  handlePairQualificationCancel,
  handlePairQualificationEvents,
  handlePairQualificationGet,
  handlePairQualificationStart,
} from "./qualification/routes.js";

/** Puts one route behind the `enabled` switch; `model-policy` and other prefixes pass unchanged. */
export function guardReviewRoute(definition: RouteDefinition): RouteDefinition {
  const guarded =
    definition.pattern.startsWith(REVIEW_ROUTE_PREFIX) &&
    definition.pattern !== REVIEW_MODEL_POLICY_ROUTE;
  if (!guarded) return definition;
  return {
    ...definition,
    handler: (ctx, deps) =>
      isReviewAreaEnabled(deps)
        ? definition.handler(ctx, deps)
        : {
            status: 404,
            body: errorBody(
              "REVIEW_DISABLED",
              "Pull request reviews are switched off.",
              ctx.correlationId,
            ),
          },
  };
}

/** The routes of Issue #4137; the run and pull request routes stay where they were registered. */
export const REVIEW_POLICY_ROUTE_GROUP: readonly RouteDefinition[] = [
  { method: "GET", pattern: REVIEW_MODEL_POLICY_ROUTE, handler: handleReviewModelPolicy },
  { method: "GET", pattern: REVIEW_SETTINGS_ROUTE, handler: handleReviewSettingsGet },
  { method: "PUT", pattern: REVIEW_SETTINGS_ROUTE, handler: handleReviewSettingsPut },
  {
    method: "POST",
    pattern: REVIEW_PAIR_QUALIFICATIONS_ROUTE,
    handler: handlePairQualificationStart,
  },
  { method: "GET", pattern: REVIEW_PAIR_QUALIFICATION_ROUTE, handler: handlePairQualificationGet },
  {
    method: "GET",
    pattern: REVIEW_PAIR_QUALIFICATION_EVENTS_ROUTE,
    handler: handlePairQualificationEvents,
  },
  {
    method: "POST",
    pattern: REVIEW_PAIR_QUALIFICATION_CANCEL_ROUTE,
    handler: handlePairQualificationCancel,
  },
];
