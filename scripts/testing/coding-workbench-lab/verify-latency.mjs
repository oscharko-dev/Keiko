#!/usr/bin/env node
// Times the server's enforced verification path on the lab repository, several times in one
// process, to compare the verifier's own cost with the latency seen in a live run (finding F14).
// It needs the built workspace packages (npm run build:packages) and a lab checkout with its
// dependencies installed.
import { performance } from "node:perf_hooks";
import { isMainModule } from "../../lib/is-main-module.mjs";
import { UsageError, importBuilt, labRepositoryPath, parseCli, runMain } from "./lab-common.mjs";

const USAGE = [
  "usage: node verify-latency.mjs [--repo <path>] [--test-file src/ledger.test.ts] [--runs 2]",
  "",
  "The repository is --repo, else KEIKO_LAB_REPO; it must be a lab copy (its package.json names",
  "ledger-lab). Prints the detected test framework, the network isolation probe and the duration of",
  "each enforced targeted-test verification.",
].join("\n");

function milliseconds(since) {
  return `${(performance.now() - since).toFixed(0)} ms`;
}

function summarizeResults(result) {
  const report = result.report ?? result;
  return (report.results ?? []).map((entry) => ({
    kind: entry.step?.kind ?? entry.kind,
    status: entry.status ?? entry.outcome,
    durationMs: entry.durationMs,
  }));
}

async function main() {
  const cli = parseCli({
    usage: USAGE,
    options: {
      repo: { type: "string" },
      "test-file": { type: "string", default: "src/ledger.test.ts" },
      runs: { type: "string", default: "2" },
    },
  });
  if (cli.help) return 0;
  const runs = Number(cli.values.runs);
  if (!Number.isInteger(runs) || runs < 1)
    throw new UsageError("--runs must be a positive integer");
  const repo = labRepositoryPath(cli.values.repo);
  const { detectWorkspaceAt } = await importBuilt("keiko-workspace", "index.js");
  const { planDirectTargetedTests } = await importBuilt("keiko-verification", "index.js");
  const execution = await importBuilt("keiko-server", "editor/verificationExecution.js");
  const workspace = detectWorkspaceAt(repo);
  console.log("framework", workspace.testFramework);
  let started = performance.now();
  console.log("probe", execution.probeNetworkIsolation(repo), milliseconds(started));
  for (let run = 1; run <= runs; run += 1) {
    const steps = planDirectTargetedTests(workspace, [cli.values["test-file"]]);
    started = performance.now();
    const result = await execution.executeVerificationEnforced({
      plan: { workspaceRoot: workspace.root, steps },
      workspace,
      signal: new globalThis.AbortController().signal,
      dependencyBootstrap: "auto",
    });
    const timing = milliseconds(started);
    console.log(
      `run ${String(run)}: ${timing}`,
      JSON.stringify(summarizeResults(result)),
      Object.keys(result).join(","),
    );
  }
  return 0;
}

if (isMainModule(import.meta.url)) runMain(main);
