// Repeated journeys, status counts and the trend line of the requirements scorecard (epic #4173).
// One run per model says nothing about variance: with `--repeat N` a journey runs N times in fresh
// Chats and the scenario reports each run, the pass rate over the valid runs and the invalid runs.

export const STATUSES = Object.freeze([
  "green",
  "red",
  "partial",
  "probe-only",
  "unchecked",
  "invalid",
]);

/** The status counts of the scenario results; an unknown status fails closed. */
export function countStatuses(results) {
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  for (const result of results) {
    if (!Object.hasOwn(counts, result.status)) {
      throw new TypeError(`${result.id}: unknown scenario status ${result.status}`);
    }
    counts[result.status] += 1;
  }
  return counts;
}

function intersection(lists) {
  const [first = [], ...rest] = lists;
  return first.filter((name) => rest.every((list) => list.includes(name)));
}

function summarize(runs, valid) {
  const green = valid.filter((run) => run.status === "green").length;
  const invalid = runs.length - valid.length;
  const statuses = runs.map((run) => run.status).join(", ");
  return `${runs.length} runs (${statuses}); pass rate ${green}/${valid.length} valid; ${invalid} invalid`;
}

// Survivorship: a repeat whose invalid runs left fewer than half valid proves nothing.
function verdictOfValid(valid, total) {
  if (valid.some((run) => run.status === "red")) return "red";
  if (valid.length < Math.ceil(total / 2)) return "invalid";
  return valid.every((run) => run.status === "green") ? "green" : "unverified";
}

/**
 * One journey check from several runs. Green only when every valid run is green and at least one
 * valid run exists; it then credits only what every valid run verified. A valid red run makes it
 * red; fewer valid runs than half (or none) make it invalid.
 */
export function aggregateRuns(runs) {
  if (runs.length === 0) throw new TypeError("A journey needs at least one run");
  const valid = runs.filter((run) => run.status !== "invalid");
  const status = verdictOfValid(valid, runs.length);
  const detail = `${summarize(runs, valid)}; ${runs.map((run, index) => `#${index + 1}: ${run.detail ?? run.status}`).join(" | ")}`;
  return {
    status,
    ...(status === "invalid" ? { reason: "insufficient-valid-runs" } : {}),
    covers: status === "green" ? intersection(valid.map((run) => run.covers ?? [])) : [],
    detail,
    runs: runs.map(({ status: runStatus, reason, detail: runDetail, durationMs }) => ({
      status: runStatus,
      ...(reason === undefined ? {} : { reason }),
      detail: runDetail,
      durationMs,
    })),
    validRuns: valid.length,
    invalidRuns: runs.length - valid.length,
    passRate:
      valid.length === 0
        ? null
        : runs.filter((run) => run.status === "green").length / valid.length,
    durationMs: runs.reduce((sum, run) => sum + (run.durationMs ?? 0), 0),
  };
}

/** The trend columns; an older file with another layout is kept aside by the scorecard. */
export const TREND_HEADER =
  "startedAt\tmodel\trepeat\tvalidity\tgreen\tred\tpartial\tprobeOnly\tunchecked\tinvalid\n";

/** A run with any invalid scenario is labelled invalid, so it is not read as a data point. */
export function trendLine(report) {
  const { counts } = report;
  const validity = counts.invalid > 0 ? "invalid" : "valid";
  return `${[
    report.startedAt,
    report.model ?? "-",
    report.repeat ?? 1,
    validity,
    counts.green,
    counts.red,
    counts.partial,
    counts["probe-only"],
    counts.unchecked,
    counts.invalid,
  ].join("\t")}\n`;
}
