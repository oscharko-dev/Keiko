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
