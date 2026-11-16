// The end of a scorecard run (#4369): the counts, the report files and the exit code, as a function
// of the report, so the exit-code rule and the field-lift bracket are proven by execution and not by
// reading the script. The scorecard calls these and nothing else at its end.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { withFixtureFieldOptional } from "../seed-fields.mjs";
import { TREND_HEADER, countStatuses, runExitCode, trendLine } from "./repeat.mjs";
import { scorecardMarkdown } from "./scorecard-markdown.mjs";

/**
 * Counts the results, writes the JSON report, `latest.md` and the trend line into `output`, prints
 * the Markdown through `log` and returns the exit code. A model run (`modelRun`) exits 0 only when
 * every scenario is green, for the document lane and the Composer lane alike; a run without a model
 * (the document lane's probes only) writes its report and exits 0. The no-model `--rehearse` has its
 * own rule and never reaches this function.
 */
export function finishRun({ report, output, modelRun, log = console.log }) {
  report.counts = countStatuses(report.results);
  report.valid = report.counts.invalid === 0;
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const stamp = report.startedAt.replaceAll(":", "-");
  writeFileSync(join(output, `${stamp}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
  writeFileSync(join(output, "latest.md"), scorecardMarkdown(report), { mode: 0o600 });
  const trend = join(output, "trend.tsv");
  // An older trend file has another column layout (no invalid or repeat column); keep it aside instead of mixing column layouts.
  if (existsSync(trend) && !readFileSync(trend, "utf8").startsWith(TREND_HEADER)) {
    renameSync(trend, join(output, `trend.before-invalid-${Date.now()}.tsv`));
  }
  if (!existsSync(trend)) appendFileSync(trend, TREND_HEADER);
  appendFileSync(trend, trendLine(report));
  log(scorecardMarkdown(report));
  return modelRun ? runExitCode(report) : 0;
}

/**
 * The Composer lane writes the work project, so a field required in every project is lifted for the
 * run; the document lane runs as it always did. `lift` is injectable for the proof.
 */
export const withComposerFieldLift = (composer, session, run, lift = withFixtureFieldOptional) =>
  composer ? lift(session, run) : run();
