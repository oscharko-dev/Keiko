// #3390 consumes the actual native measurement and its unchanged measured subject. It retains
// the original measurement commit alongside the qualification head; verification never restamps
// old samples or turns a fixture measurement into a real-model journey.
import { evaluateCodingPerformanceEvidence } from "../coding-runtime-performance-evidence.mjs";

const SCENARIO = "coding-runtime-performance-budgets";
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

function exact(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function subjectErrors(value) {
  const subject = value.currentSubject;
  const measured = value.measurement?.subject;
  const valid = [
    exact(subject, ["sourceTreeSha256", "lockfileSha256"]),
    DIGEST.test(subject?.sourceTreeSha256),
    DIGEST.test(subject?.lockfileSha256),
    subject?.sourceTreeSha256 === measured?.sourceTreeSha256,
    subject?.lockfileSha256 === measured?.lockfileSha256,
    DIGEST.test(value.measurementHarnessSha256),
    value.measurementHarnessSha256 === value.measurement?.measurementHarnessSha256,
  ].every(Boolean);
  return valid ? [] : ["performance qualification subject or ruler differs from the measurement"];
}

export function codingIssueJourneyPerformanceArtifactErrors(value) {
  if (
    !exact(value, [
      "schemaVersion",
      "scenarioId",
      "evidenceClass",
      "sourceCommitSha",
      "platformTarget",
      "result",
      "currentSubject",
      "measurementHarnessSha256",
      "measurement",
      "calibration",
      "budget",
    ])
  )
    return ["performance qualification artifact has unexpected fields"];
  const identity =
    value.schemaVersion === 1 &&
    value.scenarioId === SCENARIO &&
    value.evidenceClass === "production-functional" &&
    SHA.test(value.sourceCommitSha) &&
    value.platformTarget === "macos-arm64" &&
    value.result === "passed";
  if (!identity) return ["performance qualification identity is invalid"];
  const findings = evaluateCodingPerformanceEvidence(
    value.measurement,
    value.calibration,
    value.budget,
  );
  return [...subjectErrors(value), ...findings.defects, ...findings.verdicts];
}

export function buildCodingIssueJourneyPerformanceArtifact(input) {
  const artifact = {
    schemaVersion: 1,
    scenarioId: SCENARIO,
    evidenceClass: "production-functional",
    sourceCommitSha: input.source.commit,
    platformTarget: "macos-arm64",
    result: "passed",
    currentSubject: {
      sourceTreeSha256: input.source.sourceTreeSha256,
      lockfileSha256: input.source.lockfileSha256,
    },
    measurementHarnessSha256: input.measurementHarnessSha256,
    measurement: input.measurement,
    calibration: input.calibration,
    budget: input.budget,
  };
  if (codingIssueJourneyPerformanceArtifactErrors(artifact).length > 0) {
    throw new TypeError("native performance qualification is incomplete, stale, or over budget");
  }
  return artifact;
}
