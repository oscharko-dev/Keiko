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
    const record = finishRecord(serialized, binding, revision);
    // A stable session reference intentionally spans calls. It is not sufficient ownership
    // for cleanup: an old turn must never log out a newly established replacement cookie.
    if (record === undefined) return;
    try {
      if (record.cookie !== undefined) {
        const cookie = record.cookie;
        await logout(() => `${cookie.name}=${cookie.value}`);
      }
    } finally {
      if (!deps.vault.compareAndSet?.(reference, serialized, undefined)) fail("binding-changed");
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
function finishRecord(
  serialized: string,
  binding: JiraPrivateSessionBinding,
  revision: string,
): RecordValue | undefined {
  const record = parsed(serialized);
  return record !== undefined &&
    record.leaseId === undefined &&
    record.revision === revision &&
    JSON.stringify(record.binding) === JSON.stringify(binding)
    ? record
    : undefined;
}
type LivePod = NonNullable<
  Extract<AtlassianCredentialMetadata, { deployment: "data-center" }>["livePod"]
>;
function selectedPod(deps: Dependencies, binding: JiraPrivateSessionBinding): LivePod {
  const metadata = deps.metadata(binding.authRef);
  if (
    metadata?.deployment !== "data-center" ||
    metadata.generation !== binding.authenticationGeneration
  )
    return fail("binding-changed");
  const pod = metadata.livePod;
  if (
    pod?.verificationRevision !== binding.verificationRevision ||
    pod.ownerDigest !== binding.principalDigest ||
    pod.verificationStatus !== "ok" ||
    pod.verificationInProgress ||
    pod.credentialOperation !== undefined
  )
    return fail("binding-changed");
  return pod;
}
function selected(deps: Dependencies, raw: JiraPrivateSessionBinding): JiraPrivateSessionBinding {
  const binding = copyJiraSessionBinding(raw);
  if (binding === undefined) return fail("invalid-input");
  const pod = selectedPod(deps, binding);
  if (binding.context.kind === "chat" && pod.podId !== binding.context.podId)
    return fail("binding-changed");
  if (binding.expiresAt <= (deps.now ?? Date.now)()) return fail("expired");
  return binding;
}
function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
function recordHeader(
  raw: Readonly<Record<string, unknown>>,
  binding: JiraPrivateSessionBinding,
): RecordValue | undefined {
  if (
    !savedExactKeys(raw, KEYS) ||
    raw.schemaVersion !== 1 ||
    raw.kind !== "jira-private-session" ||
    !uuid(raw.revision) ||
    (raw.leaseId !== undefined && !uuid(raw.leaseId))
  )
    return undefined;
  return {
    schemaVersion: 1,
    kind: "jira-private-session",
    binding,
    revision: raw.revision,
    ...(typeof raw.leaseId === "string" ? { leaseId: raw.leaseId } : {}),
  };
}
function validContents(
  raw: Readonly<Record<string, unknown>>,
  binding: JiraPrivateSessionBinding,
  cookie: JiraPrivateCookie | undefined,
  temporary: JiraAvatarTemporarySnapshot | undefined,
): boolean {
  return !(
    (raw.cookie !== undefined && cookie === undefined) ||
    (raw.temporary !== undefined && temporary === undefined) ||
    (temporary !== undefined &&
      (cookie === undefined || temporary.actorKey !== binding.actorUserKey))
  );
}
function recordContents(
  raw: Readonly<Record<string, unknown>>,
  binding: JiraPrivateSessionBinding,
): Pick<RecordValue, "cookie" | "temporary"> | undefined {
  const cookie = raw.cookie === undefined ? undefined : jiraPrivateCookie(raw.cookie);
  const temporary =
    raw.temporary === undefined ? undefined : parseJiraAvatarTemporarySnapshot(raw.temporary);
  if (!validContents(raw, binding, cookie, temporary)) return undefined;
  return {
    ...(cookie === undefined ? {} : { cookie }),
    ...(temporary === undefined ? {} : { temporary }),
  };
}
function parsed(serialized: string): RecordValue | undefined {
  if (Buffer.byteLength(serialized, "utf8") > 32768) return undefined;
  const raw = parseJsonRecord(serialized);
  const binding = copyJiraSessionBinding(raw?.binding);
  if (raw === undefined || binding === undefined) return undefined;
  const header = recordHeader(raw, binding);
  if (header === undefined) return undefined;
  const contents = recordContents(raw, binding);
  return contents === undefined ? undefined : { ...header, ...contents };
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
class PrivateSessionAccess {
  private readonly reference: string;
  private readonly compare: NonNullable<AtlassianCredentialVaultPort["compareAndSet"]>;
  private serialized: string | undefined;
  private active = true;
  constructor(
    private readonly deps: Dependencies,
    private readonly binding: JiraPrivateSessionBinding,
    private readonly leaseId: string,
  ) {
    this.reference = jiraPrivateSessionReference(binding);
    const compare = deps.vault.compareAndSet;
    if (compare === undefined) fail("unavailable");
    this.compare = compare;
    this.serialized = deps.vault.get(this.reference);
    let record = this.serialized === undefined ? empty(binding) : parsed(this.serialized);
    if (record === undefined || jiraPrivateSessionReference(record.binding) !== this.reference)
      return fail("binding-changed");
    // An interrupted kernel lease is not permission to replay its session operation.
    if (record.leaseId !== undefined || record.binding.expiresAt <= (deps.now ?? Date.now)())
      record = empty(binding);
    this.save({ ...record, leaseId });
  }
  private save(next: RecordValue): void {
    const nextText = JSON.stringify(next);
    const compare = this.compare;
    if (!compare(this.reference, this.serialized, nextText)) return fail("binding-changed");
    this.serialized = nextText;
  }
  private retained(): RecordValue | undefined {
    const value = this.serialized === undefined ? undefined : parsed(this.serialized);
    return value?.leaseId === this.leaseId &&
      this.deps.vault.get(this.reference) === this.serialized
      ? value
      : undefined;
  }
  private currentRecord(requireCookie = true): RecordValue {
    if (!this.active) return fail("binding-changed");
    selected(this.deps, this.binding);
    const value = this.retained();
    if (value === undefined) return fail("binding-changed");
    if (value.binding.expiresAt <= (this.deps.now ?? Date.now)()) {
      this.save(empty(this.binding, this.leaseId));
      return fail("expired");
    }
    if (requireCookie && value.cookie === undefined) return fail("unavailable");
    return value;
  }
  private current(): ReturnType<JiraPrivateSessionAccess["current"]> {
    const value = this.currentRecord(false);
    return value.cookie === undefined
      ? undefined
      : { revision: value.revision, expiresAt: value.binding.expiresAt };
  }
  private cookieHeader(): string {
    const cookie = this.currentRecord().cookie;
    return cookie === undefined ? fail("unavailable") : `${cookie.name}=${cookie.value}`;
  }
  private establish(
    candidate: JiraPrivateCookie,
  ): ReturnType<JiraPrivateSessionAccess["establish"]> {
    this.currentRecord(false);
    const cookie = jiraPrivateCookie(candidate);
    if (cookie === undefined) return fail("invalid-input");
    const next = { ...empty(this.binding, this.leaseId), cookie };
    this.save(next);
    return { revision: next.revision, expiresAt: next.binding.expiresAt };
  }
  private invalidate(): void {
    // Revocation/expiry may prohibit execution, never erasure of this still-owned secret.
    if (!this.active || this.deps.vault.get(this.reference) !== this.serialized)
      return fail("binding-changed");
    this.save(empty(this.binding, this.leaseId));
  }
  private temporary(): JiraAvatarTemporarySnapshot | undefined {
    const value = this.currentRecord().temporary;
    return value === undefined ? undefined : parseJiraAvatarTemporarySnapshot(value);
  }
  private rememberTemporary(candidate: JiraAvatarTemporarySnapshot | undefined): void {
    const value = this.currentRecord();
    const snapshot =
      candidate === undefined ? undefined : parseJiraAvatarTemporarySnapshot(candidate);
    if (candidate !== undefined && snapshot?.actorKey !== this.binding.actorUserKey)
      return fail("invalid-input");
    const { temporary: _previous, ...retained } = value;
    this.save({ ...retained, ...(snapshot === undefined ? {} : { temporary: snapshot }) });
  }
  private finish(): void {
    if (!this.active) return;
    this.active = false;
    // Do not overwrite another record on a failed callback. The marker survives ambiguity.
    const value = this.retained();
    if (value === undefined) return;
    const { leaseId: _lease, ...retained } = value;
    this.save(retained);
  }
  ports(): JiraPrivateSessionAccess & { readonly finish: () => void } {
    // Return only the existing closures, never the owner carrying serialized private state.
    return {
      current: () => this.current(),
      cookieHeader: () => this.cookieHeader(),
      establish: (candidate) => this.establish(candidate),
      invalidate: (): void => {
        this.invalidate();
      },
      temporary: () => this.temporary(),
      rememberTemporary: (candidate): void => {
        this.rememberTemporary(candidate);
      },
      finish: (): void => {
        this.finish();
      },
    };
  }
}
function reserveSession(deps: Dependencies, binding: JiraPrivateSessionBinding): void {
  const reference = jiraPrivateSessionReference(binding);
  withJiraPrivateRecordCapacity(
    {
      vault: deps.vault,
      kind: "session",
      reference,
      now: (deps.now ?? Date.now)(),
      identity: (
        serialized,
      ): { readonly reference: string; readonly expiresAt: number } | undefined => {
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
}
async function withSessionLease<T>(
  deps: Dependencies,
  candidate: JiraPrivateSessionBinding,
  execute: (session: JiraPrivateSessionAccess) => Promise<T>,
): Promise<T> {
  const binding = selected(deps, candidate);
  const acquire = deps.vault.acquireLease;
  if (acquire === undefined || deps.vault.compareAndSet === undefined) return fail("unavailable");
  reserveSession(deps, binding);
  const release = acquire(jiraPrivateSessionReference(binding));
  if (release === undefined) return fail("busy");
  try {
    const session = new PrivateSessionAccess(deps, binding, randomUUID()).ports();
    try {
      return await execute(session);
    } finally {
      session.finish();
    }
  } finally {
    release();
  }
}
export function createJiraPrivateSessionCustody(
  deps: Dependencies,
): JiraPrivateSessionExecutionResolver {
  return {
    finish: (binding, revision, logout) => finishSession(deps, binding, revision, logout),
    withLease: (candidate, execute) => withSessionLease(deps, candidate, execute),
  };
}
