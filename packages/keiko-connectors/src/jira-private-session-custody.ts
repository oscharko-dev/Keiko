import { randomUUID } from "node:crypto";
import type { AtlassianCredentialMetadata } from "@oscharko-dev/keiko-contracts";
import type { AtlassianCredentialVaultPort } from "./atlassian-credential-custody.js";
import { parseJsonRecord } from "./atlassian-sync-classify.js";
import { savedExactKeys } from "./jira-saved-configuration-values.js";
import {
  copyJiraSessionBinding,
  jiraPrivateCookie,
  jiraPrivateSessionReference,
  type JiraPrivateSessionBinding,
  type JiraPrivateCookie,
} from "./jira-private-session-values.js";
import type { JiraAvatarTemporarySnapshot } from "./jira-avatar-mutation-values.js";
import { parseJiraAvatarTemporarySnapshot } from "./jira-avatar-mutation-input.js";
import { withJiraPrivateRecordCapacity } from "./jira-private-vault-retention.js";

export type JiraPrivateSessionRefusal =
  "invalid-input" | "binding-changed" | "unavailable" | "busy" | "expired";
export class JiraPrivateSessionError extends Error {
  constructor(readonly code: JiraPrivateSessionRefusal) {
    super(`Jira private session ${code}`);
    this.name = "JiraPrivateSessionError";
  }
}
/** Execution resolver only; all material stays in a single exclusive HTTP composition callback. */
export interface JiraPrivateSessionAccess {
  readonly current: () => { readonly revision: string; readonly expiresAt: number } | undefined;
  readonly cookieHeader: () => string;
  /** Called only after the composing HTTP owner independently proves the candidate actor/session. */
  readonly establish: (cookie: JiraPrivateCookie) => {
    readonly revision: string;
    readonly expiresAt: number;
  };
  readonly invalidate: () => void;
  readonly temporary: () => JiraAvatarTemporarySnapshot | undefined;
  readonly rememberTemporary: (snapshot: JiraAvatarTemporarySnapshot | undefined) => void;
}
export interface JiraPrivateSessionExecutionResolver {
  readonly withLease: <T>(
    binding: JiraPrivateSessionBinding,
    execute: (session: JiraPrivateSessionAccess) => Promise<T>,
  ) => Promise<T>;
  /** Delete-only end of the owning turn/run; permits cleanup after expiry/revocation. */
  readonly finish: (
    binding: JiraPrivateSessionBinding,
    revision: string,
    logout: (cookie: () => string) => Promise<void>,
  ) => Promise<void>;
}
async function finishSession(
  deps: Dependencies,
  candidate: JiraPrivateSessionBinding,
  revision: string,
  logout: (cookie: () => string) => Promise<void>,
): Promise<void> {
  const binding = copyJiraSessionBinding(candidate);
  if (binding === undefined || !UUID.test(revision)) return fail("invalid-input");
  const reference = jiraPrivateSessionReference(binding);
  const release = deps.vault.acquireLease?.(reference);
  if (release === undefined) return fail("busy");
  try {
    const serialized = deps.vault.get(reference);
    if (serialized === undefined) return;
    const record = parsed(serialized);
    // A stable session reference intentionally spans calls. It is not sufficient ownership
    // for cleanup: an old turn must never log out a newly established replacement cookie.
    if (
      record === undefined ||
      record.leaseId !== undefined ||
      record.revision !== revision ||
      JSON.stringify(record.binding) !== JSON.stringify(binding)
    )
      return;
    try {
      if (record.cookie !== undefined) {
        const cookie = record.cookie;
        await logout(() => `${cookie.name}=${cookie.value}`);
      }
    } finally {
      if (!deps.vault.compareAndSet?.(reference, serialized, undefined))
        return fail("binding-changed");
    }
  } finally {
    release();
  }
}
interface RecordValue {
  readonly schemaVersion: 1;
  readonly kind: "jira-private-session";
  readonly binding: JiraPrivateSessionBinding;
  readonly revision: string;
  readonly leaseId?: string;
  readonly cookie?: JiraPrivateCookie;
  readonly temporary?: JiraAvatarTemporarySnapshot;
}
interface Dependencies {
  readonly vault: AtlassianCredentialVaultPort;
  readonly metadata: (authRef: string) => AtlassianCredentialMetadata | undefined;
  readonly now?: () => number;
}
const KEYS = new Set([
  "schemaVersion",
  "kind",
  "binding",
  "revision",
  "leaseId",
  "cookie",
  "temporary",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function fail(code: JiraPrivateSessionRefusal): never {
  throw new JiraPrivateSessionError(code);
}
function selected(deps: Dependencies, raw: JiraPrivateSessionBinding): JiraPrivateSessionBinding {
  const binding = copyJiraSessionBinding(raw);
  if (binding === undefined) return fail("invalid-input");
  const metadata = deps.metadata(binding.authRef);
  if (
    metadata?.deployment !== "data-center" ||
    metadata.generation !== binding.authenticationGeneration ||
    metadata.livePod?.verificationRevision !== binding.verificationRevision ||
    metadata.livePod.ownerDigest !== binding.principalDigest ||
    metadata.livePod.verificationStatus !== "ok" ||
    metadata.livePod.verificationInProgress ||
    metadata.livePod.credentialOperation !== undefined
  )
    return fail("binding-changed");
  if (binding.context.kind === "chat" && metadata.livePod.podId !== binding.context.podId)
    return fail("binding-changed");
  if (binding.expiresAt <= (deps.now ?? Date.now)()) return fail("expired");
  return binding;
}
function parsed(serialized: string): RecordValue | undefined {
  if (Buffer.byteLength(serialized, "utf8") > 32768) return undefined;
  const raw = parseJsonRecord(serialized);
  const binding = copyJiraSessionBinding(raw?.binding);
  if (
    raw === undefined ||
    binding === undefined ||
    !savedExactKeys(raw, KEYS) ||
    raw.schemaVersion !== 1 ||
    raw.kind !== "jira-private-session" ||
    typeof raw.revision !== "string" ||
    !UUID.test(raw.revision) ||
    (raw.leaseId !== undefined && (typeof raw.leaseId !== "string" || !UUID.test(raw.leaseId)))
  )
    return undefined;
  const cookie = raw.cookie === undefined ? undefined : jiraPrivateCookie(raw.cookie);
  const temporary =
    raw.temporary === undefined ? undefined : parseJiraAvatarTemporarySnapshot(raw.temporary);
  if (
    (raw.cookie !== undefined && cookie === undefined) ||
    (raw.temporary !== undefined && temporary === undefined) ||
    (temporary !== undefined &&
      (cookie === undefined || temporary.actorKey !== binding.actorUserKey))
  )
    return undefined;
  return {
    schemaVersion: 1,
    kind: "jira-private-session",
    binding,
    revision: raw.revision,
    ...(typeof raw.leaseId === "string" ? { leaseId: raw.leaseId } : {}),
    ...(cookie === undefined ? {} : { cookie }),
    ...(temporary === undefined ? {} : { temporary }),
  };
}
function empty(binding: JiraPrivateSessionBinding, leaseId?: string): RecordValue {
  return {
    schemaVersion: 1,
    kind: "jira-private-session",
    binding,
    revision: randomUUID(),
    ...(leaseId === undefined ? {} : { leaseId }),
  };
}
function access(
  deps: Dependencies,
  binding: JiraPrivateSessionBinding,
  leaseId: string,
): JiraPrivateSessionAccess & { readonly finish: () => void } {
  const reference = jiraPrivateSessionReference(binding);
  const compare = deps.vault.compareAndSet;
  if (compare === undefined) return fail("unavailable");
  let serialized = deps.vault.get(reference);
  let record = serialized === undefined ? empty(binding) : parsed(serialized);
  if (record === undefined || jiraPrivateSessionReference(record.binding) !== reference)
    return fail("binding-changed");
  // A kernel lease cannot outlive its process. A retained in-progress marker is an interrupted
  // private session operation, not permission to replay it or trust its old temporary image.
  if (record.leaseId !== undefined || record.binding.expiresAt <= (deps.now ?? Date.now)())
    record = empty(binding);
  let active = true;
  function save(next: RecordValue): void {
    const nextText = JSON.stringify(next);
    if (!compare?.(reference, serialized, nextText)) return fail("binding-changed");
    serialized = nextText;
    record = next;
  }
  save({ ...record, leaseId });
  function current(requireCookie = true): RecordValue {
    if (!active) return fail("binding-changed");
    selected(deps, binding);
    const value = serialized === undefined ? undefined : parsed(serialized);
    if (
      value === undefined ||
      value.leaseId !== leaseId ||
      deps.vault.get(reference) !== serialized
    )
      return fail("binding-changed");
    if (value.binding.expiresAt <= (deps.now ?? Date.now)()) {
      save(empty(binding, leaseId));
      return fail("expired");
    }
    if (requireCookie && value.cookie === undefined) return fail("unavailable");
    return value;
  }
  return {
    current: () => {
      const value = current(false);
      return value.cookie === undefined
        ? undefined
        : { revision: value.revision, expiresAt: value.binding.expiresAt };
    },
    cookieHeader: () => {
      const cookie = current().cookie;
      return cookie === undefined ? fail("unavailable") : `${cookie.name}=${cookie.value}`;
    },
    establish: (candidate) => {
      current(false);
      const cookie = jiraPrivateCookie(candidate);
      if (cookie === undefined) return fail("invalid-input");
      const next = { ...empty(binding, leaseId), cookie };
      save(next);
      return { revision: next.revision, expiresAt: next.binding.expiresAt };
    },
    invalidate: () => {
      // Revocation/expiry may prohibit execution, never erasure of this still-owned secret.
      if (!active || deps.vault.get(reference) !== serialized) return fail("binding-changed");
      save(empty(binding, leaseId));
    },
    temporary: () => {
      const value = current().temporary;
      return value === undefined ? undefined : parseJiraAvatarTemporarySnapshot(value);
    },
    rememberTemporary: (candidate) => {
      const value = current();
      const snapshot =
        candidate === undefined ? undefined : parseJiraAvatarTemporarySnapshot(candidate);
      if (
        candidate !== undefined &&
        (snapshot === undefined || snapshot.actorKey !== binding.actorUserKey)
      )
        return fail("invalid-input");
      const { temporary: _previous, ...retained } = value;
      save({ ...retained, ...(snapshot === undefined ? {} : { temporary: snapshot }) });
    },
    finish: () => {
      if (!active) return;
      active = false;
      // Do not overwrite another record on a failed callback. The marker survives ambiguity.
      const value = serialized === undefined ? undefined : parsed(serialized);
      if (
        value === undefined ||
        value.leaseId !== leaseId ||
        deps.vault.get(reference) !== serialized
      )
        return;
      const { leaseId: _lease, ...retained } = value;
      save(retained);
    },
  };
}
export function createJiraPrivateSessionCustody(
  deps: Dependencies,
): JiraPrivateSessionExecutionResolver {
  return {
    finish: (binding, revision, logout) => finishSession(deps, binding, revision, logout),
    withLease: async (candidate, execute) => {
      const binding = selected(deps, candidate);
      const acquire = deps.vault.acquireLease;
      if (acquire === undefined || deps.vault.compareAndSet === undefined)
        return fail("unavailable");
      const reference = jiraPrivateSessionReference(binding);
      withJiraPrivateRecordCapacity(
        {
          vault: deps.vault,
          kind: "session",
          reference,
          now: (deps.now ?? Date.now)(),
          identity: (serialized) => {
            const record = parsed(serialized);
            return record === undefined
              ? undefined
              : {
                  reference: jiraPrivateSessionReference(record.binding),
                  expiresAt: record.binding.expiresAt,
                };
          },
        },
        () => {
          if (
            deps.vault.get(reference) === undefined &&
            !deps.vault.compareAndSet?.(reference, undefined, JSON.stringify(empty(binding)))
          )
            return fail("busy");
        },
      );
      const release = acquire(jiraPrivateSessionReference(binding));
      if (release === undefined) return fail("busy");
      try {
        const session = access(deps, binding, randomUUID());
        try {
          return await execute(session);
        } finally {
          session.finish();
        }
      } finally {
        release();
      }
    },
  };
}
