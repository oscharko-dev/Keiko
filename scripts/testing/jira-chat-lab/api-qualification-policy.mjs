// These nine dispositions were explicitly decided by the integrator on 2026-11-08.
// A proposed exemption, target HTTP error or self-reported run outcome grants no exemption.
import assert from "node:assert/strict";
import { qualificationDigest } from "./api-qualification-evidence.mjs";
export { isApprovedDeferred } from "./api-qualification-evidence.mjs";

const APPROVED = new Set([
  "PUT /rest/api/2/cluster/index-snapshot/{nodeId}",
  "DELETE /rest/api/2/cluster/node/{nodeId}",
  "PUT /rest/api/2/cluster/node/{nodeId}/offline",
  "POST /rest/api/2/cluster/zdu/approve",
  "POST /rest/api/2/cluster/zdu/cancel",
  "POST /rest/api/2/cluster/zdu/retryUpgrade",
  "POST /rest/api/2/cluster/zdu/start",
  "POST /rest/api/2/upgrade",
  "POST /rest/api/2/issue/{issueIdOrKey}/notify",
]);
export function decidedQualificationDeferrals(policy, ledger) {
  if (policy === undefined) return new Map();
  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.status, "decided");
  assert.equal(policy.decisionOwner, "oscharko");
  assert.equal(policy.decidedBy, "integrator");
  assert.equal(policy.decidedAt, "2026-11-08");
  const inventory = new Set(ledger.operations.map((row) => row.identity));
  const decisions = new Map();
  for (const proposal of policy.proposals) {
    if (proposal.disposition !== "deferred") continue;
    assert.equal(proposal.proposedDisposition, "deferred");
    assert.match(proposal.id, /^[a-z0-9-]+$/u);
    assert.ok(typeof proposal.rationale === "string" && proposal.rationale.length > 0);
    for (const identity of proposal.identities) {
      assert.ok(APPROVED.has(identity) && inventory.has(identity) && !decisions.has(identity));
      decisions.set(identity, {
        reference: `qualification-proposals.json#${proposal.id}`,
        digest: qualificationDigest({
          decidedBy: policy.decidedBy,
          decidedAt: policy.decidedAt,
          ...proposal,
        }),
        decidedBy: policy.decidedBy,
        decidedAt: policy.decidedAt,
      });
    }
  }
  assert.deepEqual(new Set(decisions.keys()), APPROVED);
  return decisions;
}
export function ownerDeferredRow(identity, decision, report) {
  return {
    runId: report.runId,
    sourceRevision: report.sourceRevision,
    release: report.release,
    imageDigest: report.imageDigest,
    id: qualificationDigest(identity).slice(0, 24),
    identity,
    runtimeAvailability: "deferred",
    ownerDecision: { ...decision },
    verificationReferences: [decision.reference],
  };
}
