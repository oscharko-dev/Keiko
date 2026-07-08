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
