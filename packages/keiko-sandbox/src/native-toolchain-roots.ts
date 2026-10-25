import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import { readdirSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative } from "node:path";

// The read-only support roots of the project's toolchains for the native profile (#3897). The
// launcher's `PATH` names where `node`, `npm`, `python`, `cargo` and friends live; their install
// prefixes (and, for Homebrew, the shared prefix whose Cellar holds the sibling libraries) are the
// only directories outside the system, the workspace and the run-private state that the kernel
// boundary opens for reading. The user's home itself, or anything above it, is never a root.
//
// A `PATH` entry becomes an install prefix only when it is one: outside the user's home, or a
// directory at least two levels below it (`~/.nvm/versions/node/v24`, `~/.sdkman/candidates/java/21`).
// A user-generic bin directory directly under the home (`~/bin`, `~/.local/bin`, `~/.cargo/bin`)
// has a parent that is the user's own data: `~/.local/share/opencode/auth.json`, `~/.local/state/gh`,
// `~/.cargo/credentials.toml`. It admits the bin directory itself and nothing else, plus the install
// prefix of an executable in it that is a symbolic link into a bin directory of a real prefix.

const ROOTS_MAX = 64;
/** The most entries of one generic bin directory examined for links into real install prefixes. */
const LINKED_ENTRIES_MAX = 512;
// Already readable through the system roots of both native backends.
const SYSTEM_PREFIXES = ["/usr", "/bin", "/sbin"] as const;
const BIN_DIRECTORIES: ReadonlySet<string> = new Set(["bin", "sbin"]);
const HOMEBREW_CELLAR = /^(\/opt\/homebrew|\/usr\/local)\/Cellar\//u;

/**
 * Locations under the user's home that hold credentials or the user's other agent state. The
 * backend passes them as the native profile's denied read roots, and no toolchain root may contain
 * or sit inside one of them, so a `PATH` entry can never reopen what the denial closes.
 * `CREDENTIAL_PATH_DENY_PATTERNS` (keiko-contracts) remains the final, name-based kernel rule.
 */
const HOME_DENIED_LOCATIONS: readonly string[] = Object.freeze([
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".azure",
  ".docker",
  ".netrc",
  ".pgpass",
  ".git-credentials",
  ".config/gh",
  ".config/gcloud",
  "Library/Keychains",
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".local/share/opencode",
  ".local/state/gh",
]);

export function nativeHomeDeniedReadRoots(home: string): readonly string[] {
  return HOME_DENIED_LOCATIONS.map((location) => join(home, location));
}

function insideOrEqual(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith("../") && !isAbsolute(path));
}

function installPrefix(directory: string): string {
  const cellar = HOMEBREW_CELLAR.exec(directory);
  if (cellar?.[1] !== undefined) return cellar[1];
  return BIN_DIRECTORIES.has(basename(directory)) ? dirname(directory) : directory;
}

function admissible(root: string, home: string): boolean {
  return (
    root.split("/").length > 2 &&
    !/[\0\r\n]/u.test(root) &&
    !insideOrEqual(root, home) &&
    !SYSTEM_PREFIXES.some((system) => insideOrEqual(system, root)) &&
    !nativeHomeDeniedReadRoots(home).some(
      (denied) => insideOrEqual(denied, root) || insideOrEqual(root, denied),
    )
  );
}

/** A real install prefix: outside the home, or at least two levels below it. */
function isInstallPrefix(prefix: string, home: string): boolean {
  if (!admissible(prefix, home)) return false;
  return !insideOrEqual(home, prefix) || relative(home, prefix).split("/").length >= 2;
}

/** A `PATH` entry or link target that does not exist or cannot be read is simply not a root. */
const UNREADABLE_CODES = new Set(["ENOENT", "ENOTDIR", "EACCES", "ELOOP"]);

function tolerated<T>(operation: () => T): T | undefined {
  try {
    return operation();
  } catch (error) {
    if (error instanceof Error && "code" in error && UNREADABLE_CODES.has(String(error.code)))
      return undefined;
    throw error;
  }
}

function resolvedPath(path: string): string | undefined {
  return isAbsolute(path) ? tolerated(() => realpathSync(path)) : undefined;
}

/**
 * The install prefixes that executables in a generic bin directory link into (`~/.local/bin/node`
 * -> `~/.nvm/versions/node/v24/bin/node`). Only a link whose target sits in a bin directory of a
 * real install prefix qualifies; the target's neighbours are never opened beyond that prefix.
 */
function linkedInstallPrefixes(directory: string, home: string): readonly string[] {
  const entries = tolerated(() => readdirSync(directory, { withFileTypes: true })) ?? [];
  return entries
    .slice(0, LINKED_ENTRIES_MAX)
    .filter((entry) => entry.isSymbolicLink())
    .flatMap((entry) => {
      const target = resolvedPath(join(directory, entry.name));
      const targetDirectory = target === undefined ? undefined : dirname(target);
      if (targetDirectory === undefined || !BIN_DIRECTORIES.has(basename(targetDirectory)))
        return [];
      const prefix = installPrefix(targetDirectory);
      return isInstallPrefix(prefix, home) ? [prefix] : [];
    });
}

function rootsFor(entry: string, home: string): readonly string[] {
  const directory = resolvedPath(entry);
  if (directory === undefined) return [];
  const prefix = installPrefix(directory);
  if (isInstallPrefix(prefix, home)) return [prefix];
  // Not an install prefix (`~/.local/bin` -> `~/.local`, `~/bin` -> `~`): the directory itself.
  return admissible(directory, home) ? [directory, ...linkedInstallPrefixes(directory, home)] : [];
}

/** Deterministic, bounded and free of nested duplicates; empty when nothing qualifies. */
export function nativeToolchainReadRoots(
  pathValue: string | undefined,
  home: string,
): readonly string[] {
  const resolvedHome = resolvedPath(home) ?? home;
  const roots = [
    ...new Set(
      (pathValue ?? "").split(delimiter).flatMap((entry) => rootsFor(entry, resolvedHome)),
    ),
  ].sort(compareStrings);
  return roots
    .filter((root) => !roots.some((other) => other !== root && insideOrEqual(other, root)))
    .slice(0, ROOTS_MAX);
}

/** The environment names that carry an operator's explicit OpenSSL configuration (#3901 AC4). */
export const NATIVE_OPENSSL_ENV_NAMES: readonly string[] = Object.freeze([
  "OPENSSL_CONF",
  "OPENSSL_CONF_INCLUDE",
  "OPENSSL_MODULES",
]);

// Node's own OpenSSL and FIPS switches; any other option keeps NODE_OPTIONS out of the run.
const OPENSSL_NODE_OPTION = /^--(?:openssl-[a-z-]+(?:=\S+)?|enable-fips|force-fips)$/u;
const OPENSSL_CONFIG_OPTION = /^--openssl-config=(\S+)$/u;

/** NODE_OPTIONS that consists of nothing but Node's OpenSSL and FIPS switches. */
export function nativeOpenSslNodeOptions(value: string | undefined): boolean {
  const options =
    value
      ?.trim()
      .split(/\s+/u)
      .filter((option) => option !== "") ?? [];
  return options.length > 0 && options.every((option) => OPENSSL_NODE_OPTION.test(option));
}

function openSslLocations(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  const configuration = env.OPENSSL_CONF;
  const nodeConfiguration = nativeOpenSslNodeOptions(env.NODE_OPTIONS)
    ? (env.NODE_OPTIONS ?? "")
        .trim()
        .split(/\s+/u)
        .flatMap((option) => OPENSSL_CONFIG_OPTION.exec(option)?.[1] ?? [])
    : [];
  const files = [...(configuration === undefined ? [] : [configuration]), ...nodeConfiguration];
  const directories = [env.OPENSSL_CONF_INCLUDE, env.OPENSSL_MODULES].flatMap((value) =>
    value === undefined ? [] : [value],
  );
  return [
    ...files.flatMap((file) => {
      const real = resolvedPath(file);
      return real === undefined ? [] : [dirname(real)];
    }),
    ...directories.flatMap((directory) => resolvedPath(directory) ?? []),
  ];
}

/**
 * The directories an operator's explicit OpenSSL configuration names: the configuration file's
 * directory (its includes and FIPS module configuration live beside it), the include directory and
 * the provider modules. They open read-only, under the same rule as a toolchain root: never the
 * user's home or above it, a system prefix, or a credential store. Nothing when nothing is named.
 */
export function nativeOpenSslReadRoots(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): readonly string[] {
  const resolvedHome = resolvedPath(home) ?? home;
  return [...new Set(openSslLocations(env).filter((root) => admissible(root, resolvedHome)))].sort(
    compareStrings,
  );
}
