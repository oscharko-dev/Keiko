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
const OPENSSL_NODE_FLAGS: ReadonlySet<string> = new Set([
  "--openssl-legacy-provider",
  "--openssl-shared-config",
  "--enable-fips",
  "--force-fips",
]);
const OPENSSL_CONFIG_OPTION = "--openssl-config";

interface NodeOptionScan {
  readonly tokens: string[];
  quoted: boolean;
  current: string | undefined;
}

function endNodeOption(scan: NodeOptionScan): void {
  if (scan.current !== undefined) scan.tokens.push(scan.current);
  scan.current = undefined;
}

// One character of NODE_OPTIONS; the index of the next one, or -1 for an escape Node refuses.
function scanNodeOptionCharacter(scan: NodeOptionScan, value: string, index: number): number {
  const character = value.charAt(index);
  if (character === "\\" && scan.quoted) {
    if (index + 1 === value.length) return -1;
    scan.current = (scan.current ?? "") + value.charAt(index + 1);
    return index + 2;
  }
  if (character === " " && !scan.quoted) endNodeOption(scan);
  else if (character === '"') scan.quoted = !scan.quoted;
  else scan.current = (scan.current ?? "") + character;
  return index + 1;
}

/**
 * NODE_OPTIONS split as Node splits it (`ParseNodeOptionsEnvVar`, src/node_options.cc): a space
 * outside double quotes ends an option, a double quote opens or closes a quoted run, and inside one
 * a backslash takes the next character literally. Node refuses an unterminated quote or a trailing
 * escape, and so does this: undefined.
 */
function nodeOptionTokens(value: string): readonly string[] | undefined {
  const scan: NodeOptionScan = { tokens: [], quoted: false, current: undefined };
  for (let index = 0; index < value.length;) {
    index = scanNodeOptionCharacter(scan, value, index);
    if (index === -1) return undefined;
  }
  if (scan.quoted) return undefined;
  endNodeOption(scan);
  return scan.tokens;
}

/** An option's name, with Node's equivalence of `_` and `-`, and its inline `=` value. */
function nodeOptionParts(token: string): { readonly name: string; readonly value?: string } {
  const separator = token.indexOf("=");
  const name = (separator === -1 ? token : token.slice(0, separator)).replaceAll("_", "-");
  return separator === -1 ? { name } : { name, value: token.slice(separator + 1) };
}

// The OpenSSL option at `index`: the configuration file it names, if any, and the index after it.
// `--openssl-config` takes its file inline (`=file`) or as the next option, as Node does.
function openSslNodeOption(
  tokens: readonly string[],
  index: number,
): { readonly file?: string; readonly next: number } | undefined {
  const option = nodeOptionParts(tokens[index] ?? "");
  if (OPENSSL_NODE_FLAGS.has(option.name) && option.value === undefined) return { next: index + 1 };
  if (option.name !== OPENSSL_CONFIG_OPTION) return undefined;
  const file = option.value ?? tokens[index + 1];
  if (file === undefined || file === "") return undefined;
  return { file, next: option.value === undefined ? index + 2 : index + 1 };
}

/**
 * The configuration files NODE_OPTIONS names when it consists of nothing but Node's OpenSSL and
 * FIPS switches; undefined when it holds anything else or does not parse.
 */
function openSslNodeConfigurations(value: string | undefined): readonly string[] | undefined {
  const tokens = value === undefined ? undefined : nodeOptionTokens(value);
  if (tokens === undefined || tokens.length === 0) return undefined;
  const files: string[] = [];
  for (let index = 0; index < tokens.length;) {
    const option = openSslNodeOption(tokens, index);
    if (option === undefined) return undefined;
    if (option.file !== undefined) files.push(option.file);
    index = option.next;
  }
  return files;
}

/** NODE_OPTIONS that consists of nothing but Node's OpenSSL and FIPS switches. */
export function nativeOpenSslNodeOptions(value: string | undefined): boolean {
  return openSslNodeConfigurations(value) !== undefined;
}

function openSslLocations(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  const configuration = env.OPENSSL_CONF;
  const nodeConfiguration = openSslNodeConfigurations(env.NODE_OPTIONS) ?? [];
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
