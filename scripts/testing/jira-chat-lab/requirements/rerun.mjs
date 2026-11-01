// S19 of epic #4173 (#4178): a re-run creates no duplicates. The same creation request is sent
// twice, the second time from a fresh Chat that carries no memory of the first, and Jira is the
// only oracle: it must hold exactly one epic per requirement afterwards. The deterministic draft
// identity of the product is what makes the second write reconcile instead of create.
import { claimedRequirement, turnIssues } from "./oracles.mjs";
import { countsOf, result, snapshotBefore, sumTurns } from "./journey-support.mjs";

const EPIC_QUERY = "project = REQ AND issuetype = Epic";

/** "Kann" requirements: S17 creates the "Muss" ones, and no other journey uses these two. */
export const RERUN_REQUIREMENTS = Object.freeze(["LH-019", "LH-024"]);

/**
 * Grades the second run against the epics Jira holds after each run.
 *  - red: a requirement has more than one epic after the second run, or the second run created a
 *    new epic or a second issue under an existing draft identity;
 *  - unverified: the first run created no epic for a requirement, or the second run's own draft did
 *    not report the existing epic of every requested requirement as reconciled (no write, a refused
 *    or failed write, or a write about something else), so the product's reconciliation was never
 *    shown to recognise the duplicate;
 *  - green: exactly one epic per requirement after both runs, no new issue from the second, and the
 *    second run reconciled onto each requirement's existing epic.
 */
export function gradeRerun({ requested, afterFirst, afterSecond, second }) {
  const countOf = (issues, id) => issues.filter((issue) => claimedRequirement(issue) === id).length;
  const repeated = requested.filter((id) => countOf(afterSecond, id) > 1);
  const absentFirst = requested.filter((id) => countOf(afterFirst, id) === 0);
  const absentSecond = requested.filter((id) => countOf(afterSecond, id) === 0);
  const unreconciled = requested.filter(
    (id) => !second.reconciled.some((issue) => claimedRequirement(issue) === id),
  );
  const newInSecond = second.created.length;
  const base = { repeated, absentFirst, absentSecond, unreconciled, newInSecond };
  if (repeated.length > 0 || newInSecond > 0 || second.duplicates.length > 0) {
    return { ...base, status: "red" };
  }
  if (absentFirst.length > 0 || absentSecond.length > 0 || unreconciled.length > 0) {
    return { ...base, status: "unverified" };
  }
  return { ...base, status: "green" };
}

const RERUN_PROMPT = `Lege im Jira-Projekt REQ für die Anforderungen ${RERUN_REQUIREMENTS.join(" und ")} aus dem Lastenheft je ein Epic nach der Strukturvorgabe an. Prüfe nicht vorher, ob es dazu schon Epics gibt, sondern lege sie in jedem Fall an. Melde die Vorgangsschlüssel oder den genauen Fehler.`;

function rerunDetail(grade, second) {
  const ids = (list) => (list.length === 0 ? "none" : list.join(", "));
  return `${countsOf(second, "epics")} in the second run; requirements with several epics: ${ids(grade.repeated)}; without an epic after the first run: ${ids(grade.absentFirst)}; not reconciled by the second run: ${ids(grade.unreconciled)}`;
}

export async function rerunCreatesNoDuplicates(ctx, chat) {
  const first = await ctx.turn(chat, RERUN_PROMPT);
  // The same request from a Chat that remembers nothing: only the product can recognise the epics.
  const afterFirst = await ctx.search(EPIC_QUERY, "summary,labels");
  const before = await snapshotBefore(ctx, EPIC_QUERY);
  const again = await ctx.freshChat("autonomous-delivery");
  const turn = await ctx.turn(again, RERUN_PROMPT);
  const afterSecond = await ctx.search(EPIC_QUERY, "summary,labels");
  const second = turnIssues({ before, issues: afterSecond, exchanges: turn.toolExchanges });
  const grade = gradeRerun({
    requested: RERUN_REQUIREMENTS,
    afterFirst,
    afterSecond,
    second,
  });
  return result(
    grade.status,
    sumTurns([first, turn]),
    rerunDetail(grade, second),
    grade.status === "unverified" ? [] : ["rerun-creates-no-duplicates"],
  );
}
