// The operator's review configuration as the server reads it (ADR-0182 D8, Issue #4137): the
// `review` section of `keiko.config.json` parsed together with its environment overrides by the
// gateway configuration loader, so every configuration change (setup, catalog refresh, file reload)
// is seen at the next read. Without a gateway configuration only the environment applies.

import type { GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import type { ReviewOperatorConfig } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { parseReviewOperatorConfig } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review-validation";

import type { UiHandlerDeps } from "../../deps.js";

type OperatorDeps = Pick<UiHandlerDeps, "config" | "gatewayConfig" | "env">;

/** The live gateway configuration the review policy reads. */
export function reviewGatewayConfig(deps: OperatorDeps): GatewayConfig | undefined {
  return deps.gatewayConfig?.current() ?? deps.config;
}

export function reviewOperatorConfig(deps: OperatorDeps): ReviewOperatorConfig {
  return (
    reviewGatewayConfig(deps)?.review?.operator ?? parseReviewOperatorConfig(undefined, deps.env)
  );
}

/** The operator switch of the whole Pull requests area (default off until Issue #4142). */
export function isReviewAreaEnabled(deps: OperatorDeps): boolean {
  return reviewOperatorConfig(deps).enabled;
}
