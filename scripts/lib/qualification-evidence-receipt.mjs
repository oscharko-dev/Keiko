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

export function writeQualificationEvidenceReceipt({
  receiptsDir,
  scenarioId,
  receipt,
  recordedAt,
  provenance = "real-model",
}) {
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
