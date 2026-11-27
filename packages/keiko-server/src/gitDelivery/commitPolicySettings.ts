import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { GitCommitMessagePolicy } from "@oscharko-dev/keiko-contracts";
import {
  gitCommitMessagePolicyForMode,
  resolveGitCommitMessagePolicyMode,
  type GitCommitMessagePolicyMode,
} from "@oscharko-dev/keiko-contracts/runtime/git-commit-policy";

import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import type { UiHandlerDeps } from "../deps.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";

/** Where the message policy came from: a person's setting, the repository itself, or a fallback. */
export type GovernedCommitMessagePolicySource = "setting" | "repository" | "fallback";

export interface GovernedCommitMessagePolicyDecision {
  readonly policy: GitCommitMessagePolicy;
  readonly mode: GitCommitMessagePolicyMode;
  readonly source: GovernedCommitMessagePolicySource;
}

// The files through which a repository declares that its commit messages are linted by convention.
const COMMITLINT_CONFIG_FILES: readonly string[] = [
  "commitlint.config.js",
  "commitlint.config.cjs",
  "commitlint.config.mjs",
  "commitlint.config.ts",
  "commitlint.config.cts",
  "commitlint.config.mts",
  ".commitlintrc",
  ".commitlintrc.json",
  ".commitlintrc.yaml",
  ".commitlintrc.yml",
  ".commitlintrc.js",
  ".commitlintrc.cjs",
  ".commitlintrc.mjs",
  ".commitlintrc.ts",
  ".commitlintrc.cts",
  ".commitlintrc.mts",
];
const PACKAGE_JSON_MAX_BYTES = 1_048_576;

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    // The size is asked first: an oversize manifest is never loaded, and is never read as "none".
    if ((await stat(path)).size > PACKAGE_JSON_MAX_BYTES)
      throw new Error("commit-policy-manifest-too-large");
    return await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return undefined;
    throw error;
  }
}

function packageDeclaresCommitlint(text: string): boolean {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) return false;
  const record = parsed as Record<string, unknown>;
  if ("commitlint" in record) return true;
  return ["dependencies", "devDependencies"].some((key) => {
    const group = record[key];
    return (
      typeof group === "object" &&
      group !== null &&
      Object.keys(group).some((name) => name === "commitlint" || name.startsWith("@commitlint/"))
    );
  });
}

/**
 * True only when the repository itself declares a commit-message convention Keiko can enforce: a
 * commitlint configuration, or a `commitlint` key or dependency in `package.json`. A repository that
 * declares none keeps its own habits and its own hooks; Keiko does not impose Conventional Commits.
 */
export async function repositoryDeclaresConventionalCommits(
  workspaceRoot: string,
): Promise<boolean> {
  for (const name of COMMITLINT_CONFIG_FILES) {
    if ((await readOptionalText(join(workspaceRoot, name))) !== undefined) return true;
  }
  const manifest = await readOptionalText(join(workspaceRoot, "package.json"));
  return manifest !== undefined && packageDeclaresCommitlint(manifest);
}

function decision(
  mode: GitCommitMessagePolicyMode,
  source: GovernedCommitMessagePolicySource,
): GovernedCommitMessagePolicyDecision {
  return { policy: gitCommitMessagePolicyForMode(mode), mode, source };
}

/**
 * The message policy and where it came from. A person's own setting always wins; with no setting the
 * repository decides (commitlint present means Keiko's Conventional check, otherwise the repository's
 * own hooks stay authoritative). A failed read fails closed to the Conventional check.
 */
export async function resolveGovernedCommitMessagePolicyDecision(
  deps: Pick<UiHandlerDeps, "editorSettingsControl" | "diagnostics">,
  workspaceRoot: string,
  configuredPolicy?: GitCommitMessagePolicy,
): Promise<GovernedCommitMessagePolicyDecision> {
  if (configuredPolicy !== undefined) {
    return {
      policy: configuredPolicy,
      mode: configuredPolicy.conventionalCommit.enabled
        ? "keiko-conventional"
        : "repository-native",
      source: "setting",
    };
  }
  try {
    const snapshot = await deps.editorSettingsControl?.read(workspaceRoot);
    const setting = snapshot?.settings.find((entry) => entry.id === "gitCommitMessagePolicy");
    if (setting?.source === "builtInDefault") {
      const mode = (await repositoryDeclaresConventionalCommits(workspaceRoot))
        ? "keiko-conventional"
        : "repository-native";
      return decision(mode, "repository");
    }
    return decision(resolveGitCommitMessagePolicyMode(setting?.value), "setting");
  } catch (error) {
    emitServerDiagnostic(
      deps.diagnostics,
      serverDiagnosticFromError({
        correlationId: UNKNOWN_CORRELATION_ID,
        source: "git-delivery.commit-policy",
        operation: "git.commit.message-policy.resolve",
        error,
        summary: "server-operation-failed",
        redact: (): string => "server-operation-failed",
      }),
    );
    return decision("keiko-conventional", "fallback");
  }
}

export async function resolveGovernedCommitMessagePolicy(
  deps: Pick<UiHandlerDeps, "editorSettingsControl" | "diagnostics">,
  workspaceRoot: string,
  configuredPolicy?: GitCommitMessagePolicy,
): Promise<GitCommitMessagePolicy> {
  return (await resolveGovernedCommitMessagePolicyDecision(deps, workspaceRoot, configuredPolicy))
    .policy;
}
