export const MAX_TRACKED_CONFLICTS = 100;
export const MAX_CONFLICT_CHARS = 65_536;

export interface ConflictRange {
  readonly start: number;
  readonly end: number;
  readonly startLine: number;
  readonly endLine: number;
}

export interface ConflictBlock {
  readonly range: ConflictRange;
  readonly ours: ConflictRange;
  readonly base: ConflictRange | null;
  readonly theirs: ConflictRange;
  readonly oursLabel: string;
  readonly baseLabel: string;
  readonly theirsLabel: string;
}

export interface ConflictMarkerModel {
  readonly conflicts: readonly ConflictBlock[];
  readonly total: number;
  readonly truncated: boolean;
  readonly malformed: boolean;
}

type Marker = "start" | "base" | "separator" | "end";
const TOKENS: Readonly<Record<Marker, string>> = {
  start: "<<<<<<<",
  base: "|||||||",
  separator: "=======",
  end: ">>>>>>>",
};

function marker(line: string): Marker | null {
  for (const kind of ["start", "base", "separator", "end"] as const) {
    const token = TOKENS[kind];
    if (line === token || (kind !== "separator" && line.startsWith(`${token} `))) return kind;
  }
  return null;
}

function label(line: string, kind: Marker): string {
  return line.length === TOKENS[kind].length ? "" : line.slice(TOKENS[kind].length + 1);
}

interface OpenBlock {
  readonly start: number;
  readonly startLine: number;
  readonly oursStart: number;
  readonly oursLabel: string;
  oursEnd: number | null;
  baseStart: number | null;
  baseEnd: number | null;
  baseLabel: string;
  separatorStart: number | null;
  theirsStart: number | null;
}

function range(start: number, end: number, startLine: number, endLine: number): ConflictRange {
  return { start, end, startLine, endLine };
}

function block(
  open: OpenBlock,
  endStart: number,
  end: number,
  line: number,
  endLabel: string,
): ConflictBlock {
  return {
    range: range(open.start, end, open.startLine, line),
    ours: range(open.oursStart, open.oursEnd ?? endStart, open.startLine + 1, line),
    base:
      open.baseStart === null
        ? null
        : range(open.baseStart, open.baseEnd ?? endStart, open.startLine + 1, line),
    theirs: range(open.theirsStart ?? endStart, endStart, open.startLine + 1, line),
    oursLabel: open.oursLabel,
    baseLabel: open.baseLabel,
    theirsLabel: endLabel,
  };
}

function invalid(): ConflictMarkerModel {
  return { conflicts: [], total: 0, truncated: false, malformed: true };
}

interface ParseState {
  readonly conflicts: ConflictBlock[];
  open: OpenBlock | null;
  total: number;
  truncated: boolean;
  malformed: boolean;
}

function startBlock(offset: number, end: number, lineNumber: number, text: string): OpenBlock {
  return {
    start: offset,
    startLine: lineNumber,
    oursStart: end,
    oursLabel: label(text, "start"),
    oursEnd: null,
    baseStart: null,
    baseEnd: null,
    baseLabel: "",
    separatorStart: null,
    theirsStart: null,
  };
}

function recordBlock(state: ParseState, candidate: ConflictBlock): void {
  state.total += 1;
  if (candidate.range.end - candidate.range.start > MAX_CONFLICT_CHARS) state.truncated = true;
  else if (state.conflicts.length < MAX_TRACKED_CONFLICTS) state.conflicts.push(candidate);
  else state.truncated = true;
}

function consumeOpenMarker(
  state: ParseState,
  open: OpenBlock,
  kind: Marker,
  text: string,
  offset: number,
  end: number,
  lineNumber: number,
): void {
  if (kind === "base" && open.baseStart === null && open.separatorStart === null) {
    open.oursEnd = offset;
    open.baseStart = end;
    open.baseLabel = label(text, kind);
  } else if (kind === "separator" && open.separatorStart === null) {
    open.separatorStart = offset;
    open.oursEnd ??= offset;
    open.baseEnd = open.baseStart === null ? null : offset;
    open.theirsStart = end;
  } else if (kind === "end" && open.separatorStart !== null) {
    recordBlock(state, block(open, offset, end, lineNumber, label(text, kind)));
    state.open = null;
  } else {
    state.malformed = true;
  }
}

function consumeMarker(
  state: ParseState,
  kind: Marker,
  text: string,
  offset: number,
  end: number,
  lineNumber: number,
): void {
  if (state.open !== null) {
    consumeOpenMarker(state, state.open, kind, text, offset, end, lineNumber);
  } else if (kind === "start") {
    state.open = startBlock(offset, end, lineNumber, text);
  } else {
    state.malformed = true;
  }
}

/** Parse exact column-one two-way/diff3 conflict grammar in one bounded pass. */
export function parseConflictMarkers(text: string): ConflictMarkerModel {
  const state: ParseState = {
    conflicts: [],
    open: null,
    total: 0,
    truncated: false,
    malformed: false,
  };
  let offset = 0;
  let lineNumber = 1;
  while (offset < text.length && !state.malformed) {
    const newline = text.indexOf("\n", offset);
    const end = newline < 0 ? text.length : newline + 1;
    const contentEnd =
      newline < 0 ? end : text.charCodeAt(newline - 1) === 13 ? newline - 1 : newline;
    const line = text.slice(offset, contentEnd);
    const kind = marker(line);
    if (kind !== null) consumeMarker(state, kind, line, offset, end, lineNumber);
    offset = end;
    lineNumber += 1;
  }
  if (state.malformed || state.open !== null) return invalid();
  return {
    conflicts: state.conflicts,
    total: state.total,
    truncated: state.truncated,
    malformed: false,
  };
}

export type ConflictChoice = "ours" | "theirs" | "both";

export function conflictReplacement(
  text: string,
  conflict: ConflictBlock,
  choice: ConflictChoice,
): string {
  const ours = text.slice(conflict.ours.start, conflict.ours.end);
  const theirs = text.slice(conflict.theirs.start, conflict.theirs.end);
  return choice === "ours" ? ours : choice === "theirs" ? theirs : ours + theirs;
}
