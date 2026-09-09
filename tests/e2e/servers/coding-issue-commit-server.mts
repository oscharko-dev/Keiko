import { runCodingRuntimeJourneyServer } from "./coding-runtime-server-shared.mjs";
import {
  COMMIT_EDITED,
  COMMIT_LAUNCHER_SECRET,
  COMMIT_ORIGINAL,
  COMMIT_PORT,
  COMMIT_TARGET,
  commitManagedRoot,
  commitRepository,
  commitStateDir,
} from "../support/coding-issue-commit.js";

await runCodingRuntimeJourneyServer({
  fixtureId: "verified-commit-3386",
  fixtureLabel: "Verified commit 3386",
  runtime: "scripted",
  includeQuestion: false,
  defaultPort: COMMIT_PORT,
  originalContent: COMMIT_ORIGINAL,
  editedContent: COMMIT_EDITED,
  targetRelativePath: COMMIT_TARGET,
  stateDir: commitStateDir,
  repositoryRoot: commitRepository,
  managedRoot: commitManagedRoot,
  launcherSessionSecret: COMMIT_LAUNCHER_SECRET,
  commit: true,
});
