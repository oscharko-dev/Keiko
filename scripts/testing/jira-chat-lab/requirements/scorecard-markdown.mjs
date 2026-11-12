// The Markdown report of the requirements scorecard (epic #4173).
import { evidenceLines } from "./coverage.mjs";

export function scorecardMarkdown(report) {
  const invalid = report.counts.invalid ?? 0;
  const icon = {
    green: "🟢",
    red: "🔴",
    partial: "🟠",
    invalid: "⛔",
    "probe-only": "🟡",
    unchecked: "⚪",
  };
  const rows = report.results.map(
    (result) =>
      `| ${result.id} | ${icon[result.status]} ${result.status} | ${result.requirement} | #${result.issue} | ${result.title} | ${evidenceLines(result).join("<br>") || "no check yet"} |`,
  );
  return [
    `# Jira requirements scorecard — ${report.startedAt}${report.model ? ` — ${report.model}` : ""}${invalid > 0 ? " — INVALID RUN" : ""}`,
    "",
    ...(invalid > 0
      ? [
          "Invalid scenarios were not graded: the laboratory could not trust them (lab error, model unavailable or gateway failure). Do not read this run as a data point.",
          "",
        ]
      : []),
    ...(report.repeat > 1 ? [`Each journey ran ${report.repeat} times in fresh Chats.`, ""] : []),
    `Green ${report.counts.green} · red ${report.counts.red} · partial ${report.counts.partial} · invalid ${invalid} · probe-only ${report.counts["probe-only"]} · unchecked ${report.counts.unchecked} of ${report.results.length}`,
    "",
    "| Scenario | Status | Requirement | Issue | Title | Evidence |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}
