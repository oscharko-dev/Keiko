import { createHash, randomUUID } from "node:crypto";
import type { JiraHumanInputView } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { AtlassianCredentialMetadata } from "@oscharko-dev/keiko-contracts";
import type { AtlassianCredentialVaultPort } from "./atlassian-credential-custody.js";
import { sweepExpiredJiraPrivateRecords, withJiraPrivateRecordCapacity } from "./jira-private-vault-retention.js";
import {
  copyHumanInputBinding, currentHumanInputLifetime, humanInputReference, humanInputRequestId, humanInputView,
  parseHumanInputRecord, parseHumanInputValues,
  type JiraHumanInputBinding, type JiraHumanInputRecord, type JiraHumanInputValues,
} from "./jira-human-input-values.js";

export type JiraHumanInputRefusal = "invalid-input" | "binding-changed" | "not-pending" | "not-ready" | "expired" | "cancelled";
/** Deliberately content-free; no password, license, identifier or upstream diagnostic in errors. */
export class JiraHumanInputCustodyError extends Error {
  constructor(readonly code: JiraHumanInputRefusal) { super(`Jira private input ${code}`); this.name = "JiraHumanInputCustodyError"; }
}
export interface JiraHumanInputCustody {
  /** Human route reconciliation only: original non-secret context, never stored values. */
  readonly bindingFor: (requestId: string, principalDigest: string) => JiraHumanInputBinding | undefined;
  readonly prepare: (binding: JiraHumanInputBinding) => JiraHumanInputView;
  readonly inspect: (requestId: string, binding: JiraHumanInputBinding) => JiraHumanInputView | undefined;
  readonly submit: (requestId: string, binding: JiraHumanInputBinding, expectedRevision: string, values: unknown) => JiraHumanInputView;
  readonly cancel: (requestId: string, binding: JiraHumanInputBinding) => JiraHumanInputView | undefined;
  /** Authenticated owner may clear obsolete input; never grants inspect, submit or execution. */
  readonly cancelOwned: (requestId: string, principalDigest: string) => JiraHumanInputView | undefined;
  /** First legitimate vault open and explicit owner maintenance; no background task. */
  readonly sweepExpired: () => void;
  readonly wait: (requestId: string, binding: JiraHumanInputBinding, signal: AbortSignal) => Promise<JiraHumanInputView | undefined>;
}
export interface JiraHumanInputExecutionResolver {
  /** HTTP closure only. Synchronously consumes the sealed input BEFORE it can enter an awaited dispatch.
   * Claimed bytes never enter an ordinary request snapshot, approval, transcript or model argument. */
  readonly claim: (requestId: string, binding: JiraHumanInputBinding, expectedRevision: string) => JiraHumanInputValues;
}
interface Dependencies {
  readonly vault: AtlassianCredentialVaultPort;
  readonly metadata: (authRef: string) => AtlassianCredentialMetadata | undefined;
  readonly now?: () => number;
  readonly onCleared?: (binding: JiraHumanInputBinding, phase: "cancelled" | "expired") => void;
}
interface Owner extends Dependencies {
  /** Only live notification subscriptions; records and claim state live in the existing sealed vault. */
  readonly listeners: Map<string, Set<() => void>>;
  /** Only the digest of the exact read; serialized secret material is never retained for CAS. */
  readonly loaded: WeakMap<JiraHumanInputRecord, string>;
}
function fail(code: JiraHumanInputRefusal): never { throw new JiraHumanInputCustodyError(code); }
function now(owner: Owner): number { return (owner.now ?? Date.now)(); }
function selected(owner: Owner, candidate: JiraHumanInputBinding): JiraHumanInputBinding {
  const binding = copyHumanInputBinding(candidate); if (binding === undefined) return fail("invalid-input");
  const metadata = owner.metadata(binding.authRef);
  if (metadata?.deployment !== "data-center" || metadata.generation !== binding.authenticationGeneration ||
      metadata.livePod?.verificationRevision !== binding.verificationRevision || metadata.livePod.ownerDigest !== binding.principalDigest ||
      metadata.livePod.verificationStatus !== "ok" || metadata.livePod.verificationInProgress || metadata.livePod.credentialOperation !== undefined)
    return fail("binding-changed");
  if (binding.context.kind === "chat" && metadata.livePod.podId !== binding.context.podId) return fail("binding-changed");
  return binding;
}
function reference(requestId: string): string { return humanInputReference(requestId) ?? fail("invalid-input"); }
function digest(serialized: string): string { return createHash("sha256").update(serialized).digest("hex"); }
function load(owner: Owner, requestId: string, binding: JiraHumanInputBinding): JiraHumanInputRecord | undefined {
  if (requestId !== humanInputRequestId(binding)) return fail("binding-changed");
  const serialized = owner.vault.get(reference(requestId)); if (serialized === undefined) return undefined;
  const record = parseHumanInputRecord(serialized);
  if (record === undefined || record.requestId !== requestId || humanInputRequestId(record.binding) !== humanInputRequestId(binding))
    return fail("binding-changed");
  owner.loaded.set(record, digest(serialized));
  return record;
}
function changed(owner: Owner, requestId: string): void {
  for (const notify of [...(owner.listeners.get(requestId) ?? [])]) notify();
}
function save(owner: Owner, record: JiraHumanInputRecord, previous?: JiraHumanInputRecord): void {
  const compare = owner.vault.compareAndSet;
  const expectedDigest = previous === undefined ? undefined : owner.loaded.get(previous);
  if (compare === undefined || (previous !== undefined && expectedDigest === undefined)) return fail("not-ready");
  const expected = previous === undefined ? undefined : owner.vault.get(reference(record.requestId));
  if (previous !== undefined && (expected === undefined || digest(expected) !== expectedDigest)) return fail("not-pending");
  const serialized = JSON.stringify(record);
  if (!compare(reference(record.requestId), expected, serialized)) return fail("not-pending");
  owner.loaded.set(record, digest(serialized));
  if (record.state !== previous?.state && (record.state === "expired" || record.state === "cancelled"))
    owner.onCleared?.(record.binding, record.state);
  changed(owner, record.requestId);
}
function cleared(record: JiraHumanInputRecord, state: "consumed" | "cancelled" | "expired"): JiraHumanInputRecord {
  // Construct a fresh record: values may never survive cancellation, expiry or a consumed claim.
  return { schemaVersion: 1, kind: "jira-operation-input", binding: record.binding, requestId: record.requestId,
    revision: record.revision, state };
}
function current(owner: Owner, record: JiraHumanInputRecord): JiraHumanInputRecord {
  if (record.binding.expiresAt > now(owner) || record.state === "expired" ||
      record.state === "consumed" || record.state === "cancelled") return record;
  const expired = cleared(record, "expired"); save(owner, expired, record); return expired;
}
function inspect(owner: Owner, requestId: string, candidate: JiraHumanInputBinding): JiraHumanInputView | undefined {
  const binding = selected(owner, candidate); const record = load(owner, requestId, binding);
  return record === undefined ? undefined : humanInputView(current(owner, record));
}
function bindingFor(owner: Owner, requestId: string, principalDigest: string): JiraHumanInputBinding | undefined {
  const key = humanInputReference(requestId);
  if (key === undefined || !/^[a-f0-9]{64}$/u.test(principalDigest)) return undefined;
  const serialized = owner.vault.get(key); if (serialized === undefined) return undefined;
  const record = parseHumanInputRecord(serialized);
  if (record === undefined || record.requestId !== requestId || record.binding.principalDigest !== principalDigest) return undefined;
  owner.loaded.set(record, digest(serialized));
  if (current(owner, record).state === "expired") return undefined;
  try { return selected(owner, record.binding); }
  catch (error) {
    if (error instanceof JiraHumanInputCustodyError && error.code === "binding-changed") return undefined;
    throw error;
  }
}
function prepare(owner: Owner, candidate: JiraHumanInputBinding): JiraHumanInputView {
  const binding = selected(owner, candidate);
  if (!currentHumanInputLifetime(binding, now(owner))) return fail("expired");
  const requestId = humanInputRequestId(binding);
  return withJiraPrivateRecordCapacity({ ...retentionSelection(owner), reference: reference(requestId) }, () => {
    const existing = load(owner, requestId, binding);
    if (existing !== undefined) return humanInputView(current(owner, existing));
    const record: JiraHumanInputRecord = { schemaVersion: 1, kind: "jira-operation-input", binding, requestId,
      revision: randomUUID(), state: "awaiting-input" };
    save(owner, record); return humanInputView(record);
  });
}
function retentionSelection(owner: Owner) {
  return { vault: owner.vault, kind: "input" as const, now: now(owner), identity: (serialized: string) => {
    const record = parseHumanInputRecord(serialized);
    return record === undefined ? undefined : { reference: reference(record.requestId), expiresAt: record.binding.expiresAt };
  }, onExpired: (serialized: string) => {
    const record = parseHumanInputRecord(serialized);
    if (record?.state === "awaiting-input" || record?.state === "ready") owner.onCleared?.(record.binding, "expired");
  } };
}
function submit(owner: Owner, requestId: string, candidate: JiraHumanInputBinding, revision: string, raw: unknown): JiraHumanInputView {
  const binding = selected(owner, candidate); const retained = load(owner, requestId, binding);
  if (retained === undefined) return fail("not-pending");
  const record = current(owner, retained);
  if (record.state === "expired") return fail("expired");
  if (record.state !== "awaiting-input" || record.revision !== revision) return fail("not-pending");
  const values = parseHumanInputValues(binding.operation, raw); if (values === undefined) return fail("invalid-input");
  const ready: JiraHumanInputRecord = { ...record, revision: randomUUID(), state: "ready", values };
  save(owner, ready, record); return humanInputView(ready);
}
function cancel(owner: Owner, requestId: string, candidate: JiraHumanInputBinding): JiraHumanInputView | undefined {
  // Deletion is allowed after credential/authority revocation, but remains exact-binding-only.
  const binding = copyHumanInputBinding(candidate) ?? fail("invalid-input");
  const retained = load(owner, requestId, binding); if (retained === undefined) return undefined;
  const record = current(owner, retained);
  if (record.state === "consumed" || record.state === "expired" || record.state === "cancelled") return humanInputView(record);
  const cancelled = cleared(record, "cancelled"); save(owner, cancelled, record); return humanInputView(cancelled);
}
function cancelOwned(owner: Owner, requestId: string, principalDigest: string): JiraHumanInputView | undefined {
  const key = humanInputReference(requestId);
  if (key === undefined || !/^[a-f0-9]{64}$/u.test(principalDigest)) return undefined;
  const serialized = owner.vault.get(key); if (serialized === undefined) return undefined;
  const record = parseHumanInputRecord(serialized);
  if (record?.requestId !== requestId || record.binding.principalDigest !== principalDigest ||
      humanInputRequestId(record.binding) !== requestId) return undefined;
  return cancel(owner, requestId, record.binding);
}
function claim(owner: Owner, requestId: string, candidate: JiraHumanInputBinding, revision: string): JiraHumanInputValues {
  const binding = selected(owner, candidate); const retained = load(owner, requestId, binding);
  if (retained === undefined) return fail("not-ready");
  const record = current(owner, retained);
  if (record.state === "expired" || record.state === "cancelled") return fail(record.state);
  if (record.state !== "ready" || record.revision !== revision || record.values === undefined) return fail("not-ready");
  const values = record.values;
  save(owner, cleared(record, "consumed"), record);
  return values;
}
function wait(owner: Owner, requestId: string, binding: JiraHumanInputBinding, signal: AbortSignal): Promise<JiraHumanInputView | undefined> {
  if (signal.aborted) return Promise.resolve(cancel(owner, requestId, binding));
  const view = inspect(owner, requestId, binding);
  if (view?.state !== "awaiting-input") return Promise.resolve(view);
  return new Promise((resolve) => {
    let settled = false;
    const listeners = owner.listeners.get(requestId) ?? new Set<() => void>();
    owner.listeners.set(requestId, listeners);
    const finish = (): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener("abort", finish); listeners.delete(finish);
      if (listeners.size === 0) owner.listeners.delete(requestId);
      // Adopt the observation promise, including its original rejection. The composing call
      // owns diagnostics; notification callbacks must never turn custody failures into success.
      resolve(Promise.resolve().then(() => signal.aborted
        ? cancel(owner, requestId, binding) : inspect(owner, requestId, binding)));
    };
    // Expiry shares the existing call's signal/deadline. No background replay or runtime polling.
    const timer = setTimeout(finish, Math.max(1, view.expiresAt - now(owner)));
    listeners.add(finish); signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}
/** A facet of existing Atlassian custody, backed by the same LocalSecretVault instance. */
export function createJiraHumanInputCustody(deps: Dependencies): {
  readonly custody: JiraHumanInputCustody; readonly executionResolver: JiraHumanInputExecutionResolver;
} {
  const owner: Owner = { ...deps, listeners: new Map(), loaded: new WeakMap() };
  return {
    custody: {
      bindingFor: (id, principalDigest) => bindingFor(owner, id, principalDigest),
      prepare: (binding) => prepare(owner, binding), inspect: (id, binding) => inspect(owner, id, binding),
      submit: (id, binding, revision, values) => submit(owner, id, binding, revision, values),
      cancel: (id, binding) => cancel(owner, id, binding), cancelOwned: (id, principal) => cancelOwned(owner, id, principal),
      sweepExpired: () => sweepExpiredJiraPrivateRecords(retentionSelection(owner)),
      wait: (id, binding, signal) => wait(owner, id, binding, signal),
    },
    executionResolver: { claim: (id, binding, revision) => claim(owner, id, binding, revision) },
  };
}
