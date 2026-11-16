import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { expect, it } from "vitest";
import {
  decidedQualificationDeferrals,
  ownerDeferredRow,
  isApprovedDeferred,
} from "../testing/jira-chat-lab/api-qualification-policy.mjs";

const root = new URL("../../docs/local-knowledge/jira-api-coverage/", import.meta.url);
const ledger = JSON.parse(readFileSync(new URL("operations.json", root), "utf8"));
const policy = JSON.parse(readFileSync(new URL("qualification-proposals.json", root), "utf8"));
it("binds exactly the twelve owner-decided deferrals and leaves cluster reads and filter deletion native", () => {
  const decisions = decidedQualificationDeferrals(policy, ledger);
  expect(decisions.size).toBe(12);
  expect(decisions.has("GET /rest/api/2/cluster/nodes")).toBe(false);
  expect(decisions.has("DELETE /rest/api/2/filter/{id}")).toBe(false);
});
it.each(["proposed", "owner", "date", "extra", "missing", "duplicate"])(
  "refuses %s policy evidence",
  (kind) => {
    const value = structuredClone(policy);
    const edits = {
      proposed: () => {
        value.status = "awaiting-owner-decision";
      },
      owner: () => {
        value.decidedBy = "runner";
      },
      date: () => {
        value.decidedAt = "2026-11-09";
      },
      extra: () => {
        value.proposals[0].identities.push("GET /rest/api/2/cluster/nodes");
      },
      missing: () => {
        value.proposals[0].identities.pop();
      },
      duplicate: () => {
        value.proposals[0].identities.push(value.proposals[0].identities[0]);
      },
    };
    edits[kind]();
    expect(() => decidedQualificationDeferrals(value, ledger)).toThrow();
  },
);
it("does not synthesize a native receipt or passed readback for a policy row", () => {
  const decisions = decidedQualificationDeferrals(policy, ledger);
  const [identity, decision] = decisions.entries().next().value;
  const row = ownerDeferredRow(identity, decision, {
    runId: "synthetic",
    sourceRevision: "a".repeat(40),
    release: "10.3.26",
    imageDigest: "b".repeat(64),
  });
  expect(isApprovedDeferred(row, decisions)).toBe(true);
  expect(row.runtimeAvailability).toBe("deferred");
  expect(row.dispatch).toBeUndefined();
  expect(row.readback).toBeUndefined();
  expect(row.journal).toBeUndefined();
  expect(isApprovedDeferred({ ...row, verificationReferences: ["invented"] }, decisions)).toBe(
    false,
  );
  expect(
    isApprovedDeferred(
      { ...row, ownerDecision: { ...decision, digest: "0".repeat(64) } },
      decisions,
    ),
  ).toBe(false);
});
