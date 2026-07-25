// Computes SonarCloud's `new_coverage` metric locally, over the pull-request diff (Issue #2699).
//
// This existed nowhere. Every other coverage gate in this repository measures the committed baseline
// or per-file floors; none of them answers the one question the required SonarCloud gate blocks on —
// "are the lines this diff adds covered?". So the only way to learn the answer was to push and read
// SonarCloud, which makes a required gate the discovery mechanism instead of the confirmation.
//
// Sonar's definition, replicated exactly: new_coverage is
//   (covered new lines + covered new conditions) / (new lines to cover + new conditions)
// where "new" means present on the added side of the diff, and "to cover" means the coverage report
// recorded the line at all. Lines outside Sonar's main scope (tests, generated, non-source) are not
// counted, matching `sonar.exclusions`.

const LCOV_SOURCE_PREFIX = "SF:";
const LCOV_LINE_PREFIX = "DA:";
const LCOV_BRANCH_PREFIX = "BRDA:";
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u;

/** Added/modified line numbers on the new side of a `git diff -U0`, per file. */
export function parseDiffAddedLines(diff) {
  const files = new Map();
  let current;
  let next = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).replace(/^b\//u, "");
      current = path === "/dev/null" ? undefined : path;
      if (current !== undefined && !files.has(current)) files.set(current, new Set());
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk !== null) {
      next = Number(hunk[1]);
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith("+")) files.get(current)?.add(next++);
  }
  return files;
}

function recordLine(entry, payload) {
  const [rawLine, rawHits] = payload.split(",");
  const line = Number(rawLine);
  if (!Number.isInteger(line)) return;
  entry.lines.set(line, (entry.lines.get(line) ?? 0) + Number(rawHits ?? 0));
}

function recordBranch(entry, payload) {
  const parts = payload.split(",");
  const line = Number(parts[0]);
  if (!Number.isInteger(line)) return;
  const taken = parts[3];
  const hits = taken === "-" ? 0 : Number(taken);
  const existing = entry.branches.get(line) ?? [];
  existing.push(Number.isFinite(hits) ? hits : 0);
  entry.branches.set(line, existing);
}

/** Parses one or more concatenated LCOV reports into per-file line and branch hit counts. */
export function parseLcov(text) {
  const files = new Map();
  let entry;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith(LCOV_SOURCE_PREFIX)) {
      const path = line.slice(LCOV_SOURCE_PREFIX.length);
      entry = files.get(path) ?? { branches: new Map(), lines: new Map() };
      files.set(path, entry);
      continue;
    }
    if (entry === undefined) continue;
    if (line.startsWith(LCOV_LINE_PREFIX)) recordLine(entry, line.slice(LCOV_LINE_PREFIX.length));
    else if (line.startsWith(LCOV_BRANCH_PREFIX)) {
      recordBranch(entry, line.slice(LCOV_BRANCH_PREFIX.length));
    }
  }
  return files;
}

function tallyFile(addedLines, report, path, tally) {
  for (const line of [...addedLines].sort((left, right) => left - right)) {
    const hits = report.lines.get(line);
    if (hits !== undefined) {
      tally.linesToCover += 1;
      if (hits > 0) tally.coveredLines += 1;
      else tally.uncovered.push({ kind: "line", line, path });
    }
    for (const taken of report.branches.get(line) ?? []) {
      tally.conditions += 1;
      if (taken > 0) tally.coveredConditions += 1;
      else tally.uncovered.push({ kind: "condition", line, path });
    }
  }
}

/**
 * The metric itself. `inScope` decides which paths Sonar would measure; an out-of-scope or
 * unreported file contributes nothing, exactly as it contributes nothing to Sonar's numerator.
 */
export function newCodeCoverage({ addedLinesByFile, lcov, inScope }) {
  const tally = {
    conditions: 0,
    coveredConditions: 0,
    coveredLines: 0,
    linesToCover: 0,
    uncovered: [],
  };
  for (const [path, addedLines] of addedLinesByFile) {
    if (!inScope(path)) continue;
    const report = lcov.get(path);
    if (report === undefined) continue;
    tallyFile(addedLines, report, path, tally);
  }
  const total = tally.linesToCover + tally.conditions;
  const covered = tally.coveredLines + tally.coveredConditions;
  return {
    ...tally,
    // No measurable new code is not a failure: Sonar reports no value and its condition cannot
    // trip. Reporting 0% here would fail a documentation-only change.
    percent: total === 0 ? undefined : (covered / total) * 100,
    total,
  };
}

export function coverageVerdict(result, minimum) {
  if (result.percent === undefined) {
    return { failures: [], summary: "no measurable new code in Sonar's main scope" };
  }
  const percent = result.percent.toFixed(1);
  const summary =
    `${percent}% of ${String(result.total)} new line(s)/condition(s) covered ` +
    `(minimum ${String(minimum)}%)`;
  if (result.percent >= minimum) return { failures: [], summary };
  return {
    failures: result.uncovered.map(
      (item) => `${item.path}:${String(item.line)} uncovered new ${item.kind}`,
    ),
    summary,
  };
}
