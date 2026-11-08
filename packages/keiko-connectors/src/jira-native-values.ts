/** Native project/component text permits ordinary line breaks, never terminal controls. */
// eslint-disable-next-line no-control-regex -- preserve tabs, LF and CR while refusing other controls.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

export const JIRA_PROJECT_LEAD_MAX_CHARS = 128;
export const JIRA_PROJECT_URL_MAX_CHARS = 2048;

export function jiraNativeText(value: unknown, max: number, empty = false): value is string {
  return (
    typeof value === "string" &&
    value.length <= max &&
    (empty || value.trim().length > 0) &&
    !CONTROL.test(value)
  );
}

/** Jira string int64 identifiers stay exact even beyond JavaScript's safe numeric range. */
export function jiraNativeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[1-9]\d{0,18}$/u.test(value) &&
    BigInt(value) <= 9223372036854775807n
  );
}

/** Native JSON numbers are admitted only while exact; string int64 identities remain lossless. */
export function jiraNativeNumericId(value: unknown): string | undefined {
  const exact = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return jiraNativeId(exact) ? exact : undefined;
}

/** Jira's built-in default permission scheme has the real native identity 0. */
export function jiraNativePermissionSchemeId(value: unknown): value is string {
  return value === "0" || jiraNativeId(value);
}

export function jiraNativePermissionSchemeNumericId(value: unknown): string | undefined {
  return value === 0 || value === "0" ? "0" : jiraNativeNumericId(value);
}

/** Names are sent exactly as reviewed; refuse input Jira would trim rather than guessing readback. */
export function jiraNativeName(value: unknown, max: number): value is string {
  return jiraNativeText(value, max) && value === value.trim();
}
