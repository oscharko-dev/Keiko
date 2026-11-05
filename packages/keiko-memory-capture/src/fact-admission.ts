// Whether a fact the model proposes is admitted. The model proposes; these checks decide, on the
// person's own words only. "Im Zweifel zu wenig": a check that cannot confirm a fact drops it, and
// the reason stays a closed value.

import { anyWordPattern, factWords, hasWord, isNegated, isPredicateWord } from "./fact-text.js";
import { looksLikePersonalIdentifier } from "./secret-patterns.js";

export const FACT_DROP_REASONS = [
  "no-evidence",
  "evidence-not-verbatim",
  "evidence-too-long",
  "not-clause-boundary",
  "question",
  "quoted",
  "hypothetical",
  "ironic",
  "negated-context",
  "uncertain",
  "not-self",
  "we-statement",
  "no-first-person",
  "third-party",
  "not-entailed",
  "polarity-changed",
  "personal-identifier",
] as const;

export type FactDropReason = (typeof FACT_DROP_REASONS)[number];

export const FACT_SUBJECTS = ["self", "other", "unclear"] as const;

export type FactSubject = (typeof FACT_SUBJECTS)[number];

export interface ProposedFact {
  readonly body: string;
  readonly evidence: string;
  readonly about: string;
}

export type FactAdmission =
  | {
      readonly admitted: true;
      readonly sentence: string;
      // No first-person word: "Ab jetzt lieber Listen". Such a fact only stands as a change of a
      // fact the person already stated, which the relation check decides.
      readonly subjectless: boolean;
      readonly confidence: number;
    }
  | { readonly admitted: false; readonly reason: FactDropReason };

const EVIDENCE_MAX_CHARS = 400;
const CLAUSE_PUNCTUATION = new Set([",", ";", ":", ".", "!", "?", "…", ")", "-", "–", "—"]);
const QUOTE_OPENERS = new Set(["„", "«", "‚"]);
const QUOTE_CLOSERS = new Set(["”", "»"]);
const QUOTE_TOGGLES = new Set(['"', "“"]);
const SENTENCE_END_RE = /[.!?…\n]/u;
const INNER_SENTENCE_RE = /[.!?…]\s+\p{Lu}/u;
const SUBORDINATE_LEAD_RE = /(?:^|[^\p{L}])(?:dass|that)\s*$/iu;
const CLAUSE_LEAD_RE = /(?:^|[\s,;:–—-])(?:dass|that|und|and|aber|but|doch|denn)\s*$/iu;
const CLAUSE_SPLIT_RE = /[,;:–—]/u;
// A claim can end where a joined clause begins: "... a local queue because ...".
const CLAUSE_FOLLOWER_RE =
  /^(?:weil|denn|da|wenn|und|aber|bis|because|since|when|and|but|until|till|through)(?![\p{L}\p{N}])/iu;

const FIRST_PERSON_RE = anyWordPattern([
  "ich",
  String.raw`mein(?:e|em|en|er|es)?`,
  "mir",
  "mich",
  "i",
  "my",
  "me",
  "mine",
]);
const WE_RE = anyWordPattern([
  "wir",
  String.raw`unser(?:e|em|en|er|es)?`,
  "uns",
  "we",
  "our",
  "ours",
]);
const CHANGE_WITHOUT_SUBJECT_RE = anyWordPattern([
  "ab jetzt",
  "ab sofort",
  "von nun an",
  "from now on",
]);

// A named person, or a person named through their relation to the operator. German capitalizes every
// noun, so a bare capitalized word says nothing; a title or a relation word does.
const TITLED_PERSON_RE = /(?:^|[^\p{L}])(?:Frau|Herrn?|Mrs?|Ms|Dr|Prof)\.?\s+\p{Lu}/u;
const RELATION_WORDS = [
  String.raw`kolleg(?:e|en|in|innen)`,
  String.raw`chef(?:in)?`,
  String.raw`vorgesetzte[rn]?`,
  String.raw`kund(?:e|en|in|innen)`,
  String.raw`mandant(?:en|in)?`,
  String.raw`partner(?:in)?`,
  "mann",
  "frau",
  "sohn",
  "tochter",
  "bruder",
  "schwester",
  "mutter",
  "vater",
  String.raw`freund(?:in)?`,
  String.raw`nachbar(?:in)?`,
  String.raw`mitarbeiter(?:in)?`,
  "team",
  String.raw`colleagues?`,
  String.raw`coworkers?`,
  "manager",
  "boss",
  String.raw`clients?`,
  String.raw`customers?`,
  "wife",
  "husband",
  "son",
  "daughter",
  "brother",
  "sister",
  "mother",
  "father",
  String.raw`friends?`,
  String.raw`neighbou?rs?`,
  String.raw`employees?`,
];
const RELATION_RE = anyWordPattern([
  String.raw`(?:mein(?:e|em|en|er|es)?|my|unser(?:e|em|en|er|es)?|our)\s+(?:\p{L}+\s+)?(?:${RELATION_WORDS.join("|")})`,
]);

const HYPOTHETICAL_RE = anyWordPattern([
  "wenn",
  "falls",
  "angenommen",
  "stell dir vor",
  "if",
  "suppose",
  "imagine",
  "hypothetically",
]);
const LEADING_CONDITION_RE = /^\s*(?:wenn|falls|angenommen|if|suppose|imagine)(?![\p{L}])/iu;
const SUBJUNCTIVE_RE = anyWordPattern([
  "würden?",
  "wuerden?",
  "hätten?",
  "haetten?",
  "wären?",
  "waeren?",
  "könnte",
  "koennte",
  "would",
  "could",
  "might",
  "should have",
]);
const IRONY_RE = anyWordPattern([
  "ja total",
  "ja klar",
  "na klar",
  "natürlich nicht",
  "natuerlich nicht",
  "haha",
  "hihi",
  "lol",
  "yeah right",
  "as if",
  "oh great",
  "oh toll",
]);
const IRONIC_OPENING_RE = /^\s*(?:klar|sure|toll|great),/iu;
const UNCERTAIN_RE = anyWordPattern([
  "vielleicht",
  "möglicherweise",
  "moeglicherweise",
  "weiss nicht",
  "weiß nicht",
  "keine ahnung",
  "bin nicht sicher",
  "maybe",
  "perhaps",
  "not sure",
  "do not know",
  "don['’]t know",
  "no idea",
  "although no",
]);
const CONTEXT_NEGATION_RE = anyWordPattern([
  "nicht",
  String.raw`kein(?:e|en|er|em)?`,
  "nie",
  "not",
  "never",
  "falsch",
  "false",
  "wrong",
  "unwahr",
]);
const REPORTED_SPEECH_RE = anyWordPattern([
  "sagte?",
  "meinte?",
  "behauptete?",
  "says",
  "said",
  "claims",
  "claimed",
  "told me",
]);

function sentenceAround(text: string, start: number, end: number): { from: number; to: number } {
  let from = start;
  while (from > 0 && !SENTENCE_END_RE.test(text.charAt(from - 1))) from -= 1;
  let to = end;
  while (to < text.length && !SENTENCE_END_RE.test(text.charAt(to))) to += 1;
  return { from, to: Math.min(text.length, to + 1) };
}

function startsAtClause(text: string, start: number, sentenceFrom: number): boolean {
  if (start === sentenceFrom) return true;
  const before = text.slice(sentenceFrom, start);
  const last = before.trimEnd().at(-1);
  if (last === undefined || CLAUSE_PUNCTUATION.has(last) || isQuote(last)) return true;
  return CLAUSE_LEAD_RE.test(before);
}

function endsAtClause(text: string, end: number): boolean {
  const last = text.charAt(end - 1);
  if (CLAUSE_PUNCTUATION.has(last)) return true;
  const rest = text.slice(end).trimStart();
  const next = rest.at(0);
  if (next === undefined || CLAUSE_PUNCTUATION.has(next) || isQuote(next)) return true;
  return CLAUSE_FOLLOWER_RE.test(rest);
}

function isQuote(char: string): boolean {
  return QUOTE_OPENERS.has(char) || QUOTE_CLOSERS.has(char) || QUOTE_TOGGLES.has(char);
}

function isInsideQuotes(before: string): boolean {
  let open = false;
  for (const char of before) {
    if (QUOTE_OPENERS.has(char)) open = true;
    else if (QUOTE_CLOSERS.has(char)) open = false;
    else if (QUOTE_TOGGLES.has(char)) open = !open;
  }
  return open;
}

function isHypothetical(evidence: string, prefix: string): boolean {
  // A condition behind the claim is part of it ("Ich bevorzuge Tabellen, wenn du ..."). One that
  // opens the claim leaves the claim itself open.
  return (
    SUBJUNCTIVE_RE.test(evidence) ||
    HYPOTHETICAL_RE.test(prefix) ||
    LEADING_CONDITION_RE.test(evidence)
  );
}

// "Es stimmt nicht, dass ich ..." denies the claim. A separate clause before it does not.
function isDeniedByPrefix(prefix: string): boolean {
  if (REPORTED_SPEECH_RE.test(prefix)) return true;
  if (SUBORDINATE_LEAD_RE.test(prefix)) return CONTEXT_NEGATION_RE.test(prefix);
  return CONTEXT_NEGATION_RE.test(prefix.split(CLAUSE_SPLIT_RE).at(-1) ?? "");
}

function contextDropReason(
  evidence: string,
  sentence: string,
  prefix: string,
): FactDropReason | null {
  if (sentence.trimEnd().endsWith("?") || evidence.includes("?")) return "question";
  if (isHypothetical(evidence, prefix)) return "hypothetical";
  if (IRONY_RE.test(sentence) || IRONIC_OPENING_RE.test(sentence)) return "ironic";
  if (UNCERTAIN_RE.test(sentence)) return "uncertain";
  return isDeniedByPrefix(prefix) ? "negated-context" : null;
}

function subjectDropReason(about: string, evidence: string): FactDropReason | null {
  if (about.trim().toLowerCase() !== "self") return "not-self";
  if (TITLED_PERSON_RE.test(evidence) || RELATION_RE.test(evidence)) return "third-party";
  if (WE_RE.test(evidence)) return "we-statement";
  if (FIRST_PERSON_RE.test(evidence) || CHANGE_WITHOUT_SUBJECT_RE.test(evidence)) return null;
  return "no-first-person";
}

function entailmentDropReason(body: string, evidence: string): FactDropReason | null {
  const evidenceWords = factWords(evidence);
  const bodyWords = factWords(body);
  const carried = bodyWords.filter((word) => hasWord(evidenceWords, word));
  const invented = bodyWords.filter((word) => !hasWord(evidenceWords, word));
  if (carried.length === 0 || invented.some((word) => !isPredicateWord(word))) {
    return "not-entailed";
  }
  return isNegated(body) === isNegated(evidence) ? null : "polarity-changed";
}

// Derived from what the checks saw, never taken from the model, so results stay comparable across
// models. The explicit path's 1.0 stays out of reach; repetition raises strength, not this number.
function derivedConfidence(body: string, evidence: string, subjectless: boolean): number {
  const bodyWords = factWords(body);
  const evidenceWords = factWords(evidence);
  const covered = evidenceWords.filter((word) => hasWord(bodyWords, word)).length;
  const coverage = evidenceWords.length === 0 ? 0 : covered / evidenceWords.length;
  const subjectBonus = subjectless ? 0 : 0.15;
  const coverageBonus = coverage >= 0.5 ? 0.1 : 0;
  return 0.6 + subjectBonus + coverageBonus;
}

function spanDropReason(evidence: string, text: string): FactDropReason | null {
  if (evidence.length === 0) return "no-evidence";
  if (evidence.length > EVIDENCE_MAX_CHARS) return "evidence-too-long";
  if (!text.includes(evidence)) return "evidence-not-verbatim";
  return INNER_SENTENCE_RE.test(evidence) ? "not-clause-boundary" : null;
}

function dropped(reason: FactDropReason): FactAdmission {
  return { admitted: false, reason };
}

export function admitProposedFact(fact: ProposedFact, userText: string): FactAdmission {
  const evidence = fact.evidence.trim();
  const spanReason = spanDropReason(evidence, userText);
  if (spanReason !== null) return dropped(spanReason);
  const start = userText.indexOf(evidence);
  const end = start + evidence.length;
  const { from, to } = sentenceAround(userText, start, end);
  if (!startsAtClause(userText, start, from) || !endsAtClause(userText, end)) {
    return dropped("not-clause-boundary");
  }
  if (isInsideQuotes(userText.slice(0, start))) return dropped("quoted");
  const sentence = userText.slice(from, to);
  if (looksLikePersonalIdentifier(evidence) || looksLikePersonalIdentifier(fact.body)) {
    return dropped("personal-identifier");
  }
  const reason =
    contextDropReason(evidence, sentence, userText.slice(from, start)) ??
    subjectDropReason(fact.about, evidence) ??
    entailmentDropReason(fact.body.trim(), evidence);
  if (reason !== null) return dropped(reason);
  const subjectless = !FIRST_PERSON_RE.test(evidence);
  return {
    admitted: true,
    sentence,
    subjectless,
    confidence: derivedConfidence(fact.body, evidence, subjectless),
  };
}
