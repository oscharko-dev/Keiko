import { captureCiModes, writeCiJourneyReceipt } from "./support/coding-issue-ci-evidence.js";
import { createCiFixtureReader } from "./servers/coding-issue-ci-fixture.mjs";
import { expect, test, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import type { ReadinessSnapshot } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import {
  ciStateDir,
  ciProviderPath,
  type CiFixtureMode,
  type CiProviderState,
} from "./support/coding-issue-ci.js";
import {
  startCiDraft,
  ciControl,
  ciSnapshot,
  commitCiCandidate,
  pushCiCandidate,
  stopCiRun,
} from "./support/coding-issue-ci-journey.js";

test.describe.configure({ mode: "serial" });
const stateDir = ciStateDir();
const completedCases: string[] = [];
test.afterEach(() => {
  if (test.info().status === "passed") completedCases.push(test.info().title);
});
test.afterAll(() => {
  if (completedCases.length === 2) writeCiJourneyReceipt(stateDir, completedCases);
});
function provider(): CiProviderState {
  return JSON.parse(readFileSync(ciProviderPath(stateDir), "utf8")) as CiProviderState;
}
function mode(value: CiFixtureMode): void {
  writeFileSync(ciProviderPath(stateDir), JSON.stringify({ ...provider(), mode: value }));
}
async function observe(
  page: Page,
  expected: ReadinessSnapshot["state"],
): Promise<ReadinessSnapshot> {
  const prior = (await ciSnapshot(page)).ciReadiness;
  if (prior !== undefined)
    await expect.poll(() => Date.now() >= Date.parse(prior.observedAt) + 5_001).toBe(true);
  const result = await ciControl("observe-ci");
  expect(result).toHaveProperty("ci.status", "observed");
  if (result === undefined || !("ci" in result) || result.ci.status !== "observed")
    throw new Error("Expected actual CI observation");
  expect(result.ci.snapshot.state).toBe(expected);
  const current = await ciSnapshot(page);
  expect(current.ciReadiness).toEqual(result.ci.snapshot);
  expect(current.ciReadiness?.headSha).toBe(current.draftDelivery?.binding.headSha);
  expect(JSON.stringify(current)).not.toMatch(/required-build|advisory-analysis|rawLogs/u);
  return result.ci.snapshot;
}

test("#3388 @coding-issue-ci pending failure approved repair new head and technical readiness", async ({
  page,
}) => {
  await page.clock.install();
  mode("pending");
  await startCiDraft(page, 42);
  const initial = await observe(page, "pending");
  await expect(page.getByText("CI checks pending", { exact: true })).toBeVisible();
  mode("failed");
  const failed = await observe(page, "failed");
  expect(failed.requiredChecks.failed).toBe(1);
  expect(failed).toHaveProperty("failureSignatureDigest");
  await expect(page.getByText("CI checks failed", { exact: true })).toBeVisible();
  expect(await ciControl("ci-repair")).toHaveProperty("status", "completed");
  await commitCiCandidate(page);
  await pushCiCandidate(page);
  expect(await ciControl("reconcile")).toHaveProperty(
    "draftDelivery.record.phase",
    "draft-created",
  );
  expect((await ciSnapshot(page)).draftDelivery?.binding.headSha).not.toBe(initial.headSha);
  mode("ready");
  const ready = await observe(page, "technical-ready");
  expect(ready.requiredChecks).toMatchObject({ total: 1, passed: 1, failed: 0 });
  expect(ready.advisoryChecks.failed).toBe(1);
  expect(ready.humanReview).toMatchObject({ requiredCount: 1, approvedCount: 0 });
  await expect(page.getByText("Technical checks ready", { exact: true })).toBeVisible();
  const ci = page.getByRole("region", { name: "CI readiness", exact: true });
  await expect(ci).toContainText("Draft pull request");
  await expect(ci.getByRole("button")).toHaveCount(0);
  await captureCiModes(page);
  await page.clock.fastForward(60_001);
  await expect(page.getByText("CI observation is stale", { exact: true })).toBeVisible();
  await stopCiRun(page);
  await page.reload();
  await expect(page.getByText("CI observation is stale", { exact: true })).toBeVisible();
});

test("#3388 @coding-issue-ci incomplete visibility and wrong PR or head never become ready", async ({
  page,
}) => {
  mode("visibility-unknown");
  await startCiDraft(page, 43);
  const unknown = await observe(page, "unknown");
  expect(unknown.complete).toBe(false);
  await expect(page.getByText("CI readiness unknown", { exact: true })).toBeVisible();
  for (const rejected of ["wrong-pr", "wrong-head"] as const) {
    mode(rejected);
    const changed = await observe(page, "pending");
    expect(changed.reason).toBe("revision-changed");
    await expect(page.getByText("Technical checks ready", { exact: true })).toHaveCount(0);
  }
  const before = provider().reads;
  const snapshot = await ciSnapshot(page);
  const pr = snapshot.draftDelivery?.pullRequest;
  if (pr === undefined) throw new Error("Expected confirmed fixture PR");
  const target = {
    ownerAndRepo: pr.repository,
    prExternalId: String(pr.number),
    baseBranchName: pr.baseRef,
    headSha: pr.headSha,
  };
  for (const mismatch of [
    { ownerAndRepo: "fixture/foreign" },
    { prExternalId: "999" },
    { headSha: "f".repeat(40) },
  ])
    await expect(
      createCiFixtureReader(stateDir).readFacts({ ...target, ...mismatch }),
    ).rejects.toThrow("ci-fixture-target-denied");
  expect(provider().rejectedTargets).toBe(3);
  for (const operation of ["ci-invalid-pr", "ci-invalid-head", "ci-force-fresh"] as const)
    expect(await ciControl(operation)).toHaveProperty("status", "invalid");
  expect(provider().reads).toBe(before);
  await stopCiRun(page);
});
