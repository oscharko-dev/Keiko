// Truth and tool evidence of the change-impact journey S14 (epic #4173, #4179). The comparison of a
// new specification version with the backlog is judged against what Jira holds: the trace labels
// `keiko-req-<id>` the write path put on every derived item. A requirement that no issue traces is
// `untraced` (new, or not derived yet; the labels cannot tell them apart), so the lab compares the
// answer with that set and requires the corpus's added requirements to be among them.
import { completedToolExchange } from "./tool-exchanges.mjs";

const REQUIREMENT_LABEL = "keiko-req-";
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value) =>
  Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];

/** Per requirement id, the keys of the issues that carry its trace label. */
function tracedBy(issues) {
  const traced = new Map();
  for (const issue of issues) {
    const labels = strings(issue.fields?.labels);
    for (const label of labels.filter((entry) => entry.startsWith(REQUIREMENT_LABEL))) {
      const id = label.slice(REQUIREMENT_LABEL.length);
      traced.set(id, new Set([...(traced.get(id) ?? []), issue.key]));
    }
  }
  return traced;
}

/**
 * What the answer and the tool must say about the new version: the changed and removed requirements
 * of the corpus, the requirements of the new version no issue traces, and every issue that traces a
 * changed or removed requirement (whichever journey created it). `traceable` is false when Jira
 * holds no issue for a changed or removed requirement: the comparison has no baseline then.
 */
export function changeImpactTruth(issues, change, currentIds) {
  const traced = tracedBy(issues);
  const affected = new Set(
    [...change.changed, ...change.removed].flatMap((id) => [...(traced.get(id) ?? [])]),
  );
  return {
    changed: new Set(change.changed),
    removed: new Set(change.removed),
    untraced: new Set(currentIds.filter((id) => !traced.has(id))),
    added: new Set(change.added),
    affected,
    traceable: [...change.changed, ...change.removed].every((id) => traced.has(id)),
  };
}

const idsOf = (list) => new Set(list.filter(isRecord).map((item) => item.id));

/**
 * The change set the last completed `knowledge.requirements` call of the turn with the `changes`
 * view states, or undefined when there is none, the baseline report was incomplete or a list was
 * cut (a cut list cannot vouch for the set).
 */
export function structuredChangeSet(exchanges) {
  const calls = (Array.isArray(exchanges) ? exchanges : []).filter(
    (exchange) =>
      completedToolExchange(exchange, "knowledge.requirements") &&
      exchange.result.data?.view === "changes" &&
      exchange.result.data?.outcome === "succeeded",
  );
  const changes = calls.at(-1)?.result.data.changes;
  if (!isRecord(changes) || changes.baseline?.complete !== true) return undefined;
  if (strings(changes.truncated).length > 0) return undefined;
  return {
    changed: idsOf(changes.changed ?? []),
    removed: idsOf(changes.removed ?? []),
    untraced: new Set(strings(changes.untraced)),
    affected: new Set(strings(changes.affectedIssues)),
  };
}
