import { asRecord } from "./atlassian-sync-classify.js";
import { jiraNativeId, jiraNativeNumericId } from "./jira-native-values.js";
import { savedName, savedText } from "./jira-saved-configuration-values.js";

export interface IssueTypeSnapshot {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly subtask: boolean;
  readonly avatarId?: string;
}
function description(raw: Record<string, unknown>): string | null | undefined {
  if (!Object.hasOwn(raw, "description")) return undefined;
  return raw.description === null || savedText(raw.description, 32768, true)
    ? raw.description
    : undefined;
}
function avatar(value: unknown): Pick<IssueTypeSnapshot, "avatarId"> | undefined {
  if (value === undefined || value === null) return {};
  const id = jiraNativeNumericId(value);
  return id === undefined ? undefined : { avatarId: id };
}
/** Same strict observed facts for ordinary review and mutation admission. Missing is not null. */
export function jiraIssueTypeReviewSnapshot(value: unknown): IssueTypeSnapshot | undefined {
  const raw = asRecord(value);
  if (
    raw === undefined ||
    !jiraNativeId(raw.id) ||
    !savedName(raw.name) ||
    typeof raw.subtask !== "boolean"
  )
    return undefined;
  const observedDescription = description(raw);
  if (observedDescription === undefined) return undefined;
  const observedAvatar = avatar(raw.avatarId);
  if (observedAvatar === undefined) return undefined;
  return Object.freeze({
    id: raw.id,
    name: raw.name,
    description: observedDescription,
    subtask: raw.subtask,
    ...observedAvatar,
  });
}
