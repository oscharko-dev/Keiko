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

const USAGE = `Usage:
  keiko audit local-state [--state-dir PATH]   audit a local .keiko tree (default <cwd>/.keiko)

Read-only. Never decrypts and never mutates the tree; no vault key is required.
Exit code: 0 healthy, 1 audit failure, 2 usage error.`;

const TAG: Readonly<Record<string, string>> = { pass: "PASS", fail: "FAIL", skip: "skip" };

interface AuditClass {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly findings: readonly string[];
}

interface AuditResult {
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
  | { readonly kind: "args"; readonly stateDir: string | undefined };

/** A value that looks like a flag is a typo, not a path: swallowing it would audit the wrong tree
 * and report on a directory the operator never named. Same guard as check-local-state.mjs. */
function isPathValue(value: string | undefined): value is string {
  return value !== undefined && value !== "" && !value.startsWith("-");
}

function parseLocalStateFlags(argv: readonly string[]): ParsedArgs {
  let stateDir: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { kind: "help" };
    if (arg !== "--state-dir") return { kind: "usage" };
    const value = argv[index + 1];
    if (!isPathValue(value)) return { kind: "usage" };
    stateDir = value;
    index += 1;
  }
  return { kind: "args", stateDir };
}

export function parseAuditArgs(argv: readonly string[]): ParsedArgs {
  if (argv[0] === "--help" || argv[0] === "-h") return { kind: "help" };
  if (argv[0] !== "local-state") return { kind: "usage" };
  return parseLocalStateFlags(argv.slice(1));
}

function renderReport(result: AuditResult, io: CliIo): void {
  io.out(`\nlocal-state audit — ${result.stateDir}\n`);
  for (const auditClass of result.classes) {
    io.out(`  [${TAG[auditClass.status] ?? auditClass.status}] ${auditClass.title}\n`);
    for (const finding of auditClass.findings) io.out(`        - ${finding}\n`);
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

async function runLocalStateAudit(
  stateDir: string,
  auditorPath: string,
  io: CliIo,
  deps: AuditCliDeps,
): Promise<number> {
  const load = deps.loadAuditor ?? importAuditor;
  let result: AuditResult;
  try {
    const auditor = await load(pathToFileURL(auditorPath).href);
    result = auditor.auditLocalState(stateDir);
  } catch (error) {
    io.err(
      `keiko audit: local-state audit could not run — ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 1;
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

  const stateDir = parsed.stateDir ?? join(deps.cwd ?? process.cwd(), ".keiko");
  return runLocalStateAudit(stateDir, auditorPath, io, deps);
}
