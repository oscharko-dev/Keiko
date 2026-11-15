import {
  chatTurnEndAnswerFingerprint,
  type ChatToolTurnEnd,
  type ChatToolTurnEndReason,
  type ChatTurnEndItemState,
  type ChatTurnEndReceipt,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  useOptionalWidgetTranslate,
  type OptionalWidgetTranslate,
} from "@/lib/optional-widget-i18n";
import { jiraToolLabel } from "./jira-tool-presentation";

/** One catalog sentence per closed reason the server states (#4355); a test walks the vocabulary. */
const REASON_KEYS = {
  "budget-exhausted": "chat.turnEnd.reason.budgetExhausted",
  deadline: "chat.turnEnd.reason.deadline",
  "authority-invalid": "chat.turnEnd.reason.authorityInvalid",
  "authentication-failed": "chat.turnEnd.reason.authenticationFailed",
  "tool-failure": "chat.turnEnd.reason.toolFailure",
  "output-exhausted": "chat.turnEnd.reason.outputExhausted",
  "context-overflow": "chat.turnEnd.reason.contextOverflow",
  "tool-not-offered": "chat.turnEnd.reason.toolNotOffered",
  "model-failure": "chat.turnEnd.reason.modelFailure",
} as const satisfies Record<ChatToolTurnEndReason, string>;
export const TURN_END_REASON_KEYS = REASON_KEYS;

const STATE_KEYS = {
  created: "chat.turnEnd.state.created",
  existing: "chat.turnEnd.state.existing",
  failed: "chat.turnEnd.state.failed",
  uncertain: "chat.turnEnd.state.uncertain",
  skipped: "chat.turnEnd.state.skipped",
  excluded: "chat.turnEnd.state.excluded",
  pending: "chat.turnEnd.state.pending",
} as const satisfies Record<ChatTurnEndItemState, string>;
export const TURN_END_STATE_KEYS = STATE_KEYS;

/**
 * What the person reads for a tool: the label the Jira cards already use for it, in the person's
 * language; a tool without one reads as one neutral word, never as its internal id.
 */
export function receiptToolLabel(tool: string, translate: OptionalWidgetTranslate): string {
  return translate(jiraToolLabel({ call: { name: tool, arguments: {} } }));
}

function receiptLine(entry: ChatTurnEndReceipt, translate: OptionalWidgetTranslate): string {
  const label = receiptToolLabel(entry.tool, translate);
  const subject =
    entry.key ??
    (entry.item === undefined
      ? ""
      : translate("chat.turnEnd.itemWithoutKey", { item: String(entry.item) }));
  const named = subject === "" ? label : `${label} ${subject}`;
  return entry.state === undefined ? named : `${named} (${translate(STATE_KEYS[entry.state])})`;
}

function list(
  title: string,
  entries: readonly ChatTurnEndReceipt[],
  translate: OptionalWidgetTranslate,
): string[] {
  return entries.length === 0
    ? []
    : [title, ...entries.map((entry) => `- ${receiptLine(entry, translate)}`), ""];
}

/**
 * The answer of a turn that ended early, worded from the stored closed facts in the person's
 * language (#4355). It carries the same receipts, in the same order, as the English answer the
 * server stored; nothing here is guessed from that text.
 */
export function turnEndText(end: ChatToolTurnEnd, translate: OptionalWidgetTranslate): string {
  const more =
    end.moreCount === 0
      ? []
      : [translate("chat.turnEnd.more", { count: String(end.moreCount) }), ""];
  return [
    `${translate("chat.turnEnd.lead")} ${translate(REASON_KEYS[end.reason])}`,
    "",
    ...list(translate("chat.turnEnd.completed"), end.completed, translate),
    ...list(translate("chat.turnEnd.unconfirmed"), end.unconfirmed, translate),
    ...list(translate("chat.turnEnd.unsettled"), end.unsettled, translate),
    ...list(translate("chat.turnEnd.notDone"), end.notDone, translate),
    ...more,
    translate("chat.turnEnd.counts", {
      reads: String(end.readCount),
      refused: String(end.refusedCount),
    }),
    "",
    translate("chat.turnEnd.footer"),
  ].join("\n");
}

/**
 * The ending as one plain string, or undefined when the turn did not end early OR the stored answer
 * is no longer the ending the record was built with: a record that outlived its answer (a failed
 * clearing write) never hides a model's real answer behind an ending it did not give.
 */
export function useTurnEndText(
  end: ChatToolTurnEnd | undefined,
  storedAnswer: string,
): string | undefined {
  const translate = useOptionalWidgetTranslate();
  if (end === undefined || end.answer !== chatTurnEndAnswerFingerprint(storedAnswer))
    return undefined;
  return turnEndText(end, translate);
}
