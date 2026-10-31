// Scenario scorecard for epic #4173 (#4174). Synthetic laboratory only.
// Usage: node scorecard.mjs <private-session-directory> --project <KEY> [--only S07,S08]
//          [--model <gateway-model-id> --embedding-model <gateway-model-id>]
// With --model, the end-to-end Chat journeys run too (KEIKO_JIRA_LAB_GATEWAY_CONFIG selects the
// Gateway, for example the local LiteLLM configuration).
// A scenario is green only when every check passed AND an end-to-end journey check exists.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadSession } from "../lab-client.mjs";
import { SCENARIOS } from "./catalog.mjs";
import { ensureLicenseWindow } from "./license-window.mjs";
import { JOURNEY_IDS, runJourneys } from "./journeys.mjs";
import { PROBES } from "./probes.mjs";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    project: { type: "string" },
    only: { type: "string" },
    "min-license": { type: "string", default: "900" },
    model: { type: "string" },
    "embedding-model": { type: "string" },
  },
});
const [directory] = positionals;
if (!directory || !values.project) {
  throw new TypeError("Usage: scorecard.mjs <session-directory> --project <KEY> [--only S07]");
}
const session = loadSession(directory);
const selected = values.only ? new Set(values.only.split(",")) : undefined;
const scenarios = SCENARIOS.filter((scenario) => !selected || selected.has(scenario.id));

function verdict(checks) {
  if (checks.length === 0) return "unchecked";
  if (checks.some((check) => check.status === "red")) return "red";
  return checks.some((check) => check.layer === "journey") ? "green" : "probe-only";
}

async function runChecks(scenario, journeys) {
  const checks = [];
  const probe = PROBES[scenario.id];
  if (probe !== undefined) {
    const started = Date.now();
    try {
      checks.push({ layer: "probe", ...(await probe(session, values.project)) });
    } catch (error) {
      checks.push({ layer: "probe", status: "red", detail: `lab error: ${error.message}` });
    }
    checks.at(-1).durationMs = Date.now() - started;
  }
  if (journeys[scenario.id] !== undefined)
    checks.push({ layer: "journey", ...journeys[scenario.id] });
  return { ...scenario, status: verdict(checks), checks };
}

function markdown(report) {
  const icon = { green: "🟢", red: "🔴", "probe-only": "🟡", unchecked: "⚪" };
  const rows = report.results.map(
    (result) =>
      `| ${result.id} | ${icon[result.status]} ${result.status} | ${result.requirement} | #${result.issue} | ${result.title} | ${result.checks.map((check) => `${check.layer}: ${check.detail}`).join("<br>") || "no check yet"} |`,
  );
  return [
    `# Jira requirements scorecard — ${report.startedAt}${report.model ? ` — ${report.model}` : ""}`,
    "",
    `Green ${report.counts.green} · red ${report.counts.red} · probe-only ${report.counts["probe-only"]} · unchecked ${report.counts.unchecked} of ${report.results.length}`,
    "",
    "| Scenario | Status | Requirement | Issue | Title | Evidence |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

await ensureLicenseWindow(session, directory, Number(values["min-license"]));
const report = {
  startedAt: new Date().toISOString(),
  project: values.project,
  model: values.model ?? null,
  results: [],
};
let journeys = {};
if (values.model) {
  await ensureLicenseWindow(session, directory, 3_600);
  const truth = JSON.parse(
    readFileSync(join(session.directory, "requirements-truth.json"), "utf8"),
  );
  const ids = JOURNEY_IDS.filter((id) => scenarios.some((scenario) => scenario.id === id));
  journeys = await runJourneys({
    session,
    modelId: values.model,
    embeddingModelId: values["embedding-model"],
    truth,
    ids,
  });
}
for (const scenario of scenarios) report.results.push(await runChecks(scenario, journeys));
report.counts = { green: 0, red: 0, "probe-only": 0, unchecked: 0 };
for (const result of report.results) report.counts[result.status] += 1;

const output = join(session.directory, "requirements-scorecard");
mkdirSync(output, { recursive: true, mode: 0o700 });
const stamp = report.startedAt.replaceAll(":", "-");
writeFileSync(join(output, `${stamp}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
writeFileSync(join(output, "latest.md"), markdown(report), { mode: 0o600 });
const trend = join(output, "trend.tsv");
if (!existsSync(trend)) {
  appendFileSync(trend, "startedAt\tmodel\tgreen\tred\tprobeOnly\tunchecked\n");
}
const { green, red, unchecked } = report.counts;
appendFileSync(
  trend,
  `${report.startedAt}\t${report.model ?? "-"}\t${green}\t${red}\t${report.counts["probe-only"]}\t${unchecked}\n`,
);
console.log(markdown(report));
