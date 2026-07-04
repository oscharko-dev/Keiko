import {
  stripUnsafeFormatChars,
  type ContextAssumption,
  type ContextPreservedFact,
  type ContextProvenanceRef,
  type ContextUserConstraint,
} from "@oscharko-dev/keiko-contracts";
import { redact } from "@oscharko-dev/keiko-security";

import type { CompactionDigest } from "./compaction-helpers.js";

export interface StructuredCompactionEntry {
  readonly stableId: string;
  readonly content: string;
  readonly role?: "user" | "assistant" | undefined;
}

export interface StructuredCompactionDigestInput {
  readonly entries: readonly StructuredCompactionEntry[];
  readonly redactionSecrets?: readonly string[] | undefined;
}

interface DigestBuckets {
  readonly preservedFacts: ContextPreservedFact[];
  readonly assumptions: ContextAssumption[];
  readonly userConstraints: ContextUserConstraint[];
  readonly decisions: string[];
  readonly openQuestions: string[];
  readonly resolvedQuestionKeys: string[];
  readonly filesInspected: string[];
  readonly failingTests: string[];
  readonly droppedCategories: string[];
}

interface Classification {
  readonly kind:
    "fact" | "assumption" | "constraint" | "decision" | "question" | "resolved-question" | "other";
  readonly text: string;
}

const MAX_ITEMS_PER_BUCKET = 8;
const MAX_TEXT_CHARS = 260;
const SAFE_RELATIVE_PATH = /^\.?(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z][\w+.-]*$/u;
const FILE_REF_PATTERN =
  /(?:^|[\s`"'(])((?:\.\/)?(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z][\w+.-]*)(?::(\d+)(?::(\d+))?)?/gu;
const BACKTICK_SYMBOL_PATTERN = /`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)`/gu;
const CALL_SYMBOL_PATTERN = /\b([A-Za-z_$][\w$]*)\(\)/gu;
const ABSOLUTE_PATH_PATTERN = /(?:^|\s)(?:\/[\w.-]+(?:\/[\w.-]+)+|[A-Za-z]:\\[^\s]+)/u;
const ERROR_PATTERN = /\b(?:FAIL|Error|TypeError|ReferenceError|SyntaxError|AssertionError):?\b/u;
const SYMBOL_STOP_WORDS = new Set(["if", "for", "while", "switch", "return", "expect"]);
const EXPLICIT_CLASSIFICATIONS = new Map<string, Classification["kind"]>([
  ["fact", "fact"],
  ["known", "fact"],
  ["confirmed", "fact"],
  ["assumption", "assumption"],
  ["assume", "assumption"],
  ["constraint", "constraint"],
  ["requirement", "constraint"],
  ["decision", "decision"],
  ["decided", "decision"],
  ["open question", "question"],
  ["question", "question"],
  ["resolved question", "resolved-question"],
  ["answered question", "resolved-question"],
  ["closed question", "resolved-question"],
]);

export function buildStructuredCompactionDigest(
  input: StructuredCompactionDigestInput,
): CompactionDigest {
  const buckets = emptyBuckets();
  for (const entry of input.entries) {
    consumeEntry(buckets, entry, input.redactionSecrets ?? []);
  }
  return compactBuckets(buckets);
}

function emptyBuckets(): DigestBuckets {
  return {
    preservedFacts: [],
    assumptions: [],
    userConstraints: [],
    decisions: [],
    openQuestions: [],
    resolvedQuestionKeys: [],
    filesInspected: [],
    failingTests: [],
    droppedCategories: [],
  };
}

function consumeEntry(
  buckets: DigestBuckets,
  entry: StructuredCompactionEntry,
  redactionSecrets: readonly string[],
): void {
  const sourceRef: ContextProvenanceRef = { kind: "message", stableId: entry.stableId };
  if (entry.content.includes("```")) {
    pushUnique(
      buckets.droppedCategories,
      "code-block-content-omitted-structured-references-retained",
    );
  }
  if (ABSOLUTE_PATH_PATTERN.test(entry.content)) {
    pushUnique(buckets.droppedCategories, "absolute-path-references-omitted");
  }
  for (const rawLine of entry.content.split(/\r?\n/u)) {
    consumeLine(buckets, cleanLine(rawLine, redactionSecrets), sourceRef);
  }
}

function consumeLine(buckets: DigestBuckets, line: string, sourceRef: ContextProvenanceRef): void {
  if (line.length === 0) {
    return;
  }
  const classification = classifyLine(line);
  collectClassified(buckets, classification, sourceRef);
  if (classification.kind !== "assumption") {
    collectReferences(buckets, line, sourceRef);
  }
}

function cleanLine(rawLine: string, redactionSecrets: readonly string[]): string {
  const stripped = stripUnsafeFormatChars(rawLine).normalize("NFKC");
  return boundText(redact(stripped, redactionSecrets).replace(/\s+/gu, " ").trim());
}

function boundText(value: string): string {
  return value.length <= MAX_TEXT_CHARS
    ? value
    : `${value.slice(0, MAX_TEXT_CHARS - 1).trimEnd()}…`;
}

function classifyLine(line: string): Classification {
  const explicit = explicitClassification(line);
  if (explicit !== undefined) {
    return explicit;
  }
  if (
    /^(?:must|must not|do not|don't|never|always|required|required:|requirement)\b/iu.test(line)
  ) {
    return { kind: "constraint", text: line };
  }
  if (line.endsWith("?")) {
    return { kind: "question", text: line };
  }
  return { kind: "other", text: line };
}

function explicitClassification(line: string): Classification | undefined {
  const match =
    /^(fact|known|confirmed|assumption|assume|constraint|requirement|decision|decided|open question|question|resolved question|answered question|closed question)\s*[:=-]\s*(.+)$/iu.exec(
      line,
    );
  if (match === null) {
    return undefined;
  }
  const label = match[1]?.toLowerCase();
  const text = match[2]?.trim() ?? "";
  const kind = label === undefined ? undefined : EXPLICIT_CLASSIFICATIONS.get(label);
  if (kind === undefined || text.length === 0) {
    return undefined;
  }
  return { kind, text };
}

function collectClassified(
  buckets: DigestBuckets,
  classification: Classification,
  sourceRef: ContextProvenanceRef,
): void {
  if (classification.kind === "fact") {
    pushFact(buckets, { statement: classification.text, sourceRef });
  } else if (classification.kind === "assumption") {
    pushAssumption(buckets, classification.text);
  } else if (classification.kind === "constraint") {
    pushConstraint(buckets, { statement: classification.text, sourceRef });
  } else if (classification.kind === "decision") {
    pushUnique(buckets.decisions, classification.text);
  } else if (classification.kind === "question") {
    pushOpenQuestion(buckets, classification.text);
  } else if (classification.kind === "resolved-question") {
    resolveQuestion(buckets, classification.text);
  }
}

function collectReferences(
  buckets: DigestBuckets,
  line: string,
  sourceRef: ContextProvenanceRef,
): void {
  for (const ref of safeFileRefs(line)) {
    pushUnique(buckets.filesInspected, ref.path);
    if (ref.line !== undefined || ERROR_PATTERN.test(line)) {
      pushUnique(buckets.failingTests, ref.summary);
    }
  }
  for (const symbol of symbolsIn(line)) {
    pushFact(buckets, { statement: `Referenced symbol: ${symbol}`, sourceRef });
  }
}

function safeFileRefs(
  line: string,
): readonly { readonly path: string; readonly line?: number; readonly summary: string }[] {
  const refs: { readonly path: string; readonly line?: number; readonly summary: string }[] = [];
  for (const match of line.matchAll(FILE_REF_PATTERN)) {
    const path = match[1];
    if (path === undefined || !SAFE_RELATIVE_PATH.test(path) || path.includes("..")) {
      continue;
    }
    const startLine = match[2] === undefined ? undefined : Number.parseInt(match[2], 10);
    refs.push({
      path,
      summary: referenceSummary(path, startLine, line),
      ...(startLine === undefined ? {} : { line: startLine }),
    });
  }
  return refs;
}

function referenceSummary(path: string, lineNumber: number | undefined, line: string): string {
  const target = lineNumber === undefined ? path : `${path}:${String(lineNumber)}`;
  const error = ERROR_PATTERN.test(line) ? ` ${line}` : "";
  return boundText(`${target}${error}`);
}

function symbolsIn(line: string): readonly string[] {
  const symbols: string[] = [];
  for (const match of line.matchAll(BACKTICK_SYMBOL_PATTERN)) {
    collectSymbol(symbols, match[1]);
  }
  for (const match of line.matchAll(CALL_SYMBOL_PATTERN)) {
    collectSymbol(symbols, match[1]);
  }
  return symbols;
}

function collectSymbol(symbols: string[], value: string | undefined): void {
  if (value === undefined || SYMBOL_STOP_WORDS.has(value) || value.length > 80) {
    return;
  }
  pushUnique(symbols, value);
}

function pushFact(buckets: DigestBuckets, fact: ContextPreservedFact): void {
  if (buckets.preservedFacts.length >= MAX_ITEMS_PER_BUCKET) {
    return;
  }
  if (buckets.preservedFacts.some((entry) => entry.statement === fact.statement)) {
    return;
  }
  buckets.preservedFacts.push(fact);
}

function pushAssumption(buckets: DigestBuckets, statement: string): void {
  if (buckets.assumptions.length >= MAX_ITEMS_PER_BUCKET) {
    return;
  }
  if (buckets.assumptions.some((entry) => entry.statement === statement)) {
    return;
  }
  buckets.assumptions.push({
    statement,
    rationale: "Explicitly labeled as an assumption in compacted conversation text.",
    confidence: "medium",
  });
}

function pushConstraint(buckets: DigestBuckets, constraint: ContextUserConstraint): void {
  if (buckets.userConstraints.length >= MAX_ITEMS_PER_BUCKET) {
    return;
  }
  if (buckets.userConstraints.some((entry) => entry.statement === constraint.statement)) {
    return;
  }
  buckets.userConstraints.push(constraint);
}

function pushUnique(values: string[], value: string): void {
  if (values.length >= MAX_ITEMS_PER_BUCKET || values.includes(value)) {
    return;
  }
  values.push(value);
}

function pushOpenQuestion(buckets: DigestBuckets, question: string): void {
  if (questionWasResolved(buckets, question)) {
    return;
  }
  pushUnique(buckets.openQuestions, question);
}

function resolveQuestion(buckets: DigestBuckets, resolution: string): void {
  const key = questionKey(resolution);
  if (key.length === 0) {
    return;
  }
  pushUnique(buckets.resolvedQuestionKeys, key);
  removeResolvedOpenQuestions(buckets, key);
  pushUnique(buckets.decisions, `Resolved question: ${resolution}`);
}

function questionWasResolved(buckets: DigestBuckets, question: string): boolean {
  const key = questionKey(question);
  return (
    key.length > 0 &&
    buckets.resolvedQuestionKeys.some((resolved) => sameQuestionKey(key, resolved))
  );
}

function removeResolvedOpenQuestions(buckets: DigestBuckets, resolvedKey: string): void {
  for (let index = buckets.openQuestions.length - 1; index >= 0; index -= 1) {
    const candidate = buckets.openQuestions[index];
    if (candidate !== undefined && sameQuestionKey(questionKey(candidate), resolvedKey)) {
      buckets.openQuestions.splice(index, 1);
    }
  }
}

function sameQuestionKey(left: string, right: string): boolean {
  return left === right || left.includes(right) || right.includes(left);
}

function questionKey(text: string): string {
  const questionMark = text.indexOf("?");
  const question = questionMark < 0 ? text : text.slice(0, questionMark + 1);
  return question
    .replace(/^(?:open|resolved|answered|closed)\s+question\s*[:=-]\s*/iu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function compactBuckets(buckets: DigestBuckets): CompactionDigest {
  return {
    ...(buckets.preservedFacts.length > 0 ? { preservedFacts: buckets.preservedFacts } : {}),
    ...(buckets.assumptions.length > 0 ? { assumptions: buckets.assumptions } : {}),
    ...(buckets.userConstraints.length > 0 ? { userConstraints: buckets.userConstraints } : {}),
    ...(buckets.decisions.length > 0 ? { decisions: buckets.decisions } : {}),
    ...(buckets.openQuestions.length > 0 ? { openQuestions: buckets.openQuestions } : {}),
    ...(buckets.filesInspected.length > 0 ? { filesInspected: buckets.filesInspected } : {}),
    ...(buckets.failingTests.length > 0 ? { failingTests: buckets.failingTests } : {}),
    ...(buckets.droppedCategories.length > 0
      ? { droppedCategories: buckets.droppedCategories }
      : {}),
  };
}
