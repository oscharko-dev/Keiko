// #4113: a raw diff cut at its byte cap ends inside a hunk, so the unified-diff parser of the source
// redaction refuses it and masks the whole view. The bounded prefix is reconciled into a complete
// patch instead: the partial last line is dropped, every hunk header states the lines actually
// shown, and a hunk header the cut left without lines is dropped. Body lines are never rewritten,
// so nothing the cut kept is altered and nothing it removed is invented. Output that is not a
// patch is returned unchanged, and a file section cut inside its headers keeps the existing
// redaction of that prefix.

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/u;

interface OpenHunk {
  readonly at: number;
  readonly oldStart: string;
  readonly newStart: string;
  readonly tail: string;
  oldLeft: number;
  newLeft: number;
  oldSeen: number;
  newSeen: number;
}

export function completeTruncatedDiffPrefix(diff: string): string {
  if (!diff.startsWith("diff --git ")) return diff;
  const end = diff.lastIndexOf("\n");
  if (end < 0) return "";
  const lines = diff.slice(0, end).split("\n");
  const output: (string | undefined)[] = [];
  let hunk: OpenHunk | undefined;
  for (const line of lines) {
    if (hunk !== undefined && consumeHunkLine(hunk, line)) {
      output.push(line);
      continue;
    }
    if (hunk !== undefined) closeHunk(hunk, output);
    hunk = openHunk(line, output.length);
    output.push(line);
  }
  if (hunk !== undefined) closeHunk(hunk, output);
  const kept = output.filter((line) => line !== undefined);
  return kept.length === 0 ? "" : kept.join("\n") + "\n";
}

function openHunk(line: string, at: number): OpenHunk | undefined {
  const match = HUNK_HEADER.exec(line);
  if (match === null) return undefined;
  const [, oldStart = "0", oldCount = "1", newStart = "0", newCount = "1", tail = ""] = match;
  return {
    at,
    oldStart,
    newStart,
    tail,
    oldLeft: Number(oldCount),
    newLeft: Number(newCount),
    oldSeen: 0,
    newSeen: 0,
  };
}

function consumeHunkLine(hunk: OpenHunk, line: string): boolean {
  if (line.startsWith("\\")) return hunk.oldSeen + hunk.newSeen > 0;
  const marker = line.slice(0, 1);
  const old = marker === " " || marker === "-";
  const fresh = marker === " " || marker === "+";
  if (!fitsHunk(hunk, old, fresh)) return false;
  hunk.oldLeft -= Number(old);
  hunk.oldSeen += Number(old);
  hunk.newLeft -= Number(fresh);
  hunk.newSeen += Number(fresh);
  return true;
}

function fitsHunk(hunk: OpenHunk, old: boolean, fresh: boolean): boolean {
  if (!old && !fresh) return false;
  return (!old || hunk.oldLeft > 0) && (!fresh || hunk.newLeft > 0);
}

function closeHunk(hunk: OpenHunk, output: (string | undefined)[]): void {
  if (hunk.oldLeft === 0 && hunk.newLeft === 0) return;
  if (hunk.oldSeen + hunk.newSeen === 0) {
    output[hunk.at] = undefined;
    return;
  }
  output[hunk.at] =
    `@@ -${hunk.oldStart},${String(hunk.oldSeen)} +${hunk.newStart},${String(hunk.newSeen)} @@` +
    hunk.tail;
}
