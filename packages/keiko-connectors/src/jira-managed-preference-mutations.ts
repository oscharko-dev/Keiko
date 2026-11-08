import type {
  CatalogJsonObject,
  CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  JIRA_NONSECRET_PREFERENCE_KINDS,
  projectJiraPreferenceValue,
} from "./jira-managed-application-settings.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import {
  readSavedActor,
  savedConflict,
  savedExactKeys,
  savedInvalid,
  savedText,
  savedUnchanged,
  savedUnconfirmed,
  SAVED_MALFORMED,
  type JiraSavedConfigurationAttempt,
  type JiraSavedConfigurationReceipt,
  type SavedObservation,
} from "./jira-saved-configuration-values.js";

const OPERATIONS = ["jira.set-my-preference", "jira.delete-my-preference"] as const;
type PreferenceMutation = (typeof OPERATIONS)[number];
interface Input {
  readonly key: string;
  readonly actorKey: string;
  readonly expected: string;
  readonly value?: string;
}
const FIELDS = new Set(["key", "expectedActorKey", "expectedValue", "value"]);
function preferenceText(value: CatalogJsonValue | undefined): string | undefined {
  if (typeof value === "string") return value;
  return typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
}
function nativeValue(key: string, value: CatalogJsonValue | undefined): string | undefined {
  const kinds: Readonly<Record<string, string>> = JIRA_NONSECRET_PREFERENCE_KINDS;
  const kind = kinds[key];
  if (typeof value !== kind && !(kind === "integer" && typeof value === "number")) return undefined;
  const native = preferenceText(value);
  if (native === undefined) return undefined;
  const projected = projectJiraPreferenceValue(key, native);
  return "item" in projected && projected.item.valueState === "observed" ? native : undefined;
}
function input(operation: PreferenceMutation, args: CatalogJsonObject): Input | undefined {
  if (
    !savedExactKeys(args, FIELDS) ||
    typeof args.key !== "string" ||
    !Object.hasOwn(JIRA_NONSECRET_PREFERENCE_KINDS, args.key)
  )
    return undefined;
  if (!savedText(args.expectedActorKey, 255)) return undefined;
  const expected = nativeValue(args.key, args.expectedValue);
  if (expected === undefined) return undefined;
  if (operation === "jira.delete-my-preference")
    return Object.hasOwn(args, "value")
      ? undefined
      : { key: args.key, actorKey: args.expectedActorKey, expected };
  const value = nativeValue(args.key, args.value);
  return value === undefined
    ? undefined
    : { key: args.key, actorKey: args.expectedActorKey, expected, value };
}
async function readPreference(
  request: JiraMutationRequest,
  key: string,
): Promise<SavedObservation<string>> {
  const response = await request(
    `mypreferences?${new URLSearchParams({ key }).toString()}`,
    "GET",
    undefined,
    "json-scalar",
  );
  if (!response.ok) return dispatchFailure(response);
  if (response.status !== 200) return SAVED_MALFORMED;
  const projected = projectJiraPreferenceValue(key, response.scalar);
  if ("reason" in projected) return { ok: false, reason: projected.reason };
  return projected.item.valueState === "observed" && typeof response.scalar === "string"
    ? { ok: true, value: response.scalar }
    : { ok: false, reason: "unavailable" };
}
async function confirm(
  request: JiraMutationRequest,
  selected: Input,
  receipt: JiraSavedConfigurationReceipt,
): Promise<JiraSavedConfigurationAttempt> {
  try {
    const actor = await readSavedActor(request, selected.actorKey);
    if (!actor.ok) return { ...actor, receipt };
    const current = await readPreference(request, selected.key);
    // This API publishes no complete explicit-preference key collection. A 404 or fallback default
    // cannot independently prove deletion; retain the acknowledged key without inventing absence.
    if (selected.value === undefined)
      return savedUnconfirmed(
        "Jira acknowledged the preference deletion, but this API cannot independently distinguish removal from an inaccessible key or inherited default. The reviewed key is retained. Do not replay this deletion.",
        receipt,
      );
    if (!current.ok) return { ...current, receipt };
    return current.value === selected.value
      ? { ok: true, receipt }
      : savedUnconfirmed(
          "The independent preference read did not match the requested value. The write is not confirmed and must not be replayed.",
          receipt,
        );
  } catch (error) {
    throw new JiraAcknowledgedMutationError(error, receipt);
  }
}
export function isJiraPreferenceMutation(name: string): name is PreferenceMutation {
  return (OPERATIONS as readonly string[]).includes(name);
}
/** Only the existing documented nonsecret keys are writable. Native strings remain literal strings. */
export async function executeJiraPreferenceMutation(
  operation: PreferenceMutation,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  check = false,
): Promise<JiraSavedConfigurationAttempt> {
  const selected = input(operation, args);
  if (selected === undefined)
    return savedInvalid(
      "Use a documented nonsecret preference key, the reviewed connected-user key and a typed expectedValue. Supply a typed value only when setting the preference. Nothing was written.",
    );
  const actor = await readSavedActor(request, selected.actorKey);
  if (!actor.ok) return actor;
  const current = await readPreference(request, selected.key);
  if (!current.ok) return current;
  if (current.value !== selected.expected)
    return savedConflict(
      "The preference changed after review. Read and review its current typed value before requesting this change. Nothing was written.",
    );
  const receipt: JiraSavedConfigurationReceipt = {
    userKey: actor.value.key,
    username: actor.value.name,
    preferenceKey: selected.key,
    preferencePresent: selected.value !== undefined,
  };
  if (current.value === selected.value)
    return savedUnchanged(
      "The preference already has the requested value. Nothing was written.",
      receipt,
    );
  if (check) return { ok: true, receipt: {} };
  return writePreference(request, selected, receipt);
}
async function writePreference(
  request: JiraMutationRequest,
  selected: Input,
  receipt: JiraSavedConfigurationReceipt,
): Promise<JiraSavedConfigurationAttempt> {
  const rebound = await readSavedActor(request, selected.actorKey);
  if (!rebound.ok) return rebound;
  const response = await request(
    `mypreferences?${new URLSearchParams({ key: selected.key }).toString()}`,
    selected.value === undefined ? "DELETE" : "PUT",
    selected.value,
    "none",
  );
  if (!response.ok) return { ...dispatchFailure(response), receipt };
  if (response.status < 200 || response.status >= 300) return { ...SAVED_MALFORMED, receipt };
  return confirm(request, selected, receipt);
}
