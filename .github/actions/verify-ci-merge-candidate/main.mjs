import { runCiMergeCandidateCheck } from "../../../scripts/check-ci-merge-candidate.mjs";

try {
  runCiMergeCandidateCheck({
    env: {
      ...process.env,
      KEIKO_CANDIDATE_BASE_SHA: process.env["INPUT_BASE-SHA"],
      KEIKO_CANDIDATE_HEAD_SHA: process.env["INPUT_HEAD-SHA"],
    },
  });
} catch (error) {
  process.stderr.write(
    `ci-merge-candidate: FAIL - ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
