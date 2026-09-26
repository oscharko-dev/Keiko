import { dirname, isAbsolute, join, win32 } from "node:path";
import { containsPath } from "@oscharko-dev/keiko-git";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import {
  defaultResolveExecutable,
  type ExecutableResolver,
  type ExecutableResolverDeps,
} from "./exec.js";
import { canonicalGitHubPushUrl } from "./git-push-destination.js";

export interface GitHubPushAuthenticationDeps extends ExecutableResolverDeps {
  readonly resolveExecutable?: ExecutableResolver | undefined;
}
export interface GitHubPushAuthentication {
  readonly configArgs: readonly string[];
  readonly pinnedEnv: Readonly<Record<string, string>>;
}

/** Git runs its credential protocol through sh on POSIX and Git for Windows; operands stay quoted. */
export function gitCredentialHelperCommand(
  executable: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const path = platform === "win32" ? executable.replaceAll("\\", "/") : executable;
  const absolute = platform === "win32" ? win32.isAbsolute(executable) : isAbsolute(executable);
  if (!absolute || /[\r\n\0]/u.test(path)) throw new TypeError("git-push-auth-executable-invalid");
  if (platform === "win32" && !path.toLowerCase().endsWith(".exe"))
    throw new TypeError("git-push-auth-executable-invalid");
  const escaped = path.replaceAll("'", String.raw`'\''`);
  return `!'${escaped}' auth git-credential`;
}

/**
 * Only Git and the official gh helper exchange credential protocol bytes. Keiko prepares fixed
 * configuration and metadata checks; it never invokes the helper itself or reads credential values.
 * Generic/manual pushes keep their existing path; SSH needs no HTTP credential helper.
 */
export function prepareGitHubPushAuthentication(
  remoteUrl: string,
  deps: GitHubPushAuthenticationDeps,
): GitHubPushAuthentication {
  const canonical = canonicalGitHubPushUrl(remoteUrl);
  if (canonical === undefined) throw new TypeError("git-push-auth-destination-invalid");
  if (!canonical.startsWith("https://github.com/")) return { configArgs: [], pinnedEnv: {} };
  assertAccountPaths(deps);
  const resolver = deps.resolveExecutable ?? defaultResolveExecutable;
  const executable = resolver("gh", deps);
  assertExternalPath(executable, deps);
  return {
    configArgs: [
      "-c",
      "credential.helper=",
      "-c",
      `credential.https://github.com.helper=${gitCredentialHelperCommand(executable)}`,
      "-c",
      "credential.interactive=false",
      "-c",
      "credential.useHttpPath=true",
    ],
    pinnedEnv: {
      GH_HOST: "github.com",
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
      GH_TELEMETRY: "0",
    },
  };
}

function pathFailure(): TypeError {
  return new TypeError("git-push-auth-config-untrusted");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function nearestExisting(path: string, fs: WorkspaceFs): string {
  let current = path;
  for (;;) {
    try {
      fs.stat(current);
      return fs.realPath(current);
    } catch (error) {
      // Missing descendants are normal for an account that authenticates via GH_TOKEN. Broken
      // aliases and unreadable existing config are refused, never treated as an empty credential store.
      if (!isMissing(error) || fs.exists(current)) throw pathFailure();
      const parent = dirname(current);
      if (parent === current) throw pathFailure();
      current = parent;
    }
  }
}

function assertExternalPath(path: string, deps: GitHubPushAuthenticationDeps): void {
  if (!isAbsolute(path) || path.length > 4_096 || /[\r\n\0]/u.test(path)) throw pathFailure();
  const fs = deps.fs ?? nodeWorkspaceFs;
  const root = fs.realPath(deps.workspace.root);
  if (containsPath(deps.workspace.root, path) || containsPath(root, nearestExisting(path, fs)))
    throw pathFailure();
}

function configDirectory(env: NodeJS.ProcessEnv): string | undefined {
  if (env.GH_CONFIG_DIR) return env.GH_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "gh");
  const appData = env.AppData ?? env.APPDATA;
  if (process.platform === "win32" && appData) return join(appData, "GitHub CLI");
  const home = process.platform === "win32" ? (env.USERPROFILE ?? env.HOME) : env.HOME;
  return home ? join(home, ".config", "gh") : undefined;
}

function assertAccountPaths(deps: GitHubPushAuthenticationDeps): void {
  // Access only non-secret selectors. Reading/enumerating credential-bearing environment values
  // belongs exclusively to the existing spawn boundary's forwarding and output-redaction machinery.
  for (const key of [
    "GH_CONFIG_DIR",
    "XDG_CONFIG_HOME",
    "HOME",
    "USERPROFILE",
    "AppData",
    "APPDATA",
  ]) {
    const path = deps.processEnv[key];
    if (path) assertExternalPath(path, deps);
  }
  const config = configDirectory(deps.processEnv);
  if (config === undefined) return;
  for (const path of [config, join(config, "config.yml"), join(config, "hosts.yml")])
    assertExternalPath(path, deps);
}
