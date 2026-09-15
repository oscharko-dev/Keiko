#!/usr/bin/env node
// Entry point invoked by .github/workflows/release-publish-request.yml. Wires the seams in
// scripts/lib/release-publish-request-event.mjs to `gh api` and git.

import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { requestPublishForHead } from "./lib/release-publish-request-event.mjs";

function fail(message) {
  console.error(`decide-release-publish-request: FAIL - ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { mode: "dry-run" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--head-sha") options.headSha = argv[++i];
    else if (arg === "--mode") options.mode = argv[++i];
    else if (arg === "--summary") options.summaryPath = argv[++i];
    else if (arg === "--github-output") options.githubOutputPath = argv[++i];
    else fail(`unknown argument ${arg}`);
  }
  if (typeof options.headSha !== "string") fail("--head-sha is required");
  if (options.mode !== "dry-run" && options.mode !== "enforce") {
    fail("--mode must be dry-run or enforce");
  }
  return options;
}

function ghApi(args) {
  const gh = resolveHostExecutable("gh");
  const result = spawnSync(gh, ["api", ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`gh api ${args.join(" ")} exited ${String(result.status)}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

function listLatestRunForWorkflow(name, headSha) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (typeof repo !== "string" || repo.length === 0) {
    fail("GITHUB_REPOSITORY is not set");
  }
  // The workflow_runs listing filters by `head_sha`; the display-name filter is client-side because
  // the API keys on workflow file path, not name. Fetching one page (up to 30) is enough — a head
  // that gathered more than 30 runs across all workflows is already a rerun storm to investigate.
  const response = ghApi([
    `repos/${repo}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=30`,
  ]);
  const runs = Array.isArray(response?.workflow_runs) ? response.workflow_runs : [];
  const matching = runs
    .filter((run) => run?.name === name)
    .sort((a, b) => Date.parse(b.updated_at ?? "0") - Date.parse(a.updated_at ?? "0"));
  const latest = matching[0];
  if (latest === undefined) return undefined;
  return {
    status: latest.status,
    conclusion: latest.conclusion,
    runId: latest.id,
    updatedAt: latest.updated_at,
  };
}

function readTagAtSha(headSha) {
  const repo = process.env.GITHUB_REPOSITORY;
  const response = ghApi([`repos/${repo}/git/matching-refs/tags/`]);
  if (!Array.isArray(response)) return undefined;
  const match = response.find((entry) => entry?.object?.sha === headSha);
  const ref = match?.ref;
  return typeof ref === "string" && ref.startsWith("refs/tags/")
    ? ref.slice("refs/tags/".length)
    : undefined;
}

function dispatchRelease(tag) {
  const repo = process.env.GITHUB_REPOSITORY;
  const gh = resolveHostExecutable("gh");
  const result = spawnSync(
    gh,
    [
      "api",
      "--method",
      "POST",
      `repos/${repo}/actions/workflows/release.yml/dispatches`,
      "-f",
      `ref=refs/tags/${tag}`,
      "-f",
      "inputs[publish]=true",
      "-f",
      "inputs[npm_dist_tag]=latest",
    ],
    { encoding: "utf8", stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`gh workflow dispatch exited ${String(result.status)}`);
  }
}

function writeSummary(path, verdict) {
  if (typeof path !== "string" || path.length === 0) return;
  const lines = [
    "## Release publish request",
    "",
    `- **decision**: \`${verdict.decision}\``,
    `- **reason**: ${verdict.reason}`,
    `- **dispatched**: ${verdict.dispatched ? "yes" : "no"}`,
    "",
  ];
  appendFileSync(path, lines.join("\n"));
}

function writeGithubOutput(path, verdict) {
  if (typeof path !== "string" || path.length === 0) return;
  appendFileSync(
    path,
    `decision=${verdict.decision}\ndispatched=${verdict.dispatched ? "true" : "false"}\n`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const verdict = await requestPublishForHead({
    headSha: options.headSha,
    mode: options.mode,
    listLatestRunForWorkflow,
    readTagAtSha,
    dispatchRelease,
  });
  console.log(`decide-release-publish-request: ${verdict.decision} — ${verdict.reason}`);
  writeSummary(options.summaryPath, verdict);
  writeGithubOutput(options.githubOutputPath, verdict);
  // Non-zero exit only on a real error (thrown inside seams); a `not_ready` or `refused` verdict is
  // an intended outcome that must not fail the workflow — the workflow_run event will fire again
  // when the next required workflow completes on the same head.
}

main().catch((error) => {
  fail(String(error?.message ?? error));
});
