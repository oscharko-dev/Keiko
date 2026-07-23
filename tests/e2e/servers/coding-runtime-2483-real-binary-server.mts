// Real OpenCode 1.17.17 entry for #2483. Runtime resolution is deliberately absent from this
// entry: the shared harness enables the macOS dev lane and buildUiHandlerDeps must discover the
// staged approved payload through production discovery and production composition.

import {
  AUTHORITY_APP_SESSION_LAUNCHER_SECRET,
  AUTHORITY_EDITED_CONTENT,
  AUTHORITY_ORIGINAL_CONTENT,
  AUTHORITY_TARGET_RELATIVE_PATH,
  authorityManagedWorkspaceRoot,
  authorityRepositoryRoot,
} from "../support/coding-runtime-2386-authority.js";
import {
  REAL_BINARY_DEFAULT_UI_PORT,
  realBinaryStateDir,
} from "../support/coding-runtime-2483-real-binary.js";
import { runCodingRuntimeJourneyServer } from "./coding-runtime-server-shared.mjs";

await runCodingRuntimeJourneyServer({
  fixtureId: "real-binary-2483",
  fixtureLabel: "Real binary 2483",
  runtime: "production-discovery",
  includeQuestion: true,
  defaultPort: REAL_BINARY_DEFAULT_UI_PORT,
  originalContent: AUTHORITY_ORIGINAL_CONTENT,
  editedContent: AUTHORITY_EDITED_CONTENT,
  targetRelativePath: AUTHORITY_TARGET_RELATIVE_PATH,
  stateDir: realBinaryStateDir,
  repositoryRoot: authorityRepositoryRoot,
  managedRoot: authorityManagedWorkspaceRoot,
  launcherSessionSecret: AUTHORITY_APP_SESSION_LAUNCHER_SECRET,
});
