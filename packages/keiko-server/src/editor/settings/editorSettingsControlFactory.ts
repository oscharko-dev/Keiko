import type { EditorM7PolicyCeiling } from "@oscharko-dev/keiko-contracts";

import { createWorkspaceMutexRegistry } from "../../task-workspace/mutex.js";
import type { ManagedLspControlService } from "../lsp/managedLspControl.js";
import type { DebugActivationControlService } from "../dap/debugActivationControl.js";
import {
  createEditorSettingsControlService,
  type EditorSettingsControlService,
} from "./editorSettingsControl.js";
import { createEditorSettingsStore } from "./editorSettingsStore.js";
import {
  editorAiPolicyCeilingLocks,
  resolveEditorAiAssistStatuses,
  UNVERIFIED_EDITOR_AI_GATEWAY,
  type EditorAiGatewayStatus,
} from "../aiAssistActivation.js";

export interface NodeEditorSettingsControlOptions {
  readonly stateDir: string;
  readonly managedLspControl?: ManagedLspControlService | undefined;
  readonly debugActivation?: DebugActivationControlService | undefined;
  readonly processEnv?: Readonly<Record<string, string | undefined>> | undefined;
  /**
   * F-01: live gateway truth for the AI-assist projection, read per settings read. Omitting it
   * yields the fail-closed status (nothing configured, nothing verified), so a caller that does not
   * wire it gets an honest unverified badge rather than an unbacked green one.
   */
  readonly gatewayStatus?: (() => EditorAiGatewayStatus) | undefined;
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
  const gatewayStatus =
    options.gatewayStatus ?? ((): EditorAiGatewayStatus => UNVERIFIED_EDITOR_AI_GATEWAY);
  return createEditorSettingsControlService({
    store: createEditorSettingsStore({ stateDir: options.stateDir }),
    mutex: createWorkspaceMutexRegistry(),
    managedLspControl: options.managedLspControl,
    debugActivation: options.debugActivation,
    policyCeiling: () => policyCeilingFor(processEnv),
    aiAssistance: ({ revision, settings }) =>
      resolveEditorAiAssistStatuses({
        env: processEnv,
        gateway: gatewayStatus(),
        revision,
        settings,
      }),
  });
}
