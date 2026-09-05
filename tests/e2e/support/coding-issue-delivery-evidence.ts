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

export function writeDeliveryJourneyReceipt(stateDir: string, cases: readonly string[]): void {
  expect(cases).toHaveLength(11);
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
  expect(provider).toMatchObject({ pushes: 6, creates: 4, rejections: 5 });
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

function deliverySourceHashes(): Readonly<Record<string, string>> {
  const paths = [
    "tests/e2e/coding-issue-delivery.spec.ts",
    "tests/e2e/servers/coding-issue-delivery-fixture.mts",
    "tests/e2e/servers/coding-issue-delivery-transport.mts",
    "tests/e2e/servers/coding-issue-delivery-server.mts",
    "tests/e2e/servers/coding-issue-commit-fixture.mts",
    "tests/e2e/servers/coding-runtime-server-shared.mts",
    "packages/keiko-server/src/coding-runtime/productionDraftDeliveryDependencies.ts",
    "packages/keiko-server/src/coding-runtime/productionVerifiedCommitDependencies.ts",
    "packages/keiko-server/src/gitDelivery/draftDeliveryService.ts",
    "packages/keiko-tools/src/git-publish-node.ts",
    "packages/keiko-tools/src/git-pr-node.ts",
  ];
  return Object.fromEntries(paths.map((path) => [path, artifactDigest(path)]));
}
