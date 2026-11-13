import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import { jiraMutationToolId } from "./atlassian/jiraMutationToolId.js";
import { chatToolDraftReceipts, chatToolIssueKey } from "./chat-tool-receipts.js";

/**
 * Two ways a Jira answer can claim an action that did not happen (#4355 AC4), both decided without
 * a model: an answer that announces an issue was created although this turn holds no created
 * receipt, and an answer that writes a tool call as text, which nothing executed. The detector is
 * narrow on purpose: a missed claim is variance the lab classifies, a wrongly corrected truthful
 * answer costs a round and a confusing instruction. Documented non-goals, never detected: a claim
 * in a language other than English or German, a creation named without an issue-like object ("I did
 * it"), a claim split over two sentences, and an announced edit, comment or transition.
 *
 * Rule for a correction that coincides with another one (knowledge coverage, report coverage): the
 * claimed-action correction wins and the single correction round is answered without any tool.
 * The other correction is still stated in that round's message but cannot be acted on with a tool:
 * a round that could write must never follow a false claim of a write.
 */

type ObjectSide = "after" | "before" | "inside";
interface Creation {
  readonly pattern: RegExp;
  /** Where the created object stands: after an active verb, before a passive one, or inside it. */
  readonly object: ObjectSide;
}
const CREATION: readonly Creation[] = [
  { pattern: /\b(?:i|we)(?:'ve| have) (?:created|added(?! up)|filed)\b/iu, object: "after" },
  { pattern: /\b(?:i|we) (?:created|added(?! up)|filed)\b/iu, object: "after" },
  { pattern: /\bbeen created\b/iu, object: "before" },
  { pattern: /\b(?:was|were) created\b/iu, object: "before" },
  { pattern: /\bsuccessfully created\b/iu, object: "after" },
  { pattern: /\bwurden? (?:\p{L}+ )?(?:angelegt|erstellt)\b/iu, object: "before" },
  { pattern: /\bhabe\b[^.!?\n]{0,60}\b(?:angelegt|erstellt)\b/iu, object: "inside" },
  { pattern: /\b(?:legte|erstellte) ich\b/iu, object: "after" },
];
const ISSUE_OBJECTS = [
  /\b(?:epics?|tasks?|bugs?|issues?|tickets?)\b/iu,
  /\b(?:stor(?:y|ies)|sub-?tasks?)\b/iu,
  /\b(?:vorg[aä]nge?n?|aufgaben?|teilaufgaben?)\b/iu,
  /\bfehlermeldung(?:en)?\b/iu,
] as const;
/** Something else was made: a summary, a report, a list, a comment, a text, an analysis. */
const NOT_AN_ISSUE_WORDS: ReadonlySet<string> = new Set([
  "summary",
  "summaries",
  "overview",
  "overviews",
  "report",
  "reports",
  "list",
  "lists",
  "comment",
  "comments",
  "note",
  "notes",
  "file",
  "files",
  "text",
  "texts",
  "document",
  "documents",
  "draft",
  "drafts",
  "plan",
  "plans",
  "table",
  "tables",
  "analysis",
  "analyses",
  "result",
  "results",
  "answer",
  "answers",
  "übersicht",
  "übersichten",
  "uebersicht",
  "uebersichten",
  "tabelle",
  "tabellen",
  "bericht",
  "berichte",
  "berichten",
  "liste",
  "listen",
  "zusammenfassung",
  "zusammenfassungen",
  "kommentar",
  "kommentare",
  "kommentaren",
  "notiz",
  "notizen",
  "datei",
  "dateien",
  "dokument",
  "dokumente",
  "dokumenten",
  "entwurf",
  "entwürfe",
  "entwuerfe",
  "entwürfen",
  "texte",
  "texten",
  "auswertung",
  "auswertungen",
  "analyse",
  "analysen",
  "ergebnis",
  "ergebnisse",
  "ergebnissen",
  "antwort",
  "antworten",
]);

function makesSomethingElse(window: string): boolean {
  return (window.toLowerCase().match(/\p{L}+/gu) ?? []).some((word) =>
    NOT_AN_ISSUE_WORDS.has(word),
  );
}
const WINDOW_CHARS = 60;
/** How many words after an active creation verb the created object may stand ("I created the 3 tasks"). */
const OBJECT_WORDS_MAX = 4;
/** Words and phrases that make a sentence a refusal, a question, a plan or a condition. */
const NEGATING_WORDS: ReadonlySet<string> = new Set([
  "not",
  "never",
  "no",
  "cannot",
  "can't",
  "couldn't",
  "wasn't",
  "weren't",
  "won't",
  "would",
  "will",
  "should",
  "shall",
  "if",
  "unable",
  "from",
  "nicht",
  "kein",
  "keine",
  "konnte",
  "könnte",
  "werde",
  "würde",
  "wuerde",
  "soll",
  "sollte",
  "falls",
  "wenn",
  "noch",
  "aus",
  "anhand",
]);
const NEGATING_PHRASES = ["could not", "based on", "out of"] as const;
/** Third-person or dated history: who created it and when, or a quoted Created field. */
const HISTORY = [
  /\bcreated\s+(?:by|on|at|in|from)\b/iu,
  /\b(?:angelegt|erstellt)\s+(?:von|am|um)\b/iu,
  /\bcreated\s*:/iu,
] as const;
/** A back-reference to something made earlier in the conversation. */
const BACK_REFERENCE =
  /\b(?:above|earlier|previously|before|already|oben|zuvor|vorhin|bereits|schon)\b/iu;
const ISSUE_KEY = /\b[A-Z][A-Z0-9_]{0,63}-\d{1,12}\b/gu;
const TEXT_CALLS = [
  /\b(?:jira|knowledge)_[a-z][a-z_]*\s*\(\s*[{"'[]/giu,
  /["']name["']\s*:\s*["'](?:jira|knowledge)_[a-z_]+["']/giu,
  /<(?:tool_call|function_call)>/giu,
] as const;
const SENTENCE_END = /(?<=[.!?])\s+|\n+/u;
const COUNT_MAX = 99;

function negated(sentence: string): boolean {
  if (sentence.includes("?")) return true;
  const lower = sentence.toLowerCase();
  if (NEGATING_PHRASES.some((phrase) => lower.includes(phrase))) return true;
  return (lower.match(/[\p{L}']+/gu) ?? []).some((word) => NEGATING_WORDS.has(word));
}

/** The text around a creation where its object stands. */
function objectWindow(sentence: string, match: RegExpExecArray, side: ObjectSide): string {
  const start = match.index;
  const end = start + match[0].length;
  if (side === "inside") return match[0];
  if (side === "before") return sentence.slice(Math.max(0, start - WINDOW_CHARS), start);
  const words = sentence.slice(end, end + WINDOW_CHARS).split(/\s+/u);
  return words.slice(0, OBJECT_WORDS_MAX + 1).join(" ");
}

function createsAnIssue(sentence: string): boolean {
  return CREATION.some(({ pattern, object }) => {
    const match = pattern.exec(sentence);
    if (match === null) return false;
    const window = objectWindow(sentence, match, object);
    return !makesSomethingElse(window) && ISSUE_OBJECTS.some((noun) => noun.test(window));
  });
}

/** The key as a whole key: KEIKO-1 is not found inside KEIKO-12. */
function holdsKey(haystack: string, key: string): boolean {
  for (let at = haystack.indexOf(key); at >= 0; at = haystack.indexOf(key, at + 1)) {
    const before = haystack.charAt(at - 1);
    const after = haystack.charAt(at + key.length);
    if (!/[A-Za-z0-9_-]/u.test(before) && !/\d/u.test(after)) return true;
  }
  return false;
}

function namesKnownKey(sentence: string, known: () => string): boolean {
  const keys = sentence.match(ISSUE_KEY) ?? [];
  return keys.some((key) => holdsKey(known(), key));
}

function announces(sentence: string, known: () => string): boolean {
  return (
    !negated(sentence) &&
    !HISTORY.some((pattern) => pattern.test(sentence)) &&
    !BACK_REFERENCE.test(sentence) &&
    createsAnIssue(sentence) &&
    !namesKnownKey(sentence, known)
  );
}

/** The operations whose receipt is a created issue; an edit or a comment with an issue key is not. */
const CREATING_OPERATIONS: ReadonlySet<string> = new Set([
  jiraMutationToolId("jira.create"),
  jiraMutationToolId("jira.create-issues"),
]);
/** The producer's outcomes that mean an issue may exist now (a lost answer, a failed link attach). */
const ISSUE_EXISTS_OUTCOMES: ReadonlySet<unknown> = new Set(["succeeded", "succeeded-unconfirmed"]);

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function namesAnIssueKey(data: unknown): boolean {
  const keys = record(data)?.issueKeys;
  return chatToolIssueKey(data) !== undefined || (Array.isArray(keys) && keys.length > 0);
}

/** A creating operation's receipt: a key, or an acknowledged write whose answer was lost. */
function creatingReceipt(exchange: ChatToolExchange): boolean {
  const result = record(exchange.result);
  const canonicalId = record(result?.toolRef)?.canonicalId;
  if (typeof canonicalId !== "string" || !CREATING_OPERATIONS.has(canonicalId)) return false;
  return exchange.mutationOutcome === "succeeded-unconfirmed" || namesAnIssueKey(result?.data);
}

/**
 * Whether this turn holds a created receipt, decided by the producer's own effect: a draft with a
 * created or uncertain row, or a creating operation that settled with a key or unconfirmed.
 */
function holdsCreatedReceipt(exchanges: readonly ChatToolExchange[]): boolean {
  return exchanges.some((exchange) => {
    if (!ISSUE_EXISTS_OUTCOMES.has(exchange.mutationOutcome)) return false;
    const rows = chatToolDraftReceipts(exchange);
    if (rows !== undefined)
      return rows.some((row) => row.state === "created" || row.state === "uncertain");
    return creatingReceipt(exchange);
  });
}

/**
 * How many sentences announce a created issue although this turn holds no created receipt. A
 * sentence about an issue key that a tool result or an earlier message already holds, one that
 * refers back to earlier work, one that gives who or when, and one that makes something else (a
 * summary) announce nothing.
 */
export function announcedCreateCount(
  exchanges: readonly ChatToolExchange[],
  answer: string,
  context: readonly string[] = [],
): number {
  if (holdsCreatedReceipt(exchanges)) return 0;
  let known: string | undefined;
  const lazyKnown = (): string => {
    const results = exchanges.map((exchange) => JSON.stringify(exchange.result ?? ""));
    known ??= `${context.join("\n")}\n${results.join("\n")}`;
    return known;
  };
  const sentences = answer.split(SENTENCE_END);
  return Math.min(COUNT_MAX, sentences.filter((sentence) => announces(sentence, lazyKnown)).length);
}

/** How many tool calls the answer wrote as text; nothing executed them. */
export function toolCallsWrittenAsText(answer: string): number {
  const found = TEXT_CALLS.reduce((sum, pattern) => sum + [...answer.matchAll(pattern)].length, 0);
  return Math.min(COUNT_MAX, found);
}

/** The corrections ask for an honest answer; they never ask for a write. */
export function announcedCreateCorrection(count: number): string {
  return (
    `Your answer says ${String(count)} time(s) that a Jira issue was created, but no Jira issue was ` +
    "created in this turn. Say plainly what happened and what the person can ask for; do not " +
    "create or change anything now."
  );
}

export function toolCallAsTextCorrection(count: number): string {
  return (
    `Your answer contains ${String(count)} tool call(s) written as text. That text did not call a ` +
    "tool and nothing was executed. Say plainly what happened and what the person can ask for; do " +
    "not create or change anything now."
  );
}

/** The kinds of claimed-action correction; a round that carries one is answered without any tool. */
const CLAIMED_ACTION_KINDS: ReadonlySet<string> = new Set([
  "announced-create",
  "tool-call-as-text",
]);
export function correctionRoundOffersTools(kinds: readonly string[]): boolean {
  return !kinds.some((kind) => CLAIMED_ACTION_KINDS.has(kind));
}

const GERMAN_MARKERS =
  /[äöüß]|\b(?:und|der|die|das|nicht|bitte|ich|ein|eine|erstelle|lege|mir|für)\b/iu;
const NOTICES = {
  en: {
    "announced-create": "Note from Keiko: no Jira issue was created in this turn.",
    "tool-call-as-text":
      "Note from Keiko: a tool call written as text in this answer was not executed.",
  },
  de: {
    "announced-create": "Hinweis von Keiko: In diesem Durchgang wurde kein Jira-Vorgang angelegt.",
    "tool-call-as-text":
      "Hinweis von Keiko: Ein als Text geschriebener Tool-Aufruf in dieser Antwort wurde nicht ausgeführt.",
  },
} as const;

/**
 * The one fixed sentence the published answer carries when its claim could not be corrected (the
 * correction round failed or repeated the claim), in the language of the person's last message.
 */
export function claimNotice(
  kinds: readonly ("announced-create" | "tool-call-as-text")[],
  personText: string,
): string {
  const language = GERMAN_MARKERS.test(personText) ? "de" : "en";
  return kinds.map((kind) => NOTICES[language][kind]).join(" ");
}
