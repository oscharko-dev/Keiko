import {
  explicitStatementKind,
  isMemoryForgetReference,
  sameFactWord,
  type CaptureMemoryResolver,
} from "@oscharko-dev/keiko-memory-capture";
import {
  personMemoryTags,
  type ConversationId,
  type MemoryRecord,
  type MemoryScope,
  type MemoryStatus,
} from "@oscharko-dev/keiko-contracts/memory";
import type { MemoryConversationTouch, MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";

const TARGETABLE_STATUSES: readonly MemoryStatus[] = [
  "accepted",
  "archived",
  "conflicted",
  "expired",
  "superseded",
];

// A parked proposal is still a kept fact, so forgetting it has to reach it. Update and correction
// stay on the settled statuses above.
const FORGET_TARGETABLE_STATUSES: readonly MemoryStatus[] = [...TARGETABLE_STATUSES, "proposed"];

// Words that carry no identity of a fact, in English and German. Verbs of liking belong here: a
// person says "dass ich Tabellen mag" about a memory that reads "Ich bevorzuge Tabellen".
const STOP_WORDS = new Set(
  [
    "a an about for i is it me memory my of please that the this to we",
    "like love prefer want",
    "alles an auf bitte das dass dein deine dem den der des dich die dies diese dieser dieses dir",
    "du ein eine einem einen einer es für ich im in ist mag mein meine meinem meinen meiner mich",
    "mir mit möchte oder sind über ueber und von vor wenn wir zu zum zur",
    "bevorzuge bevorzugen liebe will",
  ]
    .join(" ")
    .split(" "),
);

function normalizePhrase(value: string): string {
  return value
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function stemToken(token: string): string {
  const strippedPossessive = token.endsWith("'s") ? token.slice(0, -2) : token;
  const suffixes = ["ence", "ance", "ing", "ers", "ies", "ied", "ed", "es", "s"];
  for (const suffix of suffixes) {
    if (strippedPossessive.length > suffix.length + 2 && strippedPossessive.endsWith(suffix)) {
      return strippedPossessive.slice(0, -suffix.length);
    }
  }
  return strippedPossessive;
}

function tokenize(value: string): readonly string[] {
  return normalizePhrase(value)
    .split(/\s+/)
    .map(stemToken)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function tokensMatch(targetTokens: readonly string[], bodyTokens: readonly string[]): boolean {
  if (targetTokens.length === 0) {
    return false;
  }
  return targetTokens.every((target) =>
    bodyTokens.some(
      (body) => body === target || body.startsWith(target) || target.startsWith(body),
    ),
  );
}

function matchesTarget(target: string, record: MemoryRecord): boolean {
  const haystack = `${record.body} ${personMemoryTags(record.tags).join(" ")}`;
  const normalizedTarget = normalizePhrase(target);
  const normalizedHaystack = normalizePhrase(haystack);
  if (
    normalizedTarget.length > 0 &&
    (normalizedHaystack.includes(normalizedTarget) || normalizedTarget.includes(normalizedHaystack))
  ) {
    return true;
  }
  return tokensMatch(tokenize(target), tokenize(haystack));
}

// The resolver deliberately exposes records as well as ids. Update/forget extraction needs only
// ids, while correction review must revalidate each candidate's current status and revision before
// it can bind a supersession. Keeping one matcher prevents the two governed paths from drifting.
export function resolveMemoryTargetRecords(
  vault: MemoryVaultStore,
  target: string,
  scope: Parameters<CaptureMemoryResolver>[1],
): readonly MemoryRecord[] {
  return vault
    .listMemoriesByScope(scope, {
      status: TARGETABLE_STATUSES,
      includeExpired: true,
    })
    .filter((record) => matchesTarget(target, record));
}

export function createMemoryTargetResolver(vault: MemoryVaultStore): CaptureMemoryResolver {
  return (target, scope) =>
    resolveMemoryTargetRecords(vault, target, scope).map((record) => record.id);
}

export interface MemoryForgetResolverContext {
  readonly scopes: readonly MemoryScope[];
  readonly conversationId: ConversationId;
  // When the turn before this statement began. "Das" means what that turn left behind. Read only
  // for a bare reference, so an ordinary turn costs no history read.
  readonly lastTurnStartedAt: () => number | undefined;
  // The person's message of that turn, which a learned fact names as its source.
  readonly previousMessageId: () => string | undefined;
  // What the person said in that turn.
  readonly previousStatement: () => string | undefined;
}

// A memory the last turn only touched counts when that turn was about memory: its answer drew on
// the memory to answer a question, or the person said the fact again. After any other statement,
// "das" is the statement, not whatever the answer happened to draw on.
function lastTurnReachedMemory(statement: string | undefined): boolean {
  if (statement === undefined) return false;
  return statement.trimEnd().endsWith("?") || explicitStatementKind(statement) === "remember";
}

// Whether this conversation's last turn touched the memory. Each chat keeps its own latest touch, so
// another chat or maintenance touching it says nothing about "das" and cannot erase this chat's own
// touch. The person saying the fact again counts on its own, an answer drawing on it only after a
// turn about memory.
function reachedInLastTurn(
  touch: MemoryConversationTouch | undefined,
  startedAt: number,
  answerCounts: boolean,
): boolean {
  if (touch === undefined) return false;
  const confirmed = (touch.confirmedAt ?? -1) >= startedAt;
  const used = (touch.usedAt ?? -1) >= startedAt;
  return confirmed || (answerCounts && used);
}

// What the last turn left behind. A learned fact names the turn it came from, so a slow capture of
// an earlier turn that finishes later is not "das". Only an explicit record without that provenance
// falls back to its creation time.
function leftByLastTurn(
  record: MemoryRecord,
  previousMessageId: string | undefined,
  startedAt: number,
): boolean {
  const sources = record.provenance.sourceMessageIds;
  if (sources !== undefined) {
    return previousMessageId !== undefined && sources.includes(previousMessageId);
  }
  // A learned fact is written whenever learning runs, so its time says nothing about which turn it
  // came from; without its source message it is no "das". An explicit record is written by its turn.
  return record.provenance.evidenceSpan === undefined && record.createdAt >= startedAt;
}

function namesRecord(target: string, record: MemoryRecord): boolean {
  const body = tokenize(`${record.body} ${personMemoryTags(record.tags).join(" ")}`);
  const words = tokenize(target);
  return (
    words.length > 0 &&
    words.every((word) => body.some((candidate) => sameFactWord(word, candidate)))
  );
}

// What a bare "Vergiss das" refers to: what the last turn of this conversation left behind or drew
// on. When there is nothing, "das" is the last statement itself, not an older memory, and the caller
// handles that statement. More than one record stays more than one: the caller asks instead of
// guessing. Another conversation's memory is only "das" when the last turn reached it.
function referredRecords(
  vault: MemoryVaultStore,
  records: readonly MemoryRecord[],
  context: MemoryForgetResolverContext,
): readonly MemoryRecord[] {
  const ofConversation = records.filter(
    (record) => record.provenance.sourceConversationId === context.conversationId,
  );
  const lastTurnStartedAt = context.lastTurnStartedAt();
  // No earlier turn left anything behind, so an older record of this conversation is not "das".
  if (lastTurnStartedAt === undefined) return [];
  const previousMessageId = context.previousMessageId();
  const left = ofConversation.filter((record) =>
    leftByLastTurn(record, previousMessageId, lastTurnStartedAt),
  );
  const answerCounts = lastTurnReachedMemory(context.previousStatement());
  const touches = vault.getConversationTouches(context.conversationId);
  const reached = records.filter(
    (record) =>
      !left.includes(record) &&
      reachedInLastTurn(touches.get(record.id), lastTurnStartedAt, answerCounts),
  );
  return [...left, ...reached];
}

function recordsInScopes(
  vault: MemoryVaultStore,
  scopes: readonly MemoryScope[],
): readonly MemoryRecord[] {
  const byId = new Map<string, MemoryRecord>();
  for (const scope of scopes) {
    const records = vault.listMemoriesByScope(scope, {
      status: FORGET_TARGETABLE_STATUSES,
      includeExpired: true,
    });
    for (const record of records) byId.set(String(record.id), record);
  }
  return [...byId.values()];
}

// Searches every scope of the conversation, because the learner chose the scope and the person
// does not name it. Authorization stays with the one forget implementation that acts on the result.
export function createMemoryForgetResolver(
  vault: MemoryVaultStore,
  context: MemoryForgetResolverContext,
): CaptureMemoryResolver {
  return (target) => {
    const records = recordsInScopes(vault, context.scopes);
    const matches = isMemoryForgetReference(target)
      ? referredRecords(vault, records, context)
      : records.filter((record) => namesRecord(target, record));
    return matches.map((record) => record.id);
  };
}
