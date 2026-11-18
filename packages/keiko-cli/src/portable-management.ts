// Who manages a portable payload, as its launcher declares it (ADR-0121 D9). The server's
// install-mode detection reads the same name (keiko-server update-portable-install-mode.ts,
// PORTABLE_MANAGEMENT_ENV). Duplicated on purpose: the CLI must not load the server module graph to
// learn one name; each side's tests pin the literal.
export const PORTABLE_MANAGEMENT_ENV = "KEIKO_PORTABLE_MANAGEMENT";

/**
 * Whether this installation is managed outside the app: a standalone folder package declares
 * `organization-managed`, an IT-managed deployment `organization-managed` or `machine-managed`.
 * Keiko then performs no installation of its own. A declaration Keiko cannot read counts as managed
 * outside, the same fail-closed reading the server applies; only an absent or `user-local`
 * declaration leaves Keiko in charge of its own setup.
 */
export function managedOutsideApp(env: Readonly<Record<string, string | undefined>>): boolean {
  const declared = env[PORTABLE_MANAGEMENT_ENV];
  return declared !== undefined && declared.length > 0 && declared !== "user-local";
}
