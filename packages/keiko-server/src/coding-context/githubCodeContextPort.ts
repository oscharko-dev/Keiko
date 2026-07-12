// Production GitHub port for the coding-context connector (Epic #1982, follow-up to #1989).
//
// Executes read-only `gh api` calls through the SINGLE governed spawn boundary,
// keiko-tools `runCommand`, exactly like the governed git delivery layer
// (git-pr-node.ts). No provider SDK, no raw token handling: `gh` resolves its own
// credentials and the exec boundary scrubs the child environment. The rule set and
// the pre-validation below make the port structurally read-only — mutating `gh api`
// invocations (method overrides or field payloads) are rejected before spawn.

import {
  DEFAULT_SANDBOX_POLICY,
  runCommand,
  type RunCommandDeps,
  type ExecutableResolver,
  type SpawnFn,
} from "@oscharko-dev/keiko-tools";
import { nodeSpawnFn } from "@oscharko-dev/keiko-tools/internal/exec";
import type { CommandRule, WorkspaceInfo } from "@oscharko-dev/keiko-contracts";

import { GITHUB_CODE_CONTEXT_ALLOWED_SUBCOMMANDS } from "./githubCodeContextConnector.js";
import type { GitHubCodeContextApiPort } from "./githubCodeContextConnector.js";

const GH_API_TIMEOUT_MS = 30_000;
const GH_API_MAX_STDOUT_BYTES = 4 * 1024 * 1024;

// Flags that turn `gh api` into a mutation or redirect it to another host. Presence
// anywhere in the argument vector rejects the invocation (deny-by-default posture).
const GH_API_DENY_FLAGS: readonly string[] = Object.freeze([
  "--method",
  "-X",
  "--field",
  "-F",
  "--raw-field",
  "-f",
  "--input",
  "--hostname",
  "--verbose",
]);

const GH_CODE_CONTEXT_COMMAND_RULES: readonly CommandRule[] = Object.freeze([
  {
    executable: "gh",
    allowedSubcommands: GITHUB_CODE_CONTEXT_ALLOWED_SUBCOMMANDS,
    denyFlags: GH_API_DENY_FLAGS,
  },
]);

export class GitHubCodeContextPortError extends Error {
  readonly code: "gh-denied" | "gh-failed" | "gh-invalid-json";

  constructor(code: "gh-denied" | "gh-failed" | "gh-invalid-json") {
    super(`github code context port: ${code}`);
    this.code = code;
  }
}

export interface GitHubCodeContextPortOptions {
  readonly workspace: WorkspaceInfo;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly spawn?: SpawnFn | undefined;
  readonly resolveExecutable?: ExecutableResolver | undefined;
  readonly now?: (() => number) | undefined;
  readonly timeoutMs?: number | undefined;
}

function assertReadOnlyGhApiArgv(argv: readonly string[]): void {
  const subcommand = argv[0];
  if (subcommand !== "api") throw new GitHubCodeContextPortError("gh-denied");
  for (const arg of argv) {
    if (GH_API_DENY_FLAGS.includes(arg)) throw new GitHubCodeContextPortError("gh-denied");
  }
  const endpoint = argv[1];
  if (endpoint === undefined || !/^\/?repos\//u.test(endpoint)) {
    throw new GitHubCodeContextPortError("gh-denied");
  }
}

function runDepsFor(options: GitHubCodeContextPortOptions): RunCommandDeps {
  return {
    workspace: options.workspace,
    policy: DEFAULT_SANDBOX_POLICY,
    commandRules: GH_CODE_CONTEXT_COMMAND_RULES,
    spawn: options.spawn ?? nodeSpawnFn,
    resolveExecutable: options.resolveExecutable,
    processEnv: options.processEnv,
    now: options.now ?? ((): number => Date.now()),
  };
}

function parseBoundedJson(stdout: string): unknown {
  if (Buffer.byteLength(stdout, "utf8") > GH_API_MAX_STDOUT_BYTES) {
    throw new GitHubCodeContextPortError("gh-invalid-json");
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new GitHubCodeContextPortError("gh-invalid-json");
  }
}

export function createGitHubCodeContextApiPort(
  options: GitHubCodeContextPortOptions,
): GitHubCodeContextApiPort {
  const runDeps = runDepsFor(options);
  const timeoutMs = options.timeoutMs ?? GH_API_TIMEOUT_MS;
  return {
    readJson: async (argv: readonly string[]): Promise<unknown> => {
      assertReadOnlyGhApiArgv(argv);
      let exitCode: number | null;
      let stdout: string;
      try {
        const result = await runCommand(
          {
            command: "gh",
            args: argv,
            cwd: undefined,
            timeoutMs,
            signal: new AbortController().signal,
          },
          runDeps,
        );
        exitCode = result.exitCode;
        stdout = result.stdout;
      } catch {
        // Timeout, cancellation, or spawn failure: surface a content-free code only.
        throw new GitHubCodeContextPortError("gh-failed");
      }
      if (exitCode !== 0) throw new GitHubCodeContextPortError("gh-failed");
      return parseBoundedJson(stdout);
    },
  };
}
