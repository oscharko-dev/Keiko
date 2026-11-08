import { JIRA_DRAFT_RESULT_ROWS_MAX } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonValue } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { JIRA_DRAFT_UNLISTED_GUIDANCE, listIssueKeys } from "./jiraDraftKeyRanges.js";
import { jiraMutationToolId } from "./jiraMutationToolId.js";

// What the model reads of a `jira.draft` result (#4292). The stored result keeps a row per item for
// the person's view; the model only reports the outcome, so a long draft reaches it as the counts,
// the exact key ranges and the rows that need attention. Sending every row of 370 created issues
// cost about 26,000 prompt tokens and almost four minutes of prefill for a two-sentence answer.
// Rows that share their state and every detail but the reference (370 issues Jira refused for one
// expired license, say) reach the model as one group with its count and the first references.

const DRAFT_TOOL_ID = jiraMutationToolId("jira.draft");
/** Up to this many rows the model reads the result item by item, as stored. */
export const JIRA_DRAFT_MODEL_ROWS_MAX = 10;
/** The byte budget of the model's key lists; the stored result's own bound is far larger. */
const MODEL_KEY_LIST_BYTES = 8 * 1024;
/** How many references a group of identical rows names; its count says how many there are. */
export const JIRA_DRAFT_MODEL_GROUP_REFS_MAX = 10;

type JsonRecord = Readonly<Record<string, unknown>>;

function record(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

/** A created or found row whose key the ranges carry; every other row needs the model's words. */
function settledKey(row: unknown, state: "created" | "existing"): string | undefined {
  const item = record(row);
  return item?.state === state && typeof item.issueKey === "string" ? item.issueKey : undefined;
}

function needsAttention(row: unknown): boolean {
  if (settledKey(row, "created") !== undefined || settledKey(row, "existing") !== undefined)
    return false;
  return record(row)?.state !== "excluded";
}

function keysOf(rows: readonly unknown[], state: "created" | "existing"): string[] {
  return rows.flatMap((row) => {
    const key = settledKey(row, state);
    return key === undefined ? [] : [key];
  });
}

/** The producer's own guidance stays first; unlisted keys add theirs, so no key is ever guessed. */
function joinedGuidance(own: unknown, unlisted: boolean): string | undefined {
  const parts = [
    typeof own === "string" ? own : undefined,
    unlisted ? JIRA_DRAFT_UNLISTED_GUIDANCE : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(" ");
}

/** A row without its reference: rows alike in this read the same to the model. */
function groupKey(row: unknown): string | undefined {
  const item = record(row);
  if (item === undefined || typeof item.ref !== "string") return undefined;
  const { ref: _ref, ...rest } = item;
  return JSON.stringify(rest);
}

/** Two or more rows alike but for their reference, as one entry with their count. */
function groupedRow(rows: readonly JsonRecord[]): JsonRecord {
  const { ref: _ref, ...rest } = rows[0] ?? {};
  const refs = rows.slice(0, JIRA_DRAFT_MODEL_GROUP_REFS_MAX).map((row) => row.ref);
  const more = rows.length - refs.length;
  return { ...rest, itemCount: rows.length, refs, ...(more === 0 ? {} : { moreRefCount: more }) };
}

/** Rows alike but for their reference become one entry, in the order they first appear. */
function groupRows(rows: readonly unknown[]): unknown[] {
  const slots: unknown[][] = [];
  const byKey = new Map<string, unknown[]>();
  for (const row of rows) {
    const key = groupKey(row);
    const slot = key === undefined ? undefined : byKey.get(key);
    if (slot !== undefined) {
      slot.push(row);
      continue;
    }
    const fresh = [row];
    slots.push(fresh);
    if (key !== undefined) byKey.set(key, fresh);
  }
  // Only records carry a key, so every slot of two or more rows holds records.
  return slots.map((slot) => (slot.length === 1 ? slot[0] : groupedRow(slot as JsonRecord[])));
}

function compactRows(
  body: JsonRecord,
  rows: readonly unknown[],
): JsonRecord & { readonly items: unknown[] } {
  const listed = listIssueKeys(
    { created: keysOf(rows, "created"), existing: keysOf(rows, "existing") },
    MODEL_KEY_LIST_BYTES,
    JIRA_DRAFT_RESULT_ROWS_MAX,
  );
  const guidance = joinedGuidance(body.guidance, listed.unlisted > 0);
  return {
    ...body,
    ...(guidance === undefined ? {} : { guidance }),
    items: groupRows(rows.filter(needsAttention)),
    compact: true,
    createdRanges: listed.created.map((entry) => entry.text),
    existingRanges: listed.existing.map((entry) => entry.text),
    ...(listed.unlisted === 0 ? {} : { rangesTruncated: true, unlistedKeyCount: listed.unlisted }),
  };
}

/**
 * The model's view of a draft body, or none when it reads the body as stored: a short row-by-row
 * body stays, a long one becomes compact, and an already compact body only has its alike rows
 * grouped.
 */
function modelView(
  data: unknown,
): { readonly rowCount: number; readonly view: JsonRecord & { items: unknown[] } } | undefined {
  const body = record(data);
  const rows: unknown = body?.items;
  if (body === undefined || !Array.isArray(rows)) return undefined;
  if (body.compact === true) {
    const items = groupRows(rows);
    return items.length < rows.length
      ? { rowCount: rows.length, view: { ...body, items } }
      : undefined;
  }
  if (rows.length <= JIRA_DRAFT_MODEL_ROWS_MAX) return undefined;
  return { rowCount: rows.length, view: compactRows(body, rows) };
}

/**
 * A draft's rows as the model reads them: as stored up to {@link JIRA_DRAFT_MODEL_ROWS_MAX} rows,
 * otherwise compact; rows alike but for their reference are grouped. Anything not shaped as rows
 * stays as it is.
 */
export function jiraDraftRowsForModel<T>(data: T): T | JsonRecord {
  return modelView(data)?.view ?? data;
}

/** How many rows a `jira.draft` result stores and how many entries the model reads; none if equal. */
export function jiraDraftCondensedRows(
  canonicalId: string | undefined,
  data: unknown,
): { readonly rowCount: number; readonly keptRowCount: number } | undefined {
  const condensed = canonicalId === DRAFT_TOOL_ID ? modelView(data) : undefined;
  return condensed === undefined
    ? undefined
    : { rowCount: condensed.rowCount, keptRowCount: condensed.view.items.length };
}

/** The data the model reads of one tool result: only a `jira.draft` result can change. */
export function jiraDraftModelData(
  canonicalId: string | undefined,
  data: CatalogJsonValue,
): CatalogJsonValue {
  if (canonicalId !== DRAFT_TOOL_ID) return data;
  // The compact view is built from the result's own JSON values, strings, numbers and booleans.
  return jiraDraftRowsForModel(data) as CatalogJsonValue;
}
