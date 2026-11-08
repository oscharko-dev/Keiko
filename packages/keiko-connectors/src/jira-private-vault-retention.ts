import type { AtlassianCredentialVaultPort } from "./atlassian-credential-custody.js";

/** Separate resource bounds for short-lived sealed inputs and session/temp state. */
const LIMITS = { input: 128, session: 64 } as const;
const REFERENCES = { input: /^jira-input:jhi_[a-f0-9]{64}$/u, session: /^jira-session:[a-f0-9]{64}$/u };
type Kind = keyof typeof LIMITS;
interface RetainedIdentity { readonly reference: string; readonly expiresAt: number }
interface RetentionSelection {
  readonly vault: AtlassianCredentialVaultPort;
  readonly kind: Kind;
  readonly now: number;
  readonly identity: (serialized: string) => RetainedIdentity | undefined;
  readonly onExpired?: (serialized: string) => void;
}
interface Selection extends RetentionSelection { readonly reference: string }
export class JiraPrivateVaultRetentionError extends Error {
  constructor() { super("Jira private custody capacity is unavailable"); this.name = "JiraPrivateVaultRetentionError"; }
}
function expiredEntry(selection: RetentionSelection, reference: string): void {
  const { vault } = selection;
  const serialized = vault.get(reference); if (serialized === undefined) return;
  const identity = selection.identity(serialized);
  if (identity?.reference !== reference || identity.expiresAt > selection.now) return;
  // A live callback can still be finishing after expiry. Never remove its claimed lease/record.
  const release = vault.acquireLease?.(reference); if (release === undefined) return;
  try {
    if (vault.compareAndSet?.(reference, serialized, undefined)) selection.onExpired?.(serialized);
  } finally { release(); }
}
function selectedReferences(selection: RetentionSelection): readonly string[] {
  const list = selection.vault.list; if (list === undefined) throw new JiraPrivateVaultRetentionError();
  return list().filter((reference) => REFERENCES[selection.kind].test(reference));
}
/** Same bounded retention pass when the existing private vault is legitimately opened. */
export function sweepExpiredJiraPrivateRecords(selection: RetentionSelection): void {
  if (selection.vault.compareAndSet === undefined) throw new JiraPrivateVaultRetentionError();
  const release = selection.vault.acquireLease?.(`jira-retention:${selection.kind}`, "collection");
  if (release === undefined) throw new JiraPrivateVaultRetentionError();
  try {
    for (const reference of selectedReferences(selection).slice(0, LIMITS[selection.kind])) expiredEntry(selection, reference);
  } finally { release(); }
}
/** Invoked on real allocation, never by a background worker. No vault keys leave this module.
 * The existing kernel lease makes prune/count/create one admission across separate BFFs.
 * Only validated exact-purpose expired records can be removed; credentials are never candidates. */
export function withJiraPrivateRecordCapacity<T>(selection: Selection, allocate: () => T): T {
  if (selection.vault.compareAndSet === undefined || !REFERENCES[selection.kind].test(selection.reference))
    throw new JiraPrivateVaultRetentionError();
  const release = selection.vault.acquireLease?.(`jira-retention:${selection.kind}`, "collection");
  if (release === undefined) throw new JiraPrivateVaultRetentionError();
  try {
    const references = selectedReferences(selection);
    // At most the current purpose's capacity is decrypted/pruned per allocation. Older oversized
    // stores remain fail-closed and can be reclaimed over later calls without unbounded work.
    for (const reference of references.slice(0, LIMITS[selection.kind])) expiredEntry(selection, reference);
    if (selection.vault.get(selection.reference) === undefined && selectedReferences(selection).length >= LIMITS[selection.kind])
      throw new JiraPrivateVaultRetentionError();
    return allocate();
  } finally { release(); }
}
