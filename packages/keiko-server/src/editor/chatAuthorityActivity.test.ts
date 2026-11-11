import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import {
  ATLASSIAN_CONNECTOR_ACTION_TYPES,
  JIRA_MANAGED_READ_TOOLS,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { recordChatAuthorityResult } from "./chatAuthorityActivity.js";
import { createServerLogger, setServerLogger } from "../observability/index.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { resetServerLogger } from "../../../../tests/support/activity-log-test-support.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";

afterEach(resetServerLogger);
const READS: ReadonlySet<string> = new Set(JIRA_MANAGED_READ_TOOLS);
const OTHER: ReadonlySet<string> = new Set([
  "sync-space",
  "sync-project",
  "search-issues-live",
  "create-page",
  "update-page",
  "add-page-comment",
]);
it.each(ATLASSIAN_CONNECTOR_ACTION_TYPES)(
  "retains exact %s authority identity in bounded body-free evidence",
  (actionType) => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const result = { ok: true } as const;
    expect(
      recordChatAuthorityResult("read-grant", result, { actionType }, "synthetic-correlation"),
    ).toBe(result);
    const event = sink.events[0];
    if (event === undefined) throw new TypeError("Missing authority evidence");
    const line = formatActivityLogProofLine(event);
    expect(expectActivityLogProof("chat.tool-authority.operation.read-grant", line)).toMatchObject({
      actionType: OTHER.has(actionType)
        ? actionType
        : READS.has(actionType)
          ? "jira-read"
          : "jira-write",
      actionTypeDigest: createHash("sha256").update(actionType).digest("hex"),
      outcome: "allowed",
    });
  },
);

it("records expired read-grant lifecycle evidence at info without changing the refusal (4b)", () => {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "debug" }));
  const result: { readonly ok: false; readonly reason: "expired" } = {
    ok: false,
    reason: "expired",
  };
  const grantId = "synthetic-expired-grant";
  expect(
    recordChatAuthorityResult(
      "read-grant",
      result,
      { grantId, grantState: "expired", affectedCount: 1 },
      "synthetic-expiry-correlation",
    ),
  ).toBe(result);
  expect(sink.events).toHaveLength(1);
  const event = sink.events[0];
  if (event === undefined) throw new TypeError("Missing expired grant evidence");
  const line = formatActivityLogProofLine(event);
  expect(expectActivityLogProof("chat.tool-authority.operation.read-grant", line)).toMatchObject({
    level: "info",
    phase: "read-grant",
    outcome: "expired",
    grantState: "expired",
    grantDigest: createHash("sha256").update(grantId).digest("hex"),
    affectedCount: 1,
    completeness: "complete",
    loss: "none",
  });
  expect(line).not.toContain(grantId);
});

type AuthorityFailure = Extract<
  Parameters<typeof recordChatAuthorityResult>[1],
  { readonly ok: false }
>;
interface WarningCase {
  readonly name: string;
  readonly phase: Parameters<typeof recordChatAuthorityResult>[0];
  readonly reason: AuthorityFailure["reason"];
  readonly evidence: Parameters<typeof recordChatAuthorityResult>[2];
}

it.each<WarningCase>([
  {
    name: "rejected read grant",
    phase: "read-grant",
    reason: "policy-denied",
    evidence: { grantState: "rejected" },
  },
  {
    name: "revoked read grant",
    phase: "read-grant",
    reason: "revoked",
    evidence: { grantState: "revoked" },
  },
  {
    name: "policy-denied read grant",
    phase: "read-grant",
    reason: "policy-denied",
    evidence: {},
  },
  { name: "expired authority resolution", phase: "resolve", reason: "expired", evidence: {} },
  {
    name: "expired write approval",
    phase: "write-approval",
    reason: "expired",
    evidence: { approvalState: "expired" },
  },
])("retains warning evidence for $name (4b)", ({ phase, reason, evidence }) => {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "debug" }));
  const result: AuthorityFailure = { ok: false, reason };
  expect(recordChatAuthorityResult(phase, result, evidence, "synthetic-warning-correlation")).toBe(
    result,
  );
  expect(sink.events).toHaveLength(1);
  const event = sink.events[0];
  if (event === undefined) throw new TypeError("Missing authority warning evidence");
  const line = formatActivityLogProofLine(event);
  expect(expectActivityLogProof("chat.tool-authority.operation.read-grant", line)).toMatchObject({
    level: "warn",
    phase,
    outcome: reason,
    ...evidence,
    completeness: "complete",
    loss: "none",
  });
});
