// `keiko evidence` — inspects previously written evidence manifests (ADR-0010 D9). `list` prints the
// EvidenceListEntry[] (text or --json); `show <runId>` prints one EvidenceReport / full manifest
// (--json). It reads ONLY the contained base dir via the EvidenceStore (default $KEIKO_EVIDENCE_DIR
// or ./.keiko/evidence, overridable with --evidence-dir). Because manifests are redacted by
// construction there is no un-redaction path. Exit 0 on success, 1 on a missing runId / read error,
// 2 on usage (unknown or missing subcommand, invalid runId). Tests inject an in-memory store via deps
// so no disk is touched.

import {
  buildEvidenceReport,
  renderEvidenceReport,
  listEvidence,
  loadEvidence,
  type EvidenceListEntry,
  createNodeEvidenceStore,
  resolveEvidenceDir,
  type EvidenceStore,
  AuditError,
  InvalidRunIdError,
} from "@oscharko-dev/keiko-evidence";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type { CliIo } from "./runner.js";

const USAGE = `Usage:
  keiko evidence list [--evidence-dir PATH] [--json]
  keiko evidence show <runId> [--evidence-dir PATH] [--json]

Lists or shows redacted evidence manifests written by \`keiko run\`. Reads only the
evidence base dir (default $KEIKO_EVIDENCE_DIR or ./.keiko/evidence; override with --evidence-dir).
`;

// Test seam: inject an EvidenceStore so unit tests never touch the filesystem.
export interface EvidenceCliDeps {
  readonly store?: EvidenceStore | undefined;
  readonly env?: EnvSource | undefined;
}

type EvidenceSubcommand = "list" | "show";

interface EvidenceCliArgs {
  readonly subcommand: EvidenceSubcommand;
  readonly runId?: string | undefined;
  readonly evidenceDir: string | undefined;
  readonly json: boolean;
}

interface ParsedEvidenceArgs {
  readonly ok: boolean;
  readonly parsed?: EvidenceCliArgs | undefined;
  readonly error: string;
}

function parseSubcommand(value: string | undefined): EvidenceSubcommand | undefined {
  return value === "list" || value === "show" ? value : undefined;
}

function parseFlags(
  args: readonly string[],
  startIndex: number,
): { readonly ok: boolean; readonly json?: boolean; readonly evidenceDir?: string | undefined } {
  let json = false;
  let evidenceDir: string | undefined;
  let index = startIndex;
  while (index < args.length) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
      index += 1;
      continue;
    }
    if (arg !== "--evidence-dir") {
      return { ok: false };
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return { ok: false };
    }
    evidenceDir = value;
    index += 2;
  }
  return { ok: true, json, evidenceDir };
}

function invalidArgs(message: string): ParsedEvidenceArgs {
  return { ok: false, error: message };
}

function resolveStore(evidenceDir: string | undefined, deps: EvidenceCliDeps): EvidenceStore {
  if (deps.store !== undefined) {
    return deps.store;
  }
  return createNodeEvidenceStore(resolveEvidenceDir(evidenceDir, deps.env));
}

function parseEvidenceArgs(args: readonly string[]): ParsedEvidenceArgs {
  const subcommand = parseSubcommand(args[0]);
  if (subcommand === undefined) {
    const sub = args[0];
    return invalidArgs(
      sub === undefined ? USAGE : `keiko evidence: unknown subcommand: ${sub}\n${USAGE}`,
    );
  }

  let index = 1;
  let runId: string | undefined;

  if (subcommand === "show") {
    runId = args[index];
    if (runId === undefined || runId.startsWith("--")) {
      return invalidArgs(`keiko evidence: show requires a <runId>.\n${USAGE}`);
    }
    index += 1;
  }

  const flags = parseFlags(args, index);
  if (!flags.ok) {
    return invalidArgs(`keiko evidence: invalid arguments.\n${USAGE}`);
  }

  return {
    ok: true,
    error: "",
    parsed: { subcommand, runId, evidenceDir: flags.evidenceDir, json: flags.json === true },
  };
}

function renderListText(entries: readonly EvidenceListEntry[]): string {
  if (entries.length === 0) {
    return "No evidence manifests found.\n";
  }
  const rows = entries.map(
    (e) =>
      `${e.runId}  ${e.taskType}  ${e.outcome}  started=${String(e.startedAt)} finished=${String(e.finishedAt)}`,
  );
  return `${rows.join("\n")}\n`;
}

function runList(store: EvidenceStore, json: boolean, io: CliIo): number {
  const entries = listEvidence(store);
  io.out(json ? `${JSON.stringify(entries, null, 2)}\n` : renderListText(entries));
  return 0;
}

function runShow(store: EvidenceStore, runId: string, json: boolean, io: CliIo): number {
  const manifest = loadEvidence(store, runId);
  if (manifest === undefined) {
    io.err(`keiko evidence: no manifest for runId: ${runId}\n`);
    return 1;
  }
  if (json) {
    io.out(`${JSON.stringify(manifest, null, 2)}\n`);
    return 0;
  }
  io.out(
    renderEvidenceReport(buildEvidenceReport(manifest, store.location?.(runId) ?? `${runId}.json`)),
  );
  return 0;
}

// Maps a thrown AuditError to an exit code: an invalid runId is a usage error (2), any other
// audit/read failure is a runtime error (1). Messages are already redacted at construction.
function exitForAuditError(error: AuditError, io: CliIo): number {
  io.err(`keiko evidence: ${error.message}\n`);
  return error instanceof InvalidRunIdError ? 2 : 1;
}

export function runEvidenceCli(
  args: readonly string[],
  io: CliIo,
  deps: EvidenceCliDeps = {},
): number {
  const parsed = parseEvidenceArgs(args);
  if (!parsed.ok || parsed.parsed === undefined) {
    io.err(parsed.error);
    return 2;
  }

  try {
    if (parsed.parsed.subcommand === "list") {
      return runList(resolveStore(parsed.parsed.evidenceDir, deps), parsed.parsed.json, io);
    }
    if (parsed.parsed.runId === undefined) {
      io.err(`keiko evidence: show requires a <runId>.\n${USAGE}`);
      return 2;
    }
    return runShow(
      resolveStore(parsed.parsed.evidenceDir, deps),
      parsed.parsed.runId,
      parsed.parsed.json,
      io,
    );
  } catch (error) {
    if (error instanceof AuditError) {
      return exitForAuditError(error, io);
    }
    throw error;
  }
}
