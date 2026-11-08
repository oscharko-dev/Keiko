import type {
  CatalogJsonObject,
  CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { jiraNativeText } from "./jira-native-values.js";

export function jiraDirectoryGroup(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  return raw !== undefined && jiraNativeText(raw.name, 255) ? { name: raw.name } : undefined;
}

export function jiraDirectoryNumber(
  value: unknown,
  fallback: number,
  max: number,
  min = 0,
): number | undefined {
  const selected = value === undefined ? fallback : value;
  return typeof selected === "number" &&
    Number.isSafeInteger(selected) &&
    selected >= min &&
    selected <= max
    ? selected
    : undefined;
}

function copyOptionalFlags(
  raw: Record<string, unknown>,
  result: Record<string, CatalogJsonValue>,
): boolean {
  for (const key of ["active", "deleted"] as const) {
    if (raw[key] === undefined || raw[key] === null) continue;
    if (typeof raw[key] !== "boolean") return false;
    result[key] = raw[key];
  }
  return true;
}
/** User keys stay exact; a username's native spelling is presentation, not a rewritten identity. */
export function jiraDirectoryUser(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !jiraNativeText(raw.key, 255) || !jiraNativeText(raw.name, 255))
    return undefined;
  const result: Record<string, CatalogJsonValue> = { key: raw.key, name: raw.name };
  if (raw.displayName !== undefined && raw.displayName !== null) {
    if (!jiraNativeText(raw.displayName, 255)) return undefined;
    result.displayName = raw.displayName;
  }
  return copyOptionalFlags(raw, result) ? result : undefined;
}

export function jiraDirectoryUsers(
  value: unknown,
  max: number,
): readonly CatalogJsonObject[] | undefined {
  const values = asArray(value);
  if (values === undefined || values.length > max) return undefined;
  const items: CatalogJsonObject[] = [];
  const keys = new Set<string>();
  for (const entry of values) {
    const user = jiraDirectoryUser(entry);
    if (user === undefined || typeof user.key !== "string" || keys.has(user.key)) return undefined;
    keys.add(user.key);
    items.push(user);
  }
  return items;
}

/** Streaming cursors are transient signed native int64 values, never persisted resource IDs. */
export function jiraDirectoryCursor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:0|-?[1-9]\d{0,18})$/u.test(value) &&
    BigInt(value) >= -9223372036854775808n &&
    BigInt(value) <= 9223372036854775807n
  );
}

export function jiraDirectoryTotal(value: unknown, count: number): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "number" && Number.isInteger(value) && value >= count && value <= 2147483647)
  );
}
