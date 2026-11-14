// The Markdown report of the requirements scorecard (epic #4173).
import { evidenceLines } from "./coverage.mjs";

/** Limits of two oracles that a reader of a report containing them must know. */
const ORACLE_LIMITS = Object.freeze({
  C07: "C07's `answer-clean` flag half holds by construction on a Jira-Pod-only Chat, which never runs the entailment stage and sets no groundedAnswer; the lane proves it on the stored message. The mixed-Chat behaviour (computed figures accepted, document claims still flagged) is proven by the product's hermetic tests, not by this lane.",
  S10: "S10 derives its estimate expectation from native data read as the lab administrator (in a German-language session as the product's own actor, so names match what the product sees); the case of an account that cannot read the estimate field is not graded, and reading as the product's own actor hides a visibility or permission defect of the product from the oracle. The flag half of `answer-clean` holds by construction on a Jira-Pod-only Chat, which never runs the entailment stage; the lane proves it on the stored message, and the mixed-Chat behaviour (computed figures accepted, document claims still flagged) is proven by the product's hermetic tests, not by this lane.",
  S11: "S11's unavailable-report case is graded partly on the product's own statement that the report is unavailable.",
});

export function scorecardMarkdown(report) {
  const limits = Object.entries(ORACLE_LIMITS)
    .filter(([id]) => report.results.some((result) => result.id === id))
    .map(([, text]) => `Limit: ${text}`);
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
      `| ${result.id} | ${icon[result.status]} ${result.status}${result.runs ? ` (${result.invalidRuns} of ${result.runs.length} runs invalid)` : ""} | ${result.requirement} | #${result.issue} | ${result.title} | ${evidenceLines(result).join("<br>") || "no check yet"} |`,
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
    ...(limits.length > 0 ? [...limits, ""] : []),
    `Green ${report.counts.green} · red ${report.counts.red} · partial ${report.counts.partial} · invalid ${invalid} · probe-only ${report.counts["probe-only"]} · unchecked ${report.counts.unchecked} of ${report.results.length}`,
    "",
    "| Scenario | Status | Requirement | Issue | Title | Evidence |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}
