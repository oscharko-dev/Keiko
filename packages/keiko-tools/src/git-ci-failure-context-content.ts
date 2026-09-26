import { stripVTControlCharacters } from "node:util";
import { redact } from "@oscharko-dev/keiko-security/redaction";
import {
  GIT_CI_FAILURE_MAX_ENTRIES,
  ciFailureCompleted,
  ciFailureObject,
  ciFailurePositive,
  type GitCiFailureCollection,
  type GitCiFailureContextEntry,
  type GitCiFailureContextInput,
  type GitCiFailureSource,
} from "./git-ci-failure-context-types.js";

function boundedText(text: string, bytes: number, collection: GitCiFailureCollection): string {
  if (Buffer.byteLength(text, "utf8") <= bytes) return text;
  collection.truncated = true;
  let result = "";
  let size = 0;
  for (const character of text) {
    size += Buffer.byteLength(character, "utf8");
    if (size > bytes - 3) break;
    result += character;
  }
  return `${result}…`;
}
function control(character: string): string {
  return character === "\n" || character === "\t" ? character : "";
}
function text(
  value: unknown,
  input: GitCiFailureContextInput,
  collection: GitCiFailureCollection,
  cap = 2_048,
): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new TypeError("Malformed CI diagnostic text");
  const clean = stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}]/gu, control);
  // Strip controls and redact the complete value BEFORE truncation can split a credential.
  const safe = redact(input.redactText?.(clean) ?? clean);
  return boundedText(safe, cap, collection);
}
function append(collection: GitCiFailureCollection, entry: GitCiFailureContextEntry): void {
  if (collection.entries.length >= GIT_CI_FAILURE_MAX_ENTRIES) collection.truncated = true;
  else collection.entries.push(entry);
}
export function addGitCiCheckSummary(
  value: Record<string, unknown>,
  source: GitCiFailureSource,
  input: GitCiFailureContextInput,
  collection: GitCiFailureCollection,
): void {
  const title = text(value.title, input, collection, 256);
  const summary = text(value.summary, input, collection);
  const detail = text(value.text, input, collection);
  const content = boundedText([summary, detail].filter(Boolean).join("\n"), 2_048, collection);
  if (title.length + content.length > 0)
    append(collection, {
      kind: "check-summary",
      sourceKind: source.kind,
      sourceId: source.id,
      title,
      text: content,
    });
}
export function addGitCiAnnotation(
  raw: unknown,
  source: GitCiFailureSource,
  input: GitCiFailureContextInput,
  collection: GitCiFailureCollection,
): void {
  if (
    !ciFailureObject(raw) ||
    !ciFailurePositive(raw.startLine) ||
    !ciFailurePositive(raw.endLine) ||
    raw.endLine < raw.startLine
  )
    throw new TypeError("Malformed CI annotation location");
  if (typeof raw.level !== "string" || !new Set(["failure", "warning", "notice"]).has(raw.level))
    throw new TypeError("Malformed CI annotation level");
  if (typeof raw.message !== "string" || typeof raw.path !== "string")
    throw new TypeError("Malformed CI annotation text");
  const entry: GitCiFailureContextEntry = {
    kind: "annotation",
    sourceKind: source.kind,
    sourceId: source.id,
    title: text(raw.title, input, collection, 256),
    text: boundedText(
      [text(raw.message, input, collection), text(raw.details, input, collection)]
        .filter(Boolean)
        .join("\n"),
      2_048,
      collection,
    ),
    path: text(raw.path, input, collection, 256),
    startLine: raw.startLine,
    endLine: raw.endLine,
  };
  if (raw.level === "failure") append(collection, entry);
}
function validState(raw: Record<string, unknown>): boolean {
  if (
    typeof raw.status !== "string" ||
    !new Set(["queued", "waiting", "in_progress", "completed", "pending", "requested"]).has(
      raw.status,
    )
  )
    return false;
  if (raw.status !== "completed") return raw.conclusion === null;
  return (
    typeof raw.conclusion === "string" &&
    new Set([
      "success",
      "failure",
      "skipped",
      "cancelled",
      "neutral",
      "timed_out",
      "action_required",
      "stale",
      "startup_failure",
      "error",
    ]).has(raw.conclusion)
  );
}
function validNameState(raw: Record<string, unknown>): boolean {
  return typeof raw.name === "string" && raw.name.length > 0 && validState(raw);
}

function steps(raw: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(raw) || raw.length > 100) throw new TypeError("Malformed CI job steps");
  const values: unknown[] = raw;
  const numbers = new Set<number>();
  return values.map((value) => {
    if (
      !ciFailureObject(value) ||
      !ciFailurePositive(value.number) ||
      numbers.has(value.number) ||
      !validNameState(value)
    )
      throw new TypeError("Malformed CI job step identity");
    numbers.add(value.number);
    return value;
  });
}
export function addGitCiJob(
  raw: Record<string, unknown>,
  source: GitCiFailureSource,
  input: GitCiFailureContextInput,
  collection: GitCiFailureCollection,
): void {
  if (!ciFailurePositive(raw.id) || !validNameState(raw))
    throw new TypeError("Malformed CI job identity");
  const items = steps(raw.steps);
  const title = text(raw.name, input, collection, 256);
  if (!ciFailureCompleted(raw)) return;
  append(collection, {
    kind: "job",
    sourceKind: source.kind,
    sourceId: source.id,
    jobId: raw.id,
    title,
    text: "Required workflow job failed.",
  });
  for (const step of items) {
    const name = text(step.name, input, collection, 256);
    if (ciFailureCompleted(step))
      append(collection, {
        kind: "step",
        sourceKind: source.kind,
        sourceId: source.id,
        jobId: raw.id,
        title,
        text: name,
      });
  }
}
