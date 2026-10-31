// Fixtures of the review model-policy suites (Issue #4137): a gateway configuration whose operator
// review section is parsed by the production loader, over capabilities a test states exactly, and
// handler deps with a real settings store under a temporary state directory.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelCapability } from "@oscharko-dev/keiko-contracts";
import { parseGatewayConfig, type GatewayConfig } from "@oscharko-dev/keiko-model-gateway";

import {
  captureActivityLog,
  type ActivityLogCapture,
} from "../../activityLogCapture.test-support.js";
import {
  buildRedactor,
  createInMemoryUiStore,
  createRunRegistry,
  type UiHandlerDeps,
} from "../../index.js";
import { ReviewPairStatusRegistry } from "../qualification/pairStatus.js";
import { createReviewSettingsStore } from "./settingsStore.js";

const FIXTURE_CREDENTIAL = ["fixture", "credential"].join("-");

/** A configuration over `models` whose `review` section goes through the production parser. */
export function reviewGatewayConfig(
  models: readonly ModelCapability[],
  review: unknown,
  env: Readonly<Record<string, string>> = {},
): GatewayConfig {
  const parsed = parseGatewayConfig(
    {
      providers: models.map((model) => ({
        modelId: model.id,
        baseUrl: "https://provider.invalid/v1",
        apiKey: FIXTURE_CREDENTIAL,
      })),
      ...(review === undefined ? {} : { review }),
    },
    env,
  );
  return { ...parsed, capabilities: models };
}

export interface ReviewPolicyFixture {
  readonly deps: UiHandlerDeps;
  readonly log: ActivityLogCapture;
  readonly stateDir: string;
  cleanup(): void;
}

export function createReviewPolicyFixture(input: {
  readonly models: readonly ModelCapability[];
  readonly review: unknown;
  readonly withSettings?: boolean;
  readonly extra?: Partial<UiHandlerDeps>;
}): ReviewPolicyFixture {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-review-policy-")));
  const log = captureActivityLog();
  const store = createInMemoryUiStore();
  const deps: UiHandlerDeps = {
    config: reviewGatewayConfig(input.models, input.review),
    configPresent: true,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
    activityLog: log.sink,
    reviewPolicy: {
      settings: input.withSettings === false ? undefined : createReviewSettingsStore(stateDir),
      pairStatus: new ReviewPairStatusRegistry(),
      qualifications: undefined,
    },
    ...input.extra,
  };
  return {
    deps,
    log,
    stateDir,
    cleanup: (): void => {
      store.close();
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}
