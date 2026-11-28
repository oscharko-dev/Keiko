// The launch directory of a Keiko that runs inside its own program folder (ADR-0121 D9): the
// managed and in-place portable launches and the npm folder package declare it with this name, and
// keiko-cli starts such a Keiko without a default project. Duplicated on purpose (keiko-cli
// `portable-management.ts`): the server must not depend on the CLI; each side's tests pin the
// literal.
import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { containsPath } from "@oscharko-dev/keiko-git";

export const PROGRAM_FOLDER_LAUNCH_ENV = "KEIKO_LAUNCH_FROM_PROGRAM_FOLDER";

/** Whether this process was launched from Keiko's own program folder, which is never a project. */
export function launchedFromProgramFolder(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env[PROGRAM_FOLDER_LAUNCH_ENV] === "1";
}

type SystemName =
  | { readonly kind: "named"; readonly name: string }
  | { readonly kind: "missing" }
  | { readonly kind: "failed" };

// How the operating system itself names a path that exists: links followed and, on Windows, a
// short 8.3 name written out, which the JavaScript resolution leaves as it is. A path that does not
// exist has no other name (`missing`); any other failure (access denied, a link loop, ...) is
// `failed`, which the denying checks read as "cannot be shown to be outside". This pure predicate
// has no diagnostic port; the denial it causes is recorded by its callers on the existing
// body-free workspace-root denial line.
function resolveSystemName(path: string): SystemName {
  try {
    return { kind: "named", name: realpathSync.native(path) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? { kind: "missing" } : { kind: "failed" };
  }
}

// The same question asked without blocking the event loop: an unresponsive share holds a worker
// thread, never the BFF's other requests.
async function resolveSystemNameAsync(path: string): Promise<SystemName> {
  try {
    return { kind: "named", name: await realpath(path) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? { kind: "missing" } : { kind: "failed" };
  }
}

function systemName(path: string): string | undefined {
  const resolved = resolveSystemName(path);
  return resolved.kind === "named" ? resolved.name : undefined;
}

// The system's name of a launch directory, kept per directory: the working directory of a running
// Keiko does not change. A launch directory that cannot be resolved is refused as it was given, and
// only for this call: a passing failure (a share not yet mounted, a scan holding the folder) must
// not fix the lexical spelling for the life of the process, or a later link or short-name spelling
// of the folder would never be compared by its system name again.
const launchDirectoryNames = new Map<string, string>();

function launchDirectoryName(directory: string): string {
  const known = launchDirectoryNames.get(directory);
  if (known !== undefined) return known;
  const name = systemName(directory);
  if (name === undefined) return directory;
  launchDirectoryNames.set(directory, name);
  return name;
}

// The same name for an asynchronous caller: a launch directory on an unresponsive mount is asked of a
// worker thread, never of the event loop. A failure is not remembered, exactly as above.
async function launchDirectoryNameAsync(directory: string): Promise<string> {
  const known = launchDirectoryNames.get(directory);
  if (known !== undefined) return known;
  const resolved = await resolveSystemNameAsync(directory);
  if (resolved.kind !== "named") return directory;
  launchDirectoryNames.set(directory, resolved.name);
  return resolved.name;
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
  return programFolderDenial(path, env, launchDirectory, lazySystemName(path)) !== undefined;
}

/** Why a path inside Keiko's own installation is refused: a closed value, never the path. */
export type InstallationDenialCause =
  "program-folder" | "installation-payload" | "unresolvable-name";

// The operating system's name of a path, asked at most once per judgement and only when a check
// reaches it: the layout checks answer first, and the program-folder and payload checks of one
// request share the single resolution.
function lazySystemName(path: string): () => SystemName {
  let resolved: SystemName | undefined;
  return (): SystemName => (resolved ??= resolveSystemName(path));
}

function programFolderDenial(
  path: string,
  env: Readonly<Record<string, string | undefined>>,
  launchDirectory: string,
  name: () => SystemName,
  folderOf: () => string = () => launchDirectoryName(launchDirectory),
): InstallationDenialCause | undefined {
  if (!launchedFromProgramFolder(env) || !isAbsolute(path)) return undefined;
  const folder = folderOf();
  if (containsPath(launchDirectory, path) || containsPath(folder, path)) return "program-folder";
  const resolved = name();
  if (resolved.kind === "failed") return "unresolvable-name";
  return resolved.kind === "named" && containsPath(folder, resolved.name)
    ? "program-folder"
    : undefined;
}

// The entries of an installation's payload folder `system/Keiko` (keiko-cli `portable-shared.ts`
// `layoutFor`, built by `scripts/build-standalone-package.mjs`): the app and runtime folders, the
// portable marker folder, and the macOS bundle. Duplicated on purpose like the launch declaration:
// the server must not depend on the CLI, and keiko-cli's `portable-shared.test.ts` feeds the real
// layout into `insideInstallationPayload`.
const PAYLOAD_ENTRIES: readonly string[] = ["app", "runtime", ".portable", "Keiko.app"];

function startsAt(segments: readonly string[], index: number, names: readonly string[]): boolean {
  return names.every((name, offset) => segments[index + offset] === name);
}

// A Windows path (a drive letter, a backslash or a UNC share) names a case-insensitive file system;
// a POSIX path keeps its case, so `~/code/system/keiko/app` is a person's folder there.
function windowsShaped(path: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(path) || path.includes("\\");
}

function layoutNamesPayload(path: string): boolean {
  if (!isAbsolute(path) && !windowsShaped(path)) return false;
  const fold = windowsShaped(path) || process.platform === "win32";
  const spell = (name: string): string => (fold ? name.toLowerCase() : name);
  const segments = path
    .split(/[\\/]+/u)
    .filter((segment) => segment !== "")
    .map(spell);
  const entries = new Set(PAYLOAD_ENTRIES.map(spell));
  const npmPackage = ["node_modules", "@oscharko-dev", "keiko"];
  const payload = ["system", "Keiko"].map(spell);
  return segments.some((_, index) => {
    if (startsAt(segments, index, npmPackage)) return true;
    const entry = segments[index + 2];
    return startsAt(segments, index, payload) && entry !== undefined && entries.has(entry);
  });
}

/**
 * Whether an absolute path lies inside the program files of any Keiko installation, judged by the
 * folder layout alone: the standalone and in-place payload `system/Keiko/{app,runtime,.portable,
 * Keiko.app}` and the npm folder's `node_modules/@oscharko-dev/keiko`. The launch declaration only
 * knows the running installation, so a project row left in the shared state folder by an older
 * installation (or one registered from another one) is recognised here instead (ADR-0121 D9). Both
 * separators are read; letter case is ignored only for a Windows-shaped path (drive letter,
 * backslash, UNC share) and on a Windows host, so a lower-case POSIX folder is never mistaken for a
 * payload. A path that exists is also judged by the name the operating system gives it, so a link to
 * a payload is caught, and a path whose name cannot be resolved for another reason than not existing is
 * refused. A relative path is not judged.
 */
export function insideInstallationPayload(path: string): boolean {
  return payloadDenial(path, lazySystemName(path)) !== undefined;
}

function payloadDenial(path: string, name: () => SystemName): InstallationDenialCause | undefined {
  if (layoutNamesPayload(path)) return "installation-payload";
  if (!isAbsolute(path)) return undefined;
  const resolved = name();
  if (resolved.kind === "failed") return "unresolvable-name";
  return resolved.kind === "named" && resolved.name !== path && layoutNamesPayload(resolved.name)
    ? "installation-payload"
    : undefined;
}

/**
 * Which part of Keiko's own installation, if any, refuses an absolute path: its program folder, the
 * payload of any installation, or a name the operating system could not give (refused, never read as
 * outside). One resolution of the path serves every check, so a denial costs one `realpath`, and the
 * closed cause is what a caller records on the body-free workspace-root denial line.
 */
export function installationDenialCause(
  path: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  launchDirectory: string = process.cwd(),
): InstallationDenialCause | undefined {
  const name = lazySystemName(path);
  return programFolderDenial(path, env, launchDirectory, name) ?? payloadDenial(path, name);
}

/**
 * `installationDenialCause` for a caller that is already asynchronous. The lexical checks answer
 * first and need no filesystem; only a path they leave open is resolved, and that resolution is
 * asynchronous, so a slow mount delays this request alone. The verdict is the synchronous one:
 * links are followed, and a name the system cannot give is refused.
 */
export async function installationDenialCauseAsync(
  path: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  launchDirectory: string = process.cwd(),
): Promise<InstallationDenialCause | undefined> {
  const asked = { name: false };
  const lexical = (): SystemName => {
    asked.name = true;
    return { kind: "missing" };
  };
  const folder = launchedFromProgramFolder(env)
    ? await launchDirectoryNameAsync(launchDirectory)
    : launchDirectory;
  const folderOf = (): string => folder;
  const first =
    programFolderDenial(path, env, launchDirectory, lexical, folderOf) ??
    payloadDenial(path, lexical);
  if (first !== undefined || !asked.name) return first;
  const resolved = await resolveSystemNameAsync(path);
  const name = (): SystemName => resolved;
  return (
    programFolderDenial(path, env, launchDirectory, name, folderOf) ?? payloadDenial(path, name)
  );
}
