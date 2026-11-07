import {
  descriptionWithFooter,
  parseRequirementIds,
  type JiraDraftStore,
  type JiraDraftPreparation,
} from "@oscharko-dev/keiko-connectors";
import { projectJiraDescriptionInput } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { deepFreeze } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import { chatDraftArguments } from "./jiraChatDraftArguments.js";
import { traceRefusalData, type ItemTrace, type TraceSession } from "../requirement-trace.js";
import { logRequirementTrace } from "../requirement-inventory-activity.js";

type SourceOperation = "jira.create" | "jira.edit" | "jira.draft";
export interface PreparedJiraRequirementItem {
  readonly ref: string;
  readonly item: CatalogJsonObject;
  readonly sourceDigest: string;
  readonly trace: ItemTrace;
}
type PreparedItem =
  | { readonly ok: true; readonly prepared?: PreparedJiraRequirementItem }
  | { readonly ok: false; readonly data: CatalogJsonObject };
export interface PreparedJiraSource {
  readonly operation: SourceOperation;
  readonly argumentsDigest: string;
  readonly sourceDigest: string;
  readonly items: readonly PreparedJiraRequirementItem[];
  readonly itemRefs: readonly string[];
}
interface SourceEntry {
  readonly argumentsDigest: string;
  readonly source?: PreparedJiraSource;
  readonly refusal?: CatalogJsonObject;
}
export interface JiraChatSourcePreparation {
  readonly prepareInvocation: (
    call: ChatToolExchange["call"],
    actionId: string,
  ) => Promise<{ readonly sourceDigest?: string } | undefined>;
  readonly sourceFor: (actionId: string, argumentsDigest: string) => PreparedJiraSource | undefined;
  readonly sourceDigestFor: (actionId: string, argumentsDigest: string) => string | undefined;
  readonly refusalFor: (actionId: string, argumentsDigest: string) => CatalogJsonObject | undefined;
  readonly current: (source: PreparedJiraSource, itemRef?: string) => boolean;
}
interface SourcePreparationOptions {
  readonly chatId: string;
  readonly draftStore: JiraDraftStore | undefined;
  readonly openTrace: () => TraceSession;
  readonly admitted: () => boolean;
  readonly correlationId?: string;
}

function object(value: unknown): CatalogJsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as CatalogJsonObject)
    : undefined;
}
function unavailable(): CatalogJsonObject {
  return { outcome: "rejected", reason: "field-validation", requirementRefusal: "unavailable" };
}
type SourceRefusal = "source-changed" | "unavailable";
function sourceRefusal(
  options: SourcePreparationOptions,
  operation: SourceOperation,
  reason: SourceRefusal,
  count: number,
): CatalogJsonObject {
  logRequirementTrace(options.correlationId, {
    operation: operation === "jira.draft" ? "draft" : operation === "jira.edit" ? "edit" : "create",
    tracedItemCount: count,
    refusedItemCount: count,
    referenceProblemCount: 0,
    acceptanceCriteriaMissingCount: 0,
    labelsAppliedCount: 0,
    footerAppliedCount: 0,
    droppedLabelCount: 0,
    unavailable: reason === "unavailable",
    sourceRefusal: reason,
    sourceChangedCount: reason === "source-changed" ? count : 0,
  });
  return { outcome: "rejected", reason: "field-validation", requirementRefusal: reason };
}
function projectedFields(
  fields: CatalogJsonObject,
  trace: ItemTrace,
): CatalogJsonObject | undefined {
  const description = fields.description;
  const projected =
    description === undefined ? undefined : projectJiraDescriptionInput(description);
  if (description !== undefined && projected === undefined) return undefined;
  const labels = fields.labels;
  if (
    labels !== undefined &&
    (!Array.isArray(labels) || !labels.every((label) => typeof label === "string"))
  )
    return undefined;
  return {
    ...fields,
    description: descriptionWithFooter(projected?.text, trace),
    labels: [...new Set([...((labels as readonly string[] | undefined) ?? []), ...trace.labels])],
  };
}

/** One canonical source-derived payload, before staging or a write's approval digest exists. */
export function prepareJiraRequirementItem(
  item: CatalogJsonObject,
  session: TraceSession | undefined,
  ref = "single",
  requireDescription = false,
): PreparedItem {
  const references = parseRequirementIds(item.requirementIds);
  if (references === null) return { ok: true };
  if (references === undefined || session === undefined) return { ok: false, data: unavailable() };
  const fields = object(item.fields) ?? {};
  const check = requirementDescriptionCheck(fields, requireDescription);
  const resolution = session.resolve(references, check);
  if (!resolution.ok)
    return { ok: false, data: { outcome: "rejected", ...traceRefusalData(resolution, ref) } };
  const normalized = projectedFields(fields, resolution.trace);
  if (normalized === undefined) return { ok: false, data: unavailable() };
  const prepared = { ...item, fields: normalized };
  const sourceDigest = sha256Hex(
    canonicalise({
      revisionDigest: resolution.sourceDigest,
      fields: normalized,
      trace: resolution.trace,
    }),
  );
  return { ok: true, prepared: { ref, item: prepared, sourceDigest, trace: resolution.trace } };
}
function requirementDescriptionCheck(
  fields: CatalogJsonObject,
  required: boolean,
): { readonly description: unknown } | undefined {
  return fields.description === undefined && !required
    ? undefined
    : { description: fields.description };
}

function sourceOperation(name: string): SourceOperation | undefined {
  return (["jira.create", "jira.edit", "jira.draft"] as const).find(
    (operation) => name === operation || name === operation.replaceAll(".", "_"),
  );
}
function itemList(
  operation: SourceOperation,
  args: CatalogJsonObject,
): readonly CatalogJsonObject[] {
  if (operation !== "jira.draft") return [args];
  if (!Array.isArray(args.items)) return [];
  const items: CatalogJsonObject[] = [];
  for (const raw of args.items) {
    const item = object(raw);
    if (item !== undefined) items.push(item);
  }
  return items;
}
function prepareItems(
  operation: SourceOperation,
  args: CatalogJsonObject,
  openTrace: () => TraceSession,
): {
  readonly items: readonly PreparedJiraRequirementItem[];
  readonly refusal?: CatalogJsonObject;
} {
  let session: TraceSession | undefined;
  const items: PreparedJiraRequirementItem[] = [];
  try {
    for (const item of itemList(operation, args)) {
      if (parseRequirementIds(item.requirementIds) !== null) session ??= openTrace();
      const ref = operation === "jira.draft" && typeof item.ref === "string" ? item.ref : "single";
      const result = prepareJiraRequirementItem(item, session, ref, operation === "jira.draft");
      if (!result.ok) return { items: [], refusal: result.data };
      if (result.prepared !== undefined) items.push(result.prepared);
    }
    return { items };
  } finally {
    session?.close();
  }
}
function bindingDigest(items: readonly PreparedJiraRequirementItem[]): string {
  return sha256Hex(canonicalise(items.map(({ ref, sourceDigest }) => ({ ref, sourceDigest }))));
}

export function prepareJiraDraftRequirements(
  items: readonly Readonly<Record<string, unknown>>[],
  openTrace: () => TraceSession,
): JiraDraftPreparation {
  const result = prepareItems(
    "jira.draft",
    { items: items as readonly CatalogJsonObject[] },
    openTrace,
  );
  if (result.refusal !== undefined) return { ok: false, data: result.refusal, violationCount: 1 };
  const preparedByRef = new Map(result.items.map((candidate) => [candidate.ref, candidate.item]));
  return {
    ok: true,
    items: items.map((item) => preparedByRef.get(String(item.ref)) ?? item),
    sourceBindings: result.items.map(({ ref, sourceDigest }) => ({ ref, sourceDigest })),
  };
}

function stagedSourceRefusal(
  options: SourcePreparationOptions,
  operation: SourceOperation,
  args: CatalogJsonObject,
  items: readonly PreparedJiraRequirementItem[],
): SourceRefusal | undefined {
  const staged =
    operation === "jira.draft" && typeof args.draftId === "string"
      ? options.draftStore?.peek(args.draftId, options.chatId)
      : undefined;
  if (staged === undefined) return undefined;
  const bindings = new Map(
    staged.sourceBindings?.map((binding) => [binding.ref, binding.sourceDigest]),
  );
  for (const item of items) {
    const digest = bindings.get(item.ref);
    if (digest === undefined) return "unavailable";
    if (digest !== item.sourceDigest) return "source-changed";
  }
  return undefined;
}
function preparedEntry(
  options: SourcePreparationOptions,
  operation: SourceOperation,
  args: CatalogJsonObject,
  argumentsDigest: string,
): SourceEntry {
  if (!options.admitted()) return { argumentsDigest, refusal: unavailable() };
  const draft =
    operation === "jira.draft"
      ? chatDraftArguments(options.draftStore, options.chatId, args)
      : { ok: true as const, arguments: args };
  if (!draft.ok) return { argumentsDigest, refusal: unavailable() };
  const result = prepareItems(operation, draft.arguments, options.openTrace);
  const refusal = stagedSourceRefusal(options, operation, args, result.items);
  if (refusal !== undefined) {
    return {
      argumentsDigest,
      refusal: sourceRefusal(options, operation, refusal, result.items.length),
    };
  }
  const source =
    result.items.length === 0
      ? undefined
      : {
          operation,
          argumentsDigest,
          sourceDigest: bindingDigest(result.items),
          items: result.items,
          itemRefs: itemList(operation, draft.arguments).map((item) =>
            operation === "jira.draft" && typeof item.ref === "string" ? item.ref : "single",
          ),
        };
  return deepFreeze(
    structuredClone({
      argumentsDigest,
      ...(result.refusal === undefined ? {} : { refusal: result.refusal }),
      ...(source === undefined ? {} : { source }),
    }),
  );
}
function sourceIsCurrent(
  options: SourcePreparationOptions,
  source: PreparedJiraSource,
  items: readonly PreparedJiraRequirementItem[],
): boolean {
  if (!options.admitted()) return false;
  const args =
    source.operation === "jira.draft"
      ? { items: items.map((item) => item.item) }
      : (items[0]?.item ?? {});
  const current = prepareItems(source.operation, args, options.openTrace);
  if (current.refusal === undefined && bindingDigest(current.items) === bindingDigest(items))
    return true;
  const reason =
    current.refusal?.requirementRefusal === "unavailable" ? "unavailable" : "source-changed";
  sourceRefusal(options, source.operation, reason, items.length);
  return false;
}

/** Owned by one existing Chat turn; no entry is replaced and no state survives that turn. */
function indexSource(
  source: PreparedJiraSource,
): ReadonlyMap<string, PreparedJiraRequirementItem | undefined> {
  const index = new Map<string, PreparedJiraRequirementItem | undefined>(
    source.itemRefs.map((ref) => [ref, undefined]),
  );
  for (const item of source.items) index.set(item.ref, item);
  return index;
}
function currentSource(
  options: SourcePreparationOptions,
  source: PreparedJiraSource,
  index: ReadonlyMap<string, PreparedJiraRequirementItem | undefined> | undefined,
  itemRef: string | undefined,
): boolean {
  if (index === undefined || !options.admitted()) return false;
  if (itemRef === undefined) return sourceIsCurrent(options, source, source.items);
  if (!index.has(itemRef)) return false;
  const item = index.get(itemRef);
  return item === undefined || sourceIsCurrent(options, source, [item]);
}

export function createJiraChatSourcePreparation(
  options: SourcePreparationOptions,
): JiraChatSourcePreparation {
  const prepared = new Map<string, SourceEntry>();
  const sourceItems = new WeakMap<
    PreparedJiraSource,
    ReadonlyMap<string, PreparedJiraRequirementItem | undefined>
  >();
  const sourceFor = (actionId: string, argumentsDigest: string): PreparedJiraSource | undefined => {
    const entry = prepared.get(actionId);
    return entry?.argumentsDigest === argumentsDigest ? entry.source : undefined;
  };
  const prepare = (call: ChatToolExchange["call"], actionId: string): SourceEntry | undefined => {
    const operation = sourceOperation(call.name);
    const args = object(call.arguments);
    if (operation === undefined || args === undefined) return undefined;
    const argumentsDigest = sha256Hex(canonicalise(args));
    const held = prepared.get(actionId);
    if (held !== undefined) return held.argumentsDigest === argumentsDigest ? held : undefined;
    const entry = preparedEntry(options, operation, args, argumentsDigest);
    prepared.set(actionId, entry);
    if (entry.source !== undefined) sourceItems.set(entry.source, indexSource(entry.source));
    return entry;
  };
  return {
    prepareInvocation: (
      call,
      actionId,
    ): Promise<{ readonly sourceDigest?: string } | undefined> => {
      const source = prepare(call, actionId)?.source;
      return Promise.resolve(
        source === undefined ? undefined : { sourceDigest: source.sourceDigest },
      );
    },
    sourceFor,
    sourceDigestFor: (actionId, digest) => sourceFor(actionId, digest)?.sourceDigest,
    refusalFor: (actionId, digest): CatalogJsonObject | undefined => {
      const entry = prepared.get(actionId);
      return entry?.argumentsDigest === digest ? entry.refusal : undefined;
    },
    current: (source, itemRef): boolean =>
      currentSource(options, source, sourceItems.get(source), itemRef),
  };
}
