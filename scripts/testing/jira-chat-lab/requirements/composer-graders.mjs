// The pure graders of the Composer lane (#4369). Every verdict rests on the native state of Jira
// (the issues the turn created, the fields before and after an edit, the watcher list, the comment,
// the attachments); the tool trace only adds a claim about the gate, and an unexercised gate is
// `unverified` only when the native state is clean. A product that wrote what it should have refused
// is red whatever its trace says.
import { relatedKeys } from "./hierarchy.mjs";
import {
  editRefusals,
  gradeTemplateRepair,
  succeededEdits,
  templateRefusals,
  wroteIssue,
} from "./templates.mjs";
import { toolExchangeOf } from "./tool-exchanges.mjs";

const ISSUE_KEY = /\b[A-Z][A-Z0-9_]+-\d+\b/gu;

/**
 * Soft verdicts, over the MODEL'S prose: green, or an `unverified` model observation that says so.
 * Never red: what a model says is not what the product did, and no obligation may go red from prose.
 */
export const soft = (holds, detail) =>
  holds
    ? { status: "green", detail }
    : { status: "unverified", observation: true, detail: `model observation: ${detail}` };
/** Whether the stored exchange asked a human first: an approval card exists for the call. */
export const askedForApproval = (exchange) => exchange?.approval !== undefined;

export const writeCalls = (exchanges) =>
  (Array.isArray(exchanges) ? exchanges : []).filter(
    (exchange) => toolExchangeOf(exchange, "jira.create") || toolExchangeOf(exchange, "jira.draft"),
  );

/** The relation the request named, as Jira holds it, for one type. */
export function composerRelation(type, { epicLink, epic, task }) {
  return (issue) => {
    const fields = issue.fields ?? {};
    switch (type) {
      case "Epic":
        return true;
      case "Sub-task":
        return fields.parent?.key === task;
      case "Bug":
        return fields[epicLink] === epic && relatedKeys(issue).includes(task);
      default:
        return fields[epicLink] === epic;
    }
  };
}

/** The issues of one type among those a turn created (the graders of a type judge only that type). */
export const ofType = (issues, type) => ({
  ...issues,
  credited: issues.credited.filter((issue) => issue.fields?.issuetype?.name === type),
  created: issues.created.filter((issue) => issue.fields?.issuetype?.name === type),
});

/** The issues a turn created that are NOT of the requested type: a write nobody asked for. */
const strayTypes = (issues, type) =>
  issues.created.filter((issue) => issue.fields?.issuetype?.name !== type);

const strayDetail = (strays) =>
  `${strays.length} issues of another type were created: ${strays.map((issue) => `${issue.key} (${issue.fields?.issuetype?.name})`).join(", ")}`;

/**
 * Obligation a) — exactly one new conformant issue of the type, with the named relation, and no issue
 * of another type created by the same turn. `issues` is everything the turn created, of every type.
 */
export function gradeComposerCreate({ type, issues: all, conforms, related }) {
  const strays = strayTypes(all, type);
  if (strays.length > 0) return { status: "red", detail: strayDetail(strays) };
  const issues = ofType(all, type);
  const [issue] = issues.created;
  if (issues.created.length !== 1 || issues.credited.length !== 1 || issues.duplicates.length > 0)
    return {
      status: "red",
      detail: `${issues.created.length} ${type} created, ${issues.duplicates.length} duplicates; exactly one new ${type} was expected`,
    };
  const conformant = conforms(issue);
  const relation = related(issue);
  return {
    status: conformant && relation ? "green" : "red",
    detail: `${issue.key}: ${conformant ? "conforms to the template" : "does not conform to the template"}, ${relation ? "named relation held" : "named relation missing"}`,
  };
}

/** The keys of `created` that the answer does not name (the model's words, graded softly). */
export const keysMissingInAnswer = (created, answer) => {
  const named = new Set(String(answer ?? "").match(ISSUE_KEY) ?? []);
  return created.filter((issue) => !named.has(issue.key));
};

/** The keys of `created` that no stored write result of the turn names (the product's own card). */
export function keysMissingInCards(created, exchanges) {
  const named = new Set();
  for (const exchange of writeCalls(exchanges))
    for (const key of JSON.stringify(exchange.result?.data ?? {}).match(ISSUE_KEY) ?? [])
      named.add(key);
  return created.filter((issue) => !named.has(issue.key));
}

/** Whether the issues carry exactly the requested titles, each once. */
const hasTitles = (made, titles) => {
  const wanted = [...titles].sort();
  const found = made.map((issue) => String(issue.fields?.summary ?? "")).sort();
  return found.length === wanted.length && found.every((title, i) => title === wanted[i]);
};

/**
 * Obligation a) — one request creates several issues of one type: exactly the requested titles exist
 * natively (each once, conformant, with its relation) and every key stands in a stored write result
 * (hard); the answer listing every key is a model observation (soft).
 */
export function gradeMultiCreate({
  type,
  titles,
  issues: all,
  conforms,
  related,
  answer,
  exchanges,
}) {
  const strays = strayTypes(all, type);
  const issues = ofType(all, type);
  const made = issues.created;
  const expected = titles.length;
  const good = made.filter((issue) => conforms(issue) && related(issue));
  const sameTitles = hasTitles(made, titles);
  const complete = sameTitles && good.length === expected && issues.duplicates.length === 0;
  const created = {
    status: strays.length === 0 && complete ? "green" : "red",
    detail: `${made.length} created natively of ${expected} requested, ${good.length} conformant with their relation, ${sameTitles ? "the titles are the requested ones" : "the titles differ from the request"}${strays.length > 0 ? `; ${strayDetail(strays)}` : ""}`,
  };
  return {
    created,
    listed: gradeKeysInCards(made, exchanges),
    answered: gradeKeysInAnswer(made, answer),
  };
}

/** Hard: every natively created key stands in a stored write result of the turn (the product's card). */
function gradeKeysInCards(made, exchanges) {
  if (made.length === 0)
    return { status: "unverified", detail: "nothing was created, no key to list" };
  if (writeCalls(exchanges).length === 0)
    return {
      status: "unverified",
      detail: "no stored write result in the turn; the product's key listing cannot be read",
    };
  const missing = keysMissingInCards(made, exchanges);
  return missing.length === 0
    ? { status: "green", detail: "every created key stands in a stored write result" }
    : {
        status: "red",
        detail: `${missing.length} created keys are in no stored write result of the turn`,
      };
}

/** Soft: the answer lists every created key (the model's words). */
function gradeKeysInAnswer(made, answer) {
  if (made.length === 0) return soft(false, "nothing was created, no key to list");
  const missing = keysMissingInAnswer(made, answer);
  return soft(
    missing.length === 0,
    missing.length === 0
      ? "the answer lists every created key"
      : `the answer does not list ${missing.length} created keys`,
  );
}

/**
 * Obligation b) — a violating request is refused before any card and any effect, and the corrected
 * request then succeeds. `created` are the issues the turn created in the whole project: a violating
 * issue of the type that exists afterwards is red whatever the tool trace says.
 */
export function gradeComposerRefusal({ type, exchanges, created, template, conforms }) {
  const stray = created.filter((issue) => issue.fields?.issuetype?.name !== type);
  if (stray.length > 0) return { status: "red", detail: strayDetail(stray) };
  const own = created.filter((issue) => issue.fields?.issuetype?.name === type);
  const violating = own.filter((issue) => !conforms(issue));
  if (violating.length > 0)
    return {
      status: "red",
      detail: `${violating.length} violating ${type} exists in Jira: ${violating.map((issue) => issue.key).join(", ")}`,
    };
  const repair = gradeTemplateRepair({ exchanges, issues: own, template, conforms });
  const cards = templateRefusals(exchanges).filter((refusal) =>
    askedForApproval(exchanges[refusal.index]),
  ).length;
  const detail = `${repair.refusals} refusals (${repair.ruleIds.join(", ")}), ${cards} with an approval card, ${repair.receipts} with a receipt, ${own.length} ${type} in Jira, none violating`;
  if (!repair.detected)
    return own.length === 0
      ? {
          status: "unverified",
          detail: `no refusal and nothing written; the gate was not exercised (${detail})`,
        }
      : {
          status: "unverified",
          detail: `no refusal, but only a conformant ${type} exists; the gate was not exercised (${detail})`,
        };
  if (cards > 0)
    return { status: "red", detail: `${detail}; a card was shown for a refused write` };
  if (repair.receipts > 0)
    return { status: "red", detail: `${detail}; a refusal carries a receipt` };
  return own.length === 1
    ? { status: "green", detail }
    : { status: "red", detail: `${detail}; exactly one conformant ${type} was expected` };
}

/** The traced refusals (create, draft or edit) that name one of `ruleIds`. */
export const namesRule = (refusals, ruleIds) =>
  refusals.filter((refusal) => refusal.violations.some((item) => ruleIds.includes(item.ruleId)));
/** The distinct rule ids a list of refusals names, for a detail line. */
export const ruleNames = (refusals) =>
  [...new Set(refusals.flatMap((refusal) => refusal.violations.map((item) => item.ruleId)))].join(
    ", ",
  );

const changed = (before, after, fields) =>
  fields.some(
    (field) =>
      JSON.stringify(before.fields?.[field] ?? null) !==
      JSON.stringify(after.fields?.[field] ?? null),
  );

/**
 * Obligation d1) — an edit that would make a conformant issue non-conformant is refused: compared
 * natively before and after, through whichever tool it happened, and refused BY THE GATE — a traced
 * `jira.edit` rejection naming one of `ruleIds`. An edit that failed for another reason, or never
 * ran, leaves the issue unchanged without proving the gate, so it is `unverified`, never green.
 */
export function gradeEditBreaking({ before, after, exchanges, conforms, ruleIds }) {
  if (!conforms(before))
    return { status: "unverified", detail: "the fixture issue was not conformant before the edit" };
  if (!conforms(after))
    return { status: "red", detail: "the edit was applied and the issue is no longer conformant" };
  const refused = namesRule(editRefusals(exchanges), ruleIds);
  if (refused.length > 0)
    return {
      status: "green",
      detail: `the gate refused the edit (${ruleNames(refused)}); the issue is still conformant`,
    };
  const edits = (Array.isArray(exchanges) ? exchanges : []).filter((exchange) =>
    toolExchangeOf(exchange, "jira.edit"),
  );
  return {
    status: "unverified",
    detail:
      edits.length === 0
        ? "the issue is unchanged, but no jira.edit call was made; the gate was not exercised"
        : `the issue is unchanged, but no traced edit refusal names ${ruleIds.join(" or ")}; the gate was not shown to be the cause`,
  };
}

/** The fields other than the targeted one that differ between two reads of the same issue. */
const untouchedChanges = (before, after, touched) =>
  [...new Set([...Object.keys(before.fields ?? {}), ...Object.keys(after.fields ?? {})])].filter(
    (field) => field !== touched && changed(before, after, [field]),
  );

const escapePattern = (text) => String(text).replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

/**
 * Obligation d2, hard half — an edit of an issue with a pre-existing violation in an UNTOUCHED field
 * passes, no other field changed, and the product says so in the trace (a succeeded `jira.edit`
 * carrying a template notice for `remainingRule`). Native state plus the stored notice only.
 */
export function gradeEditPreexisting({
  before,
  after,
  touched,
  expected,
  remainingRule,
  exchanges,
}) {
  if (!changed(before, after, [touched]) || String(after.fields?.[touched]) !== expected)
    return {
      status: "red",
      detail: `the edit of ${touched} did not apply; a pre-existing violation elsewhere blocked it`,
    };
  const others = untouchedChanges(before, after, touched);
  if (others.length > 0)
    return { status: "red", detail: `untouched fields changed as well: ${others.join(", ")}` };
  const edits = succeededEdits(exchanges);
  if (edits.length === 0)
    return {
      status: "unverified",
      detail:
        "the edit applied, but no succeeded jira.edit is in the trace; the notice cannot be read",
    };
  return edits.some((edit) => edit.notices.some((item) => item.ruleId === remainingRule))
    ? {
        status: "green",
        detail: `the edit passed and the product reported the template notice ${remainingRule}`,
      }
    : {
        status: "red",
        detail: `the edit passed, but the product reported no template notice for ${remainingRule}`,
      };
}

/** Obligation d2, soft half — the answer names the remaining violation (the model's words). */
export function gradeNamesRemaining({ answer, remaining }) {
  const holds = new RegExp(escapePattern(remaining), "iu").test(answer ?? "");
  return soft(
    holds,
    holds
      ? "the answer names the remaining violation"
      : "the answer does not name the remaining violation",
  );
}

/** What a change of `field` shows: a status by its category (shared by every language), else the value. */
const shown = (issue, field) =>
  field === "status" ? issue.fields?.status?.statusCategory?.key : issue.fields?.[field];

/** Obligation d3/d4) — an edit or a status change of a type with no template passes. */
export function gradeUngovernedChange({ before, after, field, expected }) {
  const value = shown(after, field);
  if (JSON.stringify(shown(before, field) ?? null) === JSON.stringify(value ?? null))
    return {
      status: "red",
      detail: `the ${field} did not change although no template governs the type`,
    };
  return String(value) === expected
    ? { status: "green", detail: `the ${field} is now ${expected}` }
    : { status: "red", detail: `the ${field} changed to ${value}, not ${expected}` };
}

/**
 * "Nothing was created" proves nothing when the turn never ran: a failed turn, or one that answered
 * nothing and called no tool, leaves the obligation unverified. Undefined means the step ran.
 */
export function stepProof(turn, name) {
  if (turn === undefined)
    return { status: "unverified", detail: `${name} was not observed; nothing is proven` };
  const silent = String(turn.answer ?? "").trim() === "" && (turn.toolExchanges ?? []).length === 0;
  if (turn.failure !== undefined || silent)
    return {
      status: "unverified",
      detail: `${name} did not run to an answer (${turn.failure === undefined ? "empty answer, no tool call" : "the turn failed"}); nothing is proven`,
    };
  return undefined;
}

const keyIn = (answer, key) => new RegExp(String.raw`\b${key}\b`, "u").test(String(answer ?? ""));
const keysOf = (issues) => issues.map((issue) => issue.key).join(", ");

/** Whether the answer or any stored result of the turn names `key` (the answer text or a result card). */
function refersTo(key, answer, exchanges) {
  if (keyIn(answer, key)) return true;
  return (Array.isArray(exchanges) ? exchanges : []).some((exchange) =>
    keyIn(JSON.stringify(exchange?.result?.data ?? {}), key),
  );
}

/**
 * Obligation e0 (`stored-conversation-matches-turn`) — the messages the turn observed when it settled
 * are the ones the product's stored conversation holds when read again afterwards (a separate request,
 * a separate request; the lab has no browser), in the same order, at least the two of the first
 * turn. It proves the stored conversation is the one the turn saw, and nothing about a browser.
 */
export function gradeConversationSurvives({ before, after }) {
  if (!Array.isArray(before) || before.length < 2)
    return {
      status: "unverified",
      detail: "the first turn observed fewer than two messages to compare",
    };
  const same =
    Array.isArray(after) &&
    after.length === before.length &&
    before.every((id, i) => id === after[i]);
  return same
    ? {
        status: "green",
        detail: `${before.length} messages observed by the turn and stored afterwards, the same ones`,
      }
    : {
        status: "red",
        detail: `${before.length} messages observed by the turn, ${Array.isArray(after) ? after.length : 0} stored afterwards, not the same ones`,
      };
}

/**
 * Obligations e1 and e2, hard half — the same order sent again in ONE conversation, after its stored
 * messages were read again (`repeat-after-reread-no-duplicate`) or straight away (`repeat-in-chat-no-duplicate`): the turn
 * created no issue of ANY summary or type (the native keys that are new since THIS turn began, so a
 * duplicate is reported once, by the turn that made it) and the issue of the first order still carries
 * its title. A second issue is red because the person did not ask for another one. The step must
 * have run, else unverified.
 */
export function gradeRepeat({ title, created, after, repeated, turn }) {
  if (created.length !== 1)
    return { status: "unverified", detail: "the first order did not create exactly one issue" };
  const proof = stepProof(turn, "the repeated order");
  if (proof !== undefined) return proof;
  if (repeated.created.length > 0)
    return {
      status: "red",
      detail: `the repeated order created ${keysOf(repeated.created)} although the person did not ask for another issue (model; see the trace)`,
    };
  const [first] = created;
  const present = after.some((issue) => issue.key === first.key && issue.fields?.summary === title);
  return present
    ? { status: "green", detail: `created nothing; ${first.key} still carries its title` }
    : { status: "red", detail: `${first.key} no longer carries the title natively` };
}

/** Obligations e1 and e2, soft half — the reply refers to the first issue's key (answer or stored card). */
export function gradeRepeatReference({ created, answer, turn }) {
  if (created.length !== 1)
    return { status: "unverified", detail: "the first order did not create exactly one issue" };
  const proof = stepProof(turn, "the repeated order");
  if (proof !== undefined) return proof;
  const [first] = created;
  const holds = refersTo(first.key, answer, turn.toolExchanges);
  return soft(
    holds,
    holds
      ? `the reply refers to ${first.key}`
      : `the reply does not refer to ${first.key} in the answer or in a stored result`,
  );
}

/** Watcher added or removed, read from the native watcher list. */
export function gradeWatcher({ watchers, actor, expectPresent }) {
  const present = (watchers ?? []).some((watcher) => watcher.name === actor);
  return present === expectPresent
    ? {
        status: "green",
        detail: expectPresent
          ? "the watcher list holds the connected user"
          : "the watcher list no longer holds the connected user",
      }
    : {
        status: "red",
        detail: expectPresent
          ? "the connected user is not in the native watcher list"
          : "the connected user is still in the native watcher list",
      };
}

/**
 * A comment written by plain instruction: its body and author on the named issue, read natively. The
 * same text on any other fixture issue (`elsewhere`, read natively too) is a comment on the wrong
 * issue and red.
 */
export function gradeComment({ comments, elsewhere = [], actor, body }) {
  const wrong = elsewhere.filter((comment) => comment.body === body);
  if (wrong.length > 0)
    return { status: "red", detail: `${wrong.length} comments carry the text on another issue` };
  const matches = (comments ?? []).filter((comment) => comment.body === body);
  if (matches.length === 0)
    return { status: "red", detail: "no comment with the requested text exists natively" };
  if (matches.length > 1)
    return { status: "red", detail: `${matches.length} comments carry the text` };
  return matches[0].author?.name === actor
    ? { status: "green", detail: "one comment with the exact text, written by the connected user" }
    : { status: "red", detail: "the comment was written by another user" };
}

const ATTACHMENT_NOUN = /anh(?:ä|ae)nge|anhang|attachment|datei/iu;
const NOT_PART =
  /nicht\s+(?:teil|bestandteil|unterst(?:ü|ue)tzt|m(?:ö|oe)glich|verf(?:ü|ue)gbar)|(?:kein|keine)\s+\w*\s*(?:unterst(?:ü|ue)tzung|anh(?:ä|ae)nge)|not\s+(?:part|supported|available)/iu;

/**
 * Every settled write of the turn, whatever its tool: the product's closed `outcome` is `succeeded`,
 * or a draft item of it is in state `created` (a draft reports items, not one outcome).
 */
export const succeededWrite = (exchange) =>
  exchange?.result?.data?.outcome === "succeeded" || wroteIssue(exchange);
const succeededWrites = (exchanges) =>
  (Array.isArray(exchanges) ? exchanges : []).filter(succeededWrite);

/** The calls of the attach operation (`jira.attach`, model alias `jira_attach`) in the turn's trace. */
const attachCalls = (exchanges) =>
  (Array.isArray(exchanges) ? exchanges : []).filter((exchange) =>
    toolExchangeOf(exchange, "jira.attach"),
  );

/**
 * An attachment request, hard half. Release 1 switches attachments off (#4354); until then the attach
 * operation exists, so a call that succeeded or that was OFFERED to a human (an approval card exists
 * for it) is red; with it off, no such call can exist and the native attachment count stays. Beyond
 * the attach operation, no write of any kind may have succeeded in a turn that asked only for a file.
 * A turn that failed or answered nothing proves nothing: unverified, never red. What the answer says
 * is the soft half (`gradeAttachmentWording`).
 */
export function gradeAttachmentRefusal({ before, after, exchanges, turn }) {
  if (after > before)
    return { status: "red", detail: `${after - before} attachments reached Jira` };
  const attach = attachCalls(exchanges);
  const done = attach.filter(succeededWrite);
  if (done.length > 0)
    return { status: "red", detail: `${done.length} jira.attach calls succeeded` };
  const offered = attach.filter((exchange) => askedForApproval(exchange));
  if (offered.length > 0)
    return {
      status: "red",
      detail: `an approval card was offered for ${offered.length} jira.attach calls although attachments are not part of this release`,
    };
  const writes = succeededWrites(exchanges);
  if (writes.length > 0)
    return {
      status: "red",
      detail: `${writes.length} writes succeeded in a turn that asked only for an attachment`,
    };
  const proof = stepProof(turn, "the attachment request");
  if (proof !== undefined) return proof;
  return {
    status: "green",
    detail: `nothing reached Jira, ${attach.length} jira.attach calls (none succeeded or offered), no write succeeded`,
  };
}

/** An attachment request, soft half — the answer says attachments are not part of this release. */
export function gradeAttachmentWording(answer) {
  const holds = ATTACHMENT_NOUN.test(answer ?? "") && NOT_PART.test(answer ?? "");
  return soft(
    holds,
    holds
      ? "the answer says that attachments are not part of this release"
      : "the answer does not say that attachments are not part of this release",
  );
}
