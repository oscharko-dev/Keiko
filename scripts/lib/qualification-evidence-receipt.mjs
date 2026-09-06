// Shared receipt writer for the macOS and Windows native runtime qualification scripts
// (#3390 audit F8: qualify-macos-runtime-release.mjs and qualify-windows-runtime-release.mjs each
// carried a byte-identical copy). Translates a platform driver's own real qualification receipt
// into the `<scenarioId>.receipt.json` + `.artifact` pair scripts/check-coding-issue-journey-evidence.mjs
// and scripts/generate-coding-issue-journey-manifest.mjs already read, so a real, passing native
// qualification becomes #3390 evidence with no separate translation step. The artifact's bytes are
// the canonical qualification receipt itself; its digest is what the manifest's `receiptDigest`
// binds to.
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import {
  CODE_TASK_EVIDENCE_PLATFORMS,
  isCodeTaskIsoInstant,
  validateCodeTaskQualificationFlowArtifact,
} from "@oscharko-dev/keiko-contracts/runtime/code-task-acceptance";
import { codingIssueJourneyScenarioArtifactErrors } from "./coding-issue-journey-scenario-evidence.mjs";

function assertValidOwnedScenarioArtifact(scenarioId, receipt) {
  const errors = codingIssueJourneyScenarioArtifactErrors(receipt, scenarioId);
  if (errors !== null && errors.length > 0) {
    throw new TypeError("invalid coding-issue journey scenario artifact");
  }
}

export function writeQualificationEvidenceReceipt({
  receiptsDir,
  scenarioId,
  receipt,
  recordedAt,
  provenance = "real-model",
}) {
  assertValidOwnedScenarioArtifact(scenarioId, receipt);
  writeFileSync(
    join(receiptsDir, `${scenarioId}.artifact`),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(receiptsDir, `${scenarioId}.receipt.json`),
    `${JSON.stringify(
      {
        scenarioId,
        commitSha: receipt.sourceCommitSha,
        platform: receipt.platformTarget,
        testStatus: receipt.result === "passed" ? "passed" : "failed",
        recordedAt,
        provenance,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

/** Writes one completed #3390 flow with a distinct identity. Failed attempts are represented in
 * the next successful flow's ledger delta; this writer is called only after merge and closure. */
export function writeCodingIssueJourneyFlowEvidenceReceipt({
  receiptsDir,
  artifact,
  platform,
  recordedAt,
}) {
  const validation = validateCodeTaskQualificationFlowArtifact(artifact);
  if (!validation.ok) {
    throw new TypeError("invalid qualification flow artifact");
  }
  if (!CODE_TASK_EVIDENCE_PLATFORMS.includes(platform) || !isCodeTaskIsoInstant(recordedAt)) {
    throw new TypeError("invalid qualification flow receipt metadata");
  }
  const validatedArtifact = validation.value;
  const flowId = validatedArtifact.flowId;
  writeFileSync(
    join(receiptsDir, `${flowId}.artifact`),
    `${JSON.stringify(validatedArtifact, null, 2)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(receiptsDir, `${flowId}.receipt.json`),
    `${JSON.stringify(
      {
        flowId,
        commitSha: validatedArtifact.sourceCommitSha,
        platform,
        testStatus: "passed",
        recordedAt,
        provenance: "real-model",
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}
