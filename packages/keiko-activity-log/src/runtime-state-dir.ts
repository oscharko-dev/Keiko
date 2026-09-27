// The runtime state directory a process uses when nobody handed it one explicitly.
//
// Mirrors the CLI's own resolution for `keiko ui`/`keiko start` exactly: a non-empty
// `KEIKO_STATE_DIR` wins (resolved against the working directory when relative), otherwise
// `<cwd>/.keiko`. A process started without `KEIKO_STATE_DIR` — `keiko run`, `keiko memory`,
// `keiko evaluate`, `keiko update`, `keiko portable` — therefore writes the SAME Activity Log a
// `keiko start` in that directory would, instead of silently writing nothing at all (#3532).
//
// The server package cannot import the CLI's resolver (the dependency points cli -> server), so the
// one rule lives here and both the Activity Log writer and the update state share it.

import { isAbsolute, resolve } from "node:path";

export const DEFAULT_RUNTIME_STATE_DIR_NAME = ".keiko";

export type RuntimeStateDirEnv = Readonly<Record<string, string | undefined>>;

/** The configured `KEIKO_STATE_DIR`, or `undefined` when it is unset or empty. */
export function configuredRuntimeStateDir(env: RuntimeStateDirEnv): string | undefined {
  const value = env.KEIKO_STATE_DIR;
  return value === undefined || value === "" ? undefined : value;
}

export function resolveRuntimeStateDir(
  env: RuntimeStateDirEnv,
  cwd: string = process.cwd(),
): string {
  const configured = configuredRuntimeStateDir(env);
  if (configured === undefined) return resolve(cwd, DEFAULT_RUNTIME_STATE_DIR_NAME);
  return isAbsolute(configured) ? configured : resolve(cwd, configured);
}
