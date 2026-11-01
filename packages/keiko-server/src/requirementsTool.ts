// The `knowledge.requirements` read tool (#4179, Epic #4173).
//
// The model, not a keyword rule, decides when it needs a complete list of the requirements in the
// Knowledge Pods attached to its Chat. The tool pages the units a deterministic detector found, in
// document order, under byte and item bounds that fit a 32k-token model, and states honestly what
// it could not read: the totals of what was detected, the documents that were not text-extracted,
// the bounds that cut, and a cursor until the last page. It is hosted by the existing governed Chat
// tool catalog like the Jira reads; it adds no tool system of its own.

import type { JiraReportStore } from "@oscharko-dev/keiko-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ManagedMcpInvocationContext,
  ManagedMcpProvider,
  ManagedMcpTool,
  ManagedMcpToolDeclaration,
  ManagedMcpToolResult,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { type KnowledgeStore } from "@oscharko-dev/keiko-local-knowledge";
import {
  requirementChangeQueries,
  requirementReference,
  shortRequirementDigest,
} from "@oscharko-dev/keiko-quality-intelligence";
import { createToolDescriptor, createToolRef } from "@oscharko-dev/keiko-tool-catalog";

import { object, text } from "./atlassian/jiraManagedSchemas.js";
import { KNOWLEDGE_REQUIREMENTS_TOOL } from "./requirementsToolName.js";
import type { UiHandlerDeps } from "./deps.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "./diagnostics-log.js";
import { correlationIdOrUnknown } from "./correlation.js";
import { openKnowledgeStoreForDeps } from "./local-knowledge-store-open.js";
import {
  changesView,
  resolveChangesBaseline,
  type ChangesBaselineSource,
  type ChangesCounts,
} from "./requirement-changes.js";
import {
  chatKnowledgeScopes,
  collectForTurn,
  contentRedact,
  decodeCursor,
  documentsFingerprint,
  encodeCursor,
  fitWindow,
  pageLabelOf,
  selectUnits,
  selectionFingerprint,
  type LocatedRequirementUnit,
  type RequirementCollection,
  type RequirementFilter,
} from "./requirement-inventory.js";
import {
  logRequirementRead,
  type RequirementChangesActivity,
  type RequirementReadActivity,
  type RequirementReadDisposition,
  type RequirementReadView,
} from "./requirement-inventory-activity.js";

/** One page stays well inside a 32k-token window: about 6-8k tokens at most. */
export const REQUIREMENTS_PAGE_BYTES_MAX = 24_000;
export const REQUIREMENTS_PAGE_LIMIT_DEFAULT = 25;
export const REQUIREMENTS_PAGE_LIMIT_MAX = 50;
/** The tool result, as the descriptor bounds it: one page plus the totals and the envelope. */
export const REQUIREMENTS_RESULT_BYTES_MAX = REQUIREMENTS_PAGE_BYTES_MAX + 8192;
/** Room kept for the catalog envelope around the tool data, and per item for its page label. */
const ENVELOPE_BYTES_RESERVE = 2048;
const PAGE_LABEL_BYTES_RESERVE = 300;
/** One rendered unit stays within this many UTF-8 bytes, whatever its script. */
export const REQUIREMENT_UNIT_BYTES_MAX = 12_000;
const STATEMENT_CHARS_MAX = 1500;
const CRITERION_CHARS_MAX = 600;
const CRITERIA_MAX = 20;
const LISTED_IDS_MAX = 50;
const UNIT_SCALES: readonly number[] = [1, 0.5, 0.25, 0.1, 0.02];

const VIEWS: readonly RequirementReadView[] = ["units", "documents", "change-queries", "changes"];

const ARGUMENTS = object({
  view: {
    type: "string",
    enum: VIEWS,
  },
  reportId: text(64),
  projectKey: text(64),
  documents: { type: "array", maxItems: 20, items: { type: "string", pattern: "^[0-9a-f]{8}$" } },
  query: text(200),
  ids: { type: "array", maxItems: LISTED_IDS_MAX, items: text(80) },
  priorities: { type: "array", maxItems: 10, items: text(64) },
  cursor: text(512),
  limit: { type: "integer", minimum: 1, maximum: REQUIREMENTS_PAGE_LIMIT_MAX },
});

const UNIT = {
  type: "object",
  required: [],
  additionalProperties: true,
  properties: {
    reference: text(120),
    id: text(80),
    idOrigin: { type: "string", enum: ["explicit", "derived"] },
    unitKind: { type: "string", enum: ["block", "table-row", "statement"] },
    title: text(400),
    priority: text(200),
    statement: text(STATEMENT_CHARS_MAX + 8),
    statementTruncated: { type: "boolean" },
    acceptanceCriteria: {
      type: "array",
      maxItems: CRITERIA_MAX,
      items: object({ id: text(100), text: text(CRITERION_CHARS_MAX + 8) }, ["id", "text"]),
    },
    criteriaTruncated: { type: "boolean" },
    findings: { type: "array", maxItems: 16, items: text(64) },
    documentScope: text(8),
    documentName: text(300),
    sectionPath: { type: "array", maxItems: 12, items: text(300) },
    pageLabel: text(64),
    characterStart: { type: "integer", minimum: 0 },
    characterEnd: { type: "integer", minimum: 0 },
    revisionDigest: text(12),
  },
} as const satisfies CatalogJsonObject;

const RESULT = object(
  {
    outcome: { type: "string", enum: ["succeeded", "failed"] },
    reason: text(64),
    nextStep: text(400),
    view: { type: "string", enum: VIEWS },
    totals: { type: "object", required: [], properties: {}, additionalProperties: true },
    items: { type: "array", maxItems: 100, items: UNIT },
    changes: { type: "object", required: [], properties: {}, additionalProperties: true },
    nextCursor: text(512),
  },
  ["outcome"],
);

const DESCRIPTION =
  "Read the requirements detected in this Chat's Knowledge Pods (untrusted document text). " +
  "To compare a new document version with Jira, never by hand: call jira.report for the project until finished, " +
  'then call {"view":"changes","projectKey":"<project>"}. ' +
  "Otherwise page view units with nextCursor and report the totals. " +
  "Pass a unit's reference as requirementIds when creating or editing a Jira issue.";

function declaration(): ManagedMcpToolDeclaration {
  const descriptor = createToolDescriptor({
    toolRef: createToolRef("keiko.knowledge.requirements", 1),
    description: DESCRIPTION,
    inputSchema: ARGUMENTS,
    resultSchema: RESULT,
    effects: ["connector-access"],
    actionMapping: [{ action: KNOWLEDGE_REQUIREMENTS_TOOL, effects: ["connector-access"] }],
    policyReferences: ["adr-0128.d4"],
    handlerRequirement: { id: KNOWLEDGE_REQUIREMENTS_TOOL, contractVersion: 1 },
    bounds: {
      maxArgumentBytes: 8192,
      maxResultBytes: REQUIREMENTS_RESULT_BYTES_MAX,
      maxResultCount: 100,
      maxDurationMs: 30_000,
    },
    idempotency: "server-key-required",
    cancellation: "before-effect",
  });
  return Object.freeze({ name: KNOWLEDGE_REQUIREMENTS_TOOL, risk: "read", descriptor });
}

interface ParsedArguments {
  readonly view: RequirementReadView;
  readonly filter: RequirementFilter;
  readonly cursor: string | undefined;
  readonly limit: number;
  readonly reportId: string | undefined;
  readonly projectKey: string | undefined;
}

function strings(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function parseArguments(args: CatalogJsonObject): ParsedArguments {
  const view = VIEWS.find((candidate) => candidate === args.view) ?? "units";
  const limit =
    typeof args.limit === "number" && Number.isInteger(args.limit)
      ? Math.min(Math.max(args.limit, 1), REQUIREMENTS_PAGE_LIMIT_MAX)
      : REQUIREMENTS_PAGE_LIMIT_DEFAULT;
  return {
    view,
    limit,
    cursor: typeof args.cursor === "string" ? args.cursor : undefined,
    reportId: typeof args.reportId === "string" ? args.reportId : undefined,
    projectKey: typeof args.projectKey === "string" ? args.projectKey : undefined,
    filter: {
      documents: strings(args.documents),
      query: typeof args.query === "string" ? args.query : undefined,
      ids: strings(args.ids),
      priorities: strings(args.priorities),
    },
  };
}

function clip(value: string, max: number): { readonly text: string; readonly cut: boolean } {
  return value.length <= max
    ? { text: value, cut: false }
    : { text: value.slice(0, max), cut: true };
}

interface UnitCaps {
  readonly statement: number;
  readonly criterion: number;
  readonly criteria: number;
  readonly title: number;
  readonly part: number;
  readonly path: number;
}

function capsAt(scale: number): UnitCaps {
  const scaled = (max: number): number => Math.max(1, Math.floor(max * scale));
  return {
    statement: scaled(STATEMENT_CHARS_MAX),
    criterion: scaled(CRITERION_CHARS_MAX),
    criteria: scaled(CRITERIA_MAX),
    title: scaled(400),
    part: scaled(300),
    path: scaled(12),
  };
}

function renderUnitAt(
  unit: LocatedRequirementUnit,
  pageLabel: string | undefined,
  redact: (value: string) => string,
  caps: UnitCaps,
): CatalogJsonObject {
  const { entry, source } = unit;
  const statement = clip(redact(entry.statement), caps.statement);
  const criteria = entry.acceptanceCriteria.slice(0, caps.criteria).map((criterion) => ({
    id: criterion.id,
    text: clip(redact(criterion.text), caps.criterion).text,
  }));
  const criteriaCut =
    entry.acceptanceCriteria.length > caps.criteria ||
    entry.acceptanceCriteria.some((criterion) => criterion.text.length > caps.criterion);
  return {
    reference: requirementReference(entry),
    id: entry.id,
    idOrigin: entry.idOrigin,
    unitKind: entry.unitKind,
    title: redact(entry.title).slice(0, caps.title),
    ...(entry.priority === undefined ? {} : { priority: entry.priority.slice(0, 200) }),
    statement: statement.text,
    ...(statement.cut ? { statementTruncated: true } : {}),
    acceptanceCriteria: criteria,
    ...(criteriaCut ? { criteriaTruncated: true } : {}),
    findings: [...unit.findings],
    documentScope: entry.documentScope,
    documentName: redact(source.documentName).slice(0, caps.part),
    sectionPath: entry.sectionPath
      .slice(0, caps.path)
      .map((part) => redact(part).slice(0, caps.part)),
    ...(pageLabel === undefined ? {} : { pageLabel: pageLabel.slice(0, 64) }),
    characterStart: entry.characterStart,
    characterEnd: entry.characterEnd,
    revisionDigest: shortRequirementDigest(entry.digest),
  };
}

/**
 * A unit within {@link REQUIREMENT_UNIT_BYTES_MAX} UTF-8 bytes: the character caps shrink together
 * until it fits, and what was cut is flagged (`statementTruncated`, `criteriaTruncated`), so one
 * oversized requirement can never make a result exceed its descriptor bound.
 */
function renderUnit(
  unit: LocatedRequirementUnit,
  pageLabel: string | undefined,
  redact: (value: string) => string,
): CatalogJsonObject {
  const fitting = UNIT_SCALES.map((scale) => capsAt(scale)).find(
    (caps) => byteSize(renderUnitAt(unit, pageLabel, redact, caps)) <= REQUIREMENT_UNIT_BYTES_MAX,
  );
  return renderUnitAt(unit, pageLabel, redact, fitting ?? capsAt(UNIT_SCALES.at(-1) ?? 0.02));
}

function totalsOf(collection: RequirementCollection, matchedCount: number): CatalogJsonObject {
  return {
    detectedCount: collection.units.length + collection.unitsOmitted,
    matchedCount,
    documentsScanned: collection.documentsScanned,
    documentsNotExtracted: collection.documentsNotExtracted,
    documentsOmitted: collection.documentsOmitted,
    unitsOmitted: collection.unitsOmitted,
    cutReasons: [...collection.cutReasons],
    refusals: [...collection.refusals],
    conflictingIds: collection.conflictingIds.slice(0, LISTED_IDS_MAX),
    ambiguousIds: collection.ambiguousIds.slice(0, LISTED_IDS_MAX),
    referenceOnlyCount: collection.referenceOnlyCount,
    rejectedCandidateCount: collection.rejectedCandidateCount,
  };
}

interface ViewItems {
  readonly items: readonly CatalogJsonObject[];
  readonly fingerprint: string;
  /** The selected units behind `items`, for the units view only. */
  readonly units: readonly LocatedRequirementUnit[];
}

function buildView(
  collection: RequirementCollection,
  parsed: ParsedArguments,
  redact: (value: string) => string,
): ViewItems {
  const selected = selectUnits(collection.units, parsed.filter);
  if (parsed.view === "documents")
    return {
      items: collection.documents.map((document): CatalogJsonObject => ({
        documentScope: document.documentScope,
        documentName: redact(document.name).slice(0, 300),
        documentDigest: document.digest.slice(0, 12),
        unitCount: document.unitCount,
      })),
      fingerprint: documentsFingerprint(collection.documents),
      units: [],
    };
  const fingerprint = selectionFingerprint(selected, parsed.view);
  if (parsed.view === "change-queries")
    return {
      items: requirementChangeQueries(selected.map((unit) => unit.entry)).map(
        (query): CatalogJsonObject => ({ ...query, requirementIds: [...query.requirementIds] }),
      ),
      fingerprint,
      units: [],
    };
  return {
    items: selected.map((unit) => renderUnit(unit, undefined, redact)),
    fingerprint,
    units: selected,
  };
}

function byteSize(value: CatalogJsonObject): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/**
 * The bytes the items of one page may take so the whole result - totals, view label, cursor and
 * the catalog envelope - stays within the descriptor's bound.
 */
function itemsBudget(totals: CatalogJsonObject, view: RequirementReadView): number {
  const shell = byteSize({
    outcome: "succeeded",
    view,
    totals,
    items: [],
    nextCursor: "0".repeat(512),
  });
  return Math.min(
    REQUIREMENTS_PAGE_BYTES_MAX,
    REQUIREMENTS_RESULT_BYTES_MAX - ENVELOPE_BYTES_RESERVE - shell,
  );
}

interface Served {
  readonly data: CatalogJsonObject;
  readonly activity: Omit<RequirementReadActivity, "view" | "cursorUsed">;
}

const NO_COLLECTION: Pick<
  RequirementCollection,
  "documentsScanned" | "documentsNotExtracted" | "documentsOmitted" | "unitsOmitted"
> & { readonly units: readonly never[] } = {
  units: [],
  documentsScanned: 0,
  documentsNotExtracted: 0,
  documentsOmitted: 0,
  unitsOmitted: 0,
};

function activityOf(
  collection: RequirementCollection | undefined,
  disposition: RequirementReadDisposition,
  counts: { matched: number; returned: number; bytes: number; next: boolean },
): Served["activity"] {
  const read = collection ?? NO_COLLECTION;
  return {
    disposition,
    detectedCount: read.units.length + read.unitsOmitted,
    matchedCount: counts.matched,
    returnedCount: counts.returned,
    documentsScanned: read.documentsScanned,
    documentsNotExtracted: read.documentsNotExtracted,
    documentsOmitted: read.documentsOmitted,
    unitsOmitted: read.unitsOmitted,
    resultBytes: counts.bytes,
    hasNextPage: counts.next,
  };
}

function failure(reason: string, collection?: RequirementCollection, nextStep?: string): Served {
  const disposition = reason === "cursor-stale" ? "cursor-stale" : "refused";
  return {
    data: { outcome: "failed", reason, ...(nextStep === undefined ? {} : { nextStep }) },
    activity: activityOf(collection, disposition, {
      matched: 0,
      returned: 0,
      bytes: 0,
      next: false,
    }),
  };
}

function serveChanges(
  collection: RequirementCollection,
  parsed: ParsedArguments,
  environment: ServeEnvironment,
): Served {
  const { context, reports, redact, turnStartedAtMs } = environment;
  const baseline = resolveChangesBaseline(reports, context.chatId, {
    reportId: parsed.reportId,
    projectKey: parsed.projectKey,
    turnStartedAtMs: turnStartedAtMs(),
  });
  if (!baseline.ok) {
    const served = failure(baseline.reason, collection, baseline.nextStep);
    return { ...served, activity: { ...served.activity, changes: { refusal: baseline.reason } } };
  }
  const shell: CatalogJsonObject = {
    outcome: "succeeded",
    view: "changes",
    totals: totalsOf(collection, 0),
  };
  const view = changesView(
    collection,
    baseline.report,
    redact,
    REQUIREMENTS_RESULT_BYTES_MAX - ENVELOPE_BYTES_RESERVE - byteSize(shell),
  );
  const matched = view.counts.changed + view.counts.removed + view.counts.untraced;
  const data: CatalogJsonObject = {
    ...shell,
    totals: totalsOf(collection, matched),
    changes: view.data,
  };
  const activity = activityOf(collection, "served", {
    matched,
    returned: matched,
    bytes: byteSize(data),
    next: false,
  });
  return {
    data,
    activity: { ...activity, changes: changesActivity(view.counts, baseline.source) },
  };
}

function changesActivity(
  counts: ChangesCounts,
  baselineSource: ChangesBaselineSource,
): RequirementChangesActivity {
  return {
    baselineSource,
    changedCount: counts.changed,
    removedCount: counts.removed,
    untracedCount: counts.untraced,
    unchangedCount: counts.unchanged,
    affectedIssueCount: counts.affectedIssues,
    baselineIssueCount: counts.baselineIssues,
    baselineComplete: counts.baselineComplete,
  };
}

function serve(
  store: KnowledgeStore,
  collection: RequirementCollection,
  parsed: ParsedArguments,
  redact: (value: string) => string,
): Served {
  const view = buildView(collection, parsed, redact);
  const cursor = parsed.cursor === undefined ? undefined : decodeCursor(parsed.cursor);
  if (parsed.cursor !== undefined && cursor?.fingerprint !== view.fingerprint)
    return failure("cursor-stale", collection);
  const labelReserve = view.units.length > 0 ? PAGE_LABEL_BYTES_RESERVE : 0;
  const window = fitWindow(
    view.items.map((item) => byteSize(item) + labelReserve),
    cursor?.offset ?? 0,
    parsed.limit,
    itemsBudget(totalsOf(collection, view.items.length), parsed.view),
  );
  // Page labels are read only for the units of the window this call returns.
  const page = view.items.slice(window.from, window.to).map((item, index) => {
    const unit = view.units[window.from + index];
    return unit === undefined ? item : renderUnit(unit, pageLabelOf(store, unit), redact);
  });
  const next = window.to < view.items.length;
  const data: CatalogJsonObject = {
    outcome: "succeeded",
    view: parsed.view,
    totals: totalsOf(collection, view.items.length),
    items: page,
    ...(next
      ? { nextCursor: encodeCursor({ offset: window.to, fingerprint: view.fingerprint }) }
      : {}),
  };
  return {
    data,
    activity: activityOf(collection, "served", {
      matched: view.items.length,
      returned: page.length,
      bytes: byteSize(data),
      next,
    }),
  };
}

export interface RequirementsToolContext extends ManagedMcpInvocationContext {
  readonly chatId: string;
  readonly userMessageId?: string | undefined;
}

function log(context: RequirementsToolContext, parsed: ParsedArguments, served: Served): void {
  logRequirementRead(context.correlationId, {
    view: parsed.view,
    cursorUsed: parsed.cursor !== undefined,
    ...served.activity,
  });
}

function unavailable(
  deps: UiHandlerDeps,
  context: RequirementsToolContext,
  error: unknown,
): ManagedMcpToolResult {
  emitServerDiagnostic(
    deps.diagnostics,
    serverDiagnosticFromError({
      correlationId: correlationIdOrUnknown(context.correlationId),
      operation: "knowledge.requirements-read",
      source: "requirements-tool",
      error,
      redact: () => "server-operation-failed",
    }),
  );
  return { data: { outcome: "failed", reason: "unavailable" }, isError: true };
}

interface ServeEnvironment {
  readonly context: RequirementsToolContext;
  readonly reports: JiraReportStore | undefined;
  readonly redact: (value: string) => string;
  /** When the user message of this turn was stored; absent when the turn is unknown. */
  readonly turnStartedAtMs: () => number | undefined;
}

function serveView(
  store: KnowledgeStore,
  collection: RequirementCollection,
  parsed: ParsedArguments,
  environment: ServeEnvironment,
): Served {
  if (collection.units.length === 0 && collection.refusals.length > 0)
    return failure(collection.refusals[0] ?? "scope-unavailable", collection);
  return parsed.view === "changes"
    ? serveChanges(collection, parsed, environment)
    : serve(store, collection, parsed, environment.redact);
}

function execute(
  deps: UiHandlerDeps,
  args: CatalogJsonObject,
  context: RequirementsToolContext,
  reports: JiraReportStore | undefined,
): ManagedMcpToolResult {
  const parsed = parseArguments(args);
  const scopes = chatKnowledgeScopes(deps.store.findChatById(context.chatId));
  if (scopes.length === 0) {
    const served = failure("no-knowledge-pod");
    log(context, parsed, served);
    return { data: served.data, isError: true };
  }
  if (!context.beforeEffect())
    return { data: { outcome: "failed", reason: "denied" }, isError: true };
  let session: ReturnType<typeof openKnowledgeStoreForDeps> | undefined;
  try {
    session = openKnowledgeStoreForDeps(deps, { recover: false });
    const store = session.store;
    const collection = collectForTurn(store, scopes, context.chatId, context.userMessageId);
    const redact = contentRedact(deps);
    const served = serveView(store, collection, parsed, {
      context,
      reports,
      redact,
      turnStartedAtMs: () =>
        context.userMessageId === undefined
          ? undefined
          : deps.store.findMessageById(context.userMessageId)?.timestamp,
    });
    log(context, parsed, served);
    return { data: served.data, ...(served.data.outcome === "failed" ? { isError: true } : {}) };
  } catch (error) {
    logRequirementRead(context.correlationId, {
      view: parsed.view,
      cursorUsed: parsed.cursor !== undefined,
      ...failure("unavailable").activity,
      disposition: "unavailable",
    });
    return unavailable(deps, context, error);
  } finally {
    session?.close();
  }
}

/** The provider the existing Chat tool catalog hosts beside the Jira provider. */
export function createKnowledgeRequirementsProvider<Context extends RequirementsToolContext>(
  deps: UiHandlerDeps,
  reports?: JiraReportStore,
): ManagedMcpProvider<Context> {
  const tool: ManagedMcpTool<Context> = Object.freeze({
    ...declaration(),
    execute: (args: CatalogJsonObject, context: Context): Promise<ManagedMcpToolResult> =>
      Promise.resolve(execute(deps, args, context, reports ?? deps.jiraReportStore)),
  });
  return Object.freeze({
    id: "knowledge",
    tools: (): readonly ManagedMcpTool<Context>[] => [tool],
  });
}
