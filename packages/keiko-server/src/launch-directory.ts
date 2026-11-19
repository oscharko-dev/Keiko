// The launch directory of a Keiko that runs inside its own program folder (ADR-0121 D9): the
// managed and in-place portable launches and the npm folder package declare it with this name, and
// keiko-cli starts such a Keiko without a default project. Duplicated on purpose (keiko-cli
// `portable-management.ts`): the server must not depend on the CLI; each side's tests pin the
// literal.
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { containsPath } from "@oscharko-dev/keiko-git";

export const PROGRAM_FOLDER_LAUNCH_ENV = "KEIKO_LAUNCH_FROM_PROGRAM_FOLDER";

/** Whether this process was launched from Keiko's own program folder, which is never a project. */
export function launchedFromProgramFolder(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env[PROGRAM_FOLDER_LAUNCH_ENV] === "1";
}

// How the operating system itself names a path that exists: links followed and, on Windows, a
// short 8.3 name written out, which the JavaScript resolution leaves as it is.
function systemName(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

// The system's name of a launch directory, kept per directory: the working directory of a running
// Keiko does not change. A launch directory that cannot be resolved is refused as it was given.
const launchDirectoryNames = new Map<string, string>();

function launchDirectoryName(directory: string): string {
  const known = launchDirectoryNames.get(directory);
  if (known !== undefined) return known;
  const name = systemName(directory) ?? directory;
  launchDirectoryNames.set(directory, name);
  return name;
}

/**
 * Whether an absolute path is Keiko's own program folder or lies inside it. A launcher that
 * declares the program folder starts Keiko with that folder as its working directory, so the
 * working directory names it. The folder holds the program files and, in a team package, the
 * gateway configuration with its token: the read surface refuses it as a root exactly as it refuses
 * Keiko's state folders, so it is never a window's starting folder (ADR-0121 D9). A relative path is
 * not judged: it belongs to a root that was admitted on its own.
 *
 * A path can spell the same folder another way (through a link, or as a Windows short name), so a
 * path that exists is also compared by the name the operating system gives it.
 */
export function insideProgramFolder(
  path: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  launchDirectory: string = process.cwd(),
): boolean {
  if (!launchedFromProgramFolder(env) || !isAbsolute(path)) return false;
  const folder = launchDirectoryName(launchDirectory);
  if (containsPath(launchDirectory, path) || containsPath(folder, path)) return true;
  const named = systemName(path);
  return named !== undefined && containsPath(folder, named);
}
