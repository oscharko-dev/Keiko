// `keiko memory` — operator surface for the governed memory vault (Epic #204).
//
//   maintain   Run one bounded maintenance pass IN-PROCESS (consolidate + decay + reinforce +
//              forget) against the local vault and print the applied counts. Reuses the exact same
//              `runMemoryMaintenance` core the BFF route uses, so the CLI and UI never drift.
//   stats      Print memory counts by status, by scope kind, and the total.
//   diagnostics
//              Print a redacted body-free diagnostics snapshot for local support.
//
// The vault is opened at the resolved memory dir (default $KEIKO_MEMORY_DIR or the platform state
// dir; override with --memory-dir). Tests inject a vault via deps so no disk is touched. Exit 0 on
// success, 1 on a runtime error (vault open / maintenance fault), 2 on usage (unknown/missing
// subcommand).

import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import {
  createMemoryEmbedder,
  exportMemoryDiagnostics,
  runMemoryMaintenance,
  type MemoryEmbedder,
} from "@oscharko-dev/keiko-server";
import {
  createAuditRedactor,
  createNodeEvidenceStore,
  resolveEvidenceDir,
  type EvidenceStore,
} from "@oscharko-dev/keiko-evidence";
import {
  loadConfigFromFile,
  requestOpenAIEmbedding,
  GatewayError,
  type EnvSource,
} from "@oscharko-dev/keiko-model-gateway";
import type { MemoryRecord, MemoryScope } from "@oscharko-dev/keiko-contracts";
import type { CliIo } from "./runner.js";

const USAGE = `Usage:
  keiko memory maintain [--memory-dir PATH]   Run a bounded consolidate + decay + forget pass.
  keiko memory stats [--memory-dir PATH]      Print memory counts by status and scope.
  keiko memory diagnostics [--memory-dir PATH] [--evidence-dir PATH] [--last N]
                                              Print redacted local diagnostics JSON.
  keiko memory reembed [--memory-dir PATH] [--limit N] [--config PATH]
                                              Backfill embeddings for accepted memories lacking one.

Opens the local memory vault (default $KEIKO_MEMORY_DIR or the platform state dir; override with
--memory-dir). \`maintain\` strengthens recalled memories, decays stale ones, archives faded ones,
forgets expired/very-faint ones, and reports unresolved consolidation review items. \`diagnostics\`
prints schema version, generated time, scope/status counts, redacted storage path, and a bounded
audit tail without memory body or payload content. \`reembed\` computes the embedding for each
accepted memory that has none (bounded by --limit, default 200), so pre-existing memories become
semantically retrievable; it is gated on an embedding model being configured (via --config /
$KEIKO_CONFIG_FILE) and is best-effort.
`;

const DEFAULT_REEMBED_LIMIT = 200;

// Test seam: inject a vault + a factory so unit tests never touch the filesystem or keychain.
// `embedText` overrides the production embedder (built from the gateway config) so reembed tests
// never touch the network; `null` models the "no embedding model configured" case.
export interface MemoryCliDeps {
  readonly vault?: MemoryVaultStore | undefined;
  readonly openVault?:
    | ((memoryDir: string | undefined, env: EnvSource) => MemoryVaultStore)
    | undefined;
  readonly evidenceStore?: EvidenceStore | undefined;
  readonly redactString?: ((input: string) => string) | undefined;
  readonly embedText?: MemoryEmbedder | null | undefined;
}

function flagValue(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function resolveVault(
  args: readonly string[],
  env: EnvSource,
  deps: MemoryCliDeps,
): MemoryVaultStore {
  if (deps.vault !== undefined) return deps.vault;
  const memoryDir = flagValue(args, "--memory-dir");
  if (deps.openVault !== undefined) return deps.openVault(memoryDir, env);
  return createMemoryVault({
    ...(memoryDir !== undefined ? { memoryDir } : {}),
    env,
  });
}

function scopeKindOf(scope: MemoryScope): string {
  return scope.kind;
}

function scopeKey(scope: MemoryScope): string {
  switch (scope.kind) {
    case "user":
      return `user:${scope.userId}`;
    case "workspace":
      return `workspace:${scope.workspaceId}`;
    case "project":
      return `project:${scope.projectId}`;
    case "workflow":
      return `workflow:${scope.workflowDefinitionId}`;
    case "global":
      return "global";
    default: {
      const never: never = scope;
      return never;
    }
  }
}

function uniqueRecordScopes(records: readonly MemoryRecord[]): readonly MemoryScope[] {
  const scopes = new Map<string, MemoryScope>();
  for (const record of records) {
    scopes.set(scopeKey(record.scope), record.scope);
  }
  return scopes.size === 0 ? [{ kind: "global" }] : [...scopes.values()];
}

function tallyBy<TKey extends string>(
  records: readonly MemoryRecord[],
  keyOf: (record: MemoryRecord) => TKey,
): Map<TKey, number> {
  const counts = new Map<TKey, number>();
  for (const record of records) {
    const key = keyOf(record);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function renderTally(title: string, counts: ReadonlyMap<string, number>): string {
  const rows = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (rows.length === 0) return `${title}:\n  (none)\n`;
  const body = rows.map(([key, n]) => `  ${key}: ${String(n)}`).join("\n");
  return `${title}:\n${body}\n`;
}

function renderStats(records: readonly MemoryRecord[]): string {
  const byStatus = tallyBy(records, (record) => record.status);
  const byScope = tallyBy(records, (record) => scopeKindOf(record.scope));
  return (
    renderTally("By status", byStatus) +
    renderTally("By scope", byScope) +
    `Total: ${String(records.length)}\n`
  );
}

function renderMaintenanceReport(counts: ReturnType<typeof runMemoryMaintenance>): string {
  return [
    "Memory maintenance complete.",
    `  promoted:          ${String(counts.promoted)}`,
    `  reinforced:        ${String(counts.reinforced)}`,
    `  decayed:           ${String(counts.decayed)}`,
    `  archived:          ${String(counts.archived)}`,
    `  forgotten:         ${String(counts.forgotten)}`,
    `  superseded:        ${String(counts.superseded)}`,
    `  edgesCreated:      ${String(counts.edgesCreated)}`,
    `  clustersInspected: ${String(counts.clustersInspected)}`,
    `  reviewItems:       ${String(counts.reviewItemsCreated)}`,
    "",
  ].join("\n");
}

function runStats(args: readonly string[], io: CliIo, env: EnvSource, deps: MemoryCliDeps): number {
  const vault = resolveVault(args, env, deps);
  try {
    const records = vault.listMemories({ includeExpired: true });
    io.out(renderStats(records));
    return 0;
  } finally {
    if (deps.vault === undefined) vault.close();
  }
}

function parseLastAuditEvents(args: readonly string[]): number | undefined {
  const raw = flagValue(args, "--last");
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function runDiagnostics(
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  deps: MemoryCliDeps,
): number {
  const vault = resolveVault(args, env, deps);
  const evidenceDir = resolveEvidenceDir(flagValue(args, "--evidence-dir"), env);
  const evidenceStore = deps.evidenceStore ?? createNodeEvidenceStore(evidenceDir);
  const redactString = deps.redactString ?? createAuditRedactor({}, env);
  try {
    const records = vault.listMemories({ includeExpired: true });
    const lastNAuditEvents = parseLastAuditEvents(args);
    const diagnostics = exportMemoryDiagnostics({
      vault,
      scopes: uniqueRecordScopes(records),
      evidenceStore,
      redactString,
      evidenceDir,
      ...(lastNAuditEvents === undefined ? {} : { lastNAuditEvents }),
    });
    io.out(`${JSON.stringify(diagnostics, null, 2)}\n`);
    return 0;
  } finally {
    if (deps.vault === undefined) vault.close();
  }
}

function runMaintain(
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  deps: MemoryCliDeps,
): number {
  const vault = resolveVault(args, env, deps);
  try {
    const counts = runMemoryMaintenance(vault);
    io.out(renderMaintenanceReport(counts));
    return 0;
  } finally {
    if (deps.vault === undefined) vault.close();
  }
}

// Resolves the production embedder from the gateway config (--config / $KEIKO_CONFIG_FILE), or
// null when no config source is available, the config cannot be loaded, or no embedding-capable
// model is configured. The test seam (deps.embedText) short-circuits this entirely. A GatewayError
// is treated as "no model" (best-effort backfill never hard-fails on a config problem).
function resolveEmbedder(
  args: readonly string[],
  env: EnvSource,
  deps: MemoryCliDeps,
): MemoryEmbedder | null {
  if (deps.embedText !== undefined) return deps.embedText;
  const configPath = flagValue(args, "--config") ?? env.KEIKO_CONFIG_FILE;
  if (configPath === undefined) return null;
  try {
    return createMemoryEmbedder(loadConfigFromFile(configPath, env), requestOpenAIEmbedding);
  } catch (error) {
    if (error instanceof GatewayError) return null;
    throw error;
  }
}

function parseLimit(args: readonly string[]): number {
  const raw = flagValue(args, "--limit");
  if (raw === undefined) return DEFAULT_REEMBED_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_REEMBED_LIMIT;
}

interface ReembedCounts {
  embedded: number;
  skipped: number;
  failed: number;
}

async function backfillEmbeddings(
  vault: MemoryVaultStore,
  embed: MemoryEmbedder,
  limit: number,
): Promise<ReembedCounts> {
  const accepted = vault.listMemories({ status: ["accepted"], includeExpired: true, limit });
  const counts: ReembedCounts = { embedded: 0, skipped: 0, failed: 0 };
  for (const record of accepted) {
    if (vault.getEmbedding(record.id) !== undefined) {
      counts.skipped += 1;
      continue;
    }
    const input = await embed(record.body);
    if (input === null) {
      counts.failed += 1;
      continue;
    }
    try {
      vault.upsertEmbedding(record.id, input);
      counts.embedded += 1;
    } catch {
      counts.failed += 1;
    }
  }
  return counts;
}

function renderReembedReport(counts: ReembedCounts): string {
  return [
    "Memory re-embedding complete.",
    `  embedded: ${String(counts.embedded)}`,
    `  skipped:  ${String(counts.skipped)}`,
    `  failed:   ${String(counts.failed)}`,
    "",
  ].join("\n");
}

async function reembed(
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  deps: MemoryCliDeps,
): Promise<number> {
  const embed = resolveEmbedder(args, env, deps);
  if (embed === null) {
    io.out(
      "No embedding model is configured — skipping re-embedding. " +
        "Provide a gateway config with --config PATH or $KEIKO_CONFIG_FILE.\n",
    );
    return 0;
  }
  const vault = resolveVault(args, env, deps);
  try {
    const counts = await backfillEmbeddings(vault, embed, parseLimit(args));
    io.out(renderReembedReport(counts));
    return 0;
  } finally {
    if (deps.vault === undefined) vault.close();
  }
}

// async wrapper so a sync-or-async failure surfaces as exit 1 (the sync subcommands rely on
// dispatchSubcommand's try/catch, which cannot catch a rejected Promise).
async function runReembed(
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  deps: MemoryCliDeps,
): Promise<number> {
  try {
    return await reembed(args, io, env, deps);
  } catch (error) {
    io.err(`keiko memory: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function dispatchSubcommand(
  sub: string,
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  deps: MemoryCliDeps,
): number | Promise<number> {
  try {
    if (sub === "maintain") return runMaintain(args, io, env, deps);
    if (sub === "stats") return runStats(args, io, env, deps);
    if (sub === "diagnostics") return runDiagnostics(args, io, env, deps);
    if (sub === "reembed") return runReembed(args, io, env, deps);
  } catch (error) {
    io.err(`keiko memory: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  io.err(`keiko memory: unknown subcommand: ${sub}\n`);
  io.err(USAGE);
  return 2;
}

export function runMemoryCli(
  rest: readonly string[],
  io: CliIo,
  env: EnvSource = {},
  deps: MemoryCliDeps = {},
): number | Promise<number> {
  const sub = rest[0];
  if (sub === undefined || sub === "--help" || sub === "-h") {
    io.out(USAGE);
    return sub === undefined ? 2 : 0;
  }
  return dispatchSubcommand(sub, rest.slice(1), io, env, deps);
}
