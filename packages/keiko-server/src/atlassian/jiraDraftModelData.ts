import { JIRA_DRAFT_RESULT_ROWS_MAX } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonValue } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { JIRA_DRAFT_UNLISTED_GUIDANCE, listIssueKeys } from "./jiraDraftKeyRanges.js";
import { jiraMutationToolId } from "./jiraMutationToolId.js";

// What the model reads of a `jira.draft` result (#4292). The stored result keeps a row per item for
// the person's view; the model only reports the outcome, so a long draft reaches it as the counts,
// the exact key ranges and the rows that need attention. Sending every row of 370 created issues
// cost about 26,000 prompt tokens and almost four minutes of prefill for a two-sentence answer.

const DRAFT_TOOL_ID = jiraMutationToolId("jira.draft");
/** Up to this many rows the model reads the result item by item, as stored. */
export const JIRA_DRAFT_MODEL_ROWS_MAX = 10;
/** The byte budget of the model's key lists; the stored result's own bound is far larger. */
const MODEL_KEY_LIST_BYTES = 8 * 1024;

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

function compactRows(body: JsonRecord, rows: readonly unknown[]): JsonRecord {
  const listed = listIssueKeys(
    { created: keysOf(rows, "created"), existing: keysOf(rows, "existing") },
    MODEL_KEY_LIST_BYTES,
    JIRA_DRAFT_RESULT_ROWS_MAX,
  );
  const guidance = joinedGuidance(body.guidance, listed.unlisted > 0);
  return {
    ...body,
    ...(guidance === undefined ? {} : { guidance }),
    items: rows.filter(needsAttention),
    compact: true,
    createdRanges: listed.created.map((entry) => entry.text),
    existingRanges: listed.existing.map((entry) => entry.text),
    ...(listed.unlisted === 0 ? {} : { rangesTruncated: true, unlistedKeyCount: listed.unlisted }),
  };
}

/** A stored row-by-row draft body with more rows than the model reads one by one. */
function longRows(
  data: unknown,
): { readonly body: JsonRecord; readonly rows: readonly unknown[] } | undefined {
  const body = record(data);
  const rows: unknown = body?.items;
  if (body === undefined || body.compact === true || !Array.isArray(rows)) return undefined;
  return rows.length > JIRA_DRAFT_MODEL_ROWS_MAX ? { body, rows } : undefined;
}

/**
 * A draft's rows as the model reads them: as stored up to {@link JIRA_DRAFT_MODEL_ROWS_MAX} rows,
 * otherwise compact. An already compact body and anything not shaped as rows stay as they are.
 */
export function jiraDraftRowsForModel<T>(data: T): T | JsonRecord {
  const long = longRows(data);
  return long === undefined ? data : compactRows(long.body, long.rows);
}

/** How many stored rows a `jira.draft` result has and how many the model reads; none if unchanged. */
export function jiraDraftCondensedRows(
  canonicalId: string | undefined,
  data: unknown,
): { readonly rowCount: number; readonly keptRowCount: number } | undefined {
  const long = canonicalId === DRAFT_TOOL_ID ? longRows(data) : undefined;
  return long === undefined
    ? undefined
    : { rowCount: long.rows.length, keptRowCount: long.rows.filter(needsAttention).length };
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
