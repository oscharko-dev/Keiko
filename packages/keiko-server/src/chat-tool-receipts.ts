import {
  JIRA_DRAFT_ITEM_STATES,
  type JiraDraftItemState,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import { jiraMutationToolId } from "./atlassian/jiraMutationToolId.js";

/**
 * The Jira receipts a stored tool result carries, read from its validated structure (#4175): the
 * single issue key of an ordinary write, or the per-item keys and states of a backlog draft
 * (#4178). Recovery answers and compacted continuations repeat only these, never result text.
 */
const KEY_PATTERN = String.raw`[A-Z][A-Z0-9_]{0,254}-[1-9]\d{0,17}`;
const ISSUE_KEY = new RegExp(`^${KEY_PATTERN}$`, "u");
/** A compact result names a run of created keys as `PROJ-3..PROJ-40` (#4178). */
const ISSUE_KEY_RANGE = new RegExp(String.raw`^${KEY_PATTERN}\.\.${KEY_PATTERN}$`, "u");
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

/** The compact result's exact key ranges, each as one receipt that names its whole range. */
function rangeReceipts(state: "created" | "existing", ranges: unknown): ChatToolDraftReceipt[] {
  if (!Array.isArray(ranges)) return [];
  return ranges
    .filter(
      (range): range is string =>
        typeof range === "string" && (ISSUE_KEY.test(range) || ISSUE_KEY_RANGE.test(range)),
    )
    .map((issueKey) => ({ state, issueKey }));
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
  const receipts = draftRowReceipts(record(result?.data));
  return receipts.length === 0 ? undefined : receipts;
}
/** The receipts of a result's key ranges and of its rows; none for a result without rows. */
function draftRowReceipts(
  data: Readonly<Record<string, unknown>> | undefined,
): ChatToolDraftReceipt[] {
  const items = data?.items;
  if (!Array.isArray(items)) return [];
  return [
    ...rangeReceipts("created", data?.createdRanges),
    ...rangeReceipts("existing", data?.existingRanges),
    ...items
      .map(draftReceipt)
      .filter((receipt): receipt is ChatToolDraftReceipt => receipt !== undefined),
  ];
}

const REQUIREMENT_REFERENCE = /^[0-9a-f]{8}:[A-Za-z0-9._-]{1,80}$/u;
const REQUIREMENT_RECEIPTS_MAX = 50;
const RECEIPT_TEXT_CHARS = 60;

export interface ChatToolRequirementReceipt {
  readonly reference: string;
  readonly title: string;
  readonly priority?: string;
}

function requirementReceipt(value: unknown): ChatToolRequirementReceipt | undefined {
  const item = record(value);
  const reference = item?.reference;
  if (item === undefined || typeof reference !== "string" || !REQUIREMENT_REFERENCE.test(reference))
    return undefined;
  const title = typeof item.title === "string" ? item.title.slice(0, RECEIPT_TEXT_CHARS) : "";
  const priority =
    typeof item.priority === "string" ? item.priority.slice(0, RECEIPT_TEXT_CHARS) : undefined;
  return { reference, title, ...(priority === undefined ? {} : { priority }) };
}

/**
 * What a compacted page of the requirements read still tells the model: each unit's scoped
 * reference, title and priority (#4179). The page's statements and criteria are elided, but the
 * model keeps enough to list or reference every unit it has already read.
 */
export function chatToolRequirementReceipts(
  data: unknown,
): readonly ChatToolRequirementReceipt[] | undefined {
  const body = record(data);
  if (body?.view !== "units" || !Array.isArray(body.items)) return undefined;
  const receipts = body.items
    .slice(0, REQUIREMENT_RECEIPTS_MAX)
    .map((entry) => requirementReceipt(entry))
    .filter((receipt): receipt is ChatToolRequirementReceipt => receipt !== undefined);
  return receipts.length === 0 ? undefined : receipts;
}
