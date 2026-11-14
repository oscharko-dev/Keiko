// The no-model rehearsal of the Composer lane (#4369): every journey of the selected scenarios runs
// against a live Jira and a model-free product with ONLY the model turn replaced by an empty one.
// Template preparation and hygiene, native fixture creation for each type (with the project's own
// required fields), native reads and the lane's cleanup all really happen; the verdicts are not read,
// because an empty turn grades unverified or red by construction. The rehearsal is green only when no
// journey stopped on a lab error, and it names what it could not exercise. A lane head goes to a
// model only after a green rehearsal on a live Jira (a lab error found by the model pass costs a model
// slot; found here it costs none).
import { basicAuth, labRequest } from "../lab-client.mjs";
import { withModelFreeJira } from "../chat-read.mjs";
import { COMPOSER_JOURNEYS } from "./composer.mjs";
import { composerGroups, composerTruth, withBaselineSetting } from "./composer-run.mjs";
import { journeyContext } from "./journeys.mjs";
import { redactLabDetail } from "./validity.mjs";

/** The turn the rehearsal plays for the model: nothing said, nothing called, nothing approved. */
export const EMPTY_TURN = Object.freeze({
  answer: "",
  toolExchanges: Object.freeze([]),
  failure: undefined,
  durationMs: 0,
  toolCalls: 0,
  approvals: Object.freeze({ writes: 0, records: Object.freeze([]) }),
});

/** What no rehearsal can exercise, stated in every report. */
export const NOT_EXERCISED = Object.freeze([
  "the model turn of every journey (an empty turn is played instead)",
  "the verdicts: an empty turn grades unverified or red by construction and is not read",
  "the product's own gate on a model's write (no Chat, no tool call, no approval)",
]);

const WORK_PROJECT = "REQ";

/** The context of a rehearsal: the live plumbing of a journey, with the model turn and Chat replaced. */
export function rehearsalContext(base, selection) {
  let chats = 0;
  return Object.assign(base, {
    turn: async () => EMPTY_TURN,
    freshChat: async (mode) => ({ id: `rehearsal-${(chats += 1)}`, mode }),
    // The stored conversation read again: the user and assistant message of one turn.
    readStoredConversation: async () => ["rehearsal-user", "rehearsal-assistant"],
    readStoredMessages: async () => [],
    // The rehearsal's Chats exist nowhere: there is no stored assistant message to read.
    storedAnswer: async () => undefined,
    composerSelection: selection ?? {},
  });
}

/** Deletes the issues the rehearsal left in the work project (a native admin delete, 404 tolerated). */
async function removeLeftovers(session, ctx, known) {
  const now = await ctx.search(`project = ${WORK_PROJECT}`, "summary");
  const leftovers = now.map((issue) => issue.key).filter((key) => !known.has(key));
  const auth = basicAuth(session, "admin");
  for (const key of leftovers) {
    const path = `/rest/api/2/issue/${encodeURIComponent(key)}?deleteSubtasks=true`;
    const { status } = await labRequest(session, "DELETE", path, auth);
    if (![204, 404].includes(status))
      throw new TypeError(`Rehearsal cleanup of ${key} answered HTTP ${status}`);
  }
  return leftovers.length;
}

const failureOf = (id, error) => ({
  id,
  ok: false,
  error: redactLabDetail(String(error?.message ?? error)).slice(0, 400),
});

/**
 * Runs each journey once with the empty turn. A journey that throws (a lab error: a required field it
 * cannot fill, a template the lane cannot prepare, a native read that fails) is a failed rehearsal of
 * that scenario; a journey that returns, whatever its verdict, was exercised.
 */
export async function rehearseJourneys({ ctx, ids, journeys = COMPOSER_JOURNEYS }) {
  const results = [];
  for (const id of ids) {
    try {
      await journeys[id](ctx, undefined);
      results.push({ id, ok: true });
    } catch (error) {
      results.push(failureOf(id, error));
    }
  }
  return results;
}

/**
 * The rehearsal of one group of journeys (one product start): the issues of the work project that
 * existed before are kept, everything the journeys created is removed again, also after a failure.
 */
export async function rehearseGroup({ session, ids, truth, selection, ports = {} }) {
  const withProduct = ports.withProduct ?? withModelFreeJira;
  const contextOf = ports.context ?? journeyContext;
  const cleanup = ports.removeLeftovers ?? removeLeftovers;
  let outcome;
  await withProduct({
    session,
    run: async (live) => {
      const ctx = rehearsalContext(contextOf(live, session, truth), selection);
      const known = new Set(
        (await ctx.search(`project = ${WORK_PROJECT}`, "summary")).map((issue) => issue.key),
      );
      let removed = 0;
      const results = await rehearseJourneys({ ctx, ids, journeys: ports.journeys }).finally(
        async () => {
          removed = await cleanup(session, ctx, known);
        },
      );
      outcome = { results, removed };
    },
  });
  if (outcome === undefined) throw new TypeError("The rehearsal's product never ran its journeys");
  return outcome;
}

/** The summary line of a rehearsal: green only when every selected journey was exercised. */
export function rehearsalSummary(groups, ids) {
  const results = groups.flatMap((group) => group.results);
  const failed = results.filter((result) => !result.ok);
  return {
    operation: "composer-rehearsal",
    passed: failed.length === 0 && results.length === ids.length,
    exercised: results.filter((result) => result.ok).map((result) => result.id),
    failed: failed.map(({ id, error }) => ({ id, error })),
    removedLeftovers: groups.reduce((sum, group) => sum + group.removed, 0),
    notExercised: NOT_EXERCISED,
  };
}

/**
 * The whole rehearsal: the journeys in the same groups as a real run (C03 and C04 in a product
 * started without the baseline template set), each with the truth fields a real run would hand it.
 */
export async function rehearseLane({ session, ids, truth, selection, ports = {} }) {
  const groups = [];
  for (const group of composerGroups(ids))
    groups.push(
      await withBaselineSetting(
        group.baseline,
        () =>
          rehearseGroup({
            session,
            ids: group.ids,
            truth: composerTruth(truth, group.ids),
            selection,
            ports,
          }),
        ports.env,
      ),
    );
  return rehearsalSummary(groups, ids);
}
