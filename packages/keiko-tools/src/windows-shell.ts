// Hardened Windows shell invocation builder — issue #3350 / Node CVE-2024-27980.
//
// Since Node's CVE-2024-27980 fix, spawning a `.cmd`/`.bat` executable with `shell: false` raises
// `EINVAL` on Windows: `.cmd`/`.bat` files are cmd.exe scripts, not native PE binaries, and
// CreateProcess cannot execute them directly. `exec.ts`'s allowlisted-command resolver honours
// `PATHEXT`, so on Windows a bare `npm`/`git` regularly resolves to an absolute `...\npm.CMD` —
// and every such run failed closed with EINVAL before this module existed.
//
// The historical workaround (`shell: true`) is not an option here — it hands the whole command
// line to cmd.exe's OWN parser, reintroducing exactly the shell-injection surface `shell: false`
// exists to close. This module instead reproduces the escaping half of the battle-tested
// `cross-spawn` algorithm (MIT; the same one `npm` itself relies on to invoke `.cmd` shims on
// Windows): every argument is caret-escaped so cmd.exe's own metacharacters cannot be
// reinterpreted, the escaped command line is handed to `cmd.exe` as a SINGLE pre-quoted argument,
// and `windowsVerbatimArguments: true` tells Node to pass that string to `CreateProcess`
// byte-for-byte instead of re-quoting it. The result is spawned with `shell: false` end to end:
// cmd.exe runs a deterministic, fully-escaped argv, never as an interpreter of untrusted syntax.
//
// The `cmd.exe` binary itself is resolved from `%SystemRoot%\System32` (falling back to
// `%WINDIR%`, then the well-known default), NEVER from PATH — a workspace- or PATH-planted
// `cmd.exe` must never be the one an allowlisted command is routed through (mirrors the pattern
// the Windows portable-setup installer script uses to locate the system command processor).
//
// Pure and side-effect-free: callers may inject `env`/`platform` for deterministic tests; the
// defaults read `process.env`/`process.platform` only for production callers' convenience.

import { win32 } from "node:path";

// cross-spawn's metachar class, reproduced verbatim: each of these characters is meaningful to
// cmd.exe's own parser and must be caret-escaped wherever it appears in the assembled command
// line, INCLUDING in the resolved executable path (defence in depth beyond upstream cross-spawn,
// which trusts its own PATH walk and leaves the command component unescaped).
const CMD_METACHARACTERS = /([()\][%!^"`<>&|;, *?])/g;
const CMD_SHIM_EXTENSION = /\.(cmd|bat)$/i;
// An npm-generated `node_modules\.bin\<name>.cmd` shim re-expands `%*` into a SECOND cmd.exe command
// line (it forwards the arguments on to `node <cli> %*`), so a metacharacter escaped once for the
// outer `cmd.exe /d /s /c` parse is consumed there and would reach the shim's inner parse bare —
// an injection vector for a shim on PATH (e.g. another project's typescript-language-server.cmd).
// cross-spawn caret-escapes such arguments TWICE so a caret survives both parses; the trigger is the
// `.bin`-shim PATH SHAPE, not a UNC path (cross-spawn has no UNC-specific handling). Reproduced from
// cross-spawn 7.0.6 (moxystudio/node-cross-spawn PR #160), with the literal dot escaped.
const CMD_SHIM_PATH = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;

export interface WindowsShellInvocationOptions {
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}

// `windowsVerbatimArguments` is always present (never optional) so a caller can branch on it
// without an exactOptionalPropertyTypes presence check: `false` on every pass-through path (a
// non-win32 platform, or a resolved path that is not `.cmd`/`.bat`), `true` only when `args` were
// built by the escaping algorithm below and MUST reach `CreateProcess` unmodified.
export interface WindowsShellInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments: boolean;
}

// cross-spawn `escape.command`. Caret-escapes metacharacters in the resolved executable path.
function escapeCommand(arg: string): string {
  return arg.replace(CMD_METACHARACTERS, "^$1");
}

// cross-spawn `escape.argument` (7.0.6, reproduced verbatim). `doubleEscapeMetaChars` re-runs the
// metachar pass over the already-escaped string — including the carets the first pass inserted —
// which an npm `.bin` cmd-shim needs because it re-parses `%*` a second time (see CMD_SHIM_PATH).
// The two backslash-doubling replacements use cross-spawn's LOOKAHEAD form, deliberately NOT the
// simpler `/(\\*)"/g` and `/(\\*)$/`: those backtrack quadratically and hang the event loop on a
// long backslash run (cross-spawn PR #160 changed exactly this to disable JS backtracking).
function escapeArgument(arg: string, doubleEscapeMetaChars: boolean): string {
  let escaped = arg;
  escaped = escaped.replace(/(?=(\\+?)?)\1"/g, String.raw`$1$1\"`);
  escaped = escaped.replace(/(?=(\\+?)?)\1$/, "$1$1");
  escaped = '"' + escaped + '"';
  escaped = escaped.replace(CMD_METACHARACTERS, "^$1");
  if (doubleEscapeMetaChars) {
    escaped = escaped.replace(CMD_METACHARACTERS, "^$1");
  }
  return escaped;
}

function isCmdShim(resolvedCommandPath: string): boolean {
  return CMD_SHIM_PATH.test(resolvedCommandPath);
}

function needsCmdWrapping(resolvedCommandPath: string): boolean {
  return CMD_SHIM_EXTENSION.test(resolvedCommandPath);
}

function systemRoot(env: NodeJS.ProcessEnv): string {
  return env.SystemRoot ?? env.WINDIR ?? String.raw`C:\Windows`;
}

// Resolved from the environment, NEVER from PATH: a workspace-writable or PATH-planted cmd.exe
// must never be the one an allowlisted command is routed through.
function cmdExePath(env: NodeJS.ProcessEnv): string {
  return win32.join(systemRoot(env), "System32", "cmd.exe");
}

function buildWrappedInvocation(
  resolvedCommandPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): WindowsShellInvocation {
  const doubleEscapeMetaChars = isCmdShim(resolvedCommandPath);
  const normalizedCommand = win32.normalize(resolvedCommandPath);
  const escapedParts = [
    escapeCommand(normalizedCommand),
    ...args.map((arg) => escapeArgument(arg, doubleEscapeMetaChars)),
  ];
  const commandLine = '"' + escapedParts.join(" ") + '"';
  return {
    command: cmdExePath(env),
    args: ["/d", "/s", "/c", commandLine],
    windowsVerbatimArguments: true,
  };
}

// Wraps a resolved `.cmd`/`.bat` executable in a hardened `cmd.exe /d /s /c "..."` invocation so a
// `shell: false` spawn does not raise `EINVAL` on Windows (Node CVE-2024-27980), without ever
// introducing an injectable shell: every argument is escaped through the cross-spawn algorithm
// before `windowsVerbatimArguments` hands the exact string to `CreateProcess` untouched. Every
// other case — a non-Windows platform, or a resolved path that is not `.cmd`/`.bat` (`.exe`,
// `.com`, no extension) — is returned unchanged: this wrapper is additive, never a general-purpose
// shell gateway.
export function buildWindowsShellInvocation(
  resolvedCommandPath: string,
  args: readonly string[],
  opts?: WindowsShellInvocationOptions,
): WindowsShellInvocation {
  const platform = opts?.platform ?? process.platform;
  if (platform !== "win32" || !needsCmdWrapping(resolvedCommandPath)) {
    return { command: resolvedCommandPath, args, windowsVerbatimArguments: false };
  }
  const env = opts?.env ?? process.env;
  return buildWrappedInvocation(resolvedCommandPath, args, env);
}
