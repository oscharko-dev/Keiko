import { copyJiraHumanInputReview, type JiraHumanInputReview } from "./jira-human-input-review.js";
import { JIRA_HUMAN_INPUT_PURPOSES, type JiraHumanInputPurpose } from "./jira-human-input-purpose.js";
export { JIRA_HUMAN_INPUT_PURPOSES, type JiraHumanInputPurpose } from "./jira-human-input-purpose.js";
/** Human-only, write-only input for a server-bound Jira operation. These are never tool arguments. */
export const JIRA_HUMAN_INPUT_FIELDS = ["password", "currentPassword", "newPassword", "oldPassword", "license", "ownerShutdownConfirmation"] as const;
export type JiraHumanInputField = (typeof JIRA_HUMAN_INPUT_FIELDS)[number];
export type JiraHumanInputState = "awaiting-input" | "ready" | "consumed" | "cancelled" | "expired";
export interface JiraHumanInputView {
  readonly requestId: string;
  /** Random input revision, never a password/license hash. */
  readonly revision: string;
  readonly purpose: JiraHumanInputPurpose;
  readonly state: JiraHumanInputState;
  readonly expiresAt: number;
  readonly fields: readonly JiraHumanInputField[];
  readonly optionalFields: readonly JiraHumanInputField[];
  /** Absent only on historical views; never enough to enable a new secret submission. */
  readonly review?: JiraHumanInputReview;
}
/** Only the authenticated human BFF accepts this DTO. Never forward it to a runtime/model. */
export interface JiraHumanInputSubmission {
  readonly expectedRevision: string;
  readonly values: Readonly<Partial<Record<JiraHumanInputField, string>>>;
}
export const JIRA_HUMAN_INPUT_MAX_BYTES = 64 * 1024;
export const JIRA_HUMAN_INPUT_MAX_LIFETIME_MS = 10 * 60 * 1000;

/** Shared by human entry, persisted views and private custody; never inferred from model text. */
export const JIRA_HUMAN_INPUT_FIELD_SETS: Readonly<Record<JiraHumanInputPurpose, {
  readonly required: readonly JiraHumanInputField[];
  readonly optional: readonly JiraHumanInputField[];
}>> = {
  "update-myself": { required: ["password"], optional: [] },
  "update-my-password": { required: ["currentPassword", "password"], optional: [] },
  "update-user-password": { required: ["password"], optional: [] },
  "validate-create-user-password": { required: ["password"], optional: [] },
  "validate-update-user-password": { required: ["newPassword"], optional: ["oldPassword"] },
  "validate-license": { required: ["license"], optional: [] },
  login: { required: ["password"], optional: [] },
  "unlock-user-anonymization": { required: ["ownerShutdownConfirmation"], optional: [] },
};
const VIEW_KEYS = new Set(["requestId", "revision", "purpose", "state", "expiresAt", "fields", "optionalFields"]);
const VIEW_STATES: ReadonlySet<unknown> = new Set<JiraHumanInputState>(["awaiting-input", "ready", "consumed", "cancelled", "expired"]);
function viewRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== VIEW_KEYS.size + (Object.hasOwn(value, "review") ? 1 : 0) ||
      keys.some((key) => typeof key !== "string" || (!VIEW_KEYS.has(key) && key !== "review"))) return undefined;
  const result: Record<string, unknown> = {};
  for (const key of VIEW_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    result[key] = descriptor.value;
  }
  if (Object.hasOwn(value, "review")) {
    const descriptor = Object.getOwnPropertyDescriptor(value, "review");
    if (descriptor?.enumerable !== true || !("value" in descriptor)) return undefined;
    result.review = descriptor.value;
  }
  return result;
}
function exactFields(value: unknown, expected: readonly JiraHumanInputField[]): boolean {
  if (!Array.isArray(value) || value.length !== expected.length || Reflect.ownKeys(value).length !== expected.length + 1) return false;
  return expected.every((field, index) => Object.getOwnPropertyDescriptor(value, String(index))?.value === field);
}
/** Historical validity only: expiry is checked against the current clock by the private owner. */
export function isJiraHumanInputView(value: unknown): value is JiraHumanInputView {
  const raw = viewRecord(value); if (raw === undefined) return false;
  const purpose = JIRA_HUMAN_INPUT_PURPOSES.find((candidate) => candidate === raw.purpose);
  if (purpose === undefined || !VIEW_STATES.has(raw.state) || typeof raw.expiresAt !== "number" ||
      !Number.isSafeInteger(raw.expiresAt) || raw.expiresAt <= 0 || typeof raw.requestId !== "string" ||
      !/^jhi_[a-f0-9]{64}$/u.test(raw.requestId) || typeof raw.revision !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(raw.revision)) return false;
  const fields = JIRA_HUMAN_INPUT_FIELD_SETS[purpose];
  return exactFields(raw.fields, fields.required) && exactFields(raw.optionalFields, fields.optional) &&
    (!Object.hasOwn(raw, "review") || copyJiraHumanInputReview(raw.review, purpose) !== undefined);
}
