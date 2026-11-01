// The change set of a new document version against the backlog (#4179, Epic #4173).
//
// No earlier inventory is kept anywhere. What the backlog holds is the trace the write path put
// on every derived item: a label per document scope, per requirement and per content revision.
// Comparing those labels with the current inventory is exact for what the backlog traces:
//   changed   a traced requirement whose current revision label is missing on an item,
//   removed   a traced requirement its document no longer states,
//   unchanged a traced requirement every item still carries the current revision of,
//   untraced  a requirement of the document that no item of the compared scope traces (new, or not
//             derived yet: the labels cannot tell these apart).
// A traced requirement the current inventory does not show is removed only when that document's
// inventory is complete; a bounded inventory has not proved a deletion, so it is reported apart as
// `unverifiedRemoved`. An item of a document that is not among the current ones proves nothing
// about its requirements and is only counted. The comparison is pure; reading the items is the
// caller's job.

import {
  compareIssueKeys,
  compareStrings,
} from "@oscharko-dev/keiko-contracts/runtime/comparators";

import type { RequirementInventoryEntry } from "./requirementInventory.js";
import {
  REQUIREMENT_DOCUMENT_LABEL_PREFIX,
  REQUIREMENT_LABEL_PREFIX,
  revisionLabel,
} from "./requirementTrace.js";

export type RequirementChangeStatus = "changed" | "removed" | "untraced";

/** An item of the backlog with the labels it carries. */
export interface RequirementTracedIssue {
  readonly key: string;
  readonly labels: readonly string[];
}

export type ComparableRequirement = Pick<
  RequirementInventoryEntry,
  "id" | "digest" | "documentScope"
>;

export interface RequirementChange<Entry extends ComparableRequirement = ComparableRequirement> {
  readonly status: RequirementChangeStatus;
  readonly id: string;
  readonly documentScope: string;
  /** The items that make the requirement changed or removed; empty when untraced. */
  readonly issues: readonly string[];
  /** The current requirement; absent for a removed one. */
  readonly entry?: Entry;
}

export interface RequirementChanges<Entry extends ComparableRequirement = ComparableRequirement> {
  /** Changed, then removed, then untraced; requirements in document order. */
  readonly items: readonly RequirementChange<Entry>[];
  readonly unchangedCount: number;
  /** The unchanged requirements themselves, in document order. */
  readonly unchanged: readonly Entry[];
  /**
   * Traced requirements a bounded (incomplete) document inventory does not show: they may be
   * removed or merely beyond the bound, so they are neither removed nor affected.
   */
  readonly unverifiedRemoved: readonly RequirementChange<never>[];
  /** Items that name at least one requirement. */
  readonly tracedIssueCount: number;
  /** Traced items whose document is not among the current ones: counted, never judged. */
  readonly unmatchedIssueCount: number;
  /** Every item that traces a changed or removed requirement. */
  readonly affectedIssues: readonly string[];
}

interface ParsedIssue {
  readonly key: string;
  readonly requirements: ReadonlySet<string>;
  readonly documents: ReadonlySet<string>;
  readonly labels: ReadonlySet<string>;
}

function withPrefix(labels: readonly string[], prefix: string): ReadonlySet<string> {
  return new Set(
    labels.filter((label) => label.startsWith(prefix)).map((label) => label.slice(prefix.length)),
  );
}

function parse(issue: RequirementTracedIssue): ParsedIssue {
  return {
    key: issue.key,
    requirements: withPrefix(issue.labels, REQUIREMENT_LABEL_PREFIX),
    documents: withPrefix(issue.labels, REQUIREMENT_DOCUMENT_LABEL_PREFIX),
    labels: new Set(issue.labels),
  };
}

function sortedKeys(keys: Iterable<string>): readonly string[] {
  return [...new Set(keys)].sort((left, right) => compareIssueKeys(left, right));
}

function stateOf(
  entry: ComparableRequirement,
  issues: readonly ParsedIssue[],
): { readonly traced: boolean; readonly outdated: readonly string[] } {
  const traced = issues.filter(
    (issue) => issue.requirements.has(entry.id) && issue.documents.has(entry.documentScope),
  );
  const current = revisionLabel(entry.digest);
  return {
    traced: traced.length > 0,
    outdated: sortedKeys(
      traced.filter((issue) => !issue.labels.has(current)).map((issue) => issue.key),
    ),
  };
}

interface Missing {
  readonly removed: readonly RequirementChange<never>[];
  readonly unverified: readonly RequirementChange<never>[];
}

function missingItems(
  issues: readonly ParsedIssue[],
  current: ReadonlySet<string>,
  known: ReadonlySet<string>,
  incomplete: ReadonlySet<string>,
): Missing {
  const removed = new Map<string, { id: string; scope: string; keys: string[] }>();
  for (const issue of issues) {
    const scopes = [...issue.documents].filter((scope) => current.has(scope)).sort(compareStrings);
    const [scope] = scopes;
    if (scope === undefined) continue;
    for (const id of issue.requirements) {
      if (scopes.some((candidate) => known.has(`${candidate}\u0000${id}`))) continue;
      const slot = removed.get(`${scope}\u0000${id}`) ?? { id, scope, keys: [] };
      slot.keys.push(issue.key);
      removed.set(`${scope}\u0000${id}`, slot);
    }
  }
  const all = [...removed.values()]
    .sort((left, right) => compareStrings(left.scope + left.id, right.scope + right.id))
    .map((item): RequirementChange<never> => ({
      status: "removed",
      id: item.id,
      documentScope: item.scope,
      issues: sortedKeys(item.keys),
    }));
  return {
    removed: all.filter((item) => !incomplete.has(item.documentScope)),
    unverified: all.filter((item) => incomplete.has(item.documentScope)),
  };
}

/**
 * Compares the current inventory with the items of the backlog that carry the trace labels.
 * `documentScopes` lists every document the comparison may speak for, including one without units;
 * `incompleteScopes` names those whose inventory a bound cut, where no removal is judged.
 */
export function compareRequirementsWithTrace<Entry extends ComparableRequirement>(
  entries: readonly Entry[],
  documentScopes: readonly string[],
  backlog: readonly RequirementTracedIssue[],
  incompleteScopes: readonly string[] = [],
): RequirementChanges<Entry> {
  const issues = backlog
    .map((issue) => parse(issue))
    .filter((issue) => issue.requirements.size > 0);
  const current = new Set(documentScopes);
  const known = new Set(entries.map((entry) => `${entry.documentScope}\u0000${entry.id}`));
  const changed: RequirementChange<Entry>[] = [];
  const untraced: RequirementChange<Entry>[] = [];
  const unchanged: Entry[] = [];
  for (const entry of entries) {
    const state = stateOf(entry, issues);
    const item = { id: entry.id, documentScope: entry.documentScope, entry };
    if (!state.traced) untraced.push({ ...item, status: "untraced", issues: [] });
    else if (state.outdated.length > 0)
      changed.push({ ...item, status: "changed", issues: state.outdated });
    else unchanged.push(entry);
  }
  const { removed, unverified } = missingItems(issues, current, known, new Set(incompleteScopes));
  const unmatched = issues.filter(
    (issue) => ![...issue.documents].some((scope) => current.has(scope)),
  );
  return {
    items: [...changed, ...removed, ...untraced],
    unchangedCount: unchanged.length,
    unchanged,
    unverifiedRemoved: unverified,
    tracedIssueCount: issues.length,
    unmatchedIssueCount: unmatched.length,
    affectedIssues: sortedKeys([...changed, ...removed].flatMap((item) => item.issues)),
  };
}
