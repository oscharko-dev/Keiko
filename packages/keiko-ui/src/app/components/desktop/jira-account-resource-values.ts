import { isSafeAtlassianIdentifier } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  jiraPresentationIdentity,
  jiraPresentationNativeText,
  type JiraPresentationSource,
} from "./jira-presentation-values";

export type AccountResourceSource = JiraPresentationSource;
export const accountResourceAliases = (names: readonly string[]): ReadonlySet<string> =>
  new Set(names.map((name) => name.replace(/[.-]/gu, "_")));
export const accountResourceId = (value: unknown): boolean =>
  jiraPresentationIdentity(value) !== undefined;
export const accountResourcePrincipal = (value: unknown): value is string =>
  jiraPresentationNativeText(value, 255, { multiline: true });
export const accountResourceKey = isSafeAtlassianIdentifier;
export const accountResourceDigest = (value: unknown): boolean =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
export function accountResourceInteger(value: unknown, min = 0, max = 2147483647): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
const ENVELOPE_FIELDS = new Set([
  "outcome",
  "reason",
  "messages",
  "fieldErrors",
  "validation",
  "violations",
  "unchanged",
  "replayed",
  "guidance",
  "browseUrl",
  "operationBinding",
]);
export function accountResourceOwn(source: object): boolean {
  const proto: unknown = Object.getPrototypeOf(source);
  return (
    (proto === null || proto === Object.prototype) &&
    Reflect.ownKeys(source).every((key) => {
      const property = Object.getOwnPropertyDescriptor(source, key);
      return typeof key === "string" && property?.enumerable === true && "value" in property;
    })
  );
}
export function accountResourceRecord(value: unknown): AccountResourceSource | undefined {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    accountResourceOwn(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}
export function accountResourceExactFields(
  source: AccountResourceSource,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    accountResourceOwn(source) &&
    Object.keys(source).every((key) => allowed.has(key)) &&
    required.every((key) => Object.hasOwn(source, key))
  );
}
function ownDataProperty(source: object, key: PropertyKey): PropertyDescriptor | undefined {
  const property = Object.getOwnPropertyDescriptor(source, key);
  return property?.enumerable === true && "value" in property ? property : undefined;
}
/** Display admission only. A stored result never becomes new execution authority. */
export function accountResourceFields(
  source: AccountResourceSource,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const proto: unknown = Object.getPrototypeOf(source);
  if (proto !== null && proto !== Object.prototype) return false;
  const allowed = new Set([...required, ...optional]);
  const receipt: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== "string") return false;
    const property = ownDataProperty(source, key);
    if (property === undefined) return false;
    if (ENVELOPE_FIELDS.has(key)) continue;
    if (!allowed.has(key)) return false;
    receipt[key] = property.value;
  }
  return required.every((key) => Object.hasOwn(receipt, key));
}
export function accountResourceList(
  value: unknown,
  valid: (entry: unknown) => boolean,
  min = 0,
  max = 1000,
  unique = true,
): value is readonly unknown[] {
  if (
    !Array.isArray(value) ||
    value.length < min ||
    value.length > max ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return false;
  const values = arrayValues(value, valid);
  return values !== undefined && (!unique || new Set(values).size === values.length);
}
function arrayValues(
  value: readonly unknown[],
  valid: (entry: unknown) => boolean,
): unknown[] | undefined {
  const values: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = ownDataProperty(value, String(index));
    if (item === undefined || !valid(item.value)) return undefined;
    values.push(item.value);
  }
  return values;
}

export function accountResourceBudget(source: AccountResourceSource): boolean {
  const receipt = Object.fromEntries(
    Object.entries(source).filter(([key]) => !ENVELOPE_FIELDS.has(key)),
  );
  return new TextEncoder().encode(JSON.stringify(receipt)).byteLength <= 16384;
}
