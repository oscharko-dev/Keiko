import {
  buildGitHubCodeContextArgv,
  buildGitHubCodeContextCommentsArgv,
  gitHubCodeContextRawObjectFrom,
  type CodeContextConnector,
  type CodeContextRawObject,
  type CodeContextRef,
  type GitHubCodeContextRef,
} from "./codeContextConnector.js";

export interface GitHubCodeContextReadContext {
  readonly signal?: AbortSignal | undefined;
  readonly correlationId?: string | undefined;
}

export interface GitHubCodeContextApiPort {
  readJson(argv: readonly string[], context?: GitHubCodeContextReadContext): Promise<unknown>;
}

export const GITHUB_CODE_CONTEXT_ALLOWED_SUBCOMMANDS: readonly string[] = Object.freeze(["api"]);

// KEIKO-0223: The single canonical CommandRule allowlist for `gh` invocations under the
// coding-context surface lives in `githubCodeContextPort.ts` (GH_CODE_CONTEXT_COMMAND_RULES),
// where it is actually enforced at the governed spawn boundary. This module used to export a
// second, weaker rule set that admitted mutation-adjacent value flags (`--method`, `-X`,
// `--hostname`) and only denied a subset of write flags — that variant reached production code
// via zero call sites and was exercised only by its own test, so a real invocation always went
// through the port's stricter rules. To prevent the weaker copy from silently drifting back into
// production, re-export the port's canonical rules from here for tests that need them.

export function createGitHubCodeContextConnector(
  api: GitHubCodeContextApiPort,
): CodeContextConnector {
  return {
    read: async (ref): Promise<CodeContextRawObject> => readGitHubCodeContext(api, ref),
  };
}

export function gitHubCodeContextArgvIsGoverned(argv: readonly string[]): boolean {
  return argv.length > 0 && GITHUB_CODE_CONTEXT_ALLOWED_SUBCOMMANDS.includes(argv[0] ?? "");
}

async function readGitHubCodeContext(
  api: GitHubCodeContextApiPort,
  ref: CodeContextRef,
): Promise<CodeContextRawObject> {
  const githubRef = assertGitHubRef(ref);
  const [objectJson, commentsJson] = await Promise.all([
    api.readJson(buildGitHubCodeContextArgv(githubRef)),
    api.readJson(buildGitHubCodeContextCommentsArgv(githubRef)),
  ]);
  // KEIKO-#3384 B5-11/B5-15/reuse-duplication-1: this connector used to carry its own private
  // GitHub-object-to-CodeContextRawObject mapper, a byte-for-byte duplicate of the projection
  // codeContextConnector.ts owns, except it silently dropped the identity fields
  // (providerId/providerNodeId/state/isPullRequest/commentCount) the shared jq projection already
  // fetches. Call the canonical mapper so this connector's consumers (the chat/@mention
  // coding-context pack route and the editor's connected-context provider) see the same identity
  // fields the issue-resolution security path already relies on, and so there is exactly one
  // owner of the gh-api-to-CodeContextRawObject projection.
  return gitHubCodeContextRawObjectFrom(githubRef, objectJson, commentsJson);
}

function assertGitHubRef(ref: CodeContextRef): GitHubCodeContextRef {
  if (ref.source !== "github") throw new Error("GitHub connector received non-GitHub ref");
  return ref;
}
