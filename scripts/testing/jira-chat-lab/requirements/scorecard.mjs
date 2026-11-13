// Scenario scorecard for epic #4173 (#4174). Synthetic laboratory only.
// Usage: node scorecard.mjs <private-session-directory> --project <KEY> [--only S07,S08]
//          [--model <gateway-model-id> --embedding-model <gateway-model-id>] [--repeat N]
// With --model, the end-to-end Chat journeys run too (KEIKO_JIRA_LAB_GATEWAY_CONFIG selects the
// Gateway, for example the local LiteLLM configuration).
// A scenario is green only when every check passed AND every obligation of the catalog is covered
// by a passing check AND the end-to-end journey is green. A journey that verifies only part of the
// contract (or only `unverified`) leaves the scenario `partial`.
// A check the laboratory cannot trust is `invalid`, never `red`: a lab exception (native Jira, fixture, license, transport; a failed Keiko route stays red), a model that
// failed its readiness check before the journey, or a model gateway that exhausted its retries on a call or opened
// its circuit during a non-green journey (read from the Activity Log of the journey's window and from
// the turn's failure). A red model-free probe stays red. A run with any invalid scenario is
// labelled invalid in latest.md and trend.tsv and is not a data point.
// With --repeat N every journey runs N times in fresh Chats; a scenario reports each run's status,
// the pass rate over its valid runs and the number of invalid runs, and is green only when every
// valid run is green and at least half the runs are valid (else invalid).
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadSession } from "../lab-client.mjs";
import { SCENARIOS } from "./catalog.mjs";
import { COMPOSER_SCENARIOS } from "./composer-catalog.mjs";
import { COMPOSER_JOURNEY_IDS } from "./composer.mjs";
import { ensureLicenseWindow } from "./license-window.mjs";
import { registerLane } from "./lab-lanes.mjs";
import { scenarioVerdict } from "./coverage.mjs";
import { scorecardMarkdown } from "./scorecard-markdown.mjs";
import { JOURNEY_IDS, runJourneys } from "./journeys.mjs";
import { PROBES } from "./probes.mjs";
import { TREND_HEADER, countStatuses, trendLine } from "./repeat.mjs";
import { gradeException } from "./validity.mjs";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    project: { type: "string" },
    only: { type: "string" },
    "min-license": { type: "string", default: "900" },
    model: { type: "string" },
    "embedding-model": { type: "string" },
    repeat: { type: "string", default: "1" },
    set: { type: "string", default: "documents" },
  },
});
const [directory] = positionals;
if (!directory || !values.project) {
  throw new TypeError("Usage: scorecard.mjs <session-directory> --project <KEY> [--only S07]");
}
const repeat = Number(values.repeat);
if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 20) {
  throw new TypeError("--repeat must be an integer from 1 to 20");
}
const session = loadSession(directory);
const selected = values.only ? new Set(values.only.split(",")) : undefined;
// `--set composer` selects the Composer lane (#4369): its own scenarios C01-C07, no Knowledge Pod.
if (!["documents", "composer"].includes(values.set))
  throw new TypeError("--set must be documents or composer");
const composer = values.set === "composer";
const catalog = composer ? COMPOSER_SCENARIOS : SCENARIOS;
const scenarios = catalog.filter((scenario) => !selected || selected.has(scenario.id));

async function runChecks(scenario, journeys) {
  const checks = [];
  const probe = PROBES[scenario.id];
  if (probe !== undefined) {
    const started = Date.now();
    try {
      checks.push({ layer: "probe", ...(await probe(session, values.project)) });
    } catch (error) {
      checks.push({ layer: "probe", ...gradeException(error) });
    }
    checks.at(-1).durationMs = Date.now() - started;
  }
  if (journeys[scenario.id] !== undefined)
    checks.push({ layer: "journey", ...journeys[scenario.id] });
  const { status, covered, uncovered, deferred } = scenarioVerdict(scenario, checks);
  const runs = checks.find((check) => check.layer === "journey")?.runs;
  return {
    ...scenario,
    status,
    covered,
    uncovered,
    deferred,
    checks,
    ...(runs ? { runs, invalidRuns: runs.filter((run) => run.status === "invalid").length } : {}),
  };
}

registerLane(directory);
await ensureLicenseWindow(session, directory, Number(values["min-license"]));
const report = {
  startedAt: new Date().toISOString(),
  project: values.project,
  model: values.model ?? null,
  repeat,
  results: [],
};
let journeys = {};
if (values.model) {
  await ensureLicenseWindow(session, directory, 3_600);
  const truth = JSON.parse(
    readFileSync(join(session.directory, "requirements-truth.json"), "utf8"),
  );
  const known = composer ? COMPOSER_JOURNEY_IDS : JOURNEY_IDS;
  const ids = known.filter((id) => scenarios.some((scenario) => scenario.id === id));
  journeys = await runJourneys({
    session,
    directory,
    modelId: values.model,
    embeddingModelId: values["embedding-model"],
    truth,
    ids,
    repeat,
    set: values.set,
  });
}
for (const scenario of scenarios) report.results.push(await runChecks(scenario, journeys));
report.counts = countStatuses(report.results);
report.valid = report.counts.invalid === 0;

const output = join(session.directory, composer ? "composer-scorecard" : "requirements-scorecard");
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
console.log(scorecardMarkdown(report));
