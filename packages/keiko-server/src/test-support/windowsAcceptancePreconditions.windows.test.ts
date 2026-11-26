// The producer of the Windows preconditions evidence (#4492 AC3). It runs only on a Windows host,
// as the standard user whose machine is to be certified, and writes the same body-free evidence
// file as the macOS suite, with no case run. The verdict is not this test's: it passes whenever the
// file is written, and `node scripts/check-acceptance-evidence.mjs <file> --preconditions-only`
// refuses the machine for every unmet precondition (docs/qa/coding-acceptance-task.md).

import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { OPENCODE_PINNED_VERSION } from "../coding-runtime/opencodeRuntimeVersions.js";
import {
  buildAcceptanceEvidence,
  ownerPrivateEvidenceTarget,
  writeOwnerPrivateEvidence,
} from "./acceptanceEvidence.js";
import { probeWindowsPreconditions } from "./windowsAcceptancePreconditions.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

describe.skipIf(process.platform !== "win32")("Windows acceptance preconditions (#4492)", () => {
  it("writes the body-free preconditions evidence", () => {
    const file = process.env.KEIKO_ACCEPTANCE_EVIDENCE_FILE;
    expect(
      file,
      "set KEIKO_ACCEPTANCE_EVIDENCE_FILE to a .json file outside the checkout",
    ).toBeTruthy();
    const target = ownerPrivateEvidenceTarget(file ?? "", REPOSITORY_ROOT);
    const evidence = buildAcceptanceEvidence({
      preconditions: probeWindowsPreconditions(),
      opencode: OPENCODE_PINNED_VERSION,
      cases: [],
      caseSetComplete: false,
      everyCaseMetExpectation: false,
    });
    writeOwnerPrivateEvidence(target, `${JSON.stringify(evidence, null, 2)}\n`);
  });
});
