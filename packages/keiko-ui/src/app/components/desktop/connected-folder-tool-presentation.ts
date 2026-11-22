import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  CONNECTED_FOLDER_TOOL_FAILURE_REASONS,
  CONNECTED_FOLDER_TOOL_LIMITS,
  CONNECTED_FOLDER_TOOL_VIEWS,
  type ConnectedFolderToolFailureReason,
  type ConnectedFolderToolView,
} from "@oscharko-dev/keiko-contracts/runtime/connected-folder-tool";
import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraOutcomeFact } from "./jira-agile-presentation";
import type { JiraOutcomeItem, JiraToolOutcomeView } from "./jira-tool-outcome";

// How the Chat shows the model's look-ups in the one folder connected to it (`folder.files`): the
// step label, the card labels, a short summary of a completed look-up and one sentence per refusal.
// The tool only reads the person's own folder, so there is no approval and no write to present.

/**
 * The tool's identity as a transcript carries it. The server declares it
 * (`keiko-server/src/connectedFolderTool.ts`, `connectedFolderToolName.ts`) and the UI cannot import
 * the server, so it is restated here; `connected-folder-tool-presentation.test.ts` pins every value
 * against that source.
 */
export const CONNECTED_FOLDER_TOOL_ALIAS = "folder_files";
export const CONNECTED_FOLDER_TOOL_ID = "keiko.folder.files";
export const CONNECTED_FOLDER_TOOL_CONTRACT_VERSION = 1;
/** The refusals the server adds to the workspace tool's closed reasons. */
export const CONNECTED_FOLDER_SERVER_REFUSALS = ["authority-denied", "result-bound"] as const;
export type ConnectedFolderToolRefusal =
  ConnectedFolderToolFailureReason | (typeof CONNECTED_FOLDER_SERVER_REFUSALS)[number];
/** Every closed reason a refused look-up can carry. */
export const CONNECTED_FOLDER_TOOL_REFUSALS: readonly ConnectedFolderToolRefusal[] = [
  ...CONNECTED_FOLDER_TOOL_FAILURE_REASONS,
  ...CONNECTED_FOLDER_SERVER_REFUSALS,
];

/** One plain sentence per closed reason; the test walks the vocabulary, so none can be missing. */
export const CONNECTED_FOLDER_REFUSAL_MESSAGES = {
  "invalid-request": "chat.folder.refusal.invalidRequest",
  "scope-denied": "chat.folder.refusal.scopeDenied",
  "out-of-range": "chat.folder.refusal.outOfRange",
  "not-text": "chat.folder.refusal.notText",
  unreadable: "chat.folder.refusal.unreadable",
  "budget-exhausted": "chat.folder.refusal.budgetExhausted",
  failed: "chat.folder.refusal.failed",
  "authority-denied": "chat.folder.refusal.authorityDenied",
  "result-bound": "chat.folder.refusal.resultBound",
} as const satisfies Readonly<Record<ConnectedFolderToolRefusal, WidgetMessageKey>>;

const STEP_LABELS = {
  list: "chat.processing.folderList",
  search: "chat.processing.folderSearch",
  read: "chat.processing.folderRead",
} as const satisfies Readonly<Record<ConnectedFolderToolView, WidgetMessageKey>>;

export interface ConnectedFolderToolLabels {
  readonly label: WidgetMessageKey;
  readonly details: WidgetMessageKey;
}
const TOOL_LABELS: ConnectedFolderToolLabels = {
  label: "chat.folder.tool",
  details: "chat.folder.details",
};

interface NamedExchange {
  readonly call: Pick<ChatToolExchange["call"], "name">;
  readonly result?: ChatToolExchange["result"];
}
type UnknownRecord = Readonly<Record<string, unknown>>;

function isCanonicalRef(ref: NonNullable<ChatToolExchange["result"]>["toolRef"]): boolean {
  return (
    ref !== null &&
    ref.canonicalId === CONNECTED_FOLDER_TOOL_ID &&
    ref.contractVersion === CONNECTED_FOLDER_TOOL_CONTRACT_VERSION
  );
}

/**
 * The alias names the folder tool while a call has no result yet, and for a result that names no
 * tool. A result that names another tool (an MCP tool that merely carries the alias) does not.
 */
export function isConnectedFolderToolCall(exchange: NamedExchange): boolean {
  if (exchange.call.name !== CONNECTED_FOLDER_TOOL_ALIAS) return false;
  const { result } = exchange;
  return result === undefined || result.toolRef === null || isCanonicalRef(result.toolRef);
}

/** Only the exact canonical id and contract version make a result readable as a folder look-up. */
export function isCanonicalConnectedFolderExchange(exchange: NamedExchange): boolean {
  const { result } = exchange;
  return (
    exchange.call.name === CONNECTED_FOLDER_TOOL_ALIAS &&
    result !== undefined &&
    isCanonicalRef(result.toolRef)
  );
}

/** The card labels of the folder tool, or undefined for any other call. */
export function connectedFolderToolLabels(
  exchange: NamedExchange,
): ConnectedFolderToolLabels | undefined {
  return isConnectedFolderToolCall(exchange) ? TOOL_LABELS : undefined;
}

function viewOf(value: unknown): ConnectedFolderToolView | undefined {
  return CONNECTED_FOLDER_TOOL_VIEWS.find((view) => view === value);
}

/** What one look-up does, in the progress list: list a folder, search the folder, read a file. */
export function connectedFolderStepLabel(
  exchange: Pick<ChatToolExchange, "call" | "result">,
): WidgetMessageKey | undefined {
  if (!isConnectedFolderToolCall(exchange)) return undefined;
  const view = viewOf(exchange.call.arguments.view);
  return view === undefined ? "chat.processing.folder" : STEP_LABELS[view];
}

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
const PATH_CHARS_MAX = 4096;
/** A path as the tool returns it: non-empty text of a bounded length. */
function pathText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" && value.length <= PATH_CHARS_MAX
    ? value
    : undefined;
}

/** A completed look-up of the canonical tool, with the view its own result names. */
interface FolderReceipt {
  readonly view: ConnectedFolderToolView;
  readonly data: UnknownRecord;
  readonly coverage: UnknownRecord;
  /** The result envelope itself says the result was cut. */
  readonly pageCut: boolean;
}
function folderReceipt(exchange: ChatToolExchange): FolderReceipt | undefined {
  const { result } = exchange;
  if (result?.status !== "completed" || !isCanonicalConnectedFolderExchange(exchange))
    return undefined;
  const data = record(result.data);
  const view = viewOf(data?.view);
  if (data?.outcome !== "succeeded" || view === undefined) return undefined;
  return { view, data, coverage: record(data.coverage) ?? {}, pageCut: result.page.truncated };
}

/** What a completed look-up left out, most important first; empty when nothing more exists. */
type Caveats = (receipt: FolderReceipt) => readonly WidgetMessageKey[];
const listCaveats: Caveats = ({ data, coverage, pageCut }) => [
  ...(pageCut || pathText(data.nextAfter) !== undefined
    ? (["chat.folder.more.list"] as const)
    : []),
  ...(coverage.coverageIncomplete === true ? (["chat.folder.more.listIncomplete"] as const) : []),
];
const searchCaveats: Caveats = ({ coverage, pageCut }) => [
  ...(pageCut || coverage.truncated === true ? (["chat.folder.more.search"] as const) : []),
  ...(isCount(coverage.unavailableHits) && coverage.unavailableHits > 0
    ? (["chat.folder.more.searchUnavailable"] as const)
    : []),
];
const readCaveats: Caveats = ({ data, coverage, pageCut }) =>
  pageCut || coverage.truncated === true || isCount(data.nextStartLine)
    ? ["chat.folder.more.read"]
    : [];
const CAVEATS: Readonly<Record<ConnectedFolderToolView, Caveats>> = {
  list: listCaveats,
  search: searchCaveats,
  read: readCaveats,
};

/** The sentence a completed look-up carries when more exists than it returned; else undefined. */
export function connectedFolderPartialNotice(
  exchange: ChatToolExchange,
): WidgetMessageKey | undefined {
  const receipt = folderReceipt(exchange);
  return receipt === undefined ? undefined : CAVEATS[receipt.view](receipt)[0];
}

function listItem(source: UnknownRecord): JiraOutcomeItem | undefined {
  const name = pathText(source.path);
  if (name === undefined) return undefined;
  return {
    name,
    labels: source.kind === "directory" ? ["chat.folder.outcome.subfolder"] : [],
    facts: [],
  };
}
function linesFact(source: UnknownRecord): JiraOutcomeFact[] {
  const { startLine: start, endLine: end } = source;
  if (!isCount(start) || !isCount(end) || start < 1 || end < start) return [];
  const value = start === end ? String(start) : `${String(start)}–${String(end)}`;
  return [{ label: "chat.folder.outcome.lines", value }];
}
/** A search hit or a read window: the file and the lines, never the text itself. */
function excerptItem(source: UnknownRecord): JiraOutcomeItem | undefined {
  const name = pathText(source.path);
  return name === undefined ? undefined : { name, labels: [], facts: linesFact(source) };
}

type SummaryFacts = (receipt: FolderReceipt, returned: number) => readonly JiraOutcomeFact[];
const listFacts: SummaryFacts = ({ data }, returned) => {
  const directory = pathText(data.directory);
  return [
    ...(directory === undefined
      ? []
      : [{ label: "chat.folder.outcome.directory" as const, value: directory }]),
    { label: "chat.folder.outcome.entries", value: String(returned) },
  ];
};
const searchFacts: SummaryFacts = ({ coverage }, returned) => [
  { label: "chat.folder.outcome.hits", value: String(returned) },
  ...(isCount(coverage.filesScanned)
    ? [
        {
          label: "chat.folder.outcome.filesSearched" as const,
          value: String(coverage.filesScanned),
        },
      ]
    : []),
];
const FACTS: Readonly<Record<ConnectedFolderToolView, SummaryFacts>> = {
  list: listFacts,
  search: searchFacts,
  // A read names its one file and its lines in the row itself.
  read: () => [],
};

const NO_OUTCOME: JiraToolOutcomeView = {
  items: [],
  returnedCount: undefined,
  total: undefined,
  unreadableCount: 0,
  stagedCount: undefined,
  unresolvedCount: undefined,
  problems: [],
  rules: [],
  templateNotices: [],
  validation: undefined,
  itemValidations: [],
  hiddenProblemCount: 0,
  overflow: "disclosure",
  unlistedItemCount: 0,
  failure: undefined,
};

function summaryView(receipt: FolderReceipt): JiraToolOutcomeView | undefined {
  const entries = receipt.data.items;
  if (!Array.isArray(entries) || entries.length > CONNECTED_FOLDER_TOOL_LIMITS.listEntries)
    return undefined;
  const project = receipt.view === "list" ? listItem : excerptItem;
  const items = entries.flatMap((entry: unknown): JiraOutcomeItem[] => {
    const source = record(entry);
    const item = source === undefined ? undefined : project(source);
    return item === undefined ? [] : [item];
  });
  if (entries.length > 0 && items.length === 0) return undefined;
  return {
    ...NO_OUTCOME,
    items,
    unreadableCount: entries.length - items.length,
    resultsLabel: "chat.folder.outcome.results",
    facts: FACTS[receipt.view](receipt, entries.length),
    // The first caveat is the card's partial notice; any further one follows the counts.
    labels: CAVEATS[receipt.view](receipt).slice(1),
  };
}

/** The sentence of a refusal the canonical tool reported with one of its closed reasons. */
function refusalMessage(exchange: ChatToolExchange): WidgetMessageKey | undefined {
  const { result } = exchange;
  if (
    result?.status !== "failed" ||
    result.reason !== "provider-reported-error" ||
    !isCanonicalConnectedFolderExchange(exchange)
  )
    return undefined;
  const data = record(result.data);
  if (data?.outcome !== "failed") return undefined;
  const reason = CONNECTED_FOLDER_TOOL_REFUSALS.find((candidate) => candidate === data.reason);
  return reason === undefined ? undefined : CONNECTED_FOLDER_REFUSAL_MESSAGES[reason];
}

/**
 * A look-up of the canonical tool as a person reads it: how many entries or matches, which lines
 * of which file, or the one sentence of a refusal. The result's own `nextStep` is an instruction to
 * the model and its text is file content; neither is shown. Anything else has no readable view.
 */
export function connectedFolderToolOutcomeView(
  exchange: ChatToolExchange,
): JiraToolOutcomeView | undefined {
  const refusal = refusalMessage(exchange);
  if (refusal !== undefined) return { ...NO_OUTCOME, failure: refusal };
  const receipt = folderReceipt(exchange);
  return receipt === undefined ? undefined : summaryView(receipt);
}
