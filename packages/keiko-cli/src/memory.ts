// `keiko memory` — operator surface for the governed memory vault (Epic #204).
//
//   maintain   Run one bounded maintenance pass IN-PROCESS (consolidate + decay + reinforce +
//              forget) against the local vault and print the applied counts. Reuses the exact same
//              `runMemoryMaintenance` core the BFF route uses, so the CLI and UI never drift.
//   stats      Print memory counts by status, by scope kind, and the total.
//
// The vault is opened at the resolved memory dir (default $KEIKO_MEMORY_DIR or the platform state
// dir; override with --memory-dir). Tests inject a vault via deps so no disk is touched. Exit 0 on
// success, 1 on a runtime error (vault open / maintenance fault), 2 on usage (unknown/missing
// subcommand).

import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import { runMemoryMaintenance } from "@oscharko-dev/keiko-server";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type { MemoryRecord, MemoryScope } from "@oscharko-dev/keiko-contracts";
import type { CliIo } from "./runner.js";

const USAGE = `Usage:
  keiko memory maintain [--memory-dir PATH]   Run a bounded consolidate + decay + forget pass.
  keiko memory stats [--memory-dir PATH]      Print memory counts by status and scope.

Opens the local memory vault (default $KEIKO_MEMORY_DIR or the platform state dir; override with
--memory-dir). \`maintain\` strengthens recalled memories, decays stale ones, archives faded ones,
forgets expired/very-faint ones, and auto-supersedes pairwise correction conflicts.
`;

// Test seam: inject a vault + a factory so unit tests never touch the filesystem or keychain.
export interface MemoryCliDeps {
  readonly vault?: MemoryVaultStore | undefined;
  readonly openVault?:
    | ((memoryDir: string | undefined, env: EnvSource) => MemoryVaultStore)
    | undefined;
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

function dispatchSubcommand(
  sub: string,
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  deps: MemoryCliDeps,
): number {
  try {
    if (sub === "maintain") return runMaintain(args, io, env, deps);
    if (sub === "stats") return runStats(args, io, env, deps);
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
): number {
  const sub = rest[0];
  if (sub === undefined || sub === "--help" || sub === "-h") {
    io.out(USAGE);
    return sub === undefined ? 2 : 0;
  }
  return dispatchSubcommand(sub, rest.slice(1), io, env, deps);
}
