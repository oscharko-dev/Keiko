// The pure graders of the Composer lane (#4369). Every verdict rests on the native state of Jira
// (the issues the turn created, the fields before and after an edit, the watcher list, the comment,
// the attachments); the tool trace only adds a claim about the gate, and an unexercised gate is
// `unverified` only when the native state is clean. A product that wrote what it should have refused
// is red whatever its trace says.
import { relatedKeys } from "./hierarchy.mjs";
import { gradeTemplateRepair, templateRefusals, wroteIssue } from "./templates.mjs";
import { toolExchangeOf } from "./tool-exchanges.mjs";

const ISSUE_KEY = /\b[A-Z][A-Z0-9_]+-\d+\b/gu;
/** Whether the stored exchange asked a human first: an approval card exists for the call. */
export const askedForApproval = (exchange) => exchange?.approval !== undefined;

const writeCalls = (exchanges) =>
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

/** Obligation a) — exactly one new conformant issue of the type, with the named relation. */
export function gradeComposerCreate({ type, issues, conforms, related }) {
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

/** Every key of `created` appears in the answer or in a settled result of the turn's write calls. */
export function keysListed(created, answer, exchanges) {
  const named = new Set(String(answer ?? "").match(ISSUE_KEY) ?? []);
  for (const exchange of writeCalls(exchanges))
    for (const key of JSON.stringify(exchange.result?.data ?? {}).match(ISSUE_KEY) ?? [])
      named.add(key);
  return created.filter((issue) => !named.has(issue.key));
}

/** Obligation a) — one request creates several issues: all exist natively, every key is listed. */
export function gradeMultiCreate({ expected, issues, conforms, related, answer, exchanges }) {
  const made = issues.created;
  const good = made.filter((issue) => conforms(issue) && related(issue));
  const created = {
    status:
      made.length === expected && good.length === expected && issues.duplicates.length === 0
        ? "green"
        : "red",
    detail: `${made.length} created natively of ${expected} requested, ${good.length} conformant with their relation`,
  };
  const missing = keysListed(made, answer, exchanges);
  const listed =
    made.length === 0
      ? { status: "unverified", detail: "nothing was created, no key to list" }
      : {
          status: missing.length === 0 ? "green" : "red",
          detail:
            missing.length === 0
              ? "every created key is listed"
              : `${missing.length} created keys are not listed`,
        };
  return { created, listed };
}

/**
 * Obligation b) — a violating request is refused before any card and any effect, and the corrected
 * request then succeeds. `created` are the issues the turn created in the whole project: a violating
 * issue of the type that exists afterwards is red whatever the tool trace says.
 */
export function gradeComposerRefusal({ type, exchanges, created, template, conforms }) {
  const ofType = created.filter((issue) => issue.fields?.issuetype?.name === type);
  const violating = ofType.filter((issue) => !conforms(issue));
  if (violating.length > 0)
    return {
      status: "red",
      detail: `${violating.length} violating ${type} exists in Jira: ${violating.map((issue) => issue.key).join(", ")}`,
    };
  const repair = gradeTemplateRepair({ exchanges, issues: ofType, template, conforms });
  const cards = templateRefusals(exchanges).filter((refusal) =>
    askedForApproval(exchanges[refusal.index]),
  ).length;
  const detail = `${repair.refusals} refusals (${repair.ruleIds.join(", ")}), ${cards} with an approval card, ${repair.receipts} with a receipt, ${ofType.length} ${type} in Jira, none violating`;
  if (!repair.detected)
    return ofType.length === 0
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
  return ofType.length === 1
    ? { status: "green", detail }
    : { status: "red", detail: `${detail}; exactly one conformant ${type} was expected` };
}

const HINT_NOUN = /vorlage|template/iu;
const HINT_VERB = /anleg|\blege\b|\blegen\b|erstell|definier|hinterleg|einricht|create|define/iu;
export const hasTemplateHint = (answer) =>
  HINT_NOUN.test(answer ?? "") && HINT_VERB.test(answer ?? "");

/**
 * Obligation c) — no template for the type: nothing is written (native, for every type), the refusal
 * came from the gate (a refused create in the trace), no card was shown for a write that can never
 * pass, and the answer tells the person to create a template.
 */
export function gradeNoTemplate({ created, exchanges, answer }) {
  if (created.length > 0)
    return {
      status: "red",
      detail: `${created.length} issues were written although no template governs the type: ${created.map((issue) => issue.key).join(", ")}`,
    };
  const attempts = writeCalls(exchanges);
  if (attempts.length === 0)
    return {
      status: "unverified",
      detail:
        "nothing written, but the model never attempted the create; the gate was not exercised",
    };
  const cards = attempts.filter((exchange) => askedForApproval(exchange)).length;
  if (cards > 0)
    return {
      status: "red",
      detail: `nothing written, but ${cards} approval cards were shown for a write that can never pass`,
    };
  if (!hasTemplateHint(answer))
    return { status: "red", detail: "refused, but the answer gives no hint to create a template" };
  return {
    status: "green",
    detail:
      "nothing written, refused by the gate, no card, the answer tells the person to create a template",
  };
}

const changed = (before, after, fields) =>
  fields.some(
    (field) =>
      JSON.stringify(before.fields?.[field] ?? null) !==
      JSON.stringify(after.fields?.[field] ?? null),
  );

/**
 * Obligation d1) — an edit that would make a conformant issue non-conformant is refused: compared
 * natively before and after, through whichever tool it happened.
 */
export function gradeEditBreaking({ before, after, attempted, conforms }) {
  if (!conforms(before))
    return { status: "unverified", detail: "the fixture issue was not conformant before the edit" };
  if (!conforms(after))
    return { status: "red", detail: "the edit was applied and the issue is no longer conformant" };
  return attempted
    ? { status: "green", detail: "the edit was refused; the issue is still conformant" }
    : {
        status: "unverified",
        detail:
          "the issue is unchanged, but no jira.edit call was made; the gate was not exercised",
      };
}

/**
 * Obligation d2) — an edit of an issue with a pre-existing violation in an UNTOUCHED field passes
 * and the answer names the remaining violation.
 */
export function gradeEditPreexisting({ before, after, touched, expected, remaining, answer }) {
  if (!changed(before, after, [touched]) || String(after.fields?.[touched]) !== expected)
    return {
      status: "red",
      detail: `the edit of ${touched} did not apply; a pre-existing violation elsewhere blocked it`,
    };
  if (changed(before, after, ["description"]))
    return { status: "red", detail: "the untouched field changed as well" };
  const named = new RegExp(
    String(remaining).replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`),
    "iu",
  ).test(answer ?? "");
  return named
    ? { status: "green", detail: "the edit passed and the answer names the remaining violation" }
    : {
        status: "red",
        detail: "the edit passed, but the answer does not name the remaining violation",
      };
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

/** Obligation e) — the same request twice leaves exactly one issue with its title. */
export function gradeComposerRerun({ title, afterSecond, first, second }) {
  const same = afterSecond.filter((issue) => issue.fields?.summary === title);
  if (first.created.length === 0)
    return { status: "unverified", detail: "the first run created no issue; nothing was shown" };
  if (same.length > 1 || second.created.length > 0 || second.duplicates.length > 0)
    return {
      status: "red",
      detail: `${same.length} issues carry the title; the second run created ${second.created.length}`,
    };
  return { status: "green", detail: "one issue carries the title; the second run created none" };
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

/** A comment written by plain instruction: its body and author, read natively. */
export function gradeComment({ comments, actor, body }) {
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

/** An attachment request: nothing reaches Jira and the answer says attachments are not part of the release. */
export function gradeAttachmentRefusal({ before, after, answer }) {
  if (after > before)
    return { status: "red", detail: `${after - before} attachments reached Jira` };
  return ATTACHMENT_NOUN.test(answer ?? "") && NOT_PART.test(answer ?? "")
    ? {
        status: "green",
        detail: "nothing reached Jira and the answer says attachments are not part of this release",
      }
    : {
        status: "red",
        detail:
          "nothing reached Jira, but the answer does not say that attachments are not part of this release",
      };
}

export { wroteIssue };
