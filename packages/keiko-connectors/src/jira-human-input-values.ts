import { createHash } from "node:crypto";
import { isChatJiraPodId } from "@oscharko-dev/keiko-contracts/bff-wire";
import { isAtlassianConnectorAuthRef } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  JIRA_HUMAN_INPUT_MAX_BYTES, JIRA_HUMAN_INPUT_MAX_LIFETIME_MS, JIRA_HUMAN_INPUT_PURPOSES, JIRA_HUMAN_INPUT_FIELD_SETS,
  copyJiraHumanInputReview, type JiraHumanInputReview,
  type JiraHumanInputField, type JiraHumanInputPurpose, type JiraHumanInputState, type JiraHumanInputView,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { savedExactKeys, savedName, savedText } from "./jira-saved-configuration-values.js";
import { asRecord } from "./atlassian-sync-classify.js";

export type JiraHumanInputContext =
  | { readonly kind: "chat"; readonly chatId: string; readonly messageId: string; readonly callId: string; readonly podId: string; readonly bindingGeneration: number }
  | { readonly kind: "coding"; readonly taskId: string; readonly runId: string; readonly callId: string };
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
const BINDING_KEYS = new Set(["context", "authority", "principalDigest", "authRef", "authenticationGeneration", "verificationRevision", "operation", "argumentsDigest", "actorUserKey", "actorUsername", "expiresAt", "review"]);
const CHAT_KEYS = new Set(["kind", "chatId", "messageId", "callId", "podId", "bindingGeneration"]);
const CODING_KEYS = new Set(["kind", "taskId", "runId", "callId"]);
const RECORD_KEYS = new Set(["schemaVersion", "kind", "binding", "requestId", "revision", "state", "values"]);
function context(value: unknown): JiraHumanInputContext | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !savedName(raw.callId)) return undefined;
  if (raw.kind === "chat" && savedExactKeys(raw, CHAT_KEYS) && savedName(raw.chatId) && savedName(raw.messageId) && isChatJiraPodId(raw.podId) && generation(raw.bindingGeneration))
    return { kind: "chat", chatId: raw.chatId, messageId: raw.messageId, callId: raw.callId, podId: raw.podId, bindingGeneration: raw.bindingGeneration };
  if (raw.kind === "coding" && savedExactKeys(raw, CODING_KEYS) && savedName(raw.taskId) && savedName(raw.runId))
    return { kind: "coding", taskId: raw.taskId, runId: raw.runId, callId: raw.callId };
  return undefined;
}
function generation(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 1; }
export function copyJiraInputAuthority(value: unknown): JiraHumanInputBinding["authority"] | undefined {
  const raw = asRecord(value);
  return raw !== undefined && savedExactKeys(raw, new Set(["runId", "envelopeDigest"])) && savedName(raw.runId) &&
    typeof raw.envelopeDigest === "string" && DIGEST.test(raw.envelopeDigest)
    ? Object.freeze({ runId: raw.runId, envelopeDigest: raw.envelopeDigest }) : undefined;
}
export function copyHumanInputBinding(value: unknown): JiraHumanInputBinding | undefined {
  const raw = asRecord(value); if (raw === undefined || !savedExactKeys(raw, BINDING_KEYS)) return undefined;
  const selected = context(raw.context);
  const authority = copyJiraInputAuthority(raw.authority);
  const purpose = typeof raw.operation === "string" ? humanInputPurpose(raw.operation) : undefined;
  if (selected === undefined || authority === undefined || purpose === undefined || !isAtlassianConnectorAuthRef(raw.authRef) ||
      typeof raw.principalDigest !== "string" || !DIGEST.test(raw.principalDigest) || typeof raw.argumentsDigest !== "string" || !DIGEST.test(raw.argumentsDigest) ||
      !generation(raw.authenticationGeneration) || !generation(raw.verificationRevision) || !savedName(raw.actorUserKey) || !savedName(raw.actorUsername) ||
      typeof raw.expiresAt !== "number" || !Number.isSafeInteger(raw.expiresAt) || raw.expiresAt <= 0) return undefined;
  const review = Object.hasOwn(raw, "review") ? copyJiraHumanInputReview(raw.review, purpose) : undefined;
  if (Object.hasOwn(raw, "review") && (review === undefined || review.actorUserKey !== raw.actorUserKey || review.actorUsername !== raw.actorUsername)) return undefined;
  return Object.freeze({ context: Object.freeze(selected), authority, principalDigest: raw.principalDigest, authRef: raw.authRef,
    authenticationGeneration: raw.authenticationGeneration, verificationRevision: raw.verificationRevision,
    operation: `jira.${purpose}`, argumentsDigest: raw.argumentsDigest, actorUserKey: raw.actorUserKey, actorUsername: raw.actorUsername, expiresAt: raw.expiresAt,
    ...(review === undefined ? {} : { review }) });
}
export function currentHumanInputLifetime(binding: JiraHumanInputBinding, now: number): boolean {
  return Number.isSafeInteger(now) && now >= 0 && binding.expiresAt > now && binding.expiresAt - now <= JIRA_HUMAN_INPUT_MAX_LIFETIME_MS;
}
export function humanInputRequestId(binding: JiraHumanInputBinding): string {
  // copyHumanInputBinding fixes property order, so no serialization of untrusted descriptors/getters occurs here.
  return `jhi_${createHash("sha256").update(JSON.stringify(binding)).digest("hex")}`;
}
export function humanInputReference(requestId: string): string | undefined {
  return /^jhi_[a-f0-9]{64}$/u.test(requestId) ? `jira-input:${requestId}` : undefined;
}
export function humanInputView(record: JiraHumanInputRecord, state = record.state): JiraHumanInputView {
  const purpose = humanInputPurpose(record.binding.operation);
  if (purpose === undefined) throw new TypeError("Unsupported Jira private input purpose");
  const fields = JIRA_HUMAN_INPUT_FIELD_SETS[purpose];
  return Object.freeze({ requestId: record.requestId, revision: record.revision, purpose, state, expiresAt: record.binding.expiresAt,
    fields: Object.freeze([...fields.required]), optionalFields: Object.freeze([...fields.optional]),
    ...(record.binding.review === undefined ? {} : { review: record.binding.review }) });
}
export function parseHumanInputValues(operation: string, value: unknown): JiraHumanInputValues | undefined {
  const purpose = humanInputPurpose(operation); const raw = asRecord(value);
  if (purpose === undefined || raw === undefined) return undefined;
  const fields = JIRA_HUMAN_INPUT_FIELD_SETS[purpose]; const allowed = new Set([...fields.required, ...fields.optional]);
  if (!savedExactKeys(raw, allowed) || fields.required.some((field) => !Object.hasOwn(raw, field))) return undefined;
  const result: Partial<Record<JiraHumanInputField, string>> = {};
  for (const field of allowed) {
    const selected = raw[field]; if (selected === undefined && !Object.hasOwn(raw, field)) continue;
    // JSON body material only; preserve well-formed passwords verbatim including spaces/control characters.
    if (typeof selected !== "string" || selected.length === 0 || selected.length > (field === "license" ? 32768 : 4096) || /\p{Surrogate}/u.test(selected)) return undefined;
    if (field === "ownerShutdownConfirmation" && selected !== "confirmed") return undefined;
    result[field] = selected;
  }
  return new TextEncoder().encode(JSON.stringify(result)).byteLength <= JIRA_HUMAN_INPUT_MAX_BYTES ? Object.freeze(result) : undefined;
}
export function parseHumanInputRecord(serialized: string): JiraHumanInputRecord | undefined {
  if (new TextEncoder().encode(serialized).byteLength > JIRA_HUMAN_INPUT_MAX_BYTES + 8192) return undefined;
  let value: unknown; try { value = JSON.parse(serialized); } catch { return undefined; }
  const raw = asRecord(value); const binding = copyHumanInputBinding(raw?.binding);
  if (raw === undefined || !savedExactKeys(raw, RECORD_KEYS) || binding === undefined || raw.kind !== "jira-operation-input" || raw.schemaVersion !== 1 ||
      raw.requestId !== humanInputRequestId(binding) || typeof raw.revision !== "string" || !REVISION.test(raw.revision) ||
      !savedText(raw.state, 32)) return undefined;
  const state = raw.state;
  if (state !== "awaiting-input" && state !== "ready" && state !== "consumed" && state !== "cancelled" && state !== "expired") return undefined;
  const values = raw.values === undefined ? undefined : parseHumanInputValues(binding.operation, raw.values);
  if ((state === "ready") !== (values !== undefined) || (state !== "ready" && Object.hasOwn(raw, "values"))) return undefined;
  return { schemaVersion: 1, kind: "jira-operation-input", binding, requestId: raw.requestId, revision: raw.revision, state,
    ...(values === undefined ? {} : { values }) };
}
