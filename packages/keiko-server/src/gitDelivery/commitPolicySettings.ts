import {
  defaultGitProcessRunner,
  type GitProcessResult,
  type GitProcessRunner,
} from "@oscharko-dev/keiko-git";
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
const COMMIT_POLICY_GIT_TIMEOUT_MS = 10_000;
const TREE_LISTING_MAX_BYTES = 4_194_304;
const REGULAR_BLOB_MODES: ReadonlySet<string> = new Set(["100644", "100755"]);

async function runCommittedRead(
  runner: GitProcessRunner,
  root: string,
  args: readonly string[],
  maxBytes: number,
  expectedExitCodes?: readonly number[],
): Promise<GitProcessResult> {
  const result = await runner(args, {
    cwd: root,
    maxBytes,
    timeoutMs: COMMIT_POLICY_GIT_TIMEOUT_MS,
    ...(expectedExitCodes === undefined ? {} : { expectedExitCodes }),
  });
  const failed =
    result.refusal !== undefined ||
    result.timedOut === true ||
    result.aborted === true ||
    result.truncated;
  if (failed) throw new Error("commit-policy-committed-read-failed");
  return result;
}

interface RootEntry {
  readonly mode: string;
  readonly type: string;
  readonly object: string;
}

// `git ls-tree -z HEAD` lines: `<mode> SP <type> SP <object> TAB <name> NUL`.
function parseRootEntries(stdout: string): ReadonlyMap<string, RootEntry> {
  const entries = new Map<string, RootEntry>();
  for (const record of stdout.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, object] = record.slice(0, tab).split(" ");
    if (mode === undefined || type === undefined || object === undefined) continue;
    entries.set(record.slice(tab + 1), { mode, type, object });
  }
  return entries;
}

async function readCommittedRootEntries(
  runner: GitProcessRunner,
  root: string,
): Promise<ReadonlyMap<string, RootEntry> | undefined> {
  // An unborn HEAD (exit 1 under --quiet) has committed nothing, so it declares no convention.
  const head = await runCommittedRead(
    runner,
    root,
    ["rev-parse", "--verify", "--quiet", "HEAD"],
    256,
    [1],
  );
  if (head.exitCode === 1) return undefined;
  if (head.exitCode !== 0) throw new Error("commit-policy-committed-read-failed");
  const listing = await runCommittedRead(
    runner,
    root,
    ["ls-tree", "-z", "HEAD"],
    TREE_LISTING_MAX_BYTES,
  );
  if (listing.exitCode !== 0) throw new Error("commit-policy-committed-read-failed");
  return parseRootEntries(listing.stdout);
}

async function readCommittedManifest(
  runner: GitProcessRunner,
  root: string,
  entry: RootEntry,
): Promise<string> {
  if (entry.type !== "blob" || !REGULAR_BLOB_MODES.has(entry.mode))
    throw new Error("commit-policy-manifest-not-regular");
  const blob = await runCommittedRead(
    runner,
    root,
    ["cat-file", "blob", entry.object],
    PACKAGE_JSON_MAX_BYTES,
  );
  if (blob.exitCode !== 0) throw new Error("commit-policy-committed-read-failed");
  return blob.stdout;
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
 * True only when the repository itself declares, in the tree of its current `HEAD`, a commit-message
 * convention Keiko can enforce: a commitlint configuration, or a `commitlint` key or dependency in
 * `package.json`. The declaration is read from the committed tree, never from the working tree, so a
 * run that deletes or edits those files cannot downgrade the commit-message gate. A repository that
 * declares none keeps its own habits and its own hooks; Keiko does not impose Conventional Commits.
 */
export async function repositoryDeclaresConventionalCommits(
  workspaceRoot: string,
  runner: GitProcessRunner = defaultGitProcessRunner,
): Promise<boolean> {
  const entries = await readCommittedRootEntries(runner, workspaceRoot);
  if (entries === undefined) return false;
  if (COMMITLINT_CONFIG_FILES.some((name) => entries.has(name))) return true;
  const manifest = entries.get("package.json");
  if (manifest === undefined) return false;
  return packageDeclaresCommitlint(await readCommittedManifest(runner, workspaceRoot, manifest));
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
function emitFallbackDiagnostic(
  deps: Pick<UiHandlerDeps, "diagnostics">,
  correlationId: string,
  error: unknown,
): void {
  emitServerDiagnostic(
    deps.diagnostics,
    serverDiagnosticFromError({
      correlationId,
      source: "git-delivery.commit-policy",
      operation: "git.commit.message-policy.resolve",
      error,
      summary: "server-operation-failed",
      redact: (): string => "server-operation-failed",
    }),
  );
}

async function decisionFromSettings(
  deps: Pick<UiHandlerDeps, "editorSettingsControl">,
  workspaceRoot: string,
): Promise<GovernedCommitMessagePolicyDecision> {
  const snapshot = await deps.editorSettingsControl?.read(workspaceRoot);
  const setting = snapshot?.settings.find((entry) => entry.id === "gitCommitMessagePolicy");
  if (setting?.source !== "builtInDefault") {
    return decision(resolveGitCommitMessagePolicyMode(setting?.value), "setting");
  }
  const declared = await repositoryDeclaresConventionalCommits(workspaceRoot);
  return decision(declared ? "keiko-conventional" : "repository-native", "repository");
}

export async function resolveGovernedCommitMessagePolicyDecision(
  deps: Pick<UiHandlerDeps, "editorSettingsControl" | "diagnostics">,
  workspaceRoot: string,
  configuredPolicy?: GitCommitMessagePolicy,
  correlationId: string = UNKNOWN_CORRELATION_ID,
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
    return await decisionFromSettings(deps, workspaceRoot);
  } catch (error) {
    emitFallbackDiagnostic(deps, correlationId, error);
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
