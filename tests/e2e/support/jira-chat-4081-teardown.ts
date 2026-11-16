import { join } from "node:path";
import { ACTIVITY_LOG_DIRECTORY_NAME } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { copyActivityLogEvidence } from "./activity-log-evidence.js";

/**
 * After the governed Jira Chat browser run, keep the server's Activity Log next to the Playwright
 * evidence so the next red explains itself (#4355). It runs whatever the outcome; only a failed CI job
 * uploads `test-results/`. The run's state directory holds the segments in its `logs` directory, the
 * one place the file sink writes them.
 */
export default function globalTeardown(): void {
  const state = process.env.KEIKO_QUALIFICATION_ACTIVITY_LOG_DIR;
  if (state === undefined || state.length === 0) return;
  copyActivityLogEvidence(
    join(state, ACTIVITY_LOG_DIRECTORY_NAME),
    join(process.cwd(), "test-results", "jira-chat-4081-activity-log"),
  );
}
