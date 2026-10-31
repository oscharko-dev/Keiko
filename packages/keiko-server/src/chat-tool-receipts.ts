import {
  JIRA_DRAFT_ITEM_STATES,
  JIRA_DRAFT_ITEMS_MAX,
  type JiraDraftItemState,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";

/**
 * The Jira receipts a stored tool result carries, read from its validated structure (#4175): the
 * single issue key of an ordinary write, or the per-item keys and states of a backlog draft
 * (#4178). Recovery answers and compacted continuations repeat only these, never result text.
 */
const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,254}-[1-9]\d{0,17}$/u;
const DRAFT_STATES: ReadonlySet<unknown> = new Set(JIRA_DRAFT_ITEM_STATES);

export interface ChatToolDraftReceipt {
  readonly state: JiraDraftItemState;
  readonly issueKey?: string;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

export function chatToolIssueKey(data: unknown): string | undefined {
  const key = record(data)?.issueKey;
  return typeof key === "string" && ISSUE_KEY.test(key) ? key : undefined;
}

function draftReceipt(value: unknown): ChatToolDraftReceipt | undefined {
  const item = record(value);
  if (item === undefined || !DRAFT_STATES.has(item.state)) return undefined;
  const issueKey = chatToolIssueKey(item);
  return {
    state: item.state as JiraDraftItemState,
    ...(issueKey === undefined ? {} : { issueKey }),
  };
}

/**
 * Undefined when the result is not a draft result: other reads also return `items`, so only a list
 * that carries closed draft item states (a draft has at least one item) counts.
 */
export function chatToolDraftReceipts(data: unknown): readonly ChatToolDraftReceipt[] | undefined {
  const items = record(data)?.items;
  if (!Array.isArray(items)) return undefined;
  const receipts = items
    .slice(0, JIRA_DRAFT_ITEMS_MAX)
    .map(draftReceipt)
    .filter((receipt): receipt is ChatToolDraftReceipt => receipt !== undefined);
  return receipts.length === 0 ? undefined : receipts;
}
