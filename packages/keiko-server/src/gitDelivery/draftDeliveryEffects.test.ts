import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingRuntimeDeliveryResult } from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-delivery";
import { DraftDeliveryFixture } from "./draftDeliveryServiceTestSupport.js";

let fixture: DraftDeliveryFixture;
beforeEach(async () => {
  // Real GitHub Actions context must not be scrubbed out of Git's tracking headers.
  vi.stubEnv("GITHUB_REF_TYPE", "branch");
  fixture = new DraftDeliveryFixture();
  await fixture.recordVerifiedCommit();
});
afterEach(() => {
  fixture.close();
  vi.unstubAllEnvs();
});
function proposalId(value: CodingRuntimeDeliveryResult): string {
  expect(value.status, JSON.stringify(fixture.events)).toBe("recorded");
  if (value.status !== "recorded") throw new Error("missing record");
  return value.record.proposalId;
}
async function execute(value: CodingRuntimeDeliveryResult): Promise<CodingRuntimeDeliveryResult> {
  const id = proposalId(value);
  expect(fixture.service.issueApproval(id)).toBeDefined();
  const lease = fixture.service.consumeApproval(id);
  expect(lease).toBeDefined();
  if (lease === undefined) throw new Error("missing lease");
  return fixture.service.executeApproved(id, lease, { check: () => true });
}
// Configures the pushed-to branch's upstream tracking ref one commit AHEAD of local HEAD, purely
// through local git plumbing (no network) — the same local state `git status --porcelain=v2
// --branch` reports for a real behind-upstream branch.
function makeLocalBranchBehindUpstream(): void {
  const headRef = fixture.context.headRef;
  const localHead = fixture.git(["rev-parse", "HEAD"]);
  fixture.git(["checkout", "-qb", "advance-scratch"]);
  fixture.git(["commit", "-q", "--allow-empty", "-m", "advance-remote"]);
  const advanced = fixture.git(["rev-parse", "HEAD"]);
  fixture.git(["checkout", "-q", headRef]);
  fixture.git(["branch", "-qD", "advance-scratch"]);
  fixture.git(["update-ref", `refs/remotes/origin/${headRef}`, advanced]);
  fixture.git(["branch", `--set-upstream-to=origin/${headRef}`, headRef]);
  expect(fixture.git(["rev-parse", "HEAD"])).toBe(localHead);
  expect(fixture.git(["rev-parse", "@{upstream}"])).toBe(advanced);
}

describe("push effect preflight snapshot", () => {
  it("refuses a behind-upstream push with a non-fast-forward preflight finding instead of publishing", async () => {
    makeLocalBranchBehindUpstream();
    const proposal = await fixture.service.proposePush();
    const result = await execute(proposal);
    expect(result, JSON.stringify(fixture.events)).toMatchObject({
      status: "recorded",
      record: { phase: "recovery-required", reason: "preflight-failed" },
    });
    // The push adapter must never be reached once preflight blocks the attempt.
    expect(fixture.pushCount).toBe(0);
    const diagnostic = fixture.events.find(
      (event) => event.op === "git.delivery.mutation.completed",
    );
    expect(diagnostic?.correlationId).toBe("draft-delivery-test");
    expect(diagnostic?.extra).toMatchObject({
      actionKind: "push",
      status: "blocked",
      preflightBlockingCount: 1,
    });
  });
  it("still allows a clean push once the local branch is not behind its upstream", async () => {
    const proposal = await fixture.service.proposePush();
    const result = await execute(proposal);
    expect(result, JSON.stringify(fixture.events)).toMatchObject({
      status: "recorded",
      record: { phase: "pushed" },
    });
    expect(fixture.pushCount).toBe(1);
  });
});
