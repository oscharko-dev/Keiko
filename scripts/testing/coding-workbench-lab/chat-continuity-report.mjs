// Offline laboratory report: never starts a BFF, model, container or browser.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { URL } from "node:url";
import { privateContinuityOutput } from "./chat-continuity-runtime.mjs";
import { summarizeContinuityRun, compareContinuityRuns } from "./chat-continuity-results.mjs";
import { parseCli, runMain } from "./lab-common.mjs";
import { isMainModule } from "../../lib/is-main-module.mjs";

export function continuityAnalysisIdentity(readBytes = readFileSync) {
  const modules = Object.fromEntries(
    [
      "chat-continuity-results.mjs",
      "chat-continuity-campaign.mjs",
      "chat-continuity-corpus.mjs",
      "chat-continuity-report.mjs",
    ].map((name) => [
      name,
      createHash("sha256")
        .update(readBytes(new URL(name, import.meta.url)))
        .digest("hex"),
    ]),
  );
  return { modules, digest: createHash("sha256").update(JSON.stringify(modules)).digest("hex") };
}

function loadLedger(path) {
  if (statSync(path).size > 128 * 1024 * 1024) throw new TypeError("lab-ledger-size-limit");
  const bytes = readFileSync(path);
  let run;
  try {
    run = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError("invalid-lab-ledger-json");
  }
  const summary = summarizeContinuityRun(run);
  return {
    run,
    summary,
    input: {
      ledgerDigest: createHash("sha256").update(bytes).digest("hex"),
      corpusManifestDigest: createHash("sha256").update(JSON.stringify(run.corpus)).digest("hex"),
      sourceHead: /^[a-f0-9]{40}$/u.test(run.sourceHead) ? run.sourceHead : null,
      productTreeDigest: /^[a-f0-9]{64}$/u.test(run.productTreeDigest)
        ? run.productTreeDigest
        : null,
      distributionDigest: /^[a-f0-9]{64}$/u.test(run.distributionDigest)
        ? run.distributionDigest
        : null,
    },
  };
}

export function writeContinuityReport({ baseline, candidate, output }) {
  const target = privateContinuityOutput(output);
  const before = loadLedger(baseline);
  const after = candidate === undefined ? undefined : loadLedger(candidate);
  const analysis = continuityAnalysisIdentity();
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    analysisModuleDigest: analysis.digest,
    analysisModules: analysis.modules,
    inputs: { baseline: before.input, ...(after === undefined ? {} : { candidate: after.input }) },
    baseline: before.summary,
    ...(after === undefined
      ? {}
      : {
          candidate: after.summary,
          comparison: compareContinuityRuns(before.run, after.run),
        }),
  };
  writeFileSync(target, JSON.stringify(report, null, 2), { mode: 0o600, flag: "wx" });
  return report;
}

function main() {
  const cli = parseCli({
    usage:
      "chat-continuity-report.mjs --baseline <ledger.json> [--candidate <ledger.json>] --output <new-private-json>",
    options: {
      baseline: { type: "string" },
      candidate: { type: "string" },
      output: { type: "string" },
    },
  });
  if (cli.help) return;
  if (cli.values.baseline === undefined || cli.values.output === undefined)
    throw new TypeError("baseline-and-external-output-required");
  const report = writeContinuityReport(cli.values);
  console.log(
    JSON.stringify({
      scope: report.baseline.scope,
      fixtureQualification: report.baseline.fixtureQualification,
      compared: report.comparison !== undefined,
    }),
  );
}

if (isMainModule(import.meta.url)) runMain(() => Promise.resolve().then(main));
