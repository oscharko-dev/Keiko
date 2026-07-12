import type { EditorM7PolicyCeiling } from "@oscharko-dev/keiko-contracts";

import { createWorkspaceMutexRegistry } from "../../task-workspace/mutex.js";
import type { ManagedLspControlService } from "../lsp/managedLspControl.js";
import {
  createEditorSettingsControlService,
  type EditorSettingsControlService,
} from "./editorSettingsControl.js";
import { createEditorSettingsStore } from "./editorSettingsStore.js";
import {
  editorAiPolicyCeilingLocks,
  resolveEditorAiAssistStatuses,
} from "../aiAssistActivation.js";

export interface NodeEditorSettingsControlOptions {
  readonly stateDir: string;
  readonly managedLspControl?: ManagedLspControlService | undefined;
  readonly processEnv?: Readonly<Record<string, string | undefined>> | undefined;
}

function policyCeilingFor(
  env: Readonly<Record<string, string | undefined>>,
): EditorM7PolicyCeiling {
  return { locked: editorAiPolicyCeilingLocks(env) };
}

export function createNodeEditorSettingsControl(
  options: NodeEditorSettingsControlOptions,
): EditorSettingsControlService {
  const processEnv = options.processEnv ?? {};
  return createEditorSettingsControlService({
    store: createEditorSettingsStore({ stateDir: options.stateDir }),
    mutex: createWorkspaceMutexRegistry(),
    managedLspControl: options.managedLspControl,
    policyCeiling: () => policyCeilingFor(processEnv),
    aiAssistance: ({ revision, settings }) =>
      resolveEditorAiAssistStatuses({ env: processEnv, revision, settings }),
  });
}
