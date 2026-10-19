/** Public, non-credential instance identity shared by the launcher PID record and health route. */
export const KEIKO_UI_LAUNCH_ID_ENV = "KEIKO_UI_LAUNCH_ID";
export const UI_LAUNCH_ID_FLAG = "--launch-id";

export function isKeikoUiLaunchId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/u.test(value);
}
