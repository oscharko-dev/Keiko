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
// Escaping the characters cmd.exe treats specially is not sufficient by itself: `cross-spawn`'s
// metachar class omits CR and LF (moxystudio/node-cross-spawn#179), and cmd.exe treats a bare CR
// or LF as a command boundary that no amount of caret-escaping closes. `assertNoControlCharacters`
// below therefore fails closed on CR/LF — and, defensively, the full C0 control range — in the
// resolved command path and every argument BEFORE either is joined into the string cmd.exe parses.
//
// The `cmd.exe` binary itself is resolved through `resolveSystemBinaryPath` (below), NEVER from
// PATH — a workspace- or PATH-planted `cmd.exe` must never be the one an allowlisted command is
// routed through. `%SystemRoot%`/`%WINDIR%` are mutable, inherited environment text, not a trusted
// value by themselves: an override is validated for canonical SHAPE (drive-absolute, no `..`
// segment, no UNC/device prefix, no quote, cmd metacharacter, or control character) and REJECTED —
// never silently replaced with the default — when it fails that check. The pattern mirrors
// `windowsSystemRoot` in `@oscharko-dev/keiko-security`'s `windows-shortcuts.ts` (the equivalent
// trust boundary for the cscript/PowerShell helpers), hardened further here to also reject the
// UNC and device-path overrides that an `isAbsolute`-only check would accept. Node has no binding
// to `GetSystemDirectoryW` — the only OS-authoritative source — so this validates SHAPE, never the
// live identity of the directory; `resolveSystemBinaryPath` is exported for every caller in this
// package that needs the same trusted-System32 resolution (e.g. `exec.ts`'s `taskkill.exe` lookup).
//
// Pure and side-effect-free: callers may inject `env`/`platform` for deterministic tests; the
// defaults read `process.env`/`process.platform` only for production callers' convenience.
//
// ─── Attribution ────────────────────────────────────────────────────────────────────────────
// `escapeCommand`/`escapeArgument` below reproduce the escaping algorithm of cross-spawn 7.0.6
// (`lib/util/escape.js`), MIT licensed:
//
//   The MIT License (MIT)
//   Copyright (c) 2018 Made With MOXY Lda <hello@moxy.studio>
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this
//   software and associated documentation files (the "Software"), to deal in the Software
//   without restriction, including without limitation the rights to use, copy, modify, merge,
//   publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
//   to whom the Software is furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in all copies or
//   substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
//   INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
//   PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
//   FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
//   OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
//   DEALINGS IN THE SOFTWARE.
//
// https://github.com/moxystudio/node-cross-spawn

import { win32 } from "node:path";

// cross-spawn's metachar class, reproduced verbatim: each of these characters is meaningful to
// cmd.exe's own parser and must be caret-escaped wherever it appears in the assembled command
// line, INCLUDING in the resolved executable path — cross-spawn escapes its command component
// too (`escape.command` in `lib/util/escape.js`), so matching that is parity with upstream, not
// extra hardening. What this module does beyond upstream is WHICH interpreter runs the escaped
// line: cross-spawn trusts `process.env.comspec || 'cmd.exe'` (env-controlled AND PATH-searchable,
// `lib/parse.js`), while this module resolves cmd.exe through `resolveSystemBinaryPath` (below),
// which validates an environment override instead of trusting it and never falls back to PATH.
//
// Caret-escaping `%` here stops it being re-parsed as a metacharacter on the SAME pass, but not
// cmd.exe's separate, earlier expansion of a `%NAME%`-shaped argument against the child process's
// own environment — a known cross-spawn residual this module faithfully inherits, not something
// caret-escaping neutralises. No current caller pairs a `.cmd` target with a credential-bearing
// environment policy, but `buildWindowsShellInvocation` is a public export: a future caller that
// does should not have to rediscover this by reading cmd.exe's own parsing order first.
const CMD_METACHARACTERS = /([()\][%!^"`<>&|;, *?])/g;

// The wrap trigger: exactly `.cmd`/`.bat`. cross-spawn's own condition is broader — it wraps
// everything that is NOT a recognised native image (`needsShell = !/\.(?:com|exe)$/i.test(...)`
// in `lib/parse.js`), i.e. an allowlist of the two extensions it does NOT wrap, not an allowlist
// of the ones it does. This module inverts that into the narrower two-entry allowlist below
// because today's only caller needs exactly `.cmd`/`.bat` wrapped: `exec.ts`'s resolver honours
// `PATHEXT`, which falls back to `.EXE;.CMD;.BAT;.COM` only when the host has not set one — but a
// real Windows host's default PATHEXT also lists `.VBS`, `.JS`, `.WSF`, and others. A resolution
// that ever lands on one of those trailing entries would take the (safe) pass-through branch
// below and could still hit the EINVAL this module exists to avoid: a latent gap versus upstream's
// condition, not a case this module claims to close. Widening this trigger to match upstream, or
// narrowing the caller's effective PATHEXT, is a follow-up — not a silent assumption of coverage.
const CMD_SHIM_EXTENSION = /\.(cmd|bat)$/i;
// An npm-generated `node_modules\.bin\<name>.cmd` shim re-expands `%*` into a SECOND cmd.exe command
// line (it forwards the arguments on to `node <cli> %*`), so a metacharacter escaped once for the
// outer `cmd.exe /d /s /c` parse is consumed there and would reach the shim's inner parse bare —
// an injection vector for a shim on PATH (e.g. another project's typescript-language-server.cmd).
// cross-spawn caret-escapes such arguments TWICE so a caret survives both parses; the trigger is the
// `.bin`-shim PATH SHAPE, not a UNC path (cross-spawn has no UNC-specific handling). Reproduced from
// cross-spawn 7.0.6 (moxystudio/node-cross-spawn PR #160), with the literal dot escaped.
const CMD_SHIM_PATH = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;

// NUL plus the full C0 control range plus DEL. cmd.exe treats a bare CR or LF as a command
// boundary that no caret-escaping neutralises (moxystudio/node-cross-spawn#179, the exact gap
// cross-spawn's own metachar class leaves open); the rest of the C0 range has no legitimate reason
// to appear in a resolved executable path or a shell-bound argument either, so the whole range
// fails closed together rather than special-casing CR/LF alone.
// eslint-disable-next-line no-control-regex -- intentionally matches control chars to REJECT them
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** Thrown when the resolved command path or an argument cannot be safely wrapped for cmd.exe. */
export class WindowsShellInvocationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WindowsShellInvocationError";
  }
}

// Fails closed BEFORE any value is joined into the cmd.exe command-line string built below. Never
// echoes the rejected value: a raw control character has no place in a thrown message either (some
// are terminal control codes in their own right), and the value may carry sensitive content.
function assertNoControlCharacters(value: string, label: string): void {
  if (CONTROL_CHARACTER.test(value)) {
    throw new WindowsShellInvocationError(`${label} must not contain a control character`);
  }
}

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

/** Thrown when a `SystemRoot`/`WINDIR` override — or a `binaryName` — fails canonical validation. */
export class WindowsSystemDirectoryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WindowsSystemDirectoryError";
  }
}

const DEFAULT_WINDOWS_SYSTEM_ROOT = String.raw`C:\Windows`;

// Drive-absolute only (`C:\...`). Deliberately excludes every other Windows path SHAPE that
// resolves against something other than one fixed drive letter: UNC (`\\server\share\...`) and
// device paths (`\\?\...`) resolve against a remote or reparsed namespace, root-relative
// (`\Windows`) resolves against the CURRENT drive, and bare-relative (`Windows`) resolves against
// the process cwd — the workspace, for every caller of this module. Each of those ambiguities is
// exactly the substitution this validation exists to reject.
const DRIVE_ABSOLUTE_WINDOWS_PATH = /^[A-Za-z]:\\/;

// Same character class as CMD_METACHARACTERS, without its `g` flag: `RegExp#test` on a global
// pattern mutates `lastIndex` across calls, and this runs for the life of the process, so a shared
// global instance would silently stop matching after its first hit. Deriving `.source` keeps the
// two definitions of "cmd metacharacter" from drifting apart instead of hand-duplicating the class.
const CMD_METACHARACTER_MEMBER = new RegExp(CMD_METACHARACTERS.source);

function hasPathTraversalSegment(candidate: string): boolean {
  return candidate.split(/[\\/]/).includes("..");
}

// Pure syntactic validation of a Windows system-directory OVERRIDE (`SystemRoot`/`WINDIR` from the
// environment). Node has no binding to `GetSystemDirectoryW` — the only OS-authoritative source —
// so this cannot confirm the returned directory truly IS the live system directory, only that its
// SHAPE is unambiguous enough that a binary resolved under it can never land on a workspace- or
// PATH-adjacent file. Throws rather than falling back to the next candidate or the default: an
// invalid override is a signal the environment is misconfigured or hostile, and silently
// substituting a "safe" value would let that same environment defeat this check on a machine where
// the default itself has been tampered with.
function assertCanonicalSystemRoot(candidate: string): void {
  if (CONTROL_CHARACTER.test(candidate)) {
    throw new WindowsSystemDirectoryError(
      "Windows system directory override must not contain a control character",
    );
  }
  if (!DRIVE_ABSOLUTE_WINDOWS_PATH.test(candidate)) {
    throw new WindowsSystemDirectoryError(
      String.raw`Windows system directory override must be a drive-absolute path, e.g. C:\Windows`,
    );
  }
  if (hasPathTraversalSegment(candidate)) {
    throw new WindowsSystemDirectoryError(
      'Windows system directory override must not contain a ".." path segment',
    );
  }
  if (CMD_METACHARACTER_MEMBER.test(candidate)) {
    throw new WindowsSystemDirectoryError(
      "Windows system directory override must not contain a quote or cmd.exe metacharacter",
    );
  }
}

/**
 * The trusted Windows system directory: `SystemRoot`, then `WINDIR`, then the hard-coded default —
 * validated for canonical shape in every case (see `assertCanonicalSystemRoot`). Every trusted
 * Windows system-binary resolution in this package should go through this function or
 * `resolveSystemBinaryPath` below rather than re-deriving the environment fallback chain.
 */
export function resolveWindowsSystemDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const candidate = env.SystemRoot ?? env.WINDIR ?? DEFAULT_WINDOWS_SYSTEM_ROOT;
  assertCanonicalSystemRoot(candidate);
  return candidate;
}

/**
 * A named binary under the validated Windows system directory's `System32`, NEVER from PATH — the
 * one path `cmd.exe` resolution below and callers such as `exec.ts`'s `taskkill.exe` lookup share.
 */
export function resolveSystemBinaryPath(
  binaryName: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (binaryName.length === 0 || /[\\/]/.test(binaryName) || binaryName === "..") {
    throw new WindowsSystemDirectoryError(
      "binaryName must be a bare System32 file name, not a path",
    );
  }
  return win32.join(resolveWindowsSystemDirectory(env), "System32", binaryName);
}

function buildWrappedInvocation(
  resolvedCommandPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): WindowsShellInvocation {
  assertNoControlCharacters(resolvedCommandPath, "resolved command path");
  for (const [index, arg] of args.entries()) {
    assertNoControlCharacters(arg, `argument ${String(index)}`);
  }
  const doubleEscapeMetaChars = isCmdShim(resolvedCommandPath);
  const normalizedCommand = win32.normalize(resolvedCommandPath);
  const escapedParts = [
    escapeCommand(normalizedCommand),
    ...args.map((arg) => escapeArgument(arg, doubleEscapeMetaChars)),
  ];
  const commandLine = '"' + escapedParts.join(" ") + '"';
  return {
    command: resolveSystemBinaryPath("cmd.exe", env),
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
