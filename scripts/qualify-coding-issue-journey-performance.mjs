// Converts the existing native producer's validated artifacts to the shared #3390 receipt.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CODING_PERFORMANCE_FILES } from "./coding-runtime-performance-producer.mjs";
import { checkCodingPerformanceEvidence } from "./coding-runtime-performance-gate.mjs";
import {
  codingPerformanceSource,
  codingPerformanceToolchainDigest,
} from "./coding-runtime-performance-toolchain.mjs";
import { buildCodingIssueJourneyPerformanceArtifact } from "./lib/coding-issue-journey-functional-evidence.mjs";
import { writeQualificationEvidenceReceipt } from "./lib/qualification-evidence-receipt.mjs";
import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";

const ROOT = resolve(import.meta.dirname, "..");

function parseArgs(args) {
  if (
    args.length !== 4 ||
    args[0] !== "--source-commit-sha" ||
    args[2] !== "--receipts" ||
    !args[3]
  ) {
    throw new TypeError("usage: --source-commit-sha <sha> --receipts <directory>");
  }
  return { sourceCommitSha: args[1], receiptsDir: resolve(args[3]) };
}

export function qualifyCodingIssueJourneyPerformance(options) {
  const source = codingPerformanceSource(ROOT);
  const status = execFileSync(resolveHostExecutable("git"), ["status", "--porcelain=v1"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (source.commit !== options.sourceCommitSha || status.length > 0) {
    throw new TypeError("performance qualification requires the clean exact source head");
  }
  const findings = checkCodingPerformanceEvidence({ enforceSourceFreshness: true });
  if (findings.defects.length > 0 || findings.verdicts.length > 0) {
    throw new TypeError("native performance gate has stale, incomplete, or failed evidence");
  }
  const documents = Object.fromEntries(
    Object.entries(CODING_PERFORMANCE_FILES).map(([key, path]) => [
      key,
      JSON.parse(readFileSync(join(ROOT, path), "utf8")),
    ]),
  );
  const artifact = buildCodingIssueJourneyPerformanceArtifact({
    ...documents,
    source,
    measurementHarnessSha256: codingPerformanceToolchainDigest(),
  });
  mkdirSync(options.receiptsDir, { recursive: true, mode: 0o700 });
  writeQualificationEvidenceReceipt({
    receiptsDir: options.receiptsDir,
    scenarioId: artifact.scenarioId,
    receipt: artifact,
    recordedAt: new Date().toISOString(),
    provenance: "production-functional",
  });
  return artifact;
}

if (isMainModule(import.meta.url)) {
  try {
    qualifyCodingIssueJourneyPerformance(parseArgs(process.argv.slice(2)));
    process.stdout.write("Coding-issue journey native performance qualification passed.\n");
  } catch (error) {
    process.stderr.write(`FAIL ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  }
}
