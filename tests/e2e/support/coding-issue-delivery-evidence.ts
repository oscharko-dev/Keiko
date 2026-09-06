import { expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evidenceArtifactPath } from "./evidence.js";
import { artifactDigest } from "./coding-issue-commit-evidence.js";
import {
  DELIVERY_TEMPLATE,
  DELIVERY_TITLE,
  deliveryProviderState,
} from "./coding-issue-delivery.js";
import { COMMIT_MESSAGE } from "./coding-issue-commit.js";

function expectProviderEvidence(provider: Readonly<Record<string, unknown>>): void {
  expect(provider).toMatchObject({ pushes: 7, creates: 5, rejections: 5 });
  expect(provider.rejectionReasons).toEqual({
    "branch-query": 1,
    "gh-target": 2,
    "push-target": 2,
  });
}

export function writeDeliveryJourneyReceipt(stateDir: string, cases: readonly string[]): void {
  expect(cases).toHaveLength(12);
  const lines = readDeliveryLog(stateDir);
  const deliveries = lines.filter((line) => line.op === "git.draft-delivery");
  expect(deliveries.length).toBeGreaterThan(0);
  expect(deliveries.every((line) => typeof line.correlationId === "string")).toBe(true);
  const diagnostics = lines.filter(
    (line) =>
      typeof line.clientNote === "string" &&
      line.clientNote.startsWith("[keiko] draft delivery review"),
  );
  expect(diagnostics.length).toBeGreaterThan(0);
  expect(diagnostics.every((line) => typeof line.correlationId === "string")).toBe(true);
  const provider = JSON.parse(readFileSync(deliveryProviderState(stateDir), "utf8")) as Record<
    string,
    unknown
  >;
  expectProviderEvidence(provider);
  writeFileSync(
    evidenceArtifactPath("docs/design-system/evidence/3387/journey-proof.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        issue: 3387,
        checkedAt: new Date().toISOString(),
        passed: true,
        evidenceClass: "production-composed-deterministic-browser",
        modelQualification: false,
        liveAuthenticationQualification: false,
        runtime: "scripted-supervisor-with-production-generated-tools",
        provider:
          "canonical-network-target-substituted-with-real-local-git-and-deterministic-github",
        terminalCleanup: "operator-stop-or-revoked",
        cases,
        correlatedDeliveryLogCount: deliveries.length,
        correlatedReviewDiagnosticCount: diagnostics.length,
        pushes: provider.pushes,
        creates: provider.creates,
        boundaryRejections: provider.rejections,
        sourceHashes: deliverySourceHashes(),
        rawContentRecorded: false,
      },
      null,
      2,
    )}\n`,
  );
}

function readDeliveryLog(stateDir: string): readonly Record<string, unknown>[] {
  const log = readFileSync(join(stateDir, "bff-state", "state", "logs", "server.log"), "utf8");
  for (const value of [DELIVERY_TITLE, DELIVERY_TEMPLATE, COMMIT_MESSAGE])
    expect(log).not.toContain(value);
  const lines = log
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return lines;
}

// #3401 review finding (T42): a fixture the journey depends on for a mocked gateway turn (or its
// production counterpart) missing from this list lets `journey-proof.json` attest reviewed
// sources while the unlisted file drifts underneath it. `coding-issue-delivery-evidence.test.ts`
// derives the journey's own fixture graph from its actual entry point
// (coding-issue-delivery-server.mts) and pins that every sibling `tests/e2e/servers/` module it
// reaches is present here — extend this list, never silently narrow it.
export const DELIVERY_SOURCE_PATHS: readonly string[] = [
  "tests/e2e/coding-issue-delivery.spec.ts",
  "tests/e2e/servers/coding-issue-delivery-fixture.mts",
  "tests/e2e/servers/coding-issue-delivery-transport.mts",
  "tests/e2e/servers/coding-issue-delivery-server.mts",
  "tests/e2e/servers/coding-issue-description-model.mts",
  "tests/e2e/servers/coding-issue-commit-fixture.mts",
  "tests/e2e/servers/coding-issue-ci-driver.mts",
  "tests/e2e/servers/coding-runtime-server-shared.mts",
  "packages/keiko-server/src/deps.ts",
  "packages/keiko-server/src/coding-runtime/productionCodingRuntimePorts.ts",
  "packages/keiko-server/src/coding-runtime/codingRuntimeDescriptionJobStore.ts",
  "packages/keiko-server/src/coding-runtime/codingRuntimeOrchestrator.ts",
  "packages/keiko-server/src/coding-runtime/productionDraftDeliveryDependencies.ts",
  "packages/keiko-server/src/coding-runtime/productionVerifiedCommitDependencies.ts",
  "packages/keiko-server/src/gitDelivery/draftDeliveryService.ts",
  "packages/keiko-server/src/gitDelivery/prDescriptionGeneration.ts",
  "packages/keiko-server/src/gitDelivery/prDescriptionPreparation.ts",
  "packages/keiko-server/src/gitDelivery/prDescriptionRoutes.ts",
  "packages/keiko-server/src/gitDelivery/prDescriptionService.ts",
  "packages/keiko-model-gateway/src/prDescription/render.ts",
  "packages/keiko-tools/src/git-publish-node.ts",
  "packages/keiko-tools/src/git-pr-node.ts",
];

function deliverySourceHashes(): Readonly<Record<string, string>> {
  return Object.fromEntries(DELIVERY_SOURCE_PATHS.map((path) => [path, artifactDigest(path)]));
}
