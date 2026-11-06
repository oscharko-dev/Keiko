// Whether a fact the model proposes is admitted. The model proposes; these checks decide, on the
// person's own words only. "Im Zweifel zu wenig": a check that cannot confirm a fact drops it, and
// the reason stays a closed value.

import { anyWordPattern, factWords, hasWord, isNegated } from "./fact-text.js";
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

export const FACT_SUBJECTS = ["self", "team", "other", "unclear"] as const;

export type FactSubject = (typeof FACT_SUBJECTS)[number];

export interface ProposedFact {
  readonly body: string;
  readonly evidence: string;
  readonly about: string;
}

// What the person said just before this message, in their own words: the only place a pronoun in
// this message may point to ("Ich habe eine Regel für meine Berichte." then "Sie beginnen …").
export interface AdmissionContext {
  readonly previousUserText?: string | undefined;
}

export type FactAdmission =
  | {
      readonly admitted: true;
      readonly sentence: string;
      // The person's verbatim words the fact rests on: the model's span, opened at its clause.
      readonly evidence: string;
      // The person's own words for the fact, a leading pronoun replaced by what it stood for in
      // the previous message: what is stored, so no paraphrase replaces what they said.
      readonly claim: string;
      // "team" is the person's team or project as a whole; its fact belongs to the project.
      readonly subject: "self" | "team";
      // No first-person word: "Ab jetzt lieber Listen". Such a fact only stands as a change of a
      // fact the person already stated, which the relation check decides.
      readonly subjectless: boolean;
      readonly confidence: number;
    }
  | { readonly admitted: false; readonly reason: FactDropReason };

const EVIDENCE_MAX_CHARS = 400;
const CLAUSE_PUNCTUATION = new Set([",", ";", ":", ".", "!", "?", "…", ")", "-", "–", "—"]);
// A bracket opens an aside: "Ich mag Tee (aber Anna mag Kaffee)".
const BRACKET_OPENERS = new Set(["(", "["]);
const QUOTE_OPENERS = new Set(["„", "«", "‚"]);
const QUOTE_CLOSERS = new Set(["”", "»"]);
const QUOTE_TOGGLES = new Set(['"', "“"]);
const SENTENCE_END_RE = /[.!?…\n]/u;
const INNER_SENTENCE_RE = /[.!?…]\s+\p{Lu}/u;
const SUBORDINATE_LEAD_RE = /(?:^|[^\p{L}])(?:dass|that)\s*$/iu;
const CLAUSE_LEAD_RE = /(?:^|[\s,;:([–—-])(?:dass|that|und|and|aber|but|doch|denn)\s*$/iu;
const CLAUSE_SPLIT_RE = /[,;:–—]/u;
// The longest clause lead ("dass", "that") and the mark before it.
const CLAUSE_LEAD_REACH = 6;
// A claim can end where a joined clause begins: "... a local queue because ...".
const CLAUSE_FOLLOWER_RE =
  /^(?:weil|denn|da|wenn|und|aber|bis|because|since|when|and|but|until|till|through)(?![\p{L}\p{N}])/iu;

const FIRST_PERSON_RE = anyWordPattern([
  "ich",
  "mein(?:e|em|en|er|es)?",
  "mir",
  "mich",
  "i",
  "my",
  "me",
  "mine",
]);
const SUBJECT_RE = anyWordPattern(["ich", "i", "wir", "we"]);
const WE_RE = anyWordPattern(["wir", "unser(?:e|em|en|er|es)?", "uns", "we", "our", "ours"]);
// The person names the group as their team or project: "als Team", "in unserem Projekt", "our team".
// Another group's name is no marker: "The marketing team decided that we ship on Fridays".
const TEAM_MARKERS = [
  String.raw`als\s+team`,
  String.raw`im\s+(?:\p{L}+-)?(?:team|projekt)`,
  String.raw`unser(?:e|em|en|er|es)?\s+(?:\p{L}+\s+)?(?:\p{L}+-?)?(?:team|projekt|abteilung|firma|unternehmen)`,
  "(?:team|projekt|firmen)-?weit",
  String.raw`as\s+a\s+team`,
  String.raw`(?:in|on)\s+the\s+(?:team|project)`,
  String.raw`our\s+(?:\p{L}+\s+)?(?:team|project|department|company)(?!\s+(?:lead|leader|manager|owner)s?(?!\p{L}))`,
  "(?:team|project|company)-?wide",
];
const TEAM_MARKER_RE = anyWordPattern(TEAM_MARKERS);
const TEAM_MARKER_GLOBAL_RE = new RegExp(TEAM_MARKER_RE.source, "giu");
// "Wir und Anna nutzen Jira", "Anna und wir": the group includes someone named.
const WE_AND_OTHER_RES: readonly RegExp[] = [
  /(?:^|[,;:])\s*(?:wir|we)\s+(?:und|and)\s+(?!unser|our(?!\p{L}))\p{L}+/iu,
  /(?:^|[,;:])\s*\p{L}+\s+(?:und|and)\s+(?:wir|we)(?![\p{L}\p{N}])/iu,
];
// "Unser Team und Anna nutzen Jira": with the marker removed, the clause opens on "und Anna".
const MARKER_AND_OTHER_RE = /(?:^|[,;:])\s*(?:und|and)\s+\p{L}+/iu;
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
  "enkel(?:in|kinder)?",
  "oma",
  "opa",
  "onkel",
  "tante",
  "ehemann",
  "ehefrau",
  "verlobter?",
  "grand(?:ma|pa|mother|father|son|daughter)",
  "uncle",
  "aunt",
  "girlfriend",
  "boyfriend",
  "fianc[eé]e?",
];
// A role names a person only once something points at one: "der Kunde", "this colleague". "Ich
// arbeite mit Kunden" and "customer tickets" name a kind of work, not someone.
const ENGLISH_ROLE_WORDS = [
  "doctors?",
  "lawyers?",
  "therapists?",
  "colleagues?",
  "coworkers?",
  "boss",
  "customers?",
  "friends?",
  "neighbou?rs?",
  "employees?",
  "landlord",
  "landlady",
  "tenants?",
  "roommates?",
  "flatmates?",
  "teachers?",
];
const ROLE_WORDS = [
  "kolleg(?:e|en|in|innen)",
  "chef(?:in)?",
  "vorgesetzte[rn]?",
  "kund(?:e|en|in|innen)",
  "mandant(?:en|in)?",
  "freund(?:in)?",
  "nachbar(?:in|n)?",
  "mitarbeiter(?:in)?",
  "arzt",
  "ärztin",
  "aerztin",
  "anwalt",
  "anwältin",
  "anwaeltin",
  "therapeut(?:in)?",
  "vermieter(?:in)?",
  "mieter(?:in)?",
  "mitbewohner(?:in)?",
  "lehrer(?:in)?",
  ...ENGLISH_ROLE_WORDS,
];
const RELATION_WORDS = [...FAMILY_WORDS, ...ROLE_WORDS];
const DETERMINER =
  "(?:der|die|den|dem|des|ein|eine|einen|einem|einer|eines|dies(?:e|er|em|en|es)?|jen(?:e|er|em|en|es)|the|this|that|a|an)";
// These also name things ("desktop client", "Teamleiter"), so they only count behind a possessive.
const POSSESSIVE_ONLY_RELATION_WORDS = [
  "partner(?:in)?",
  "mann",
  "frau",
  "team",
  "manager",
  "clients?",
  "leute",
  "people",
  "menschen",
  "eltern",
  "kinder(?:n)?",
  "parents",
  "patient(?:en|innen|in)?",
  "sch(?:ü|ue)ler(?:in|innen|n)?",
  "student(?:en|in|innen)?",
  "nutzer(?:in|innen|n)?",
  "teammitglied(?:er|ern)?",
  "mitarbeitende[n]?",
  "patients?",
  "students?",
  "pupils?",
  "users?",
  "staff",
  "children",
  "kids",
];
const FAMILY_RE = anyWordPattern(FAMILY_WORDS);
// A person named through their relation to someone else: "Annas Chef", "Sam's boss".
// The name's capital is checked apart, since \p{Lu} matches either case under the /i flag.
const GENITIVE_RELATION_RE = new RegExp(
  String.raw`(?:^|[^\p{L}])(\p{L}+?)(?:s|['’]s)\s+(?:${[...RELATION_WORDS, ...POSSESSIVE_ONLY_RELATION_WORDS].join("|")})(?![\p{L}\p{N}])`,
  "giu",
);
const CAPITAL_START_RE = /^\p{Lu}/u;
// Words ending in "s" that are no one's name: "Das Team", "This client", "his manager", "Als Lehrerin".
const NOT_A_NAME = new Set([
  "al",
  "au",
  "bi",
  "un",
  "etwa",
  "eine",
  "meine",
  "deine",
  "seine",
  "unsere",
  "da",
  "de",
  "die",
  "thi",
  "hi",
  "it",
  "u",
  "a",
  "i",
  "wa",
  "ha",
  "alle",
  "jede",
]);
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
  "gesetzt den fall",
  "im fall",
  "es sei denn",
  "unless",
  "provided",
  "what if",
  "im falle",
  "sofern",
  "vorausgesetzt",
  "für den fall",
  "in case",
  "as long as",
  "even if",
]);
const LEADING_CONDITION_RE = /^\s*(?:wenn|falls|angenommen|if|suppose|imagine)(?!\p{L})/iu;
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
  "sollten?",
  "solltest",
  "should",
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
  // A hedge unless a preposition makes it a fact about the person: "Ich denke in Tabellen", "Ich
  // glaube an Gott", "I believe in testing". "Ich schätze Klarheit" values one plain object.
  String.raw`(?:glaube|denke|vermute)(?!\s+(?:in|an|auf|über|ueber|daran|dran)(?!\p{L}))`,
  String.raw`(?:schätze|schaetze)(?!\s+[\p{L}-]+(?:\s+[\p{L}-]+)?\s*[.!]?\s*$)`,
  String.raw`i\s+(?:think|believe|guess|suppose)(?!\s+(?:in|of|about)(?!\p{L}))`,
  String.raw`(?:think|guess|suppose)\s*$`,
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
  /(?<!\p{L})(?:(?:ge|be|ver|er|ent|zer)\p{Ll}{2,30}t|\p{Ll}{2,30}iert)(?![\p{L}\p{N}])/gu;
const PRESENT_STATE_PARTICIPLES: ReadonlySet<string> = new Set([
  "gewechselt",
  "migriert",
  "installiert",
  "aktiviert",
  "ersetzt",
  "gewählt",
  "gewaehlt",
  "getauscht",
  "konfiguriert",
  "eingerichtet",
  "umgestellt",
  "spezialisiert",
  "erkannt",
  "entdeckt",
  "gelernt",
]);

function hasPastParticiple(claim: string): boolean {
  for (const match of claim.matchAll(PAST_PARTICIPLE_RE)) {
    if (!PRESENT_STATE_PARTICIPLES.has(match[0])) return true;
  }
  return false;
}
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
const ME_AND_OTHER_RES: readonly RegExp[] = [
  /(?:^|[,;:])\s*\p{L}+\s+(?:und|and)\s+(?:ich|i)(?![\p{L}\p{N}])/iu,
  /(?:^|[,;:])\s*(?:ich|i)\s+(?:und|and)\s+\p{L}+(?![\p{L}\p{N}])/iu,
  /(?:^|[^\p{L}])\p{L}+\s+und\s+ich\s+\p{L}+en(?![\p{L}\p{N}])/iu,
  /(?:^|[^\p{L}])\p{L}+en\s+\p{L}+\s+und\s+ich(?![\p{L}\p{N}])/iu,
];
// A partner named by the relation itself: "Ich lebe mit Peter zusammen", "I am married to Sam".
// English marks no plural on the verb, so a capitalized word before "and I" is the pair anywhere:
// "Today Anna and I use Jira". Once the person spoke as "I", "and I" joins their own clauses: "I like
// Vim and I use Linux". The pronoun "I" itself is always capital.
const ENGLISH_PAIR_RE = /(?:^|[^\p{L}])\p{Lu}\p{Ll}+\s+and\s+I(?![\p{L}\p{N}])/u;
const ENGLISH_I_RE = /(?:^|[^\p{L}])I(?![\p{L}\p{N}])/u;
const PARTNER_RES: readonly RegExp[] = [
  /(?:^|[^\p{L}])(?:lebe|wohne)\s+mit\s+\S+\s+zusammen/iu,
  /(?:^|[^\p{L}])bin\s+mit\s+\S+\s+verheiratet/iu,
  /(?:^|[^\p{L}])(?:am|i['’]m)\s+married\s+to\s+(?!(?:my|a|an|the)\s)/iu,
  // "I live with Sam" names someone; "I live with legacy code" or "two cats" does not.
  /(?:^|[^\p{L}])[Ll]ives?\s+with\s+\p{Lu}\p{Ll}+\s*(?:[.,;!?]|$)/u,
  /(?:^|[^\p{L}])[Ll]ives?\s+with\s+\p{Lu}\p{Ll}+\s+(?:and|together)(?!\p{L})/u,
];
// Lower case only: the formal "Sie" and "Ihnen" address the reader, not someone else. A capital one
// opens the claim or a clause after a colon: "Er hilft mir".
const GERMAN_OTHER_PRONOUN_RES: readonly RegExp[] = [
  /(?:^|[^\p{L}])(?:er|sie|ihm|ihn|ihr|ihnen)(?![\p{L}\p{N}])/u,
  /(?:^|[.:;!?])\s*(?:Er|Sie|Ihm|Ihn|Ihr|Ihnen)(?![\p{L}\p{N}])/u,
];
const ENGLISH_OTHER_PRONOUN_RE = anyWordPattern(["he", "she", "him", "her", "they", "them"]);
// The claim ends where its reason, condition or time begins: in "Ich nutze Tabellen, weil sie
// übersichtlich sind" the "sie" is the tables. "Ich mag, dass sie pünktlich ist" keeps its object.
// Each alternative starts only at the first of a run of spaces, so a long run stays linear.
const CLAIM_END_RES: readonly RegExp[] = [
  /(?<![\s,])[,\s]\s*(?:weil|denn|obwohl|because|although|since)(?![\p{L}\p{N}])/iu,
  /(?<!\s),\s*(?:da|wenn|falls|sobald|as|when|if|while)(?![\p{L}\p{N}])/iu,
];
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
  "wünscht(?:e|en)?",
  "wuenscht(?:e|en)?",
  "verlangt(?:e|en)?",
  "bat",
  "baten",
  "fordert(?:e|en)?",
  "sagt(?:e|en)?",
  "meint(?:e|en)?",
  "mag",
  "mochte",
  "bevorzugt(?:e|en)?",
  "entschied",
  "entscheidet",
  "empfiehlt",
  "empfahl",
  "rät",
  "raet",
  "riet",
]);
const ENGLISH_ATTRIBUTION_RE = anyWordPattern([
  "want(?:s|ed)?",
  "ask(?:s|ed)?",
  "request(?:s|ed)?",
  "says?",
  "said",
  "insist(?:s|ed)?",
  "decide(?:s|d)?",
  "tells?",
  "told",
  // "likes" and "liked" have a subject; the bare "like" compares: "it feels like home".
  "likes",
  "liked",
  "prefer(?:s|red)?",
  "recommend(?:s|ed)?",
  "suggest(?:s|ed)?",
  "advise(?:s|d)?",
  "thinks?",
  "thought",
  "believe(?:s|d)?",
]);
// The person as the one who wants: "weil ich es so will". "mir" or "me" is someone telling them.
const FIRST_PERSON_SUBJECT_RE = anyWordPattern(["ich", "i"]);
// A thing or nobody in particular wants nothing of the person: "weil es so entschieden wurde",
// "weil das Tool es so will", "because it suggests". A role behind a determiner is judged as a role.
// "der", "die" or "the" may stand before a person ("weil der Peter es will", "the CTO"), so only a
// lower-case thing behind them is impersonal; "das" and "es" never name a person.
const IMPERSONAL_REASON_RE =
  /^\s*(?:es|das|dies\p{L}*|man|eines?|it|this|that|there)(?![\p{L}\p{N}])/iu;
const ARTICLE_BEFORE_THING_RE = /^\s*(?:[Tt]he|[Aa]n?)\s+\p{Ll}/u;
// Each conjunct of a reason has its own subject: "weil ich es will und Anna es mag".
const CONJUNCT_RE = /\s(?:und|oder|aber|and|or|but)\s/iu;
// An English role is a compound when a capital word follows: "Customer Relationship Tool".
const ENGLISH_ROLE_RE = anyWordPattern(ENGLISH_ROLE_WORDS);
const CAPITAL_WORD_RE = /^\s+\p{Lu}/u;
// The person's own role names a relation word without being about anyone else: "Ich bin Manager".
// "Ich bin der Chef von Anna" still names Anna, so a role followed by "von" or "of" stays.
const I_AM_DETERMINED = String.raw`(?:^|[^\p{L}])(?:ich bin|i am|i['’]m)\s+(?:(?:an?|the|ein|eine|der|die|das)\s+)?`;
const OWN_ROLE_RE = new RegExp(String.raw`${I_AM_DETERMINED}\p{L}+(?!\p{L})`, "giu");
// A role between people names the other one: "Ich bin der Vorgesetzte von Anna", "I'm Sam's boss".
// "I'm an employee of Foo" names an organization.
const ROLE_TOWARD_OTHER_RE = new RegExp(
  String.raw`${I_AM_DETERMINED}(?:${[
    "kolleg(?:e|in)",
    "chef(?:in)?",
    "vorgesetzte[r]?",
    "freund(?:in)?",
    "nachbar(?:in)?",
    "colleague",
    "coworker",
    "boss",
    "neighbou?r",
    "mentor",
  ].join("|")})\s+(?:von|of)\s+(\p{L}+)`,
  "giu",
);
// A person asking for something states no fact about themselves, even when the request names them:
// "Erkläre mir bitte Kafka", "Give me a summary". "Tabellen gefallen mir" keeps its object at the end.
const POLITE_REQUEST_RE = anyWordPattern(["bitte", "please"]);
// A preposition is no imperative: "Für mich sind Listen besser".
const IMPERATIVE_TO_ME_RE =
  /^\s*(?!(?:für|fuer|for|bei|mit|zu|von|to|with|by|wie|like)\s)\p{L}+\s+(?:mir|mich|me)(?![\p{L}\p{N}])/iu;
const CONTEXT_NEGATION_RE = anyWordPattern([
  "nicht",
  "kein(?:e|en|er|em)?",
  "nie",
  "not",
  "never",
  "falsch",
  "false",
  "wrong",
  "unwahr",
]);
// Plural or bare forms; after them a name may be an object ("then tell Anna"), so only a person
// before them counts: "They say …", "people think …".
const BARE_SPEECH_VERBS = new Set(["say", "tell", "think", "believe", "claim"]);
// Someone else's words or view framing the claim. A speech verb counts beside a person, a name or
// pronoun, never beside the person themselves: "Anna says I like tables", "…, sagt Anna", "Er
// sagte, ich …" are attributions; "I use Vim, I said" and "Claims Management" are not.
const SPEECH_VERBS = new Set([
  "sagt",
  "sagte",
  "sagten",
  "sagen",
  "meint",
  "meinte",
  "meinten",
  "behauptet",
  "behauptete",
  "glaubt",
  "glaubte",
  "denkt",
  "dachte",
  "erzählt",
  "erzählte",
  "erklärt",
  "erklärte",
  "says",
  "said",
  "tells",
  "told",
  "claims",
  "claimed",
  "thinks",
  "thought",
  "believes",
  "believed",
  "stated",
  "reckons",
  ...BARE_SPEECH_VERBS,
]);
const OTHER_PERSON_WORDS = new Set([
  "er",
  "sie",
  "ihr",
  "man",
  "du",
  "jemand",
  "niemand",
  "alle",
  "jeder",
  "viele",
  "leute",
  "he",
  "she",
  "they",
  "you",
  "everyone",
  "everybody",
  "someone",
  "somebody",
  "nobody",
  "people",
  "others",
]);
// A noun after one of these names someone even when typed in lower case: "the doctor", "mein chef".
const PERSON_DETERMINERS = new Set([
  "the",
  "a",
  "an",
  "my",
  "your",
  "his",
  "her",
  "our",
  "their",
  "every",
  "each",
  "der",
  "die",
  "den",
  "dem",
  "ein",
  "eine",
  "einem",
  "einen",
  "mein",
  "meine",
  "meinem",
  "dein",
  "deine",
  "sein",
  "seine",
  "ihre",
  "unser",
  "unsere",
]);
// The person speaking: "I told Anna", "sagte ich Anna" report the person's own words.
const SELF_SPEAKERS = new Set(["ich", "i", "wir", "we"]);
const NOT_A_PERSON = new Set([
  "ich",
  "i",
  "wir",
  "we",
  "mir",
  "me",
  "mich",
  "uns",
  "us",
  "es",
  "it",
  "das",
  "dies",
  "diese",
  "dieser",
  "dieses",
  "this",
  "that",
  "there",
  "was",
  "what",
]);
// Markers that name a source whatever stands beside them.
const ATTRIBUTION_MARKER_RE = anyWordPattern([
  "zufolge",
  "angeblich",
  "anscheinend",
  "offenbar",
  "vermeintlich",
  "gemäß",
  String.raw`findet(?=\s*(?:,|dass(?!\p{L})))`,
  "according to",
  "supposedly",
  "allegedly",
  "reportedly",
  "apparently",
]);
// "laut" is also "loud"; as attribution it names someone: "Laut Anna", "laut meinem Chef".
const ATTRIBUTED_RE =
  /(?:^|[^\p{L}])[Ll]aut\s+(?:\p{Lu}|(?:mein(?:em|er)?|ihr|ihm|ihnen|dem|der|den)(?!\p{L}))/u;
// "hat Anna gesagt", "Man hat mir gesagt"; "Ehrlich gesagt" names nobody.
const SPEECH_PARTICIPLES = new Set(["gesagt", "erzählt", "gemeint", "behauptet"]);
const SPEECH_AUXILIARIES = new Set(["hat", "haben", "hatte", "hatten"]);
// Told by someone unnamed: "I was told …", "Mir wurde gesagt, …".
const PASSIVE_SPEECH_RE =
  /(?:^|[^\p{L}])(?:am|is|are|was|were|been|wird|werde|wurde|wurden)\s+(?:\p{L}+\s+)?(?:told|said|gesagt|erzählt)(?!\p{L})/iu;
// The first words of each later clause, an aside in brackets included.
// Each later clause up to the next mark, an aside in brackets included.
const CLAUSE_HEAD_RE = /[,;:–—(-]\s*(\p{L}+)[^,;:–—()]*/gu;
// A relative clause, reason or condition is no attribution: "…, which says nothing", "…, weil Anna
// es mir sagte", "…, wenn man sagt, was zu tun ist".
const RELATIVE_LEAD_RE =
  /^(?:which|that|who|whom|whose|where|because|since|when|whenever|if|der|die|das|den|dem|welche[rsmn]?|weil|da|wo|denn|obwohl|wenn|falls|sobald)$/iu;
// How far before a verb its speaker may stand: "Anna also says", "My boss always says".
const SPEAKER_REACH = 3;

function sentenceAround(text: string, start: number, end: number): { from: number; to: number } {
  let from = start;
  while (from > 0 && !SENTENCE_END_RE.test(text.charAt(from - 1))) from -= 1;
  if (end > start && SENTENCE_END_RE.test(text.charAt(end - 1))) return { from, to: end };
  let to = end;
  while (to < text.length && !SENTENCE_END_RE.test(text.charAt(to))) to += 1;
  return { from, to: Math.min(text.length, to + 1) };
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
  if (SUBORDINATE_LEAD_RE.test(prefix)) return CONTEXT_NEGATION_RE.test(prefix);
  return CONTEXT_NEGATION_RE.test(prefix.split(CLAUSE_SPLIT_RE).at(-1) ?? "");
}

// The part of the evidence that states the claim, without its reason, condition or time.
function claimClause(evidence: string): string {
  const ends = CLAIM_END_RES.map((pattern) => pattern.exec(evidence)?.index ?? evidence.length);
  return evidence.slice(0, Math.min(...ends));
}

// "Ich nutze Excel, weil es früher besser war" is about now; only the claim's own tense counts.
function isPast(evidence: string): boolean {
  const claim = claimClause(evidence);
  if (PAST_RE.test(claim) || PRETERITE_RE.test(claim)) return true;
  return PERFECT_AUXILIARY_RE.test(claim) && hasPastParticiple(claim);
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
            !IMPERSONAL_REASON_RE.test(part) &&
            !ARTICLE_BEFORE_THING_RE.test(part),
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

function speaksAsEnglishPair(evidence: string): boolean {
  const pair = ENGLISH_PAIR_RE.exec(evidence);
  return pair !== null && !ENGLISH_I_RE.test(evidence.slice(0, pair.index));
}

function capitalFollows(text: string, pattern: RegExp): boolean {
  return [...text.matchAll(pattern)].some((match) => {
    const name = match[1] ?? "";
    return CAPITAL_START_RE.test(name) && !NOT_A_NAME.has(name.toLowerCase());
  });
}

// "Annas Chef", "Ich bin der Vorgesetzte von Anna", "Ich lebe mit Peter zusammen".
function namesRelatedPerson(text: string): boolean {
  return (
    capitalFollows(text, GENITIVE_RELATION_RE) ||
    capitalFollows(text, ROLE_TOWARD_OTHER_RE) ||
    PARTNER_RES.some((pattern) => pattern.test(text))
  );
}

// Whether a text names someone other than the person. Private memory holds nothing about others.
export function namesOtherPerson(text: string): boolean {
  if (
    TITLED_PERSON_RE.test(text) ||
    RELATION_RE.test(text) ||
    namesRelatedPerson(text) ||
    reasonNamesOtherPerson(text)
  ) {
    return true;
  }
  const withoutOwnRole = text.replace(OWN_ROLE_RE, " ");
  return FAMILY_RE.test(withoutOwnRole) || pointsAtPerson(withoutOwnRole);
}

function claimNamesOtherPronoun(evidence: string): boolean {
  const claim = claimClause(evidence);
  return (
    GERMAN_OTHER_PRONOUN_RES.some((pattern) => pattern.test(claim)) ||
    ENGLISH_OTHER_PRONOUN_RE.test(claim)
  );
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
  // A condition is read up to the first word about the person, so "Es hilft mir, wenn ich …" keeps
  // its trailing condition; attribution is read up to the subject ("My colleague says I …").
  const framing = `${prefix}${openingTo(evidence, [FIRST_PERSON_RE, WE_RE]) ?? ""}`;
  if (isHypothetical(evidence, framing)) return "hypothetical";
  if (IRONY_RE.test(sentence) || IRONIC_OPENING_RE.test(sentence)) return "ironic";
  if (UNCERTAIN_RE.test(sentence)) return "uncertain";
  if (isPast(evidence)) return "past-statement";
  const opening = `${prefix}${openingToSubject(evidence)}`;
  const rest = sentence.slice(prefix.length);
  return isDeniedByPrefix(prefix) || isReported(opening, rest) ? "negated-context" : null;
}

// Attribution before the person's subject, or in a later clause: "Anna also says I …", "Dass ich
// Tabellen mag, sagt Anna", "I use Vim, hat mein Chef gesagt". Before the subject the person cannot
// be the speaker, so any speech verb counts unless "ich" or "I" stands right before it ("Wie ich
// sagte, …"); in a later clause another person must stand by the verb.
function isReported(opening: string, rest: string): boolean {
  // Being told is never the person's own statement, wherever the passive stands: "I am told I …".
  if (PASSIVE_SPEECH_RE.test(opening) || PASSIVE_SPEECH_RE.test(rest)) return true;
  if (namesSource(opening) || speaksInOpening(splitWords(opening))) return true;
  return [...rest.matchAll(CLAUSE_HEAD_RE)].some(
    (head) => !RELATIVE_LEAD_RE.test(head[1] ?? "") && speaksInClause(head[0]),
  );
}

function namesSource(text: string): boolean {
  return ATTRIBUTION_MARKER_RE.test(text) || ATTRIBUTED_RE.test(text);
}

function splitWords(text: string): readonly string[] {
  return text.split(/[^\p{L}]+/u);
}

function speaksInOpening(words: readonly string[]): boolean {
  return words.some(
    (word, at) =>
      (SPEECH_VERBS.has(word) && !SELF_SPEAKERS.has(words[at - 1]?.toLowerCase() ?? "")) ||
      (SPEECH_PARTICIPLES.has(word) && saidInPerfect(words, at)),
  );
}

function speaksInClause(clause: string): boolean {
  if (namesSource(clause)) return true;
  const words = splitWords(clause);
  return words.some(
    (word, at) =>
      (SPEECH_VERBS.has(word) && speaksForAnother(words, at)) ||
      (SPEECH_PARTICIPLES.has(word) && saidInPerfect(words, at)),
  );
}

// "hat Anna gesagt", "Das hat mir mein Chef gesagt": the auxiliary stands up to four words before
// the participle, and another person stands beside it or between them.
function saidInPerfect(words: readonly string[], at: number): boolean {
  const aux = [1, 2, 3, 4]
    .map((back) => at - back)
    .find((index) => SPEECH_AUXILIARIES.has(words[index]?.toLowerCase() ?? ""));
  if (aux === undefined) return false;
  const around = [aux - 1, ...Array.from({ length: at - aux - 1 }, (_, step) => aux + 1 + step)];
  return around.some((index) => isOtherPerson(words, index));
}

// Another person stands shortly before the verb, or right after it while the person is not the one
// speaking.
function speaksForAnother(words: readonly string[], at: number): boolean {
  const before = Array.from({ length: SPEAKER_REACH }, (_, step) => at - 1 - step);
  if (before.some((index) => isOtherPerson(words, index))) return true;
  if (BARE_SPEECH_VERBS.has(words[at] ?? "")) return false;
  const neighbours = [words[at - 1], words[at + 1]].map((word) => word?.toLowerCase() ?? "");
  if (neighbours.some((word) => SELF_SPEAKERS.has(word))) return false;
  // "says the doctor", "sagt der Arzt": the person follows the determiner.
  const next = PERSON_DETERMINERS.has(neighbours[1] ?? "") ? at + 2 : at + 1;
  return isOtherPerson(words, next);
}

function isOtherPerson(words: readonly string[], at: number): boolean {
  const word = words[at];
  if (word === undefined || word === "") return false;
  const lower = word.toLowerCase();
  if (NOT_A_PERSON.has(lower)) return false;
  if (OTHER_PERSON_WORDS.has(lower) || /^\p{Lu}/u.test(word)) return true;
  return PERSON_DETERMINERS.has(words[at - 1]?.toLowerCase() ?? "");
}

// The words up to the person's own subject frame the claim like the words before it: "Anna says I
// like tables", "My colleague says I ...", "Stell dir vor, ich ...". A possessive or object form
// ("mein", "mir", "my") ends the opening only where no subject follows. A claim without either has
// no opening.
function openingToSubject(evidence: string): string {
  return openingTo(evidence, [SUBJECT_RE]) ?? openingTo(evidence, [FIRST_PERSON_RE, WE_RE]) ?? "";
}

function openingTo(evidence: string, patterns: readonly RegExp[]): string | null {
  const ends = patterns.flatMap((pattern) => {
    const match = pattern.exec(evidence);
    return match === null ? [] : [match.index + match[0].length];
  });
  return ends.length === 0 ? null : evidence.slice(0, Math.min(...ends));
}

// "Wir", "Anna und ich", "Today Anna and I": a statement for more than the person.
function speaksForMore(evidence: string): boolean {
  return (
    WE_RE.test(evidence) ||
    ME_AND_OTHER_RES.some((pattern) => pattern.test(evidence)) ||
    speaksAsEnglishPair(evidence)
  );
}

// "We decided as a team to release on Tuesdays": the team's fact, which never names anyone else.
// "Wir" alone may be a couple or a household ("Wir erwarten ein Kind"), so the person must name the
// group as their team or project; the marker itself names no one, the rest of the claim must not
// either.
function teamDropReason(evidence: string): FactDropReason | null {
  const rest = evidence.replace(TEAM_MARKER_GLOBAL_RE, " ");
  const pair =
    ME_AND_OTHER_RES.some((pattern) => pattern.test(rest)) ||
    WE_AND_OTHER_RES.some((pattern) => pattern.test(evidence)) ||
    MARKER_AND_OTHER_RE.test(rest) ||
    speaksAsEnglishPair(rest);
  if (pair || namesOtherPerson(rest) || claimNamesOtherPronoun(rest)) return "third-party";
  return WE_RE.test(evidence) && TEAM_MARKER_RE.test(evidence) ? null : "not-self";
}

function subjectDropReason(about: string, evidence: string): FactDropReason | null {
  const subject = about.trim().toLowerCase();
  if (subject === "team") return teamDropReason(evidence);
  if (subject !== "self") return "not-self";
  if (TITLED_PERSON_RE.test(evidence) || RELATION_RE.test(evidence)) return "third-party";
  if (speaksForMore(evidence)) return "we-statement";
  if (!FIRST_PERSON_RE.test(evidence) && !CHANGE_WITHOUT_SUBJECT_RE.test(evidence)) {
    return "no-first-person";
  }
  return namesOtherPerson(evidence) || claimNamesOtherPronoun(evidence) ? "third-party" : null;
}

// The person's words are what is stored, so the model's statement may paraphrase or translate them.
// It may not invert them: a statement that drops or adds a negation shows the model misread the
// fact, and its label for how the fact relates to a stored one cannot be trusted either.
function polarityDropReason(body: string, claim: string): FactDropReason | null {
  return isNegated(body) === isNegated(claim) ? null : "polarity-changed";
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

// "Sie beginnen immer mit einer Zusammenfassung" after "… meine Berichte": the claim's subject is the
// person's own thing only when the model's statement names it and the person named exactly that
// thing as theirs just before. "Diese" and "These" open a noun phrase and stand for nothing.
const LEADING_THING_PRONOUN_RE = /^(?:Sie|Es|They|It)\s+/u;
const OWN_THING_GLOBAL_RE = /(?:^|[^\p{L}])(mein(?:e|em|en|er|es)?|my)\s+(\p{L}+)/giu;
const LEADING_WORDS_RE = /^(?:(?:mein(?:e|em|en|er|es)?|my|die|der|das|the)\s+)?(\p{L}+)/iu;
// The subject form of the possessive the person used: "für meine Berichte" → "Meine Berichte".
const SUBJECT_POSSESSIVE: Readonly<Record<string, string>> = {
  my: "My",
  mein: "Mein",
  meine: "Meine",
  meiner: "Meine",
  meinen: "Meine",
  meinem: "Mein",
  meines: "Mein",
};

interface OwnThing {
  readonly possessive: string;
  readonly noun: string;
}

function ownThings(earlier: string): ReadonlyMap<string, OwnThing> {
  const things = new Map<string, OwnThing>();
  for (const match of earlier.matchAll(OWN_THING_GLOBAL_RE)) {
    const possessive = SUBJECT_POSSESSIVE[(match[1] ?? "").toLowerCase()] ?? "";
    const noun = match[2] ?? "";
    things.set(noun.toLowerCase(), { possessive, noun });
  }
  return things;
}

// The model must name which of the person's things the pronoun stands for: a pronoun alone may
// mean anyone, so a kept pronoun never resolves. The noun is taken from the person's own words.
function referent(body: string, earlier: string): string | null {
  const named = LEADING_WORDS_RE.exec(body.normalize("NFC").trim())?.[1];
  const thing = named === undefined ? undefined : ownThings(earlier).get(named.toLowerCase());
  return thing === undefined ? null : `${thing.possessive} ${thing.noun}`;
}

function resolvedClaim(body: string, evidence: string, context: AdmissionContext): string {
  const pronoun = LEADING_THING_PRONOUN_RE.exec(evidence);
  const earlier = context.previousUserText?.normalize("NFC");
  if (pronoun === null || earlier === undefined) return evidence;
  const thing = referent(body, earlier);
  return thing === null ? evidence : `${thing} ${evidence.slice(pronoun[0].length)}`;
}

function dropped(reason: FactDropReason): FactAdmission {
  return { admitted: false, reason };
}

export function admitProposedFact(
  fact: ProposedFact,
  spokenText: string,
  context: AdmissionContext = {},
): FactAdmission {
  // A decomposed "würde" must read like the composed one to every check below.
  const userText = spokenText.normalize("NFC");
  const evidence = fact.evidence.normalize("NFC").trim();
  const spanReason = spanDropReason(evidence, userText);
  if (spanReason !== null) return dropped(spanReason);
  const span = clauseSpan(userText, evidence);
  if (typeof span === "string") return dropped(span);
  const { start, from, words } = span;
  if (isInsideQuotes(userText.slice(0, start))) return dropped("quoted");
  const sentence = userText.slice(from, span.to);
  if (looksLikePersonalIdentifier(words) || looksLikePersonalIdentifier(fact.body)) {
    return dropped("personal-identifier");
  }
  const reason = contextDropReason(words, sentence, userText.slice(from, start));
  if (reason !== null) return dropped(reason);
  const claim = resolvedClaim(fact.body, words, context);
  return admittedClaim(fact, { claim, evidence: words, opensSentence: start === from }, sentence);
}

interface ClauseSpan {
  // Where the person's words open, after widening to their clause.
  readonly start: number;
  readonly from: number;
  readonly to: number;
  readonly words: string;
}

// Models often copy a clause without its first words: "decided as a team to release …" out of
// "We decided as a team to release …". The words are the person's either way, so the span opens at
// the start of its clause and every check reads that whole clause, never the fragment. Its end is
// not moved: a span that stops before "nicht" stays dropped.
function clauseSpan(text: string, evidence: string): ClauseSpan | FactDropReason {
  const copied = text.indexOf(evidence);
  const end = copied + evidence.length;
  const { from, to } = sentenceAround(text, copied, end);
  if (!endsAtClause(text, end)) return "not-clause-boundary";
  const start = clauseStart(text, { copied, end, sentenceFrom: from });
  return start === null ? "evidence-too-long" : { start, from, to, words: text.slice(start, end) };
}

interface CopiedSpan {
  readonly copied: number;
  readonly end: number;
  readonly sentenceFrom: number;
}

// Looks back no further than a span may reach, so a long message stays linear.
function clauseStart(text: string, { copied, end, sentenceFrom }: CopiedSpan): number | null {
  const limit = Math.max(sentenceFrom, end - EVIDENCE_MAX_CHARS);
  for (let at = copied; at >= limit && at > sentenceFrom; at -= 1) {
    if (opensWord(text, at) && opensClause(text, at, sentenceFrom)) return at;
  }
  if (limit > sentenceFrom) return null;
  let at = sentenceFrom;
  while (at < copied && /\s/u.test(text.charAt(at))) at += 1;
  return at;
}

// A mark with no space after it sits inside a word ("Home-Office"), so no word opens there.
function opensWord(text: string, at: number): boolean {
  const before = text.charAt(at - 1);
  if (/\s/u.test(text.charAt(at))) return false;
  return /\s/u.test(before) || isQuote(before) || BRACKET_OPENERS.has(before);
}

// A clause opens at its sentence's start, after a mark or quote, or after a lead such as "dass".
// Only the few characters a lead can occupy are read.
function opensClause(text: string, at: number, sentenceFrom: number): boolean {
  let gap = at;
  while (gap > sentenceFrom && /\s/u.test(text.charAt(gap - 1))) gap -= 1;
  if (gap === sentenceFrom) return true;
  const last = text.charAt(gap - 1);
  if (CLAUSE_PUNCTUATION.has(last) || BRACKET_OPENERS.has(last) || isQuote(last)) return true;
  return CLAUSE_LEAD_RE.test(text.slice(Math.max(sentenceFrom, gap - CLAUSE_LEAD_REACH), at));
}

// A span may end at a comma or dash; the stored fact does not: "Ich mag Tabellen," → "Ich mag Tabellen".
const TRAILING_MARKS = new Set([",", ";", ":", "-", "–", "—"]);

function withoutTrailingMarks(claim: string): string {
  let end = claim.length;
  while (
    end > 0 &&
    (TRAILING_MARKS.has(claim.charAt(end - 1)) || /\s/u.test(claim.charAt(end - 1)))
  ) {
    end -= 1;
  }
  return claim.slice(0, end);
}

// A clause taken from inside a sentence opens the stored fact: "…, ich bin Oliver" → "Ich bin Oliver".
function sentenceCase(claim: string): string {
  const first = claim.charAt(0);
  return first === first.toLowerCase() && first !== first.toUpperCase()
    ? first.toUpperCase() + claim.slice(1)
    : claim;
}

interface ClaimWords {
  readonly claim: string;
  readonly evidence: string;
  // The clause opens its sentence; one from inside it is stored with a capital first letter.
  readonly opensSentence: boolean;
}

function admittedClaim(
  fact: ProposedFact,
  { claim, evidence, opensSentence }: ClaimWords,
  sentence: string,
): FactAdmission {
  const reason =
    subjectDropReason(fact.about, claim) ?? polarityDropReason(fact.body.trim(), claim);
  if (reason !== null) return dropped(reason);
  const subject = fact.about.trim().toLowerCase() === "team" ? "team" : "self";
  const subjectless = subject === "self" && !FIRST_PERSON_RE.test(claim);
  return {
    admitted: true,
    sentence,
    evidence,
    claim: opensSentence ? withoutTrailingMarks(claim) : sentenceCase(withoutTrailingMarks(claim)),
    subject,
    subjectless,
    confidence: derivedConfidence(fact.body, claim, subjectless),
  };
}
