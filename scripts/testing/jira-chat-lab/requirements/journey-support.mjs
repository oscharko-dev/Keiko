// Shared building blocks of the requirements journeys (epic #4173): the check envelope every
// journey returns, the pre-turn Jira snapshot the oracles compare against, and the aggregation of
// journeys that run several turns (one per format, one per mode).
import { draftIdentity } from "./oracles.mjs";

/** The check a journey returns; the scorecard credits `covers` only while the status is green. */
export const result = (status, turn, detail, covers) => ({
  status,
  covers,
  // The gateway or transport error of the turn, so validity can tell it from a product failure.
  ...(turn.failure ? { turnFailure: turn.failure } : {}),
  detail: `${detail}; ${Math.round(turn.durationMs / 1000)} s, ${turn.toolCalls} tool calls${turn.requirementReads ? ` (${turn.requirementReads} requirement reads)` : ""}${turn.failure ? `, failed: ${turn.failure}` : ""}`,
});

/** A journey that never sent a Chat turn reports no duration or tool calls. */
export const NO_TURN = Object.freeze({ durationMs: 0, toolCalls: 0 });

/**
 * The issues a query matches before a turn: their keys, which the oracle compares against, and the
 * draft identity labels they already carry, which a duplicate would repeat.
 */
export async function snapshotBefore(ctx, query) {
  const issues = await ctx.search(query, "summary,labels");
  return {
    keys: new Set(issues.map((issue) => issue.key)),
    identities: new Set(issues.map(draftIdentity).filter((identity) => identity !== undefined)),
  };
}

/** "3 epics created, 2 reconciled, 1 duplicates" - a run that only reconciled reads as such. */
export const countsOf = (turn, label) =>
  `${turn.created.length} ${label} created, ${turn.reconciled.length} reconciled` +
  (turn.duplicates.length === 0 ? "" : `, ${turn.duplicates.length} duplicates`);

/**
 * Runs `step` on every item one after the other and returns the results in order. The steps share
 * one live Pod or one Jira project, so they must not overlap; recursion keeps the order without an
 * `await` inside a loop.
 */
export async function sequentially(items, step, done = []) {
  if (items.length === 0) return done;
  const [head, ...rest] = items;
  return sequentially(rest, step, [...done, await step(head)]);
}

/** The turns of a multi-turn journey as one: durations and tool calls add up, a failure stays. */
export function sumTurns(turns) {
  return {
    durationMs: turns.reduce((sum, turn) => sum + turn.durationMs, 0),
    toolCalls: turns.reduce((sum, turn) => sum + turn.toolCalls, 0),
    requirementReads: turns.reduce((sum, turn) => sum + (turn.requirementReads ?? 0), 0),
    failure: turns.find((turn) => turn.failure)?.failure,
  };
}

/** Red beats green, and no green part at all verifies nothing. */
function verdictOf(red, greenParts) {
  if (red) return "red";
  return greenParts > 0 ? "green" : "unverified";
}

/**
 * One check from independently graded parts, each `{ label, status, covers, detail }` with the
 * status `green`, `red` or `unverified` (the evidence was absent). Any red part makes the check red;
 * otherwise it is green for the obligations of its green parts only, so a part that could not be
 * verified leaves its obligations uncovered (the scenario stays partial); no green part at all is
 * `unverified`, which credits nothing.
 *
 * With `unverifiedIsNotGreen` (the Composer lane) a check with ANY unverified part is itself
 * `unverified` and never logs `green`: the green parts still credit their own obligations
 * (`unverifiedParts` tells the scenario verdict why), the scenario reports `unverified`, and a
 * journey that could not verify everything cannot read as passed.
 */
export function aggregateParts(parts, turns, { unverifiedIsNotGreen = false } = {}) {
  // A part that is itself a strict aggregate (`unverifiedParts`) keeps crediting what its green parts
  // verified, and counts as the unverified parts it holds.
  const inner = (part) => part.unverifiedParts ?? 0;
  const green = parts.filter((part) => part.status === "green" || inner(part) > 0);
  const red = parts.some((part) => part.status === "red");
  const unverified = parts.reduce(
    (sum, part) => sum + (inner(part) > 0 ? inner(part) : Number(part.status === "unverified")),
    0,
  );
  let status = verdictOf(red, green.length);
  if (unverifiedIsNotGreen && !red && unverified > 0) status = "unverified";
  const covers = (red ? parts : green).flatMap((part) => part.covers);
  const detail = parts.map((part) => `${part.label}: ${part.status} (${part.detail})`).join("; ");
  return {
    ...result(status, sumTurns(turns), detail, covers),
    ...(unverifiedIsNotGreen && unverified > 0 ? { unverifiedParts: unverified } : {}),
  };
}
