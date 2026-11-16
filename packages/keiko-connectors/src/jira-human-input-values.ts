import { createHash } from "node:crypto";
import { isChatJiraPodId } from "@oscharko-dev/keiko-contracts/bff-wire";
import { isActivityLogCorrelationId } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { isAtlassianConnectorAuthRef } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  JIRA_HUMAN_INPUT_MAX_BYTES,
  JIRA_HUMAN_INPUT_MAX_LIFETIME_MS,
  JIRA_HUMAN_INPUT_PURPOSES,
  JIRA_HUMAN_INPUT_FIELD_SETS,
  copyJiraHumanInputReview,
  type JiraHumanInputReview,
  type JiraHumanInputField,
  type JiraHumanInputPurpose,
  type JiraHumanInputState,
  type JiraHumanInputView,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { savedExactKeys, savedName, savedText } from "./jira-saved-configuration-values.js";
import { asRecord, parseJsonRecord } from "./atlassian-sync-classify.js";

export type JiraHumanInputContext =
  | {
      readonly kind: "chat";
      readonly chatId: string;
      readonly messageId: string;
      readonly callId: string;
      readonly podId: string;
      readonly bindingGeneration: number;
    }
  | {
      readonly kind: "coding";
      readonly taskId: string;
      readonly runId: string;
      readonly callId: string;
    };
/** Constructed from the current server-owned invocation, never submitted by the model/human. */
export interface JiraHumanInputBinding {
  readonly context: JiraHumanInputContext;
  readonly authority: { readonly runId: string; readonly envelopeDigest: string };
  readonly principalDigest: string;
  readonly authRef: string;
  readonly authenticationGeneration: number;
  readonly verificationRevision: number;
  readonly operation: `jira.${JiraHumanInputPurpose}`;
  readonly argumentsDigest: string;
  readonly actorUserKey: string;
  readonly actorUsername: string;
  readonly review?: JiraHumanInputReview;
  readonly expiresAt: number;
  /** Original invocation identity; absent on retained legacy records. Never an authority ID. */
  readonly operationCorrelationId?: string;
}
export type JiraHumanInputValues = Readonly<Partial<Record<JiraHumanInputField, string>>>;
export interface JiraHumanInputRecord {
  readonly schemaVersion: 1;
  readonly kind: "jira-operation-input";
  readonly binding: JiraHumanInputBinding;
  readonly requestId: string;
  readonly revision: string;
  readonly state: JiraHumanInputState;
  readonly values?: JiraHumanInputValues;
}
export function humanInputPurpose(operation: string): JiraHumanInputPurpose | undefined {
  const purpose = operation.startsWith("jira.") ? operation.slice(5) : "";
  return JIRA_HUMAN_INPUT_PURPOSES.find((value) => value === purpose);
}
const DIGEST = /^[a-f0-9]{64}$/u;
const REVISION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BINDING_KEYS = new Set([
  "context",
  "authority",
  "principalDigest",
  "authRef",
  "authenticationGeneration",
  "verificationRevision",
  "operation",
  "argumentsDigest",
  "actorUserKey",
  "actorUsername",
  "expiresAt",
  "review",
  "operationCorrelationId",
]);
const CHAT_KEYS = new Set(["kind", "chatId", "messageId", "callId", "podId", "bindingGeneration"]);
const CODING_KEYS = new Set(["kind", "taskId", "runId", "callId"]);
const RECORD_KEYS = new Set([
  "schemaVersion",
  "kind",
  "binding",
  "requestId",
  "revision",
  "state",
  "values",
]);
function context(value: unknown): JiraHumanInputContext | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !savedName(raw.callId)) return undefined;
  if (raw.kind === "chat") return chatContext(raw, raw.callId);
  if (raw.kind === "coding") return codingContext(raw, raw.callId);
  return undefined;
}
function chatContext(
  raw: Readonly<Record<string, unknown>>,
  callId: string,
): JiraHumanInputContext | undefined {
  if (
    savedExactKeys(raw, CHAT_KEYS) &&
    savedName(raw.chatId) &&
    savedName(raw.messageId) &&
    isChatJiraPodId(raw.podId) &&
    generation(raw.bindingGeneration)
  )
    return {
      kind: "chat",
      chatId: raw.chatId,
      messageId: raw.messageId,
      callId,
      podId: raw.podId,
      bindingGeneration: raw.bindingGeneration,
    };
  return undefined;
}
function codingContext(
  raw: Readonly<Record<string, unknown>>,
  callId: string,
): JiraHumanInputContext | undefined {
  return savedExactKeys(raw, CODING_KEYS) && savedName(raw.taskId) && savedName(raw.runId)
    ? { kind: "coding", taskId: raw.taskId, runId: raw.runId, callId }
    : undefined;
}
function generation(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}
export function copyJiraInputAuthority(
  value: unknown,
): JiraHumanInputBinding["authority"] | undefined {
  const raw = asRecord(value);
  return raw !== undefined &&
    savedExactKeys(raw, new Set(["runId", "envelopeDigest"])) &&
    savedName(raw.runId) &&
    typeof raw.envelopeDigest === "string" &&
    DIGEST.test(raw.envelopeDigest)
    ? Object.freeze({ runId: raw.runId, envelopeDigest: raw.envelopeDigest })
    : undefined;
}
function digestValue(value: unknown): value is string {
  return typeof value === "string" && DIGEST.test(value);
}
type CredentialBindingFields = Pick<
  JiraHumanInputBinding,
  | "authRef"
  | "principalDigest"
  | "argumentsDigest"
  | "authenticationGeneration"
  | "verificationRevision"
>;
function credentialBindingFields(
  raw: Readonly<Record<string, unknown>>,
): CredentialBindingFields | undefined {
  if (
    !isAtlassianConnectorAuthRef(raw.authRef) ||
    !digestValue(raw.principalDigest) ||
    !digestValue(raw.argumentsDigest) ||
    !generation(raw.authenticationGeneration) ||
    !generation(raw.verificationRevision)
  )
    return undefined;
  return {
    authRef: raw.authRef,
    principalDigest: raw.principalDigest,
    argumentsDigest: raw.argumentsDigest,
    authenticationGeneration: raw.authenticationGeneration,
    verificationRevision: raw.verificationRevision,
  };
}
type ActorBindingFields = Pick<
  JiraHumanInputBinding,
  "actorUserKey" | "actorUsername" | "expiresAt"
>;
function actorBindingFields(
  raw: Readonly<Record<string, unknown>>,
): ActorBindingFields | undefined {
  if (
    !savedName(raw.actorUserKey) ||
    !savedName(raw.actorUsername) ||
    typeof raw.expiresAt !== "number" ||
    !Number.isSafeInteger(raw.expiresAt) ||
    raw.expiresAt <= 0
  )
    return undefined;
  return {
    actorUserKey: raw.actorUserKey,
    actorUsername: raw.actorUsername,
    expiresAt: raw.expiresAt,
  };
}
function requiredBinding(
  raw: Readonly<Record<string, unknown>>,
): JiraHumanInputBinding | undefined {
  const selected = context(raw.context);
  const authority = copyJiraInputAuthority(raw.authority);
  const purpose = typeof raw.operation === "string" ? humanInputPurpose(raw.operation) : undefined;
  const credentials = credentialBindingFields(raw);
  const actor = actorBindingFields(raw);
  if (
    selected === undefined ||
    authority === undefined ||
    purpose === undefined ||
    credentials === undefined ||
    actor === undefined
  )
    return undefined;
  return {
    context: Object.freeze(selected),
    authority,
    principalDigest: credentials.principalDigest,
    authRef: credentials.authRef,
    authenticationGeneration: credentials.authenticationGeneration,
    verificationRevision: credentials.verificationRevision,
    operation: `jira.${purpose}`,
    argumentsDigest: credentials.argumentsDigest,
    actorUserKey: actor.actorUserKey,
    actorUsername: actor.actorUsername,
    expiresAt: actor.expiresAt,
  };
}
function bindingReview(
  raw: Readonly<Record<string, unknown>>,
  binding: JiraHumanInputBinding,
): Pick<JiraHumanInputBinding, "review"> | undefined {
  if (!Object.hasOwn(raw, "review")) return {};
  const purpose = humanInputPurpose(binding.operation);
  if (purpose === undefined) return undefined;
  const review = copyJiraHumanInputReview(raw.review, purpose);
  return review?.actorUserKey === binding.actorUserKey &&
    review.actorUsername === binding.actorUsername
    ? { review }
    : undefined;
}
function bindingCorrelation(
  raw: Readonly<Record<string, unknown>>,
): Pick<JiraHumanInputBinding, "operationCorrelationId"> | undefined {
  const operationCorrelationId = raw.operationCorrelationId;
  if (operationCorrelationId === undefined)
    return Object.hasOwn(raw, "operationCorrelationId") ? undefined : {};
  return isActivityLogCorrelationId(operationCorrelationId)
    ? { operationCorrelationId }
    : undefined;
}
export function copyHumanInputBinding(value: unknown): JiraHumanInputBinding | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !savedExactKeys(raw, BINDING_KEYS)) return undefined;
  const binding = requiredBinding(raw);
  if (binding === undefined) return undefined;
  const review = bindingReview(raw, binding);
  const correlation = bindingCorrelation(raw);
  if (review === undefined || correlation === undefined) return undefined;
  return Object.freeze({ ...binding, ...review, ...correlation });
}
export function currentHumanInputLifetime(binding: JiraHumanInputBinding, now: number): boolean {
  return (
    Number.isSafeInteger(now) &&
    now >= 0 &&
    binding.expiresAt > now &&
    binding.expiresAt - now <= JIRA_HUMAN_INPUT_MAX_LIFETIME_MS
  );
}
export function humanInputRequestId(binding: JiraHumanInputBinding): string {
  // copyHumanInputBinding fixes property order, so no serialization of untrusted descriptors/getters occurs here.
  return `jhi_${createHash("sha256").update(JSON.stringify(binding)).digest("hex")}`;
}
export function humanInputReference(requestId: string): string | undefined {
  return /^jhi_[a-f0-9]{64}$/u.test(requestId) ? `jira-input:${requestId}` : undefined;
}
export function humanInputView(
  record: JiraHumanInputRecord,
  state = record.state,
): JiraHumanInputView {
  const purpose = humanInputPurpose(record.binding.operation);
  if (purpose === undefined) throw new TypeError("Unsupported Jira private input purpose");
  const fields = JIRA_HUMAN_INPUT_FIELD_SETS[purpose];
  return Object.freeze({
    requestId: record.requestId,
    revision: record.revision,
    purpose,
    state,
    expiresAt: record.binding.expiresAt,
    fields: Object.freeze([...fields.required]),
    optionalFields: Object.freeze([...fields.optional]),
    ...(record.binding.review === undefined ? {} : { review: record.binding.review }),
  });
}
export function parseHumanInputValues(
  operation: string,
  value: unknown,
): JiraHumanInputValues | undefined {
  const purpose = humanInputPurpose(operation);
  const raw = asRecord(value);
  if (purpose === undefined || raw === undefined) return undefined;
  const fields = JIRA_HUMAN_INPUT_FIELD_SETS[purpose];
  const allowed = new Set([...fields.required, ...fields.optional]);
  if (!savedExactKeys(raw, allowed) || fields.required.some((field) => !Object.hasOwn(raw, field)))
    return undefined;
  return inputValues(raw, allowed);
}
function validInputField(field: JiraHumanInputField, value: unknown): value is string {
  // JSON body material only; preserve well-formed passwords verbatim including spaces/control characters.
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= (field === "license" ? 32768 : 4096) &&
    !/\p{Surrogate}/u.test(value) &&
    (field !== "ownerShutdownConfirmation" || value === "confirmed")
  );
}
function inputValues(
  raw: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<JiraHumanInputField>,
): JiraHumanInputValues | undefined {
  const result: Partial<Record<JiraHumanInputField, string>> = {};
  for (const field of allowed) {
    const selected = raw[field];
    if (selected === undefined && !Object.hasOwn(raw, field)) continue;
    if (!validInputField(field, selected)) return undefined;
    result[field] = selected;
  }
  return new TextEncoder().encode(JSON.stringify(result)).byteLength <= JIRA_HUMAN_INPUT_MAX_BYTES
    ? Object.freeze(result)
    : undefined;
}
function inputState(value: unknown): value is JiraHumanInputState {
  return (
    value === "awaiting-input" ||
    value === "ready" ||
    value === "consumed" ||
    value === "cancelled" ||
    value === "expired"
  );
}
function revisionValue(value: unknown): value is string {
  return typeof value === "string" && REVISION.test(value);
}
function recordIdentity(
  raw: Readonly<Record<string, unknown>>,
  binding: JiraHumanInputBinding,
): Pick<JiraHumanInputRecord, "requestId" | "revision" | "state"> | undefined {
  const requestId = humanInputRequestId(binding);
  if (
    !savedExactKeys(raw, RECORD_KEYS) ||
    raw.kind !== "jira-operation-input" ||
    raw.schemaVersion !== 1 ||
    raw.requestId !== requestId ||
    !revisionValue(raw.revision) ||
    !savedText(raw.state, 32) ||
    !inputState(raw.state)
  )
    return undefined;
  return { requestId, revision: raw.revision, state: raw.state };
}
function inputRecord(raw: Readonly<Record<string, unknown>>): JiraHumanInputRecord | undefined {
  const binding = copyHumanInputBinding(raw.binding);
  if (binding === undefined) return undefined;
  const identity = recordIdentity(raw, binding);
  if (identity === undefined) return undefined;
  const { state } = identity;
  const values =
    raw.values === undefined ? undefined : parseHumanInputValues(binding.operation, raw.values);
  if (
    (state === "ready") !== (values !== undefined) ||
    (state !== "ready" && Object.hasOwn(raw, "values"))
  )
    return undefined;
  return {
    schemaVersion: 1,
    kind: "jira-operation-input",
    binding,
    requestId: identity.requestId,
    revision: identity.revision,
    state,
    ...(values === undefined ? {} : { values }),
  };
}
export function parseHumanInputRecord(serialized: string): JiraHumanInputRecord | undefined {
  if (new TextEncoder().encode(serialized).byteLength > JIRA_HUMAN_INPUT_MAX_BYTES + 8192)
    return undefined;
  const raw = parseJsonRecord(serialized);
  return raw === undefined ? undefined : inputRecord(raw);
}
