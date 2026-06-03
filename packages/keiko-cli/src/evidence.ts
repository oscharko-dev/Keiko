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

function flagValue(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) {
    return undefined;
  }
  const value = args[i + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function resolveStore(args: readonly string[], deps: EvidenceCliDeps): EvidenceStore {
  if (deps.store !== undefined) {
    return deps.store;
  }
  return createNodeEvidenceStore(resolveEvidenceDir(flagValue(args, "--evidence-dir"), deps.env));
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
  const sub = args[0];
  const json = args.includes("--json");
  try {
    if (sub === "list") {
      return runList(resolveStore(args, deps), json, io);
    }
    if (sub === "show") {
      const runId = args[1];
      if (runId === undefined || runId.startsWith("--")) {
        io.err(`keiko evidence: show requires a <runId>.\n${USAGE}`);
        return 2;
      }
      return runShow(resolveStore(args, deps), runId, json, io);
    }
    io.err(sub === undefined ? USAGE : `keiko evidence: unknown subcommand: ${sub}\n${USAGE}`);
    return 2;
  } catch (error) {
    if (error instanceof AuditError) {
      return exitForAuditError(error, io);
    }
    throw error;
  }
}
