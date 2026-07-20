// Scripted-engine entry for the #2385 Code-task tracer. Shared composition lives in
// coding-runtime-server-shared.mts so every Code-task journey boots the same BFF/UI/workspace path.

import {
  TRACER_DEFAULT_UI_PORT,
  TRACER_EDITED_CONTENT,
  TRACER_ORIGINAL_CONTENT,
  TRACER_TARGET_RELATIVE_PATH,
  tracerManagedWorkspaceRoot,
  tracerRepositoryRoot,
  tracerStateDir,
} from "../support/coding-runtime-2385-tracer.js";
import { runCodingRuntimeJourneyServer } from "./coding-runtime-server-shared.mjs";

await runCodingRuntimeJourneyServer({
  fixtureId: "tracer-2385",
  fixtureLabel: "Tracer 2385",
  runtime: "scripted",
  includeQuestion: false,
  defaultPort: TRACER_DEFAULT_UI_PORT,
  originalContent: TRACER_ORIGINAL_CONTENT,
  editedContent: TRACER_EDITED_CONTENT,
  targetRelativePath: TRACER_TARGET_RELATIVE_PATH,
  stateDir: tracerStateDir,
  repositoryRoot: tracerRepositoryRoot,
  managedRoot: tracerManagedWorkspaceRoot,
});
