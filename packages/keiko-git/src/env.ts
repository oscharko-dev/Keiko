// Git process environments. Two hardened profiles cover every git execution in the product:
// `gitEnv` for local reads (fully config-isolated), `networkGitEnv` for clone/fetch/pull/push
// (credential-capable but never interactive). Both pin LC_ALL=C so every parsed or classified
// git message is stable English — a localized `fatal:` line must never defeat failure
// classification. Porcelain `-z` path output is raw bytes and unaffected by the C locale.

function devNullPath(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "NUL" : "/dev/null";
}

// Local-read env: fully config-isolated. HOME/XDG/global+system config are neutralized so a read
// can never load a user `~/.gitconfig`, a credential helper, or an SSH identity. Correct for the
// local status/diff/branches/summary/history/remotes reads, which never authenticate to a remote.
export function gitEnv(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: source.PATH ?? "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNullPath(platform),
    GIT_OPTIONAL_LOCKS: "0",
    // A local read or branch switch must never invoke a promisor remote's lazy fetch. The
    // protocol denylist also protects older Git versions that ignore GIT_NO_LAZY_FETCH.
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "",
    LC_ALL: "C",
  };
  if (platform === "win32") {
    env.SystemRoot = source.SystemRoot ?? "";
    env.WINDIR = source.WINDIR ?? "";
  } else {
    env.HOME = "/nonexistent";
    env.XDG_CONFIG_HOME = "/nonexistent";
  }
  return env;
}

const GIT_NETWORK_ENV_PASSTHROUGH = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "TMPDIR",
  "TEMP",
  "TMP",
  "USER",
  "USERNAME",
  "SystemRoot",
  "WINDIR",
] as const;

function inheritAllowedGitNetworkEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of GIT_NETWORK_ENV_PASSTHROUGH) {
    const value = source[key];
    if (value !== undefined && value.length > 0) env[key] = value;
  }
  env.PATH ??= process.env.PATH ?? "";
  return env;
}

// Network-sync env: clone/fetch/pull/push MUST be able to authenticate to private/SSH remotes, so
// they preserve only the account and SSH-agent state needed for normal git credentials. They do
// not inherit arbitrary ambient secrets or caller-provided GIT_* overrides. Prompts remain
// disabled at every layer, so missing credentials fail closed rather than opening a terminal, GUI
// askpass, or first-use host-key flow. LC_ALL=C (not inherited) keeps remote/transport errors in
// English for the sync/publish outcome classifiers. Local reads keep the fully config-isolated
// `gitEnv` above.
export function networkGitEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...inheritAllowedGitNetworkEnv(source),
    GIT_TERMINAL_PROMPT: "0", // never prompt — fail closed
    GIT_ASKPASS: devNullPath(),
    SSH_ASKPASS: devNullPath(),
    SSH_ASKPASS_REQUIRE: "never",
    GCM_INTERACTIVE: "never",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
    // No SSH credential prompt and no implicit first-use trust. Unknown or changed host keys fail
    // closed and are surfaced by the sync outcome classifier.
    GIT_SSH_COMMAND:
      "ssh -oBatchMode=yes -oStrictHostKeyChecking=yes -oNumberOfPasswordPrompts=0 -oKbdInteractiveAuthentication=no -oPasswordAuthentication=no",
  };
}

// Review env (ADR-0182 D3, Issue #4133): the review worktree materializes a hostile pull request
// head, so both review profiles add the Git LFS smudge skip on top of their base profile. With it,
// an installed `git-lfs` that a configured `filter.lfs.*` driver would otherwise invoke leaves every
// LFS pointer a pointer; the runner's filter neutralization removes the driver itself as well.
// Local review operations keep `gitEnv`'s complete config isolation; the pull request fetch keeps
// `networkGitEnv`'s bounded credential passthrough. Neither inherits a caller's `GIT_*` variables.
const GIT_REVIEW_ENV_ADDITIONS: Readonly<NodeJS.ProcessEnv> = Object.freeze({
  GIT_LFS_SKIP_SMUDGE: "1",
  GIT_TERMINAL_PROMPT: "0",
});

export function gitReviewEnv(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return { ...gitEnv(source, platform), ...GIT_REVIEW_ENV_ADDITIONS };
}

export function networkGitReviewEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...networkGitEnv(source), ...GIT_REVIEW_ENV_ADDITIONS };
}
