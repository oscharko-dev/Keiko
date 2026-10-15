// Shared `git status --porcelain=v2 --branch -z` parser (Issue #1573, Epic #1572).
// Pure parsing only: no process, no filesystem, no clock. Centralizing the porcelain-v2 XY
// semantics keeps branch/ahead/behind and change-record counting audited in one place so the
// summary read route and the fetch/pull sync preview consume identical logic.

import type { GitUpstreamSummary } from "@oscharko-dev/keiko-contracts";

export interface PorcelainV2Status {
  readonly branch?: string | undefined;
  readonly detached: boolean;
  readonly upstream?: GitUpstreamSummary | undefined;
  readonly ahead: number;
  readonly behind: number;
  readonly stagedCount: number;
  readonly unstagedCount: number;
  readonly untrackedCount: number;
  readonly conflictedCount: number;
  readonly dirty: boolean;
}

export interface PorcelainV2Change {
  readonly path: string;
  readonly status: "modified" | "added" | "renamed" | "untracked" | "deleted";
}

interface PorcelainCounts {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

interface PorcelainHeaders {
  branch?: string | undefined;
  detached: boolean;
  upstream?: GitUpstreamSummary | undefined;
  ahead: number;
  behind: number;
}

// Upstream ref splits on the first `/`: prefix is the remote, remainder the tracked branch.
function parseUpstreamRef(ref: string): GitUpstreamSummary {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash >= ref.length - 1) {
    return { ref };
  }
  return { ref, remote: ref.slice(0, slash), branch: ref.slice(slash + 1) };
}

function parseAheadBehind(value: string): { readonly ahead: number; readonly behind: number } {
  let ahead = 0;
  let behind = 0;
  for (const token of value.split(/\s+/u).filter((entry) => entry.length > 0)) {
    const magnitude = Number.parseInt(token.slice(1), 10);
    if (Number.isNaN(magnitude)) continue;
    if (token.startsWith("+")) ahead = magnitude;
    else if (token.startsWith("-")) behind = magnitude;
  }
  return { ahead, behind };
}

function applyHeader(record: string, headers: PorcelainHeaders): void {
  const body = record.slice(2).trim();
  if (body.startsWith("branch.head ")) {
    const name = body.slice("branch.head ".length).trim();
    if (name === "(detached)") headers.detached = true;
    else if (name.length > 0) headers.branch = name;
    return;
  }
  if (body.startsWith("branch.upstream ")) {
    const ref = body.slice("branch.upstream ".length).trim();
    if (ref.length > 0) headers.upstream = parseUpstreamRef(ref);
    return;
  }
  if (body.startsWith("branch.ab ")) {
    const parsed = parseAheadBehind(body.slice("branch.ab ".length));
    headers.ahead = parsed.ahead;
    headers.behind = parsed.behind;
  }
}

// Ordinary (`1`) and rename/copy (`2`) records carry XY at field offset 2..4 of the
// space-split tokens: X = index (staged) status, Y = worktree (unstaged) status.
function applyOrdinaryChange(record: string, counts: PorcelainCounts): void {
  const xy = record.split(" ")[1] ?? "..";
  const index = xy[0] ?? ".";
  const worktree = xy[1] ?? ".";
  if (index !== ".") counts.staged += 1;
  if (worktree !== ".") counts.unstaged += 1;
}

function applyChangeRecord(record: string, counts: PorcelainCounts): void {
  if (record.startsWith("1 ") || record.startsWith("2 ")) {
    applyOrdinaryChange(record, counts);
  } else if (record.startsWith("u ")) {
    counts.conflicted += 1;
  } else if (record.startsWith("? ")) {
    counts.untracked += 1;
  }
}

// Rename/copy (`2`) records are followed by an extra NUL-separated original-path field that must
// be skipped so it is never mistaken for a change record.
function isRenameRecord(record: string): boolean {
  return record.startsWith("2 ");
}

export function parsePorcelainV2Branch(stdout: string): PorcelainV2Status {
  const records = stdout.split("\0").filter((record) => record.length > 0);
  const headers: PorcelainHeaders = { detached: false, ahead: 0, behind: 0 };
  const counts: PorcelainCounts = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
  let changeRecords = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.startsWith("# ")) {
      applyHeader(record, headers);
      continue;
    }
    applyChangeRecord(record, counts);
    changeRecords += 1;
    if (isRenameRecord(record)) index += 1;
  }
  return {
    branch: headers.branch,
    detached: headers.detached,
    upstream: headers.upstream,
    ahead: headers.ahead,
    behind: headers.behind,
    stagedCount: counts.staged,
    unstagedCount: counts.unstaged,
    untrackedCount: counts.untracked,
    conflictedCount: counts.conflicted,
    dirty: changeRecords > 0,
  };
}

function pathAfterFields(record: string, fieldCount: number): string | undefined {
  let offset = 0;
  for (let field = 0; field < fieldCount; field += 1) {
    const separator = record.indexOf(" ", offset);
    if (separator < offset) return undefined;
    offset = separator + 1;
  }
  return offset < record.length ? record.slice(offset) : undefined;
}

function ordinaryStatus(xy: string, renamed: boolean): PorcelainV2Change["status"] {
  if (xy.includes("D")) return "deleted";
  if (renamed) return "renamed";
  return xy.includes("A") ? "added" : "modified";
}

const CHANGE_FIELD_COUNTS: Readonly<Record<string, number>> = { "1": 8, "2": 9, u: 10 };

function parsedChange(record: string): PorcelainV2Change | undefined {
  if (record.startsWith("? ") && record.length > 2)
    return { path: record.slice(2), status: "untracked" };
  const fieldCount = CHANGE_FIELD_COUNTS[record[0] ?? ""];
  if (fieldCount === undefined) return undefined;
  const xy = record.slice(2, 4);
  if (!/^[.MADRCUT]{2}$/u.test(xy) || xy === "..") return undefined;
  const path = pathAfterFields(record, fieldCount);
  return path === undefined ? undefined : { path, status: ordinaryStatus(xy, fieldCount === 9) };
}

// Only complete NUL-terminated records are eligible. A rename's second record is an old path,
// never another change, even when that filename itself starts with a porcelain marker.
export function parsePorcelainV2Changes(
  stdout: string,
  maxChanges = 512,
): readonly PorcelainV2Change[] {
  const cap = Number.isFinite(maxChanges) ? Math.max(0, Math.min(512, Math.floor(maxChanges))) : 0;
  const changes: PorcelainV2Change[] = [];
  const records = stdout.split("\0").slice(0, -1);
  for (let index = 0; index < records.length && changes.length < cap; index += 1) {
    const record = records[index] ?? "";
    const change = parsedChange(record);
    if (change !== undefined) changes.push(change);
    if (isRenameRecord(record)) index += 1;
  }
  return changes;
}
