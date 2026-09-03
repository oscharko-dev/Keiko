import { runSonarLogCheck } from "../../../scripts/check-sonar-analysis-log.mjs";

try {
  runSonarLogCheck({
    path: process.env["INPUT_LOG-PATH"],
    requireFullAnalysis: true,
  });
} catch (error) {
  process.stderr.write(
    `sonar-analysis-log: FAIL - ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
