// Scripted-engine entry for the #2386 real-authority Code-task journey. Shared composition lives in
// coding-runtime-server-shared.mts so the real-binary variant can reuse the same browser journey.

import {
  AUTHORITY_APP_SESSION_LAUNCHER_SECRET,
  AUTHORITY_DEFAULT_UI_PORT,
  AUTHORITY_EDITED_CONTENT,
  AUTHORITY_ORIGINAL_CONTENT,
  AUTHORITY_TARGET_RELATIVE_PATH,
  authorityManagedWorkspaceRoot,
  authorityRepositoryRoot,
  authorityStateDir,
} from "../support/coding-runtime-2386-authority.js";
import { runCodingRuntimeJourneyServer } from "./coding-runtime-server-shared.mjs";

await runCodingRuntimeJourneyServer({
  fixtureId: "authority-2386",
  fixtureLabel: "Authority 2386",
  runtime: "scripted",
  includeQuestion: true,
  // Under the causal-terminal contract the child's first `stop` completion settles the run, so a
  // turn that ends after verification would leave nothing to pause. The journey drives pause,
  // follow-up, resume and stop on the live run, which the scripted model holds open with a
  // blocking question once verification completed.
  holdAfterVerification: true,
  defaultPort: AUTHORITY_DEFAULT_UI_PORT,
  originalContent: AUTHORITY_ORIGINAL_CONTENT,
  editedContent: AUTHORITY_EDITED_CONTENT,
  targetRelativePath: AUTHORITY_TARGET_RELATIVE_PATH,
  stateDir: authorityStateDir,
  repositoryRoot: authorityRepositoryRoot,
  managedRoot: authorityManagedWorkspaceRoot,
  launcherSessionSecret: AUTHORITY_APP_SESSION_LAUNCHER_SECRET,
});
