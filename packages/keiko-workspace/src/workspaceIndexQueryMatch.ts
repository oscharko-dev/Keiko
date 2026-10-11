import type { ScoredLine } from "./repoSearchLineSelection.js";

const MAX_QUERY_MATCH_LINES = 128;

/** Completed matching metadata only; source bodies and previews never enter this record. */
export interface WorkspaceIndexQueryMatch {
  readonly queryIdentitySha256: string;
  readonly best: readonly ScoredLine[];
  readonly maxScore: number;
  readonly contentScore?: number | undefined;
  readonly definitionMatch?: boolean | undefined;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function score(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validLineFields(value: {
  readonly line: unknown;
  readonly startLine: unknown;
  readonly endLine: unknown;
  readonly score: unknown;
}): value is ScoredLine {
  return (
    positiveInteger(value.line) &&
    positiveInteger(value.startLine) &&
    positiveInteger(value.endLine) &&
    score(value.score) &&
    value.startLine <= value.line &&
    value.line <= value.endLine
  );
}

function normalizeLine(value: unknown): ScoredLine | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!("line" in value && "startLine" in value && "endLine" in value && "score" in value))
    return undefined;
  if (!validLineFields(value)) return undefined;
  return {
    line: value.line,
    startLine: value.startLine,
    endLine: value.endLine,
    score: value.score,
  };
}

function normalizeOptionalScores(
  value: object,
): Pick<WorkspaceIndexQueryMatch, "contentScore" | "definitionMatch"> | undefined {
  const contentScore = "contentScore" in value ? value.contentScore : undefined;
  const definitionMatch = "definitionMatch" in value ? value.definitionMatch : undefined;
  if (contentScore !== undefined && !score(contentScore)) return undefined;
  if (definitionMatch !== undefined && typeof definitionMatch !== "boolean") return undefined;
  return {
    ...(contentScore === undefined ? {} : { contentScore }),
    ...(definitionMatch === undefined ? {} : { definitionMatch }),
  };
}

function normalizeLines(value: unknown): readonly ScoredLine[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_QUERY_MATCH_LINES) return undefined;
  const lines: readonly unknown[] = value;
  const best = lines.map(normalizeLine);
  return best.some((line) => line === undefined)
    ? undefined
    : best.filter((line): line is ScoredLine => line !== undefined);
}

function queryMatchIdentity(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

export function normalizeWorkspaceIndexQueryMatch(
  value: unknown,
): WorkspaceIndexQueryMatch | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!("queryIdentitySha256" in value && "best" in value && "maxScore" in value)) return undefined;
  if (!queryMatchIdentity(value.queryIdentitySha256)) return undefined;
  const best = normalizeLines(value.best);
  const optional = normalizeOptionalScores(value);
  if (best === undefined || optional === undefined || !score(value.maxScore)) return undefined;
  return {
    queryIdentitySha256: value.queryIdentitySha256,
    best,
    maxScore: value.maxScore,
    ...optional,
  };
}
