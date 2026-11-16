// The same environment-name rule for child projection, executable lookup and trusted Windows
// helpers (#4408). Node selects the first lexicographic casing alias on Windows, even when that
// entry's value is undefined. POSIX callers retain exact-name lookup; no ambient fallback is used.

import { compareStrings } from "./comparators.js";

type ProcessEnvironment = Readonly<Record<string, string | undefined>>;

export function environmentVariableNames(
  env: ProcessEnvironment,
  name: string,
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  if (platform !== "win32") return [name];
  const folded = name.toUpperCase();
  return Object.keys(env)
    .filter((key) => key.toUpperCase() === folded)
    .sort(compareStrings);
}

export function environmentVariableValue(
  env: ProcessEnvironment,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const key = environmentVariableNames(env, name, platform)[0];
  return key === undefined ? undefined : env[key];
}
