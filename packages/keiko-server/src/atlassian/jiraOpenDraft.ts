import type { JiraDraftStore, StagedJiraDraft } from "@oscharko-dev/keiko-connectors";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { recordJiraDraftActivity } from "./jiraDraftActivity.js";
import { JIRA_TOOL_GUIDANCE } from "./jiraToolGuidance.js";

// The Chat's open Jira draft, named in the tool turn's instruction (#4292). A long conversation
// folds earlier turns into a summary that does not keep a draftId, so "please try creating the
// issues again" reached the model without the draft it meant, and the model drafted all 370
// requirements again (16 minutes) instead of creating the staged ones. The draft store, not the
// conversation, knows which draft the Chat holds.

/** The words that name the Chat's open draft; its id and digest are Keiko's own, never user text. */
export function jiraOpenDraftGuidance(
  draft: Pick<StagedJiraDraft, "id" | "digest" | "items"> | undefined,
): string | undefined {
  if (draft === undefined) return undefined;
  return (
    `This Chat holds a staged Jira draft: draftId ${draft.id}, draftDigest ${draft.digest}, ` +
    `${String(draft.items.length)} items. When the user asks to create, retry or continue these ` +
    "issues, use this draft: jira_draft with this draftId and draftDigest creates its issues, and " +
    "issues already in Jira are recognised, so nothing is created twice; jira_draft_batch with " +
    "this draftId continues drafting it and skips requirements already drafted. Start a new draft " +
    "only when the user asks for different issues."
  );
}

/**
 * The tool turn's Jira guidance with the Chat's open draft, if it holds one. Records the draft's
 * counts when it is named; never its id, digest or content.
 */
export function jiraTurnGuidance(
  store: JiraDraftStore | undefined,
  chatId: string,
  log: ServerLogSink | undefined,
  correlationId: string,
): string {
  const draft = store?.latest(chatId);
  const open = jiraOpenDraftGuidance(draft);
  if (draft === undefined || open === undefined) return JIRA_TOOL_GUIDANCE;
  recordJiraDraftActivity(log, correlationId, {
    phase: "named",
    newDraft: false,
    pageItemCount: 0,
    itemCount: draft.items.length,
    pageCount: draft.pageCount,
    byteCount: draft.bytes,
    unresolvedRefCount: 0,
    violationCount: 0,
    durationMs: 0,
  });
  return `${JIRA_TOOL_GUIDANCE} ${open}`;
}
