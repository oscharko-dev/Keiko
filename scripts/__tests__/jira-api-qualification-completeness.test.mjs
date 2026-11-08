import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { expect, it } from "vitest";
import { API_QUALIFICATION_ALL_CASES } from "../testing/jira-chat-lab/api-qualification-case-list.mjs";
import { decidedQualificationDeferrals } from "../testing/jira-chat-lab/api-qualification-policy.mjs";

it("has an explicit governed recipe for every native inventory identity outside the nine decided deferrals", () => {
  const root = new URL("../../docs/local-knowledge/jira-api-coverage/", import.meta.url);
  const ledger = JSON.parse(readFileSync(new URL("operations.json", root), "utf8"));
  const policy = JSON.parse(readFileSync(new URL("qualification-proposals.json", root), "utf8"));
  const deferred = decidedQualificationDeferrals(policy, ledger);
  const tools = new Set(API_QUALIFICATION_ALL_CASES.map((entry) => entry.tool));
  expect(tools.size).toBe(API_QUALIFICATION_ALL_CASES.length);
  const missing = ledger.operations.filter(
    (row) =>
      !deferred.has(row.identity) && !row.currentCapabilityIds.some((tool) => tools.has(tool)),
  );
  expect(missing.map((row) => row.identity)).toEqual([]);
  expect(API_QUALIFICATION_ALL_CASES.length + deferred.size).toBe(ledger.operations.length);
});
