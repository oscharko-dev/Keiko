// Required macOS smoke: run the existing direct native profile consumers and separately prove
// that the public command owner refuses Seatbelt-only assured execution. This is not ES proof.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SUITE = "native profile containment only";
const OWNER = "packages/keiko-tools/src/exec.test.ts";
const REQUIRED_TITLES = Object.freeze([
  "does not admit an assured run with only Seatbelt and network:none",
  "does not admit an assured run with only Seatbelt and network:inherit",
  "confines files, symlinks and descendants while keeping an owned temporary directory",
  "refuses outbound connections to a host-loopback listener",
  "retains the explicit inherited network choice without removing filesystem confinement",
]);
const MAX_REPORT_BYTES = 8 * 1024 * 1024;

class NativeContainmentError extends Error {
  constructor(reason) {
    super(`macos-native-containment: ${reason}`);
  }
}

function fail(reason) {
  throw new NativeContainmentError(reason);
}

function validAssertion(assertion, title) {
  return (
    assertion?.title === title &&
    assertion.fullName === `${SUITE} ${title}` &&
    Array.isArray(assertion.ancestorTitles) &&
    assertion.ancestorTitles.length === 1 &&
    assertion.ancestorTitles[0] === SUITE &&
    assertion.status === "passed"
  );
}

function validAggregate(report) {
  return (
    report?.success === true &&
    report.numPassedTests === REQUIRED_TITLES.length &&
    report.numFailedTests === 0 &&
    Array.isArray(report.testResults) &&
    report.testResults.length === 1
  );
}

function validOwnerResult(result, ownerPath) {
  return (
    typeof result?.name === "string" &&
    resolve(result.name) === resolve(ownerPath) &&
    Array.isArray(result.assertionResults) &&
    result.assertionResults.filter((assertion) => assertion?.status === "passed").length ===
      REQUIRED_TITLES.length &&
    !result.assertionResults.some((assertion) => assertion?.status === "failed")
  );
}

export function validateMacNativeContainmentReport(report, ownerPath) {
  if (!validAggregate(report)) fail("invalid-test-report");
  const result = report.testResults[0];
  if (!validOwnerResult(result, ownerPath)) fail("invalid-test-report");
  for (const title of REQUIRED_TITLES) {
    const matches = result.assertionResults.filter((assertion) => assertion?.title === title);
    if (matches.length !== 1 || !validAssertion(matches[0], title)) fail("invalid-test-report");
  }
  return { required: REQUIRED_TITLES.length, passed: REQUIRED_TITLES.length };
}

function successful(result, reason) {
  if (result.error !== undefined || result.status !== 0 || result.signal != null) fail(reason);
}

function reportFrom(path) {
  try {
    const bytes = readFileSync(path);
    if (bytes.length === 0 || bytes.length > MAX_REPORT_BYTES) fail("invalid-test-report");
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("invalid-test-report");
  }
}

function testArgs(root, reportPath) {
  return [
    join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    OWNER,
    "--testNamePattern",
    `^${SUITE} (${REQUIRED_TITLES.join("|")})$`,
    "--reporter=json",
    `--outputFile=${reportPath}`,
  ];
}

export function checkMacNativeContainment({
  root = resolve(import.meta.dirname, ".."),
  platform = process.platform,
  run = spawnSync,
} = {}) {
  if (platform !== "darwin") fail("non-darwin-host");
  const scratch = mkdtempSync(join(tmpdir(), "keiko-native-containment-"));
  try {
    const options = { cwd: root, encoding: "utf8", timeout: 180_000, maxBuffer: 1024 * 1024 };
    successful(
      run(
        process.execPath,
        [
          join(root, "node_modules/@typescript/native/bin/tsc"),
          "-b",
          "packages/keiko-tools/tsconfig.json",
        ],
        options,
      ),
      "tools-build-failed",
    );
    const reportPath = join(scratch, "vitest.json");
    successful(run(process.execPath, testArgs(root, reportPath), options), "tests-failed");
    return validateMacNativeContainmentReport(reportFrom(reportPath), join(root, OWNER));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
) {
  try {
    const result = checkMacNativeContainment();
    process.stdout.write(
      `macos-native-containment: PASS - ${String(result.passed)}/${String(result.required)} required controls executed.\n`,
    );
  } catch (error) {
    const reason =
      error instanceof NativeContainmentError
        ? error.message
        : "macos-native-containment: runner-failed";
    process.stderr.write(`${reason}\n`);
    process.exitCode = 1;
  }
}
