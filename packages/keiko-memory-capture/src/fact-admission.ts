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
  "request",
  "past-statement",
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
// A family word names one person even without "mein": "Tochter mag Pferde".
const FAMILY_WORDS = [
  "sohn",
  "tochter",
  "bruder",
  "schwester",
  "mutter",
  "vater",
  "wife",
  "husband",
  "son",
  "daughter",
  "brother",
  "sister",
  "mother",
  "father",
];
// A role names a person only once something points at one: "der Kunde", "this colleague". "Ich
// arbeite mit Kunden" and "customer tickets" name a kind of work, not someone.
const ROLE_WORDS = [
  String.raw`kolleg(?:e|en|in|innen)`,
  String.raw`chef(?:in)?`,
  String.raw`vorgesetzte[rn]?`,
  String.raw`kund(?:e|en|in|innen)`,
  String.raw`mandant(?:en|in)?`,
  String.raw`freund(?:in)?`,
  String.raw`nachbar(?:in|n)?`,
  String.raw`mitarbeiter(?:in)?`,
  String.raw`colleagues?`,
  String.raw`coworkers?`,
  "boss",
  String.raw`customers?`,
  String.raw`friends?`,
  String.raw`neighbou?rs?`,
  String.raw`employees?`,
];
const RELATION_WORDS = [...FAMILY_WORDS, ...ROLE_WORDS];
const DETERMINER = String.raw`(?:der|die|den|dem|des|ein|eine|einen|einem|einer|eines|dies(?:e|er|em|en|es)?|jen(?:e|er|em|en|es)|the|this|that|a|an)`;
// These also name things ("desktop client", "Teamleiter"), so they only count behind a possessive.
const POSSESSIVE_ONLY_RELATION_WORDS = [
  String.raw`partner(?:in)?`,
  "mann",
  "frau",
  "team",
  "manager",
  String.raw`clients?`,
];
const FAMILY_RE = anyWordPattern(FAMILY_WORDS);
const POINTED_ROLE_RE = anyWordPattern([
  String.raw`${DETERMINER}\s+(?:\p{L}+\s+)?(?:${ROLE_WORDS.join("|")})`,
]);
const RELATION_RE = anyWordPattern([
  String.raw`(?:mein(?:e|em|en|er|es)?|my|unser(?:e|em|en|er|es)?|our)\s+(?:\p{L}+\s+)?(?:${[...RELATION_WORDS, ...POSSESSIVE_ONLY_RELATION_WORDS].join("|")})`,
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
  "glaube",
  "denke",
  "vermute",
  "schätze",
  "schaetze",
  "i think",
  "i believe",
  "i guess",
  "i suppose",
]);
const PAST_RE = anyWordPattern([
  "früher",
  "frueher",
  "damals",
  "ehemals",
  "hatte",
  "war",
  "waren",
  "formerly",
  "previously",
  "used to",
  "in the past",
  "back then",
  "had",
  "was",
  "were",
]);
const PERFECT_AUXILIARY_RE = anyWordPattern(["habe"]);
// "Ich habe Excel genutzt" is over; "Ich habe zu Listen gewechselt" is the change itself. A participle
// is lower case, so a noun ("Gerät", "Gewohnheit") is none.
const PAST_PARTICIPLE_RE = /(?:^|[^\p{L}])ge(?!wechselt)\p{Ll}{2,30}t(?![\p{L}\p{N}])/u;
// "Ich nutzte Excel", "Damals verwendete ich", "I used Excel": the simple past next to the person.
const GERMAN_PRETERITE = String.raw`(?:${[
  "nutzte",
  "benutzte",
  "mochte",
  "wohnte",
  "lebte",
  "liebte",
  "spielte",
  "machte",
  "bevorzugte",
  "lernte",
  "hörte",
  "hoerte",
  "kaufte",
  "brauchte",
  "suchte",
  "kannte",
  "wollte",
  "schrieb",
  "las",
  "trank",
  "fand",
  "hieß",
  "hiess",
  "ging",
  "fuhr",
  "aß",
  "trug",
  "nahm",
  "blieb",
].join("|")}|\p{Ll}+(?:ierte|tete|dete|nete))`;
// A decision or a switch made in the past holds now: "I decided on a local queue".
const ENGLISH_PRETERITE = String.raw`(?:(?:always|often|usually|mostly|once|really|also|just)\s+)?(?!(?:decided|chose|switched|moved|changed|picked|settled|opted|committed|adopted|agreed)(?![\p{L}]))(?:\p{Ll}*[^\se]ed|\p{Ll}+ied|was|had|did|went|wrote|drank|ate|took|made|got|knew|thought|found|bought|spent|kept|became)`;
const PRETERITE_RE = anyWordPattern([
  String.raw`ich\s+${GERMAN_PRETERITE}`,
  String.raw`${GERMAN_PRETERITE}\s+ich`,
  String.raw`i\s+${ENGLISH_PRETERITE}`,
]);
// "Anna und ich nutzen Jira" speaks for two.
const ME_AND_OTHER_RE =
  /(?:^|[^\p{L}])(?:\p{L}+\s+(?:und|and)\s+(?:ich|i)|(?:ich|i)\s+(?:und|and)\s+\p{L}+)(?![\p{L}\p{N}])/iu;
// Lower case only: the formal "Sie" and "Ihnen" address the reader, not someone else.
// A capital one opens the claim: "Er hilft mir".
const GERMAN_OTHER_PRONOUN_RE =
  /(?:^|[^\p{L}])(?:er|sie|ihm|ihn|ihr|ihnen)(?![\p{L}\p{N}])|^\s*(?:Er|Sie|Ihm|Ihn|Ihr|Ihnen)(?![\p{L}\p{N}])/u;
const ENGLISH_OTHER_PRONOUN_RE = anyWordPattern(["he", "she", "him", "her", "they", "them"]);
// The claim ends where its reason, condition or time begins: in "Ich nutze Tabellen, weil sie
// übersichtlich sind" the "sie" is the tables. "Ich mag, dass sie pünktlich ist" keeps its object.
const CLAIM_END_RE =
  /(?:,\s*|\s+)(?:weil|denn|obwohl|because|although|since)(?![\p{L}\p{N}])|,\s*(?:da|wenn|falls|sobald|as|when|if|while)(?![\p{L}\p{N}])/iu;
// Someone else's wish or word: "weil Anna es wollte", "because they asked".
const ATTRIBUTION_RE = anyWordPattern([
  "wollte",
  "wollten",
  "wollen",
  "möchte",
  "moechte",
  String.raw`wünscht(?:e|en)?`,
  String.raw`wuenscht(?:e|en)?`,
  String.raw`verlangt(?:e|en)?`,
  "bat",
  "baten",
  String.raw`fordert(?:e|en)?`,
  String.raw`sagt(?:e|en)?`,
  String.raw`meint(?:e|en)?`,
  String.raw`entschied(?:en)?`,
  String.raw`wants?`,
  "wanted",
  "asked",
  "requested",
  String.raw`says?`,
  "said",
  "insisted",
  "decided",
  "told",
]);
const CLAUSE_RE =
  /[,;:–—]|(?:^|\s)(?:weil|denn|da|wenn|und|aber|because|since|when|and|but)(?=\s)/iu;
// The person's own role names a relation word without being about anyone else: "Ich bin Manager".
const OWN_ROLE_RE = /(?:^|[^\p{L}])(?:ich bin|i am|i['’]m)\s+(?:(?:an?|ein|eine)\s+)?\p{L}+/giu;
// A person asking for something states no fact about themselves, even when the request names them:
// "Erkläre mir bitte Kafka", "Give me a summary". "Tabellen gefallen mir" keeps its object at the end.
const POLITE_REQUEST_RE = anyWordPattern(["bitte", "please"]);
const IMPERATIVE_TO_ME_RE = /^\s*\p{L}+\s+(?:mir|mich|me)(?![\p{L}\p{N}])/iu;
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
  if (end > start && SENTENCE_END_RE.test(text.charAt(end - 1))) return { from, to: end };
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

// The part of the evidence that states the claim, without its reason, condition or time.
function claimClause(evidence: string): string {
  const end = CLAIM_END_RE.exec(evidence);
  return end === null ? evidence : evidence.slice(0, end.index);
}

// "Ich nutze Excel, weil es früher besser war" is about now; only the claim's own tense counts.
function isPast(evidence: string): boolean {
  const claim = claimClause(evidence);
  if (PAST_RE.test(claim) || PRETERITE_RE.test(claim)) return true;
  return PERFECT_AUXILIARY_RE.test(claim) && PAST_PARTICIPLE_RE.test(claim);
}

// A clause that reports a wish or word without the person in it: "weil Anna es wollte".
function attributesToOther(text: string): boolean {
  return text
    .split(CLAUSE_RE)
    .some((clause) => ATTRIBUTION_RE.test(clause) && !FIRST_PERSON_RE.test(clause));
}

// Whether a text names someone other than the person. Private memory holds nothing about others.
export function namesOtherPerson(text: string): boolean {
  if (TITLED_PERSON_RE.test(text) || RELATION_RE.test(text) || attributesToOther(text)) {
    return true;
  }
  const withoutOwnRole = text.replace(OWN_ROLE_RE, " ");
  return FAMILY_RE.test(withoutOwnRole) || POINTED_ROLE_RE.test(withoutOwnRole);
}

function claimNamesOtherPronoun(evidence: string): boolean {
  const claim = claimClause(evidence);
  return GERMAN_OTHER_PRONOUN_RE.test(claim) || ENGLISH_OTHER_PRONOUN_RE.test(claim);
}

// A question or a request asks for something; it states no fact.
function speechActDropReason(evidence: string, sentence: string): FactDropReason | null {
  if (sentence.trimEnd().endsWith("?") || evidence.includes("?")) return "question";
  if (POLITE_REQUEST_RE.test(evidence) || IMPERATIVE_TO_ME_RE.test(evidence)) return "request";
  return null;
}

function contextDropReason(
  evidence: string,
  sentence: string,
  prefix: string,
): FactDropReason | null {
  const speechAct = speechActDropReason(evidence, sentence);
  if (speechAct !== null) return speechAct;
  if (isHypothetical(evidence, prefix)) return "hypothetical";
  if (IRONY_RE.test(sentence) || IRONIC_OPENING_RE.test(sentence)) return "ironic";
  if (UNCERTAIN_RE.test(sentence)) return "uncertain";
  if (isPast(evidence)) return "past-statement";
  return isDeniedByPrefix(prefix) ? "negated-context" : null;
}

function subjectDropReason(about: string, evidence: string): FactDropReason | null {
  if (about.trim().toLowerCase() !== "self") return "not-self";
  if (TITLED_PERSON_RE.test(evidence) || RELATION_RE.test(evidence)) return "third-party";
  if (WE_RE.test(evidence) || ME_AND_OTHER_RE.test(evidence)) return "we-statement";
  if (!FIRST_PERSON_RE.test(evidence) && !CHANGE_WITHOUT_SUBJECT_RE.test(evidence)) {
    return "no-first-person";
  }
  return namesOtherPerson(evidence) || claimNamesOtherPronoun(evidence) ? "third-party" : null;
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
// A thin fact with no subject stays below the promotion gate, so it waits for approval when asked.
function derivedConfidence(body: string, evidence: string, subjectless: boolean): number {
  const bodyWords = factWords(body);
  const evidenceWords = factWords(evidence);
  const covered = evidenceWords.filter((word) => hasWord(bodyWords, word)).length;
  const coverage = evidenceWords.length === 0 ? 0 : covered / evidenceWords.length;
  const subjectBonus = subjectless ? 0 : 0.3;
  const coverageBonus = coverage >= 0.5 ? 0.15 : 0;
  return 0.4 + subjectBonus + coverageBonus;
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

export function admitProposedFact(fact: ProposedFact, spokenText: string): FactAdmission {
  // A decomposed "würde" must read like the composed one to every check below.
  const userText = spokenText.normalize("NFC");
  const evidence = fact.evidence.normalize("NFC").trim();
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
