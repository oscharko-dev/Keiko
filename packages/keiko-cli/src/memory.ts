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

import {
  createMemoryVault,
  resolveMemoryDir,
  type MemoryVaultStore,
} from "@oscharko-dev/keiko-memory-vault";
import type { MemoryEmbedder } from "@oscharko-dev/keiko-server";
import { redact } from "@oscharko-dev/keiko-security";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type { MemoryRecord, MemoryScope } from "@oscharko-dev/keiko-contracts";
import { loadGatewayConfigFromFile } from "./gateway-config.js";
// GEN-PERF-CLI-001 — server/evidence/gateway graphs load per subcommand at dispatch;
// the memory-vault import above is a light leaf (contracts+security only) and stays static.
import { loadEvidence, loadModelGateway, loadServer } from "./lazy-modules.js";
import type { CliIo } from "./runner.js";

type ServerModule = typeof import("@oscharko-dev/keiko-server");

const USAGE = `Usage:
  keiko memory maintain [--memory-dir PATH] [--evidence-dir PATH]
                                              Run a bounded consolidate + archive + forget pass.
  keiko memory stats [--memory-dir PATH]      Print memory counts by status and scope.
  keiko memory diagnostics [--memory-dir PATH] [--evidence-dir PATH] [--last N]
                                              Print redacted local diagnostics JSON.
  keiko memory reembed [--memory-dir PATH] [--limit N] [--config PATH] [--force]
                                              Backfill embeddings for accepted memories lacking one;
                                              use --force to re-embed every accepted memory instead.

Opens the local memory vault (default $KEIKO_MEMORY_DIR or the platform state dir; override with
--memory-dir). \`maintain\` archives faded memories, expires un-reviewed faint proposals, forgets
memories whose validity window elapsed, and reports unresolved consolidation review items (memory
strength itself is derived live at retrieval; this pass never rewrites confidence). It never
promotes a proposal to accepted: the CLI cannot read the MemoriaViva autonomy posture, so it fails
closed to "Ask for approval" and leaves acceptance to the review queue. \`diagnostics\`
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
    ((memoryDir: string | undefined, env: EnvSource) => MemoryVaultStore) | undefined;
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

function renderMaintenanceReport(counts: ReturnType<ServerModule["runMemoryMaintenance"]>): string {
  return [
    "Memory maintenance complete.",
    `  promoted:          ${String(counts.promoted)}`,
    `  archived:          ${String(counts.archived)}`,
    `  expired:           ${String(counts.expired)}`,
    `  forgotten:         ${String(counts.forgotten)}`,
    `  retentionForgotten:${String(counts.retentionForgotten).padStart(7)}`,
    `  tombstonesPurged:  ${String(counts.tombstonesPurged).padStart(7)}`,
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
    const records = vault.listMemoriesAcrossScopes(vault.listMemoryScopes(), {
      includeExpired: true,
    });
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

async function runDiagnostics(
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  deps: MemoryCliDeps,
): Promise<number> {
  const [{ exportMemoryDiagnostics }, evidence] = await Promise.all([loadServer(), loadEvidence()]);
  const vault = resolveVault(args, env, deps);
  const memoryDir = resolveMemoryDir(flagValue(args, "--memory-dir"), env);
  const evidenceDir = evidence.resolveEvidenceDir(flagValue(args, "--evidence-dir"), env);
  const evidenceStore = deps.evidenceStore ?? evidence.createNodeEvidenceStore(evidenceDir);
  const redactString = deps.redactString ?? evidence.createAuditRedactor({}, env);
  try {
    const records = vault.listMemoriesAcrossScopes(vault.listMemoryScopes(), {
      includeExpired: true,
    });
    const lastNAuditEvents = parseLastAuditEvents(args);
    const diagnostics = exportMemoryDiagnostics({
      vault,
      scopes: uniqueRecordScopes(records),
      evidenceStore,
      redactString,
      evidenceDir,
      memoryDir,
      ...(lastNAuditEvents === undefined ? {} : { lastNAuditEvents }),
    });
    io.out(`${JSON.stringify(diagnostics, null, 2)}\n`);
    return 0;
  } finally {
    if (deps.vault === undefined) vault.close();
  }
}

async function runMaintain(
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  deps: MemoryCliDeps,
): Promise<number> {
  const [
    { runMemoryMaintenance, memoryRetentionPolicy, memorySemanticizationMultipliers },
    evidence,
  ] = await Promise.all([loadServer(), loadEvidence()]);
  const vault = resolveVault(args, env, deps);
  const evidenceDir = evidence.resolveEvidenceDir(flagValue(args, "--evidence-dir"), env);
  const evidenceStore = deps.evidenceStore ?? evidence.createNodeEvidenceStore(evidenceDir);
  // Honour KEIKO_MEMORY_SEMANTICIZATION on the CLI exactly as the two server passes do, so the
  // "CLI and UI never drift" invariant in this module's header holds when the flag is on.
  const multipliers = memorySemanticizationMultipliers(env);
  const retentionPolicy = memoryRetentionPolicy(env);
  try {
    // The pass writes audit evidence, so it needs the security layer's redactor by name — the API no
    // longer accepts a bare store and silently falls back to identity redaction.
    //
    // No autonomyMode: the CLI opens the memory vault only and cannot read the operator's persisted
    // MemoriaViva posture, so the pass fails closed to "Ask for approval" (ADR-0124 D2 / ADR-0146
    // D2) and promotes nothing. Acceptance stays a decision made in the review queue.
    const counts = runMemoryMaintenance(
      vault,
      { evidenceStore, redactString: (input: string): string => redact(input) },
      {
        ...(multipliers !== undefined ? { decayHalfLifeMultiplierByType: multipliers } : {}),
        ...(retentionPolicy !== undefined ? { retentionPolicy } : {}),
      },
    );
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
async function resolveEmbedder(
  args: readonly string[],
  env: EnvSource,
  deps: MemoryCliDeps,
): Promise<MemoryEmbedder | null> {
  if (deps.embedText !== undefined) return deps.embedText;
  const configPath = flagValue(args, "--config") ?? env.KEIKO_CONFIG_FILE;
  if (configPath === undefined) return null;
  const [{ createMemoryEmbedder }, gateway] = await Promise.all([loadServer(), loadModelGateway()]);
  try {
    return createMemoryEmbedder(
      await loadGatewayConfigFromFile(configPath, env),
      gateway.requestOpenAIEmbedding,
    );
  } catch (error) {
    if (error instanceof gateway.GatewayError) return null;
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

async function embedOne(
  vault: MemoryVaultStore,
  embed: MemoryEmbedder,
  record: MemoryRecord,
  counts: ReembedCounts,
): Promise<void> {
  // Default mode: skip records that already carry an embedding — that is the "backfill
  // missing embeddings" contract from USAGE. The --force path uses its own
  // forceReembedAtomically() flow and does not call this helper (KEIKO-0440 PR-review
  // follow-up: --force must stage the new vector space and swap atomically).
  if (vault.getEmbedding(record.id) !== undefined) {
    counts.skipped += 1;
    return;
  }
  // PR-review follow-up: a thrown embed() (network error, provider auth failure, timeout)
  // must count as failed for THIS record and let the loop keep going — otherwise a single
  // provider error aborts the whole reembed pass with an unreported partial state.
  let input;
  try {
    input = await embed(record.body);
  } catch {
    counts.failed += 1;
    return;
  }
  if (input === null) {
    counts.failed += 1;
    return;
  }
  try {
    vault.upsertEmbedding(record.id, input);
    counts.embedded += 1;
  } catch {
    counts.failed += 1;
  }
}

async function backfillEmbeddings(
  vault: MemoryVaultStore,
  embed: MemoryEmbedder,
  limit: number,
  _force: boolean,
): Promise<ReembedCounts> {
  // KEIKO-0440 (PR-review follow-up): the limit is the target COUNT of records the pass will
  // re-embed, not a cap on the scan window. Iterate the accepted set and skip records that
  // already carry an embedding, so a small `--limit` can still reach an older un-embedded
  // record hidden behind newer already-embedded pages. The --force mode has its own atomic
  // staging path and never calls this function.
  //
  // PR-review follow-up (KfQ thread 3769955302 + Codex thread 3770110870): the fast-path
  // driven by observedEmbedded==embeddedSet.size was unsafe when embedded and unembedded
  // records are interleaved across pages (skipping the older unembedded tail) — reverted.
  // The perf concern (fully-embedded corpus paging the whole scan) is now addressed by an
  // O(1) short-circuit at the top: if the embedded set already covers every accepted
  // memoryId, no work is possible and the pass exits immediately without paging.
  const counts: ReembedCounts = { embedded: 0, skipped: 0, failed: 0 };
  const scopes = vault.listMemoryScopes();
  const embeddedSet = new Set<MemoryRecord["id"]>(vault.listEmbeddedMemoryIds());
  const acceptedIds = collectAcceptedMemoryIds(vault, scopes);
  const unembeddedIds: MemoryRecord["id"][] = [];
  for (const id of acceptedIds) {
    if (embeddedSet.has(id)) counts.skipped += 1;
    else unembeddedIds.push(id);
  }
  for (const id of unembeddedIds) {
    if (counts.embedded + counts.failed >= limit) break;
    const record = vault.getMemory(id);
    if (record === undefined) continue;
    await embedOne(vault, embed, record, counts);
  }
  return counts;
}

// Enumerate every accepted memoryId across the given scopes in a single deterministic pass.
// Paginating the id list up front keeps backfillEmbeddings clean (single loop over the work
// list) and lets the fully-embedded fast path exit before any per-record work happens.
function collectAcceptedMemoryIds(
  vault: MemoryVaultStore,
  scopes: readonly MemoryScope[],
): readonly MemoryRecord["id"][] {
  const ids: MemoryRecord["id"][] = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const page = vault.listMemoriesAcrossScopes(scopes, {
      status: ["accepted"],
      includeExpired: true,
      limit: pageSize,
      offset,
    });
    if (page.length === 0) break;
    for (const record of page) ids.push(record.id);
    if (page.length < pageSize) break;
  }
  return ids;
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
  const embed = await resolveEmbedder(args, env, deps);
  if (embed === null) {
    io.out(
      "No embedding model is configured — skipping re-embedding. " +
        "Provide a gateway config with --config PATH or $KEIKO_CONFIG_FILE.\n",
    );
    return 0;
  }
  const vault = resolveVault(args, env, deps);
  try {
    const force = args.includes("--force");
    if (force) {
      const counts = await forceReembedAtomically(vault, embed);
      io.out(renderReembedReport(counts));
      // Any provider or upsert failure during --force means the swap was NOT performed —
      // the prior vector space is intact and the operator sees a non-zero exit so they can
      // retry rather than silently continuing on a partially rebuilt corpus.
      return counts.failed > 0 ? 1 : 0;
    }
    const counts = await backfillEmbeddings(vault, embed, parseLimit(args), false);
    io.out(renderReembedReport(counts));
    return 0;
  } finally {
    if (deps.vault === undefined) vault.close();
  }
}

interface StagedVector {
  readonly memoryId: MemoryRecord["id"];
  readonly input: NonNullable<Awaited<ReturnType<MemoryEmbedder>>>;
}

// PR-review follow-up (KEIKO-0440, threads 3769276197 + 3769424330 + 3769557887 +
// 3769711626 + 3769711634): `--force` must be atomic — either every accepted memory ends
// up with a fresh vector AND every previously-embedded memory keeps one, OR the prior
// vector space is preserved and the operator sees the failure. Three phases:
//   1. Snapshot the target set as the UNION of (every accepted memoryId) and (every
//      currently-embedded memoryId). Accepted is the documented force contract; the
//      embedded set adds archived/superseded memories whose embeddings updateMemory
//      intentionally does not delete on status transitions.
//   2. Stage a new vector for each target id. A provider throw / null-return aborts here,
//      so the persisted vectors stay intact and reembed returns exit 1.
//   3. Hand the staged pairs to `vault.replaceAllEmbeddings`, which takes a RESERVED lock,
//      re-checks the embedding set for concurrent writes we did not stage, then performs
//      the delete + reinsert in ONE SQLite transaction; any error inside that transaction
//      rolls the whole swap back so the prior vector space is preserved.
async function forceReembedAtomically(
  vault: MemoryVaultStore,
  embed: MemoryEmbedder,
): Promise<ReembedCounts> {
  const counts: ReembedCounts = { embedded: 0, skipped: 0, failed: 0 };
  // PR-review follow-up (Codex thread 3769903807 + 3770792792): capture the
  // (memoryId, createdAt) snapshot FIRST, then derive embedded targets from the snapshot
  // itself. If we enumerated targets before snapshotting, a concurrent DELETE that removes
  // an embedding between the two calls would leave the deleted id in targets but absent
  // from the snapshot — the swap would then have no drift signal and would recreate the
  // deleted vector from the staged pair. Snapshot-first closes that ordering gap.
  const snapshot = vault.snapshotEmbeddedMemoryIds();
  const targetIds = collectForceReembedTargetIds(vault, snapshot);
  // PR-review follow-up (Codex thread 3770211415): capture memories.updated_at for each
  // staged pair too. The embedding-row snapshot cannot catch a body edit on a memory that
  // had no prior embedding — the concurrent write leaves the (empty) row set unchanged.
  // Comparing the memory revision inside the swap detects that case; a mismatch aborts.
  const memoryVersions = new Map<MemoryRecord["id"], number>();
  const staged: StagedVector[] = [];
  for (const memoryId of targetIds) {
    const record = vault.getMemory(memoryId);
    if (record === undefined) {
      // Under FK ON DELETE CASCADE this only surfaces if a concurrent deletion races
      // between the snapshot and the record lookup. Drop the stray id — the vault-wide
      // replace will remove any lingering embedding row for it under the same lock.
      continue;
    }
    memoryVersions.set(record.id, record.updatedAt);
    const staged1 = await embedOneForForce(embed, record, counts);
    if (staged1 === null) return counts;
    staged.push(staged1);
  }
  try {
    vault.replaceAllEmbeddings(staged, snapshot, memoryVersions);
    counts.embedded = staged.length;
  } catch {
    // PR-review follow-up (Codex thread 3770517480): a storage failure on an empty stage
    // (SQLite refuses BEGIN IMMEDIATE, sidecar hardening throws, etc.) must not report
    // success — max(1, staged.length) so counts.failed is at least 1 and the CLI exits
    // non-zero even when the target set was empty.
    counts.failed = Math.max(1, staged.length);
  }
  return counts;
}

function collectForceReembedTargetIds(
  vault: MemoryVaultStore,
  snapshot: ReadonlyMap<MemoryRecord["id"], number>,
): readonly MemoryRecord["id"][] {
  // PR-review follow-up (Codex thread 3771011289): use vault.listMemoryIdsByStatus which
  // returns every accepted memoryId in ONE SQL query. Prior implementation paginated with
  // OFFSET; a concurrent DELETE that removed a row from an earlier page shifted the
  // remaining rows and skipped an unembedded accepted record across the page boundary.
  const targetIds = new Set<MemoryRecord["id"]>();
  for (const memoryId of vault.listMemoryIdsByStatus("accepted")) targetIds.add(memoryId);
  // Embedded targets come from the snapshot (not a fresh listEmbeddedMemoryIds()) so a
  // concurrent DELETE between snapshot and target enumeration cannot re-add a deleted id
  // that the snapshot omits.
  for (const memoryId of snapshot.keys()) targetIds.add(memoryId);
  return Array.from(targetIds);
}

async function embedOneForForce(
  embed: MemoryEmbedder,
  record: MemoryRecord,
  counts: ReembedCounts,
): Promise<StagedVector | null> {
  let input;
  try {
    input = await embed(record.body);
  } catch {
    counts.failed += 1;
    return null;
  }
  if (input === null) {
    counts.failed += 1;
    return null;
  }
  return { memoryId: record.id, input };
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

async function dispatchSubcommand(
  sub: string,
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  deps: MemoryCliDeps,
): Promise<number> {
  // Await inside the try so async rejections surface as exit 1 exactly like the
  // previous synchronous throws did.
  try {
    if (sub === "maintain") return await runMaintain(args, io, env, deps);
    if (sub === "stats") return runStats(args, io, env, deps);
    if (sub === "diagnostics") return await runDiagnostics(args, io, env, deps);
    if (sub === "reembed") return await runReembed(args, io, env, deps);
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
