import {
  GIT_EDITOR_BLAME_AUTHOR_MAX_CHARS,
  GIT_EDITOR_BLAME_SUMMARY_MAX_CHARS,
  type GitEditorBlameLine,
} from "@oscharko-dev/keiko-contracts";

export interface GitBlameParseOptions {
  readonly maxLines: number;
  readonly processTruncated: boolean;
}

export interface ParsedGitBlame {
  readonly lines: readonly GitEditorBlameLine[];
  readonly totalLines: number;
  readonly truncated: boolean;
}

interface BlameHeader {
  readonly hash: string;
  readonly finalLine: number;
}

const BLAME_HEADER = /^(\S+) \d+ (\d+)(?: \d+)?$/u;
const GIT_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const EMAIL_SHAPE = /[^\s<>@]+@[^\s<>@]+/u;
const PRIVATE_AUTHOR = "Private author";

function parseHeader(line: string): BlameHeader | undefined {
  const match = BLAME_HEADER.exec(line);
  if (match === null) return undefined;
  const hash = (match[1] ?? "").replace(/^\^/u, "");
  const finalLine = Number(match[2]);
  return GIT_HASH.test(hash) && Number.isInteger(finalLine) && finalLine > 0
    ? { hash, finalLine }
    : undefined;
}

function field(lines: readonly string[], name: string): string | undefined {
  const prefix = `${name} `;
  return lines.find((line) => line.startsWith(prefix))?.slice(prefix.length);
}

function bounded(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function privacyMinimizedAuthor(value: string): string {
  return EMAIL_SHAPE.test(value)
    ? PRIVATE_AUTHOR
    : bounded(value, GIT_EDITOR_BLAME_AUTHOR_MAX_CHARS);
}

function hasRequiredRecordFields(
  header: BlameHeader | undefined,
  author: string | undefined,
  authorTime: string | undefined,
  summary: string | undefined,
  lines: readonly string[],
): header is BlameHeader {
  return (
    header !== undefined &&
    author !== undefined &&
    author.length > 0 &&
    authorTime !== undefined &&
    summary !== undefined &&
    lines.some((line) => line.startsWith("\t"))
  );
}

function parseRecord(lines: readonly string[]): GitEditorBlameLine | undefined {
  if (lines.some((line) => line.includes("\uFFFD"))) return undefined;
  const header = parseHeader(lines[0] ?? "");
  const author = field(lines, "author");
  const authorTime = field(lines, "author-time");
  const summary = field(lines, "summary");
  if (!hasRequiredRecordFields(header, author, authorTime, summary, lines)) return undefined;
  if (author === undefined || authorTime === undefined || summary === undefined) return undefined;
  const epoch = Number(authorTime);
  const date = new Date(epoch * 1_000);
  if (!Number.isInteger(epoch) || !Number.isFinite(date.valueOf())) return undefined;
  return {
    line: header.finalLine,
    commitHash: header.hash,
    author: privacyMinimizedAuthor(author),
    authorTime: date.toISOString(),
    summary: bounded(summary, GIT_EDITOR_BLAME_SUMMARY_MAX_CHARS),
  };
}

function records(input: string): readonly (readonly string[])[] {
  const lines = input.split("\n");
  const result: string[][] = [];
  let current: string[] | undefined;
  for (const line of lines) {
    if (BLAME_HEADER.test(line)) {
      if (current !== undefined) result.push(current);
      current = [line];
    } else if (current !== undefined) {
      current.push(line);
      if (line.startsWith("\t")) {
        result.push(current);
        current = undefined;
      }
    }
  }
  if (current !== undefined) result.push(current);
  return result;
}

export function parseGitBlamePorcelain(
  input: string,
  options: GitBlameParseOptions,
): ParsedGitBlame {
  const rawRecords = records(input);
  const parsed = rawRecords.map(parseRecord);
  const valid = parsed.filter((line): line is GitEditorBlameLine => line !== undefined);
  const lines = valid.slice(0, options.maxLines);
  return {
    lines,
    totalLines: rawRecords.length,
    truncated:
      options.processTruncated || valid.length > options.maxLines || parsed.some((line) => !line),
  };
}
