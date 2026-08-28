#!/usr/bin/env node
// Reports the body-free workflow-run envelope for the infrastructure re-run observer.
//
// GitHub caps one workflow-runs listing at 1,000 records. This reporter requests one UTC day at a
// time, so a busy observation window cannot silently truncate its counts. It intentionally reports
// observer outcomes, not classifier verdicts: verdicts live in job summaries and are not exposed by
// the Actions REST response without downloading logs.

const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const DEFAULT_REPOSITORY = "oscharko-dev/Keiko";
const WORKFLOW = "infra-failure-retry.yml";

function fail(message) {
  throw new Error(message);
}

function validateDateRange(parsed) {
  if (!DATE.test(parsed.from ?? "") || !DATE.test(parsed.to ?? "")) {
    fail("--from and --to must be UTC dates in YYYY-MM-DD form");
  }
  if (parsed.from > parsed.to) fail("--from must not be after --to");
}

function parseArguments(args) {
  const parsed = { from: undefined, to: undefined, repo: DEFAULT_REPOSITORY };
  const argumentKeys = { "--from": "from", "--to": "to", "--repo": "repo" };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    const key = argumentKeys[value];
    if (key === undefined) fail(`unknown argument: ${value}`);
    const next = args[index + 1];
    if (next === undefined) fail(`${value} requires a value`);
    parsed[key] = next;
    index += 1;
  }
  validateDateRange(parsed);
  return parsed;
}

function utcDates(from, to) {
  const dates = [];
  for (let date = new Date(`${from}T00:00:00Z`); date <= new Date(`${to}T00:00:00Z`);) {
    dates.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return dates;
}

function githubToken() {
  if (process.env.GH_TOKEN !== undefined) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN !== undefined) return process.env.GITHUB_TOKEN;
  fail("GitHub authentication is required (set GH_TOKEN or GITHUB_TOKEN)");
}

function nextLinkTarget(link) {
  if (link === null) return undefined;
  for (const entry of link.split(",")) {
    if (!entry.includes('rel="next"')) continue;
    const start = entry.indexOf("<");
    const end = entry.indexOf(">", start + 1);
    if (start >= 0 && end > start + 1) return entry.slice(start + 1, end);
  }
  return undefined;
}

async function actionRunsPage(fetchImpl, token, url, date) {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
  });
  if (!response.ok)
    fail(`GitHub Actions query for ${date} failed with HTTP ${String(response.status)}`);
  const payload = await response.json();
  if (!Array.isArray(payload.workflow_runs))
    fail(`GitHub Actions query for ${date} has no workflow_runs`);
  const next = nextLinkTarget(response.headers.get("link"));
  return { runs: payload.workflow_runs, next };
}

async function runsForDate(fetchImpl, token, repo, date) {
  const first = new globalThis.URL(
    `https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/runs`,
  );
  first.searchParams.set("created", date);
  first.searchParams.set("per_page", "100");
  const runs = [];
  let pageUrl = first;
  for (;;) {
    const page = await actionRunsPage(fetchImpl, token, pageUrl, date);
    runs.push(...page.runs);
    if (page.next === undefined) return runs;
    pageUrl = new globalThis.URL(page.next);
  }
}

export async function observeInfrastructureRuns(args, dependencies = {}) {
  const dates = utcDates(args.from, args.to);
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const token = dependencies.token ?? githubToken();
  const days = await Promise.all(
    dates.map(async (date) => {
      const runs = await runsForDate(fetchImpl, token, args.repo, date);
      const observed = runs.filter((run) => run.event === "workflow_run");
      const skipped = observed.filter((run) => run.conclusion === "skipped").length;
      return {
        date,
        total: observed.length,
        skipped,
        observerCompleted: observed.length - skipped,
      };
    }),
  );
  const total = days.reduce((sum, day) => sum + day.total, 0);
  const skipped = days.reduce((sum, day) => sum + day.skipped, 0);
  return {
    schemaVersion: 1,
    repository: args.repo,
    workflow: WORKFLOW,
    from: args.from,
    to: args.to,
    days,
    total,
    skipped,
    observerCompleted: total - skipped,
  };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const report = await observeInfrastructureRuns(args);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1]?.endsWith("report-infra-failure-observation.mjs") === true) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
