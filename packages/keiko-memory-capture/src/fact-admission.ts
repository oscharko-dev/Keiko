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
const ENGLISH_ROLE_WORDS = [
  String.raw`doctors?`,
  String.raw`lawyers?`,
  String.raw`therapists?`,
  String.raw`colleagues?`,
  String.raw`coworkers?`,
  "boss",
  String.raw`customers?`,
  String.raw`friends?`,
  String.raw`neighbou?rs?`,
  String.raw`employees?`,
];
const ROLE_WORDS = [
  String.raw`kolleg(?:e|en|in|innen)`,
  String.raw`chef(?:in)?`,
  String.raw`vorgesetzte[rn]?`,
  String.raw`kund(?:e|en|in|innen)`,
  String.raw`mandant(?:en|in)?`,
  String.raw`freund(?:in)?`,
  String.raw`nachbar(?:in|n)?`,
  String.raw`mitarbeiter(?:in)?`,
  "arzt",
  String.raw`ärztin`,
  String.raw`aerztin`,
  "anwalt",
  String.raw`anwältin`,
  String.raw`anwaeltin`,
  String.raw`therapeut(?:in)?`,
  ...ENGLISH_ROLE_WORDS,
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
// A person named through their relation to someone else: "Annas Chef", "Sam's boss".
const GENITIVE_RELATION_RE = new RegExp(
  String.raw`(?:^|[^\p{L}])\p{Lu}\p{L}*(?:s|['’]s)\s+(?:${[...RELATION_WORDS, ...POSSESSIVE_ONLY_RELATION_WORDS].join("|")})(?![\p{L}\p{N}])`,
  "iu",
);
const POINTED_ROLE_RE = new RegExp(
  String.raw`(?:^|[^\p{L}])${DETERMINER}\s+(?:\p{L}+\s+)?(${ROLE_WORDS.join("|")})(?![\p{L}\p{N}])`,
  "giu",
);
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
  // A hedge opens a claim: "Ich glaube, ich nutze Jira", "I think I use Jira". The same verb with an
  // object states a fact: "Ich schätze Klarheit", "Ich denke in Tabellen", "I believe in testing".
  String.raw`(?:glaube|denke|vermute|schätze|schaetze)(?=\s*(?:,|dass|ich|es|das|schon|mal|eher|wohl)(?![\p{L}]))`,
  String.raw`i\s+(?:think|believe|guess|suppose)(?!\s+(?:in|of|about)(?![\p{L}]))`,
  String.raw`(?:glaube|denke|vermute|schätze|schaetze|think|guess|suppose)\s*$`,
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
  // "I'm used to Vim" is a habit now.
  String.raw`(?<!(?:am|['’]m|be|get|got|is|are)\s)used to`,
  "in the past",
  "back then",
  "had",
  // German "was" is "what": "Ich nutze, was funktioniert". Only the English verb after its subject.
  String.raw`(?:i|it|this|that|there)\s+was`,
  String.raw`(?:we|they|you)\s+were`,
]);
const PERFECT_AUXILIARY_RE = anyWordPattern(["habe", "hab"]);
// "Ich habe Excel genutzt" or "verwendet" is over. A participle is lower case, so a noun ("Gerät",
// "Gewohnheit") is none. A change made holds now: "Ich habe zu Listen gewechselt".
const PAST_PARTICIPLE_RE =
  /(?:^|[^\p{L}])(?!(?:gewechselt|migriert|installiert|aktiviert|ersetzt|gewählt|gewaehlt|getauscht|konfiguriert|eingerichtet|umgestellt|spezialisiert|erkannt|entdeckt|gelernt)(?![\p{L}]))(?:(?:ge|be|ver|er|ent|zer)\p{Ll}{2,30}t|\p{Ll}{2,30}iert)(?![\p{L}\p{N}])/u;
// The simple past next to the person: "Ich nutzte Excel", "Damals verwendete ich", "I used Excel".
// Closed lists: an open "-ed" or "-te" ending also matches the present ("I embed", "ich arbeite").
// A decision or a switch made in the past holds now and is not on them.
const GERMAN_PRETERITE = String.raw`(?:${[
  "nutzte",
  "benutzte",
  "mochte",
  "wohnte",
  "lebte",
  "liebte",
  "hasste",
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
  "programmierte",
  "studierte",
  "entwickelte",
  "pflegte",
  "besaß",
  "besass",
  "leitete",
].join("|")}|\p{L}+(?:tete|dete|nete))`;
const ENGLISH_PRETERITE = String.raw`(?:(?:always|often|usually|mostly|once|really|also|just)\s+)?(?:${[
  "used",
  "liked",
  "preferred",
  "loved",
  "hated",
  "worked",
  "lived",
  "wanted",
  "needed",
  "owned",
  "enjoyed",
  "played",
  "studied",
  "was",
  "had",
  "did",
  "went",
  "wrote",
  "drank",
  "ate",
  "took",
  "made",
  "got",
  "knew",
  "thought",
  "found",
  "bought",
  "spent",
  "kept",
  "became",
  "coded",
  "managed",
  "developed",
  "led",
].join("|")})`;
const PRETERITE_RE = anyWordPattern([
  String.raw`ich\s+${GERMAN_PRETERITE}`,
  String.raw`${GERMAN_PRETERITE}\s+ich`,
  String.raw`i\s+${ENGLISH_PRETERITE}`,
]);
// "Anna und ich nutzen Jira" speaks for two: the pair opens its clause, or a plural verb follows.
// "Ich mag Tabellen und ich nutze Excel" joins two of the person's own clauses.
const ME_AND_OTHER_RE =
  /(?:(?:^|[,;:])\s*(?:\p{L}+\s+(?:und|and)\s+(?:ich|i)|(?:ich|i)\s+(?:und|and)\s+\p{L}+)|(?:^|[^\p{L}])\p{L}+\s+und\s+ich\s+\p{L}+en|(?:^|[^\p{L}])\p{L}+en\s+\p{L}+\s+und\s+ich)(?![\p{L}\p{N}])/iu;
// A partner named by the relation itself: "Ich lebe mit Peter zusammen", "I am married to Sam".
const PARTNER_RE =
  /(?:^|[^\p{L}])(?:(?:lebe|wohne)\s+mit\s+\S+\s+zusammen|bin\s+mit\s+\S+\s+verheiratet|(?:am|i['’]m)\s+married\s+to|(?:live|lives)\s+with\s+(?!(?:my|a|an|the)\s))/iu;
// Lower case only: the formal "Sie" and "Ihnen" address the reader, not someone else. A capital one
// opens the claim or a clause after a colon: "Er hilft mir".
const GERMAN_OTHER_PRONOUN_RE =
  /(?:^|[^\p{L}])(?:er|sie|ihm|ihn|ihr|ihnen)(?![\p{L}\p{N}])|(?:^|[.:;!?])\s*(?:Er|Sie|Ihm|Ihn|Ihr|Ihnen)(?![\p{L}\p{N}])/u;
const ENGLISH_OTHER_PRONOUN_RE = anyWordPattern(["he", "she", "him", "her", "they", "them"]);
// The claim ends where its reason, condition or time begins: in "Ich nutze Tabellen, weil sie
// übersichtlich sind" the "sie" is the tables. "Ich mag, dass sie pünktlich ist" keeps its object.
// Each alternative starts only at the first of a run of spaces, so a long run stays linear.
const CLAIM_END_RE =
  /(?<![\s,])[,\s]\s*(?:weil|denn|obwohl|because|although|since)(?![\p{L}\p{N}])|(?<!\s),\s*(?:da|wenn|falls|sobald|as|when|if|while)(?![\p{L}\p{N}])/iu;
// A reason that is someone else's wish, word or taste: "weil Anna es so will", "because they asked".
// Each language has its own words: English "will" is the future, German "will" a wish.
const GERMAN_REASON_RE =
  /(?:(?<![\p{L}\p{N}])(?:weil|denn)|(?:^|,)\s*da)\s+([^,;:.!?…\n]{1,300})/giu;
const ENGLISH_REASON_RE =
  /(?:(?<![\p{L}\p{N}])(?:because|since)|(?:^|,)\s*as)\s+([^,;:.!?…\n]{1,300})/giu;
const GERMAN_ATTRIBUTION_RE = anyWordPattern([
  "will",
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
  "mag",
  "mochte",
  String.raw`bevorzugt(?:e|en)?`,
  "entschied",
  "entscheidet",
  String.raw`empfiehlt`,
  "empfahl",
  String.raw`rät`,
  "raet",
  "riet",
]);
const ENGLISH_ATTRIBUTION_RE = anyWordPattern([
  String.raw`want(?:s|ed)?`,
  String.raw`ask(?:s|ed)?`,
  String.raw`request(?:s|ed)?`,
  String.raw`says?`,
  "said",
  String.raw`insist(?:s|ed)?`,
  String.raw`decide(?:s|d)?`,
  String.raw`tells?`,
  "told",
  // Not "like": "because it feels like home" compares, it wants nothing.
  String.raw`prefer(?:s|red)?`,
  String.raw`recommend(?:s|ed)?`,
  String.raw`suggest(?:s|ed)?`,
  String.raw`advise(?:s|d)?`,
  String.raw`thinks?`,
  "thought",
  String.raw`believe(?:s|d)?`,
]);
// The person as the one who wants: "weil ich es so will". "mir" or "me" is someone telling them.
const FIRST_PERSON_SUBJECT_RE = anyWordPattern(["ich", "i"]);
// A thing or nobody in particular wants nothing of the person: "weil es so entschieden wurde",
// "weil das Tool es so will", "because it suggests". A role behind a determiner is judged as a role.
const IMPERSONAL_REASON_RE =
  /^\s*(?:es|das|dies\p{L}*|man|der|die|den|dem|ein\p{L}*|it|this|that|there|the|a|an)(?![\p{L}\p{N}])/iu;
// Each conjunct of a reason has its own subject: "weil ich es will und Anna es mag".
const CONJUNCT_RE = /\s(?:und|oder|aber|and|or|but)\s/iu;
// An English role is a compound when a capital word follows: "Customer Relationship Tool".
const ENGLISH_ROLE_RE = anyWordPattern(ENGLISH_ROLE_WORDS);
const CAPITAL_WORD_RE = /^\s+\p{Lu}/u;
// The person's own role names a relation word without being about anyone else: "Ich bin Manager".
// "Ich bin der Chef von Anna" still names Anna, so a role followed by "von" or "of" stays.
const OWN_ROLE_RE =
  /(?:^|[^\p{L}])(?:ich bin|i am|i['’]m)\s+(?:(?:an?|the|ein|eine|der|die|das)\s+)?\p{L}+(?![\p{L}])(?!\s+(?:\p{L}+\s+)?(?:von|of|für|fuer|for)\s)/giu;
// A person asking for something states no fact about themselves, even when the request names them:
// "Erkläre mir bitte Kafka", "Give me a summary". "Tabellen gefallen mir" keeps its object at the end.
const POLITE_REQUEST_RE = anyWordPattern(["bitte", "please"]);
// A preposition is no imperative: "Für mich sind Listen besser".
const IMPERATIVE_TO_ME_RE =
  /^\s*(?!(?:für|fuer|for|bei|mit|zu|von|to|with|by|wie|like)\s)\p{L}+\s+(?:mir|mich|me)(?![\p{L}\p{N}])/iu;
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

// A reason in which someone else wants, says or likes something, and the person is not the one who
// does: "weil Anna es so will". Only a reason clause counts, so "Ich nutze Excel und möchte Tabellen"
// stays the person's own wish.
export function reasonNamesOtherPerson(text: string): boolean {
  const attributed = (pattern: RegExp, attribution: RegExp): boolean =>
    [...text.matchAll(pattern)].some((match) =>
      (match[1] ?? "")
        .split(CONJUNCT_RE)
        .some(
          (part) =>
            attribution.test(part) &&
            !FIRST_PERSON_SUBJECT_RE.test(part) &&
            !IMPERSONAL_REASON_RE.test(part),
        ),
    );
  return (
    attributed(GERMAN_REASON_RE, GERMAN_ATTRIBUTION_RE) ||
    attributed(ENGLISH_REASON_RE, ENGLISH_ATTRIBUTION_RE)
  );
}

// "der Kunde" or "this colleague" points at one person; "die Kunden-Tickets" and "the Customer
// Relationship Tool" name a thing.
function pointsAtPerson(text: string): boolean {
  return [...text.matchAll(POINTED_ROLE_RE)].some((match) => {
    const after = text.slice(match.index + match[0].length);
    if (after.startsWith("-")) return false;
    const role = match[1] ?? "";
    return !(ENGLISH_ROLE_RE.test(role) && /^\p{Lu}/u.test(role) && CAPITAL_WORD_RE.test(after));
  });
}

// Whether a text names someone other than the person. Private memory holds nothing about others.
export function namesOtherPerson(text: string): boolean {
  if (
    TITLED_PERSON_RE.test(text) ||
    RELATION_RE.test(text) ||
    GENITIVE_RELATION_RE.test(text) ||
    PARTNER_RE.test(text) ||
    reasonNamesOtherPerson(text)
  ) {
    return true;
  }
  const withoutOwnRole = text.replace(OWN_ROLE_RE, " ");
  return FAMILY_RE.test(withoutOwnRole) || pointsAtPerson(withoutOwnRole);
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
