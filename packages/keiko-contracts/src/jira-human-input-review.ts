import { canonicalAtlassianConnectorBaseUrl } from "./atlassian-connector-url.js";
import type { JiraHumanInputPurpose } from "./jira-human-input-purpose.js";

interface ReviewConnection {
  /** Exact saved connection destination, never a model URL or navigation link. */
  readonly jiraBaseUrl: string;
  readonly actorUserKey: string;
  readonly actorUsername: string;
}
type ReviewTarget =
  | { readonly targetKind: "user"; readonly targetUserKey: string; readonly targetUsername: string }
  | { readonly targetKind: "proposed-user"; readonly targetUsername: string }
  | { readonly targetKind: "instance" }
  | {
      readonly targetKind: "anonymization-task";
      readonly targetUserKey: string;
      readonly executingNode: string;
    };
/** Non-secret facts independently bound before requesting a human-only value. */
export type JiraHumanInputReview = ReviewConnection & ReviewTarget;
const COMMON = ["jiraBaseUrl", "actorUserKey", "actorUsername", "targetKind"] as const;
function text(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    value.trim() === value &&
    !/\p{C}/u.test(value)
  );
}
function own(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor?.enumerable === true && "value" in descriptor ? descriptor.value : undefined;
}
function fields(value: object, extra: readonly string[]): boolean {
  const keys: readonly string[] = [...COMMON, ...extra];
  return (
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => own(value, key) !== undefined)
  );
}
function proposedUser(value: object): ReviewTarget | undefined {
  const name = own(value, "targetUsername");
  return own(value, "targetKind") === "proposed-user" &&
    fields(value, ["targetUsername"]) &&
    text(name)
    ? { targetKind: "proposed-user", targetUsername: name }
    : undefined;
}
function observedUser(value: object): ReviewTarget | undefined {
  const key = own(value, "targetUserKey");
  const name = own(value, "targetUsername");
  return own(value, "targetKind") === "user" &&
    fields(value, ["targetUserKey", "targetUsername"]) &&
    text(key) &&
    text(name)
    ? { targetKind: "user", targetUserKey: key, targetUsername: name }
    : undefined;
}
function observedTask(value: object): ReviewTarget | undefined {
  const key = own(value, "targetUserKey");
  const node = own(value, "executingNode");
  return own(value, "targetKind") === "anonymization-task" &&
    fields(value, ["targetUserKey", "executingNode"]) &&
    text(key) &&
    text(node)
    ? { targetKind: "anonymization-task", targetUserKey: key, executingNode: node }
    : undefined;
}
function target(value: object, purpose: JiraHumanInputPurpose): ReviewTarget | undefined {
  switch (purpose) {
    case "validate-license":
      return own(value, "targetKind") === "instance" && fields(value, [])
        ? { targetKind: "instance" }
        : undefined;
    case "validate-create-user-password":
      return proposedUser(value);
    case "unlock-user-anonymization":
      return observedTask(value);
    default:
      return observedUser(value);
  }
}
function isSelfTarget(
  purpose: JiraHumanInputPurpose,
  target: ReviewTarget,
  key: string,
  username: string,
): boolean {
  if (purpose !== "login" && purpose !== "update-myself" && purpose !== "update-my-password")
    return true;
  return (
    target.targetKind === "user" &&
    target.targetUserKey === key &&
    target.targetUsername === username
  );
}
/** Own-data projection also binds self purposes to the independently observed actor. */
export function copyJiraHumanInputReview(
  value: unknown,
  purpose: JiraHumanInputPurpose,
): JiraHumanInputReview | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const jiraBaseUrl = canonicalAtlassianConnectorBaseUrl(own(value, "jiraBaseUrl"));
  const actorUserKey = own(value, "actorUserKey");
  const actorUsername = own(value, "actorUsername");
  const selected = target(value, purpose);
  if (
    jiraBaseUrl === undefined ||
    !text(actorUserKey) ||
    !text(actorUsername) ||
    selected === undefined
  )
    return undefined;
  if (!isSelfTarget(purpose, selected, actorUserKey, actorUsername)) return undefined;
  return Object.freeze({ jiraBaseUrl, actorUserKey, actorUsername, ...selected });
}
