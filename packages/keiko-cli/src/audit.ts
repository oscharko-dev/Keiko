import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { CliIo } from "./runner.js";

// `keiko audit local-state` — the at-rest self-verification the local-at-rest contract
// (docs/local-runtime-state-contract.md) names as its compensating control, reachable from a real
// packaged install (audit KEIKO-0230).
//
// Before this command the only way to run the auditor was `npm run audit:local-state`, which needs
// the monorepo checked out. The audience that HAS a ~/.keiko directory to audit is precisely the
// audience that does NOT have the monorepo — so the control the documentation leans on was
// unreachable by everyone who needed it.
//
// The auditor itself is NOT ported here. scripts/lib/local-state-audit.mjs is 1500+ lines that
// deliberately import only Node builtins and deliberately duplicate the on-disk filename constants
// rather than take a package-graph edge (its own header says so). A TypeScript twin would double
// that surface and create exactly the drift it was written to avoid. Instead this command imports
// the one existing implementation at runtime, and the module is shipped in the package `files`
// allowlist. The edge points cli -> script, so the script still takes no package-graph edge and
// still runs standalone against a real tree with no build.
//
// The bin entry (src/cli/index.ts) resolves the packaged path and passes it through
// KEIKO_LOCAL_STATE_AUDITOR, the same convention already used for KEIKO_UI_STATIC_ROOT and
// KEIKO_CLI_BIN_PATH: the installation layout is the bin's business, not this package's.
//
// `--json` and `auditLocalStateResult` exist so another in-process caller (e.g. `keiko bundle
// export`'s manifest assembly) can obtain the same `AuditResult` this command prints, without
// shelling out to a second `keiko audit` process and re-parsing its stdout.

const USAGE = `Usage:
  keiko audit local-state [--state-dir PATH] [--json]   audit a local .keiko tree

Without --state-dir the target is $KEIKO_STATE_DIR when set, otherwise <cwd>/.keiko.
--json prints the AuditResult as a single JSON line instead of the human report; the exit
code is unchanged.

Read-only. Never decrypts and never mutates the tree; no vault key is required.
Exit code: 0 healthy, 1 audit failure, 2 usage error.`;

const TAG: Readonly<Record<string, string>> = { pass: "PASS", fail: "FAIL", skip: "skip" };

export interface AuditClass {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly findings: readonly string[];
}

export interface AuditResult {
  readonly ok: boolean;
  readonly stateDir: string;
  readonly classes: readonly AuditClass[];
}

interface AuditorModule {
  readonly auditLocalState: (stateDir: string) => AuditResult;
}

type ParsedArgs =
  | { readonly kind: "help" }
  | { readonly kind: "usage" }
  | { readonly kind: "args"; readonly stateDir: string | undefined; readonly json: boolean };

/** A value that looks like a flag is a typo, not a path: swallowing it would audit the wrong tree
 * and report on a directory the operator never named. Same guard as check-local-state.mjs. */
function isPathValue(value: string | undefined): value is string {
  return value !== undefined && value !== "" && !value.startsWith("-");
}

function parseLocalStateFlags(argv: readonly string[]): ParsedArgs {
  let stateDir: string | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { kind: "help" };
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg !== "--state-dir") return { kind: "usage" };
    const value = argv[index + 1];
    if (!isPathValue(value)) return { kind: "usage" };
    stateDir = value;
    index += 1;
  }
  return { kind: "args", stateDir, json };
}

export function parseAuditArgs(argv: readonly string[]): ParsedArgs {
  if (argv[0] === "--help" || argv[0] === "-h") return { kind: "help" };
  if (argv[0] !== "local-state") return { kind: "usage" };
  return parseLocalStateFlags(argv.slice(1));
}

/** Findings carry filesystem-derived names. A crafted artifact name containing a newline or an
 * ANSI escape could otherwise forge report lines or repaint the verdict in the operator's terminal
 * (review finding on #3159). Control characters are escaped, never passed through. */
function safeForTerminal(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // C0, DEL and C1: newline and carriage return would forge report lines, ESC would let a
    // crafted artifact name repaint the verdict in the operator's terminal.
    const isControl = code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    out += isControl ? String.raw`\x` + code.toString(16).padStart(2, "0") : ch;
  }
  return out;
}

function renderReport(result: AuditResult, io: CliIo): void {
  io.out(`\nlocal-state audit — ${safeForTerminal(result.stateDir)}\n`);
  for (const auditClass of result.classes) {
    io.out(
      `  [${TAG[auditClass.status] ?? auditClass.status}] ${safeForTerminal(auditClass.title)}\n`,
    );
    for (const finding of auditClass.findings) io.out(`        - ${safeForTerminal(finding)}\n`);
  }
  io.out(`  => ${result.ok ? "PASS" : "FAIL"}\n`);
}

export interface AuditCliDeps {
  /** Injection seam for tests; production resolves the path from the environment. */
  readonly loadAuditor?: (specifier: string) => Promise<AuditorModule>;
  readonly cwd?: string;
}

function importAuditor(specifier: string): Promise<AuditorModule> {
  return import(specifier) as Promise<AuditorModule>;
}

/**
 * The auditor is loaded by path at runtime, so its shape is an assumption until checked. A missing
 * `classes` array made renderReport throw, and a truthy non-boolean `ok` reported PASS — the one
 * command whose whole job is proving the at-rest claims would have announced a clean tree on
 * malformed input (review finding on #3159). Validated rather than cast.
 */
function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && (value as readonly unknown[]).every((s) => typeof s === "string");
}

function isAuditClass(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.title === "string" &&
    // Domain-checked, not just typed: renderReport falls back to printing an unknown status
    // verbatim, so a status outside the vocabulary would reach the operator as an unlabelled row
    // that reads neither PASS nor FAIL (review finding on #3159).
    typeof record.status === "string" &&
    Object.hasOwn(TAG, record.status) &&
    isStringArray(record.findings)
  );
}

function asAuditResult(value: unknown): AuditResult | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.ok !== "boolean") return undefined;
  if (typeof record.stateDir !== "string") return undefined;
  if (!Array.isArray(record.classes)) return undefined;
  const classes = record.classes as readonly unknown[];
  if (!classes.every(isAuditClass)) return undefined;
  // Vacuous: an empty class list would render an empty report and print PASS, which reads as
  // "audited, nothing wrong" for a tree nothing was checked against.
  if (classes.length === 0) return undefined;
  // Contradictory: ok=true alongside a failing class. Reporting the headline verdict over the
  // detail would hide the finding (review finding on #3159).
  const anyFailed = classes.some((c) => (c as { status: string }).status === "fail");
  if (record.ok && anyFailed) return undefined;
  return value as AuditResult;
}

/** Why `loadAuditResult` failed, kept as a closed set rather than a raw message: `threw` is the
 * only branch whose cause can quote the state tree it was reading, and it is reduced to the
 * constructor name — body-free, same discipline as the rest of this command (AGENTS.md §7). */
type AuditLoadFailureReason = "missing-export" | "invalid-result" | "threw";

/** Thrown by {@link loadAuditResult} (and so by {@link auditLocalStateResult}) instead of a plain
 * `Error` so an in-process caller — e.g. `keiko bundle export`'s manifest assembly — can branch on
 * `reason` without string-matching a message, the same way `runLocalStateAudit` does for the CLI's
 * own text/JSON output. */
export class AuditLoadError extends Error {
  readonly reason: AuditLoadFailureReason;
  readonly causeConstructorName: string | undefined;

  constructor(reason: AuditLoadFailureReason, causeConstructorName?: string) {
    super(`keiko audit: local-state audit could not produce a result (${reason})`);
    this.name = "AuditLoadError";
    this.reason = reason;
    this.causeConstructorName = causeConstructorName;
  }
}

/** Loads the auditor module, runs it, and validates its output — the one code path shared by the
 * CLI's text/JSON rendering and the programmatic {@link auditLocalStateResult} entry point. Throws
 * {@link AuditLoadError} rather than returning a sentinel so neither caller can forget to check. */
async function loadAuditResult(
  stateDir: string,
  auditorPath: string,
  deps: AuditCliDeps,
): Promise<AuditResult> {
  const load = deps.loadAuditor ?? importAuditor;
  try {
    const auditor: unknown = await load(pathToFileURL(auditorPath).href);
    const audit = (auditor as Partial<AuditorModule> | null)?.auditLocalState;
    if (typeof audit !== "function") {
      throw new AuditLoadError("missing-export");
    }
    const validated = asAuditResult(audit(stateDir));
    if (validated === undefined) {
      throw new AuditLoadError("invalid-result");
    }
    return validated;
  } catch (error) {
    if (error instanceof AuditLoadError) throw error;
    // Type, not message: the auditor reads the state tree, so its failure text can quote a path
    // or a file fragment it was parsing. The class of failure is the actionable part, and it is
    // body-free (AGENTS.md §7; review finding on #3159).
    throw new AuditLoadError(
      "threw",
      error instanceof Error ? error.constructor.name : typeof error,
    );
  }
}

/**
 * Programmatic twin of `keiko audit local-state --json`: runs the same auditor against `stateDir`
 * and returns the validated {@link AuditResult}, for a caller that wants the value in-process (e.g.
 * `keiko bundle export`'s manifest) instead of shelling out to a second `keiko` process and
 * re-parsing its stdout. Resolves the auditor path from `env.KEIKO_LOCAL_STATE_AUDITOR` the same
 * way `runAuditCli` does; the caller resolves `stateDir` itself (default-state-dir precedence is a
 * CLI-argument concern, not this function's).
 *
 * Rejects with {@link AuditLoadError} once it has actually tried the auditor — never resolves with
 * a guessed verdict. Rejects with a plain `Error` first if the auditor was never located at all
 * (mirrors `runAuditCli`'s own "KEIKO_LOCAL_STATE_AUDITOR is unset" precondition, which is a
 * configuration problem, not a load failure, so it is kept out of {@link AuditLoadError}'s closed
 * `reason` set).
 */
export async function auditLocalStateResult(
  stateDir: string,
  env: Readonly<Record<string, string | undefined>>,
  deps: AuditCliDeps = {},
): Promise<AuditResult> {
  const auditorPath = env.KEIKO_LOCAL_STATE_AUDITOR;
  if (auditorPath === undefined || auditorPath === "") {
    throw new Error(
      "keiko audit: the local-state auditor was not located in this installation " +
        "(KEIKO_LOCAL_STATE_AUDITOR is unset).",
    );
  }
  return loadAuditResult(stateDir, auditorPath, deps);
}

function reportLoadFailure(error: AuditLoadError, io: CliIo): void {
  if (error.reason === "missing-export") {
    io.err(
      "keiko audit: the module at the configured auditor path does not export " +
        "auditLocalState; the installation is incomplete or the path is wrong.\n",
    );
    return;
  }
  if (error.reason === "invalid-result") {
    io.err(
      "keiko audit: the auditor returned a result this CLI cannot read. Refusing to report a " +
        "verdict rather than guess one.\n",
    );
    return;
  }
  io.err(
    `keiko audit: local-state audit could not run — ${error.causeConstructorName ?? "Error"}\n`,
  );
}

async function runLocalStateAudit(
  stateDir: string,
  auditorPath: string,
  io: CliIo,
  json: boolean,
  deps: AuditCliDeps,
): Promise<number> {
  let result: AuditResult;
  try {
    result = await loadAuditResult(stateDir, auditorPath, deps);
  } catch (error) {
    if (!(error instanceof AuditLoadError)) throw error;
    reportLoadFailure(error, io);
    return 1;
  }

  if (json) {
    // Exactly the serialized result plus a newline, nothing else on stdout: a consumer piping
    // this into `jq` (or `keiko bundle export`'s own manifest assembly, run out of process) must
    // never have to strip human report lines out of its input first.
    io.out(`${JSON.stringify(result)}\n`);
    return result.ok ? 0 : 1;
  }

  renderReport(result, io);
  if (result.ok) {
    io.out("\nlocal-state: PASS\n");
    return 0;
  }
  io.err("\nlocal-state: FAIL\n");
  return 1;
}

export async function runAuditCli(
  rest: readonly string[],
  io: CliIo,
  env: Readonly<Record<string, string | undefined>>,
  deps: AuditCliDeps = {},
): Promise<number> {
  const parsed = parseAuditArgs(rest);
  if (parsed.kind === "help") {
    io.out(`${USAGE}\n`);
    return 0;
  }
  if (parsed.kind === "usage") {
    io.err(`${USAGE}\n`);
    return 2;
  }

  const auditorPath = env.KEIKO_LOCAL_STATE_AUDITOR;
  if (auditorPath === undefined || auditorPath === "") {
    // Fail closed and say why. A silent skip here would read as "audited, nothing wrong" for the
    // one control that is supposed to prove the at-rest claims.
    io.err(
      "keiko audit: the local-state auditor was not located in this installation " +
        "(KEIKO_LOCAL_STATE_AUDITOR is unset). Reinstall the package, or run " +
        "`npm run audit:local-state -- --state-dir <path>` from a repository checkout.\n",
    );
    return 1;
  }

  // KEIKO_STATE_DIR is where the product actually keeps its state when the operator moved it, so
  // defaulting to <cwd>/.keiko while that is set audits a directory the runtime does not use —
  // and a PASS on the wrong tree is worse than no answer (review finding on #3159). An explicit
  // --state-dir still wins over both.
  const configuredStateDir = env.KEIKO_STATE_DIR;
  const defaultStateDir =
    configuredStateDir !== undefined && configuredStateDir !== ""
      ? configuredStateDir
      : join(deps.cwd ?? process.cwd(), ".keiko");
  const stateDir = parsed.stateDir ?? defaultStateDir;
  return runLocalStateAudit(stateDir, auditorPath, io, parsed.json, deps);
}
