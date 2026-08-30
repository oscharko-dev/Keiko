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
// or LF as a command boundary that no amount of caret-escaping closes. `assertSafelyTransportable`
// below therefore fails closed on NUL, CR and LF in the resolved command path and every argument,
// BEFORE either is joined into the string cmd.exe parses — but deliberately NOT the rest of the C0
// control range: TAB is a literal for both cmd.exe's own parse and the child's CRT inside the
// double-quoted argument this module always produces, and rejecting it broke an allowlisted
// `npm`/`.cmd` run on a TSV/JSON/diff argument that passes untouched on every other platform
// (review 5058571583 finding 4). The same function also fails closed on a second, unrelated
// hazard under the same name: a `%` anywhere in the resolved command path or an argument, because
// cmd.exe expands `%NAME%` against the child's environment in an earlier parse phase that no
// caret-escaping this module emits can reach (review 5058544058 P1 3887021639).
//
// The `cmd.exe` binary itself is resolved through `resolveSystemBinaryPath` (below), NEVER from
// PATH — a workspace- or PATH-planted `cmd.exe` must never be the one an allowlisted command is
// routed through. `%SystemRoot%`/`%WINDIR%` are mutable, inherited environment text, not a trusted
// value by themselves. The validation itself — canonical SHAPE (drive-absolute, no `..` segment,
// no UNC/device prefix, no quote, cmd metacharacter, or control character), REJECTED rather than
// silently replaced with the default when it fails — is NOT implemented in this module: it lives in
// `@oscharko-dev/keiko-security` (`windows-system-directory.ts`: `resolveWindowsSystemBinary` and
// `resolveWindowsSystemDirectory`), the single shared implementation this module and
// keiko-security's own cscript/PowerShell helpers (`windows-shortcuts.ts`) both call. PR #3354's
// review found two independently hand-written copies of this check had drifted — the other side's
// `isAbsolute`-only check accepted UNC/device/root-relative shapes this one rejected — so
// `resolveSystemBinaryPath` here is a thin wrapper over the shared function, not a parallel
// implementation to keep in sync by hand. Node has no binding to `GetSystemDirectoryW` — the only
// OS-authoritative source — so the shared check validates SHAPE, never the live identity of the
// directory; `resolveSystemBinaryPath` is exported for every caller in this package that needs the
// same trusted-System32 resolution (e.g. `exec.ts`'s `taskkill.exe` lookup).
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
import { resolveWindowsSystemBinary } from "@oscharko-dev/keiko-security";

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

// Exactly NUL, LF and CR — the three characters that genuinely BREAK a cmd.exe command line: NUL
// terminates the native string, and a bare CR or LF ends the command (moxystudio/node-cross-spawn
// #179, the gap cross-spawn's own metachar class leaves open; no caret-escaping neutralises them).
// Deliberately NOT the whole C0 range: TAB (U+0009) inside the double-quoted argument is a literal
// for both the outer cmd.exe parse and the child's CRT — cross-spawn escapes it correctly, and
// rejecting it made an allowlisted `npm`/`.cmd` run fail on Windows for a TSV/JSON/diff argument
// that passes untouched on every other platform (review 5058571583 finding 4).
// eslint-disable-next-line no-control-regex -- intentionally matches control chars to REJECT them
const LINE_BREAKING_CHARACTER = /[\u0000\n\r]/;

// cmd.exe performs %NAME% environment expansion in an EARLY parse phase, before caret processing —
// so no escaping this module can emit keeps a percent-carrying argument literal on the wrapped
// path. `^%` survives only into phases the expansion has already left, and the batch-file `%%`
// doubling does not apply to a `cmd /c` command line. An expanded value draws from the child's
// (sanitized) environment and can itself contain quotes or separators that were never escaped as
// part of the original input — so the wrapped path fails CLOSED on `%` instead of silently
// transporting a different argv than the caller passed (review 5058544058 P1 3887021639).

/** Thrown when the resolved command path or an argument cannot be safely wrapped for cmd.exe. */
export class WindowsShellInvocationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WindowsShellInvocationError";
  }
}

// Fails closed BEFORE any value is joined into the cmd.exe command-line string built below. Never
// echoes the rejected value: a raw control character has no place in a thrown message either, and
// the value may carry sensitive content.
function assertSafelyTransportable(value: string, label: string): void {
  if (LINE_BREAKING_CHARACTER.test(value)) {
    throw new WindowsShellInvocationError(`${label} must not contain NUL, CR, or LF`);
  }
  if (value.includes("%")) {
    throw new WindowsShellInvocationError(
      `${label} must not contain '%' — cmd.exe expands %NAME% before any escaping applies, so a ` +
        "percent-carrying value cannot be transported literally through the cmd.exe wrapper",
    );
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

// The trusted-System32 decision is NOT re-implemented here. It lives in keiko-security
// (windows-system-directory.ts) so this module and keiko-security's own cscript/powershell helpers
// share ONE implementation — PR #3354's review found the two had drifted, with an `isAbsolute`-only
// check on the other side accepting the exact UNC/device/root-relative shapes this one rejects.
// Re-exported under the historical names so existing importers (exec.ts's taskkill.exe lookup, the
// package barrel) keep working against the single source of truth.
export {
  resolveWindowsSystemDirectory,
  WindowsSystemDirectoryError,
} from "@oscharko-dev/keiko-security";

export function resolveSystemBinaryPath(
  binaryName: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveWindowsSystemBinary(binaryName, env);
}

function buildWrappedInvocation(
  resolvedCommandPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): WindowsShellInvocation {
  assertSafelyTransportable(resolvedCommandPath, "resolved command path");
  for (const [index, arg] of args.entries()) {
    assertSafelyTransportable(arg, `argument ${String(index)}`);
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
