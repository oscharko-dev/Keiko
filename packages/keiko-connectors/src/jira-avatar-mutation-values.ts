import {
  JIRA_AVATAR_MUTATIONS,
  type JiraAvatarMutation,
  type JiraMutationAttempt,
  type JiraMutationReceipt,
  type JiraAttachmentPreview,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import type { JiraAttachmentSource } from "./jira-attachments.js";

export { JIRA_AVATAR_MUTATIONS };
export type { JiraAvatarMutation };
export type JiraAvatarType = "user" | "project" | "issuetype";
export interface JiraAvatarReview {
  readonly id: string;
  readonly category: "system" | "custom";
  readonly selected: boolean;
  readonly owner?: string;
}
export type JiraAvatarTarget =
  | { readonly kind: "session"; readonly avatarType: JiraAvatarType }
  | { readonly kind: "user"; readonly key: string; readonly name: string }
  | { readonly kind: "project"; readonly id: string; readonly key: string }
  | { readonly kind: "issuetype"; readonly id: string };
export interface JiraAvatarCrop {
  readonly cropperOffsetX: number;
  readonly cropperOffsetY: number;
  readonly cropperWidth: number;
}
export interface JiraAvatarTemporarySnapshot {
  readonly actorKey: string;
  readonly target: JiraAvatarTarget;
  readonly uploadSha256: string;
  readonly uploadBytes: number;
  readonly crop: JiraAvatarCrop;
  readonly needsCropping: boolean;
}
export interface JiraAvatarReceipt extends JiraMutationReceipt {
  readonly actorUserKey: string;
  readonly avatarType: JiraAvatarType;
  readonly avatarId?: string;
  readonly avatarPresent?: boolean;
  readonly avatarSelected?: boolean;
  readonly temporaryAvatar?: true;
  /** Bounded acknowledgement metadata only, not independent image-content evidence. */
  readonly temporaryCrop?: JiraAvatarCrop;
  readonly temporaryNeedsCropping?: boolean;
  readonly uploadSha256?: string;
  readonly uploadBytes?: number;
}
export type AvatarFailure = Omit<Extract<JiraMutationAttempt, { ok: false }>, "receipt"> & {
  readonly receipt?: JiraAvatarReceipt;
};
export type JiraAvatarAttempt =
  AvatarFailure | { readonly ok: true; readonly receipt: JiraAvatarReceipt };
export type AvatarObservation<T> = AvatarFailure | { readonly ok: true; readonly value: T };
/** The real custody owner must hold one exclusive slot per session, never a model-supplied token. */
export interface JiraAvatarSession {
  readonly request: JiraMutationRequest;
  readonly temporary: () => JiraAvatarTemporarySnapshot | undefined;
  readonly rememberTemporary: (value: JiraAvatarTemporarySnapshot | undefined) => void;
  readonly upload: (
    operation: JiraAvatarMutation,
    target: JiraAvatarTarget,
    file: JiraAttachmentPreview,
    mimeType: "image/png" | "image/jpeg",
    bytes: Uint8Array,
  ) => Promise<AtlassianWriteHttpOutcome>;
}
export interface JiraAvatarPorts {
  readonly request: JiraMutationRequest;
  readonly source?: JiraAttachmentSource;
  /** Existing image admission returns metadata only after credential/structure/byte bounds. */
  readonly inspectImage?: (
    bytes: Uint8Array,
  ) => Promise<AvatarObservation<{ readonly mimeType: "image/png" | "image/jpeg" }>>;
  /** Optional until the existing custody owner supplies actual session continuity and exclusivity. */
  readonly withSession?: (
    actorKey: string,
    execute: (session: JiraAvatarSession) => Promise<JiraAvatarAttempt>,
  ) => Promise<JiraAvatarAttempt>;
  /** Server-owned compatibility, never an argument or an inferred successful runtime qualification. */
  readonly legacyTemporaryRelease?: "10.3" | "10.4";
}
export const AVATAR_MALFORMED: AvatarFailure = { ok: false, reason: "malformed-payload" };
export function avatarInvalid(message: string): AvatarFailure {
  return {
    ok: false,
    reason: "field-validation",
    detail: { validation: "invalid-field", messages: [message] },
  };
}
export function avatarConflict(message: string): AvatarFailure {
  return { ok: false, reason: "conflict", detail: { messages: [message] } };
}
export function avatarUnavailable(message: string, receipt?: JiraAvatarReceipt): AvatarFailure {
  return {
    ok: false,
    reason: "unavailable",
    detail: { messages: [message] },
    ...(receipt === undefined ? {} : { receipt }),
  };
}
export function avatarFailure(failure: Pick<AvatarFailure, "reason" | "detail">): AvatarFailure {
  return {
    ok: false,
    reason: failure.reason,
    ...(failure.detail === undefined ? {} : { detail: failure.detail }),
  };
}
export function avatarTypeOf(target: JiraAvatarTarget): JiraAvatarType {
  return target.kind === "session" ? target.avatarType : target.kind;
}
export function isJiraAvatarMutation(value: string): value is JiraAvatarMutation {
  return (JIRA_AVATAR_MUTATIONS as readonly string[]).includes(value);
}
