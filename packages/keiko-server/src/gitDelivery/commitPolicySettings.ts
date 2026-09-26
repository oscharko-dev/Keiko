import type { GitCommitMessagePolicy } from "@oscharko-dev/keiko-contracts";
import {
  gitCommitMessagePolicyForMode,
  resolveGitCommitMessagePolicyMode,
} from "@oscharko-dev/keiko-contracts/runtime/git-commit-policy";

import type { UiHandlerDeps } from "../deps.js";

export async function resolveGovernedCommitMessagePolicy(
  deps: Pick<UiHandlerDeps, "editorSettingsControl">,
  workspaceRoot: string,
  configuredPolicy?: GitCommitMessagePolicy,
): Promise<GitCommitMessagePolicy> {
  if (configuredPolicy !== undefined) return configuredPolicy;
  try {
    const snapshot = await deps.editorSettingsControl?.read(workspaceRoot);
    const selection = snapshot?.settings.find(
      (setting) => setting.id === "gitCommitMessagePolicy",
    )?.value;
    return gitCommitMessagePolicyForMode(resolveGitCommitMessagePolicyMode(selection));
  } catch {
    return gitCommitMessagePolicyForMode("keiko-conventional");
  }
}
