// The Markdown report of the requirements scorecard (epic #4173).
import { evidenceLines } from "./coverage.mjs";

export function scorecardMarkdown(report) {
  const icon = { green: "🟢", red: "🔴", partial: "🟠", "probe-only": "🟡", unchecked: "⚪" };
  const rows = report.results.map(
    (result) =>
      `| ${result.id} | ${icon[result.status]} ${result.status} | ${result.requirement} | #${result.issue} | ${result.title} | ${evidenceLines(result).join("<br>") || "no check yet"} |`,
  );
  return [
    `# Jira requirements scorecard — ${report.startedAt}${report.model ? ` — ${report.model}` : ""}`,
    "",
    `Green ${report.counts.green} · red ${report.counts.red} · partial ${report.counts.partial} · probe-only ${report.counts["probe-only"]} · unchecked ${report.counts.unchecked} of ${report.results.length}`,
    "",
    "| Scenario | Status | Requirement | Issue | Title | Evidence |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}
