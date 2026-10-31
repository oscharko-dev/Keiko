import {
  JIRA_DRAFT_ITEM_STATES,
  JIRA_DRAFT_ITEMS_MAX,
  type JiraDraftItemState,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import { jiraMutationToolId } from "./atlassian/jiraMutationToolId.js";

/**
 * The Jira receipts a stored tool result carries, read from its validated structure (#4175): the
 * single issue key of an ordinary write, or the per-item keys and states of a backlog draft
 * (#4178). Recovery answers and compacted continuations repeat only these, never result text.
 */
const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,254}-[1-9]\d{0,17}$/u;
const DRAFT_STATES: ReadonlySet<unknown> = new Set(JIRA_DRAFT_ITEM_STATES);
const DRAFT_TOOL_ID = jiraMutationToolId("jira.draft");

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
 * Undefined unless the exchange is the managed `jira.draft` write itself: its validated result names
 * that tool and the mutation journal classified it. Any other result, including a read or an MCP
 * tool whose data merely has the same shape, never becomes a write receipt.
 */
export function chatToolDraftReceipts(
  exchange: ChatToolExchange,
): readonly ChatToolDraftReceipt[] | undefined {
  if (exchange.mutationOutcome === undefined) return undefined;
  // Read defensively: a transcript stored by an older build is data, not a validated envelope.
  const result = record(exchange.result);
  if (record(result?.toolRef)?.canonicalId !== DRAFT_TOOL_ID) return undefined;
  const items = record(result?.data)?.items;
  if (!Array.isArray(items)) return undefined;
  const receipts = items
    .slice(0, JIRA_DRAFT_ITEMS_MAX)
    .map(draftReceipt)
    .filter((receipt): receipt is ChatToolDraftReceipt => receipt !== undefined);
  return receipts.length === 0 ? undefined : receipts;
}
