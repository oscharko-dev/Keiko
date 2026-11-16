import { describe, expect, it } from "vitest";
import { createJiraDraftStore } from "@oscharko-dev/keiko-connectors";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { jiraOpenDraftGuidance, jiraTurnGuidance } from "./jiraOpenDraft.js";
import { JIRA_TOOL_GUIDANCE } from "./jiraToolGuidance.js";
import { recordJiraDraftActivity } from "./jiraDraftActivity.js";

const DRAFT_ID = "0b5c1f9e-2d4a-4b7e-9a51-6f3e2c1d0a99";

function staged(): ReturnType<typeof createJiraDraftStore> {
  const store = createJiraDraftStore({ newId: () => DRAFT_ID });
  const items = Array.from({ length: 3 }, (_, i) => ({ ref: `r${String(i)}`, summary: "Secret" }));
  const result = store.append("chat-1", undefined, "fingerprint", items);
  if (!result.ok) throw new Error("Expected a staged draft");
  return store;
}

describe("the Chat's open Jira draft in the tool turn (#4292)", () => {
  it("persists closed template rule counters through the real draft formatter (S17)", () => {
    const logs = createBufferedServerLogSink();
    recordJiraDraftActivity(logs, "rule-count-proof", {
      phase: "refused",
      refusal: "template-violation",
      newDraft: true,
      pageItemCount: 2,
      itemCount: 0,
      pageCount: 0,
      byteCount: 0,
      unresolvedRefCount: 0,
      violationCount: 3,
      durationMs: 1,
      violationRuleCounts: { "section-missing": 2, "summary-too-short": 1 },
    });
    const [event] = logs.events;
    if (event === undefined) throw new Error("Missing draft activity");
    const line = formatActivityLogProofLine(event);
    expect(expectActivityLogProof("atlassian.jira-draft.line", line)).toMatchObject({
      sectionMissingCount: 2,
      summaryTooShortCount: 1,
      violationCount: 3,
    });
    expect(line).not.toMatch(/requirementIds|description|subject|template=/u);
  });
  it("names the draft a folded conversation lost, so a retry creates it instead of redrafting", () => {
    const store = staged();
    const draft = store.latest("chat-1");
    const logs = createBufferedServerLogSink();

    const guidance = jiraTurnGuidance(store, "chat-1", logs, "correlation-1");

    expect(guidance.startsWith(JIRA_TOOL_GUIDANCE)).toBe(true);
    expect(guidance).toContain(`draftId ${DRAFT_ID}`);
    expect(guidance).toContain(`draftDigest ${draft?.digest ?? "missing"}`);
    expect(guidance).toContain("3 items");
    const [event] = logs.events;
    if (event === undefined) throw new Error("Missing activity event");
    const line = formatActivityLogProofLine(event);
    expect(expectActivityLogProof("atlassian.jira-draft.line", line)).toMatchObject({
      op: "atlassian.jira-draft",
      correlationId: "correlation-1",
      phase: "named",
      itemCount: 3,
      pageCount: 1,
    });
    // Counts only: never the draft's id, digest or content.
    expect(line).not.toContain(DRAFT_ID);
    expect(line).not.toContain(draft?.digest ?? "missing");
    expect(line).not.toContain("Secret");
  });

  it("adds nothing for a Chat without a draft, another Chat's draft or no store", () => {
    const logs = createBufferedServerLogSink();
    expect(jiraTurnGuidance(staged(), "chat-2", logs, "c")).toBe(JIRA_TOOL_GUIDANCE);
    expect(jiraTurnGuidance(undefined, "chat-1", logs, "c")).toBe(JIRA_TOOL_GUIDANCE);
    expect(jiraOpenDraftGuidance(undefined)).toBeUndefined();
    expect(logs.events).toHaveLength(0);
  });
});
