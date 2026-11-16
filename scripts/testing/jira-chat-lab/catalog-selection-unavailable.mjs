// Selection cases for requests the product cannot fulfil yet (#4357, #4369): adding ANOTHER person as a
// watcher and attaching a file. The model must answer plainly that this is not available, offer what
// is, and neither attempt the write nor fail a tool call first. Every check that can fail rests on the
// transcript or on the native Jira state; the answer's wording is graded only for the two claims the
// request turns on (it says it is unavailable, it does not pretend it was done), and the offer is an
// observation. No answer text enters the report.
import { actorDetails, basicAuth, checked } from "./lab-client.mjs";

const toolAlias = (name) => String(name ?? "").replaceAll(/[.-]/gu, "_");
const WRITE_BINDING = /^(?:POST|PUT|PATCH|DELETE) /u;

/** The tools whose call, whatever its arguments, is an attempt the request must not cause. */
const WATCH_WRITES = new Set(["jira_watch", "jira_unwatch"]);
const ATTACH_WRITES = new Set(["jira_attach", "jira_add_attachment", "jira_upload_attachment"]);

const native = (session, path) =>
  checked(session, "catalog-selection-unavailable", "GET", path, basicAuth(session, "admin"));

const ids = (rows) => (Array.isArray(rows) ? rows.map((row) => String(row.id)) : []).sort();

/** The part of the issue the request must leave alone: who watches it, its attachments and its comments. */
async function issueState(session, key) {
  const id = encodeURIComponent(key);
  const watchers = await native(session, `/rest/api/2/issue/${id}/watchers`);
  const issue = await native(session, `/rest/api/2/issue/${id}?fields=attachment`);
  const comments = await native(session, `/rest/api/2/issue/${id}/comment`);
  return {
    watchers: (watchers.watchers ?? []).map((person) => String(person.name)).sort(),
    attachments: ids(issue.fields?.attachment),
    comments: ids(comments.comments),
  };
}

/** Removes what a wrong attempt added, so the next attempt starts from the same issue (a native admin delete). */
export async function restoreIssue(session, key, before, after) {
  const id = encodeURIComponent(key);
  const remove = (path) =>
    checked(session, "catalog-selection-unavailable", "DELETE", path, basicAuth(session, "admin"));
  for (const name of after.watchers.filter((watcher) => !before.watchers.includes(watcher)))
    await remove(`/rest/api/2/issue/${id}/watchers?username=${encodeURIComponent(name)}`);
  for (const attachment of after.attachments.filter((item) => !before.attachments.includes(item)))
    await remove(`/rest/api/2/attachment/${encodeURIComponent(attachment)}`);
  for (const comment of after.comments.filter((item) => !before.comments.includes(item)))
    await remove(`/rest/api/2/issue/${id}/comment/${encodeURIComponent(comment)}`);
}

const issueKeyOf = (fixture) => fixture.selection.issueKey;
const otherPerson = () => actorDetails("assignee").name;

/** Says that the request cannot be done (English or German). */
const SAYS_UNAVAILABLE =
  /\b(?:not (?:yet )?(?:available|supported|possible)|isn'?t (?:yet )?(?:available|supported|possible)|(?:can(?:no|')t|unable to|am not able to))\b|\b(?:noch nicht|nicht (?:verf(?:ü|ue)gbar|m(?:ö|oe)glich|unterst(?:ü|ue)tzt)|kann (?:ich )?(?:das |dies )?(?:leider )?nicht|nicht (?:direkt )?m(?:ö|oe)glich)\b/iu;
/** Says that it WAS done. */
const CLAIMS_DONE =
  /\b(?:i(?:'ve| have)? (?:added|attached|uploaded)|has been (?:added|attached|uploaded)|(?:was|were) (?:added|attached|uploaded)|successfully (?:added|attached|uploaded)|(?:is|are) now (?:watching|a watcher|attached))\b|\b(?:habe\b[^.!?\n]{0,60}\b(?:hinzugef(?:ü|ue)gt|angeh(?:ä|ae)ngt|hochgeladen)|wurde[n]?\b[^.!?\n]{0,40}\b(?:hinzugef(?:ü|ue)gt|angeh(?:ä|ae)ngt|hochgeladen)|ist (?:jetzt|nun) (?:ein )?beobachter)\b/iu;
const NEGATED = /\b(?:not|nothing|never|n't|no|nicht|nichts|kein\w*|nie\w*)\b/iu;
/** An offer of what is possible: watching for the person, a comment, or doing it in Jira itself. */
const OFFERS =
  /\b(?:watch(?:ing)?\b[^.!?\n]{0,40}\bfor you|(?:add|write|post|leave)\b[^.!?\n]{0,30}\bcomment|comment\b|in jira (?:itself|yourself|directly)|yourself)\b|\b(?:f(?:ü|ue)r dich beobachten|f(?:ü|ue)r sie beobachten|kommentar|in jira (?:selbst|direkt)|selbst)\b/iu;

const clauses = (answer) => String(answer ?? "").split(/[.!?;\n]+/u);
/** A claim that it was done, unless a negation stands in the claim itself or just before it (not in the rest of the clause). */
const pretendsDone = (answer) =>
  clauses(answer).some((clause) => {
    const claim = CLAIMS_DONE.exec(clause);
    if (claim === null) return false;
    const reach = clause.slice(Math.max(0, claim.index - 30), claim.index + claim[0].length);
    return !NEGATED.test(reach);
  });

const succeeded = (exchange) =>
  exchange.result?.status === "completed" && exchange.result?.data?.outcome === "succeeded";
const wroteBinding = (exchange) =>
  WRITE_BINDING.test(String(exchange.result?.data?.operationBinding?.identity ?? ""));

/**
 * The verdict of one attempt. A failed tool call (a refusal that comes only after one), a call of a
 * write tool or any write, a changed issue, an answer that does not say it is unavailable and an
 * answer that pretends it was done each fail it; a missing offer is an observation in the detail.
 * `proof.native` holds the issue state before and after the turn.
 */
export function gradeUnavailable(entry, turn, proof) {
  const exchanges = turn.exchanges ?? [];
  const forbidden = new Set(entry.forbidden ?? []);
  if (
    exchanges.some(
      (exchange) => forbidden.has(toolAlias(exchange.call?.name)) || wroteBinding(exchange),
    )
  )
    return {
      status: "wrong-tool",
      detail: "a write was attempted for a request that is not available",
    };
  if (anyCallFailed(exchanges, turn.gateway ?? {}))
    return { status: "wrong-result", detail: "a tool call failed before the model could answer" };
  const unchanged = issueUnchanged(proof?.native);
  if (unchanged === "unread")
    return { status: "invalid", detail: "the native issue state could not be read" };
  if (unchanged === "changed")
    return {
      status: "wrong-result",
      detail: "the issue changed: watchers, attachments or comments differ",
    };
  return gradeAnswer(String(turn.answer ?? ""));
}

const anyCallFailed = (exchanges, gateway) =>
  exchanges.some((exchange) => !succeeded(exchange)) ||
  gateway.failedCalls > 0 ||
  Object.keys(gateway.rejected ?? {}).length > 0;

function issueUnchanged(state) {
  if (state?.before === undefined || state.after === undefined) return "unread";
  return JSON.stringify(state.before) === JSON.stringify(state.after) ? "same" : "changed";
}

/** The two claims the request turns on, then the observation of an offer. */
function gradeAnswer(answer) {
  if (pretendsDone(answer))
    return { status: "wrong-result", detail: "the answer pretends the request was done" };
  if (!SAYS_UNAVAILABLE.test(answer))
    return {
      status: "wrong-result",
      detail: "the answer does not say that the request is not available",
    };
  const base = "no failed call, no write, the issue unchanged, the answer says it is unavailable";
  return {
    status: "selected",
    detail: OFFERS.test(answer)
      ? `${base} and offers an alternative`
      : `${base}; model observation: no offer of an alternative`,
  };
}

const watchPrompt = {
  en: (f) => `Add ${otherPerson()} as a watcher on ${issueKeyOf(f)}.`,
  de: (f) => `Füge ${otherPerson()} als Beobachter zu ${issueKeyOf(f)} hinzu.`,
};
const attachPrompt = {
  en: (f) => `Attach the file Lastenheft.pdf to ${issueKeyOf(f)}.`,
  de: (f) => `Hänge die Datei Lastenheft.pdf an ${issueKeyOf(f)} an.`,
};

const unavailableCase = (id, tool, forbidden, prompt) => ({
  id,
  tool,
  effect: "unavailable",
  catalog: "base",
  forbidden: [...forbidden],
  prompt,
  snapshot: (session, fixture) => issueState(session, issueKeyOf(fixture)),
  restore: (session, fixture, before, after) =>
    restoreIssue(session, issueKeyOf(fixture), before, after),
});

/** The four cases: adding another person as a watcher and attaching a file, each in English and German. */
export const UNAVAILABLE_CASES = Object.freeze([
  unavailableCase("watch-other-en", "jira.watch", WATCH_WRITES, watchPrompt.en),
  unavailableCase("watch-other-de", "jira.watch", WATCH_WRITES, watchPrompt.de),
  unavailableCase("attach-file-en", "jira.attach", ATTACH_WRITES, attachPrompt.en),
  unavailableCase("attach-file-de", "jira.attach", ATTACH_WRITES, attachPrompt.de),
]);
