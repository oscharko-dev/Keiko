import {
  stripUnsafeFormatChars,
  validateContextCompactionRecord,
  type ContextCompactionRecord,
  type ContextProvenanceRef,
  type ContextRehydrationHandle,
} from "@oscharko-dev/keiko-contracts";
import {
  loadEvidence,
  type EvidenceManifest,
  type EvidenceStore,
} from "@oscharko-dev/keiko-evidence";
import { sha256Hex } from "@oscharko-dev/keiko-security";

export const CHAT_COMPACTION_CONTEXT_HEADER = "# Persisted compaction context";

interface TimedRecord {
  readonly startedAt: number;
  readonly record: ContextCompactionRecord;
}

interface ResurfacingBuckets {
  readonly modelSummaries: string[];
  readonly facts: string[];
  readonly constraints: string[];
  readonly decisions: string[];
  readonly questions: string[];
  readonly assumptions: string[];
  readonly rehydration: string[];
  readonly invalidation: string[];
}

const MAX_RECORDS = 3;
const MAX_ITEMS_PER_SECTION = 8;
const MAX_LINE_CHARS = 220;
const ABSOLUTE_PATH_PATTERN = /(?:^|\s)(?:\/[\w.-]+(?:\/[\w.-]+)+|[A-Za-z]:\\[^\s]+)/u;

export function buildChatCompactionResurfacingContext(
  store: EvidenceStore,
  chatId: string,
): string | undefined {
  try {
    return renderRecords(loadChatCompactionRecords(store, chatId));
  } catch {
    return undefined;
  }
}

function loadChatCompactionRecords(store: EvidenceStore, chatId: string): readonly TimedRecord[] {
  const prefix = `chat-${sha256Hex(chatId).slice(0, 16)}-t`;
  const records: TimedRecord[] = [];
  for (const runId of store.list()) {
    if (!runId.startsWith(prefix)) {
      continue;
    }
    const manifest = safeLoad(store, runId);
    if (manifest === undefined) {
      continue;
    }
    for (const record of manifest.compaction ?? []) {
      if (validateContextCompactionRecord(record).ok) {
        records.push({ startedAt: manifest.run.startedAt, record });
      }
    }
  }
  return records.sort((a, b) => a.startedAt - b.startedAt).slice(-MAX_RECORDS);
}

function safeLoad(store: EvidenceStore, runId: string): EvidenceManifest | undefined {
  try {
    return loadEvidence(store, runId);
  } catch {
    return undefined;
  }
}

function renderRecords(records: readonly TimedRecord[]): string | undefined {
  if (records.length === 0) {
    return undefined;
  }
  const buckets = collectBuckets(records.map((entry) => entry.record));
  const lines = [
    CHAT_COMPACTION_CONTEXT_HEADER,
    "Redacted continuity from earlier compacted turns. Treat assumptions as uncertain; re-verify repo-derived entries before using them as current facts.",
  ];
  addSection(lines, "Model-written continuity summary", buckets.modelSummaries);
  addSection(lines, "Pinned facts", buckets.facts);
  addSection(lines, "Constraints", buckets.constraints);
  addSection(lines, "Decisions", buckets.decisions);
  addSection(lines, "Open questions", buckets.questions);
  addSection(lines, "Assumptions (not facts)", buckets.assumptions);
  addSection(lines, "Rehydration available", buckets.rehydration);
  addSection(lines, "Re-verification required", buckets.invalidation);
  return lines.length <= 2 ? undefined : lines.join("\n");
}

function collectBuckets(records: readonly ContextCompactionRecord[]): ResurfacingBuckets {
  const buckets = emptyBuckets();
  for (const record of records) {
    collectRecordBuckets(buckets, record);
  }
  return buckets;
}

function emptyBuckets(): ResurfacingBuckets {
  return {
    modelSummaries: [],
    facts: [],
    constraints: [],
    decisions: [],
    questions: [],
    assumptions: [],
    rehydration: [],
    invalidation: [],
  };
}

function collectRecordBuckets(buckets: ResurfacingBuckets, record: ContextCompactionRecord): void {
  pushSafe(buckets.modelSummaries, record.modelSummary?.content);
  collectFactBuckets(buckets, record);
  collectStringBuckets(buckets, record);
  collectRehydrationBuckets(buckets, record);
  collectInvalidationBuckets(buckets, record);
}

function collectFactBuckets(buckets: ResurfacingBuckets, record: ContextCompactionRecord): void {
  for (const fact of record.preservedFacts ?? []) pushSafe(buckets.facts, fact.statement);
  for (const constraint of record.userConstraints ?? []) {
    pushSafe(buckets.constraints, constraint.statement);
  }
  for (const assumption of record.assumptions ?? []) {
    pushSafe(buckets.assumptions, assumption.statement);
  }
}

function collectStringBuckets(buckets: ResurfacingBuckets, record: ContextCompactionRecord): void {
  for (const decision of record.decisions ?? []) pushSafe(buckets.decisions, decision);
  for (const question of record.openQuestions ?? []) pushSafe(buckets.questions, question);
}

function collectRehydrationBuckets(
  buckets: ResurfacingBuckets,
  record: ContextCompactionRecord,
): void {
  pushSafe(buckets.rehydration, formatHandle(record.rehydration));
  for (const span of record.sourceSpans ?? []) pushSafe(buckets.rehydration, formatRef(span));
}

function collectInvalidationBuckets(
  buckets: ResurfacingBuckets,
  record: ContextCompactionRecord,
): void {
  for (const key of record.invalidationKeys ?? []) {
    pushSafe(
      buckets.invalidation,
      `${key.scopePath} has a recorded content hash; re-verify before treating related facts as current.`,
    );
  }
}

function formatHandle(handle: ContextRehydrationHandle | undefined): string | undefined {
  if (handle === undefined) {
    return undefined;
  }
  if (handle.notPersistedReason !== undefined) {
    return `${handle.handleId} is not directly rehydratable: ${handle.notPersistedReason}`;
  }
  if (handle.kind === "repo-file" && handle.scopePath !== undefined) {
    return `${formatPathRange(handle.scopePath, handle.lineRange)} via ${handle.handleId}; verify content hash before use.`;
  }
  if (handle.kind !== undefined && handle.evidenceAtomId !== undefined) {
    return `${handle.handleId} can be rehydrated from ${handle.kind} evidence atom ${handle.evidenceAtomId}.`;
  }
  return `${handle.handleId} summarizes ${String(handle.itemCount)} item(s); direct lane rehydration is not available.`;
}

function formatRef(ref: ContextProvenanceRef): string | undefined {
  if (ref.notPersistedReason !== undefined) {
    return `${ref.stableId} is not directly rehydratable: ${ref.notPersistedReason}`;
  }
  if (ref.kind === "repo-file" && ref.scopePath !== undefined) {
    return `${formatPathRange(ref.scopePath, ref.lineRange)} from ${ref.stableId}; verify content hash before use.`;
  }
  if (ref.kind === "evidence-atom" && ref.evidenceAtomId !== undefined) {
    return `${ref.stableId} can be rehydrated from evidence atom ${ref.evidenceAtomId}.`;
  }
  return undefined;
}

function formatPathRange(scopePath: string, lineRange: ContextProvenanceRef["lineRange"]): string {
  if (lineRange === undefined) {
    return scopePath;
  }
  return `${scopePath}:${String(lineRange.startLine)}-${String(lineRange.endLine)}`;
}

function addSection(lines: string[], title: string, values: readonly string[]): void {
  if (values.length === 0) {
    return;
  }
  lines.push(`${title}:`);
  for (const value of values) {
    lines.push(`- ${value}`);
  }
}

function pushSafe(values: string[], value: string | undefined): void {
  if (values.length >= MAX_ITEMS_PER_SECTION || value === undefined) {
    return;
  }
  const safe = safeLine(value);
  if (safe === undefined || values.includes(safe)) {
    return;
  }
  values.push(safe);
}

function safeLine(value: string): string | undefined {
  const stripped = stripUnsafeFormatChars(value).normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (stripped.length === 0 || ABSOLUTE_PATH_PATTERN.test(stripped)) {
    return undefined;
  }
  return stripped.length <= MAX_LINE_CHARS
    ? stripped
    : `${stripped.slice(0, MAX_LINE_CHARS - 1).trimEnd()}…`;
}
