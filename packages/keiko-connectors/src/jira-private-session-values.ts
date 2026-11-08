import { createHash } from "node:crypto";
import { isChatJiraPodId } from "@oscharko-dev/keiko-contracts/bff-wire";
import { isAtlassianConnectorAuthRef } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { asRecord } from "./atlassian-sync-classify.js";
import { savedExactKeys, savedName } from "./jira-saved-configuration-values.js";
import { copyJiraInputAuthority, type JiraHumanInputBinding } from "./jira-human-input-values.js";

export type JiraPrivateSessionContext = { readonly kind: "chat"; readonly chatId: string; readonly podId: string; readonly bindingGeneration: number } |
  { readonly kind: "coding"; readonly taskId: string; readonly runId: string };
/** Current server-owned task scope; per-call authority is checked again by the existing HTTP owner. */
export interface JiraPrivateSessionBinding {
  readonly context: JiraPrivateSessionContext;
  readonly authority: JiraHumanInputBinding["authority"];
  readonly principalDigest: string;
  readonly authRef: string;
  readonly authenticationGeneration: number;
  readonly verificationRevision: number;
  readonly actorUserKey: string;
  readonly actorUsername: string;
  readonly expiresAt: number;
}
export type JiraPrivateSessionScope = Omit<JiraPrivateSessionBinding, "actorUserKey" | "actorUsername">;
/** Private cookie octets only. Never a model DTO, receipt, transcript or log field. */
export interface JiraPrivateCookie { readonly name: string; readonly value: string }
const KEYS = new Set(["context", "authority", "principalDigest", "authRef", "authenticationGeneration", "verificationRevision", "actorUserKey", "actorUsername", "expiresAt"]);
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function context(value: unknown): JiraPrivateSessionContext | undefined {
  const raw = asRecord(value); if (raw === undefined) return undefined;
  if (raw.kind === "chat" && savedExactKeys(raw, new Set(["kind", "chatId", "podId", "bindingGeneration"])) && savedName(raw.chatId) && isChatJiraPodId(raw.podId) && positive(raw.bindingGeneration))
    return { kind: "chat", chatId: raw.chatId, podId: raw.podId, bindingGeneration: raw.bindingGeneration };
  if (raw.kind === "coding" && savedExactKeys(raw, new Set(["kind", "taskId", "runId"])) && savedName(raw.taskId) && savedName(raw.runId))
    return { kind: "coding", taskId: raw.taskId, runId: raw.runId };
  return undefined;
}
export function copyJiraSessionBinding(value: unknown): JiraPrivateSessionBinding | undefined {
  const raw = asRecord(value); const selected = context(raw?.context);
  const authority = copyJiraInputAuthority(raw?.authority);
  if (raw === undefined || selected === undefined || authority === undefined || !savedExactKeys(raw, KEYS) || !isAtlassianConnectorAuthRef(raw.authRef) ||
      typeof raw.principalDigest !== "string" || !/^[a-f0-9]{64}$/u.test(raw.principalDigest) || !positive(raw.authenticationGeneration) ||
      !positive(raw.verificationRevision) || !positive(raw.expiresAt) || !savedName(raw.actorUserKey) || !savedName(raw.actorUsername)) return undefined;
  return Object.freeze({ context: Object.freeze(selected), authority, principalDigest: raw.principalDigest, authRef: raw.authRef,
    authenticationGeneration: raw.authenticationGeneration, verificationRevision: raw.verificationRevision,
    actorUserKey: raw.actorUserKey, actorUsername: raw.actorUsername, expiresAt: raw.expiresAt });
}
export function jiraSessionBindingForInput(binding: JiraHumanInputBinding): JiraPrivateSessionBinding {
  const selected = binding.context;
  return { context: selected.kind === "chat" ? { kind: "chat", chatId: selected.chatId, podId: selected.podId, bindingGeneration: selected.bindingGeneration } : { kind: "coding", taskId: selected.taskId, runId: selected.runId },
    authority: binding.authority, principalDigest: binding.principalDigest, authRef: binding.authRef, authenticationGeneration: binding.authenticationGeneration,
    verificationRevision: binding.verificationRevision, actorUserKey: binding.actorUserKey, actorUsername: binding.actorUsername, expiresAt: binding.expiresAt };
}
export function jiraPrivateSessionReference(binding: JiraPrivateSessionBinding): string {
  // The existing Pod-binding generation is stable across Chat messages. Cookies do not confer
  // authority: every physical request is separately admitted against the current envelope.
  const { expiresAt: _expiry, authority: _authority, ...scope } = binding;
  return `jira-session:${createHash("sha256").update(JSON.stringify(scope)).digest("hex")}`;
}
export function jiraPrivateCookie(value: unknown): JiraPrivateCookie | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !savedExactKeys(raw, new Set(["name", "value"])) || typeof raw.name !== "string" || typeof raw.value !== "string") return undefined;
  // RFC token / cookie-octet. Domain/path and remote redirects are never adopted from the server.
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u.test(raw.name) && /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$/u.test(raw.value)
    ? { name: raw.name, value: raw.value } : undefined;
}
