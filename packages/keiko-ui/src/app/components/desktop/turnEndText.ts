import type {
  ChatToolTurnEnd,
  ChatToolTurnEndReason,
  ChatTurnEndItemState,
  ChatTurnEndReceipt,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  useOptionalWidgetTranslate,
  type OptionalWidgetTranslate,
} from "@/lib/optional-widget-i18n";

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

function receiptLine(entry: ChatTurnEndReceipt, translate: OptionalWidgetTranslate): string {
  const subject =
    entry.key ??
    (entry.item === undefined
      ? ""
      : translate("chat.turnEnd.itemWithoutKey", { item: String(entry.item) }));
  const named = subject === "" ? entry.tool : `${entry.tool} ${subject}`;
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
    translate("chat.turnEnd.lead", { reason: translate(REASON_KEYS[end.reason]) }),
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

/** The ending as one plain string, or undefined for a turn that did not end early. */
export function useTurnEndText(end: ChatToolTurnEnd | undefined): string | undefined {
  const translate = useOptionalWidgetTranslate();
  return end === undefined ? undefined : turnEndText(end, translate);
}
