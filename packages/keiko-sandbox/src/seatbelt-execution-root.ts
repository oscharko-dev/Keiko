import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { CREDENTIAL_PATH_SEATBELT_RULE } from "./seatbelt-credential-paths.js";
import type { IsolatedRunPlan, RuntimeGatewayFilesystem } from "./types.js";

const MACOS_RUNTIME_READ_ROOTS = [
  "/System/Library",
  "/System/Cryptexes",
  "/System/Volumes/Preboot/Cryptexes/OS",
  "/Library/Apple",
  "/private/var/db/dyld",
  // Bun's native Intl.Segmenter loads the immutable macOS ICU data file during startup.
  "/usr/share/icu",
] as const;
const READ_LITERALS = [
  "/dev/null",
  "/dev/random",
  "/dev/urandom",
  "/private/var/select/sh",
  "/",
  "/System/Volumes",
  // dyld enumerates this directory before opening its OS cache; its other children stay denied.
  "/System/Volumes/Preboot",
] as const;

function pathFilters(kind: "literal" | "subpath", paths: readonly string[]): string {
  return [...new Set(paths)].map((path) => `(${kind} ${JSON.stringify(path)})`).join(" ");
}

function ancestors(path: string): readonly string[] {
  const parents: string[] = [];
  for (let current = path; ; current = dirname(current)) {
    parents.push(current);
    if (dirname(current) === current) return parents;
  }
}

function commandReadRoots(command: string): readonly string[] {
  if (!isAbsolute(command)) return [];
  const directory = dirname(command);
  // Resolved npm launchers import sibling lib/ and node_modules/ under their own trusted package.
  const npmRoot = dirname(directory);
  const npmLauncher = command.endsWith("/npm-cli.js") || command.endsWith("/npx-cli.js");
  return npmLauncher && basename(directory) === "bin" && basename(npmRoot) === "npm"
    ? [npmRoot]
    : [directory];
}

function installedLibraryReads(systemReadRoots: readonly string[]): string {
  const prefixes = ["/opt/homebrew", "/usr/local"].filter((prefix) =>
    systemReadRoots.some((root) => root.startsWith(`${prefix}/Cellar/`)),
  );
  return prefixes
    .map((prefix) => {
      const library = `^${prefix}/(Cellar/[^/]+/[^/]+|opt/[^/]+)/lib/[^/]+[.]dylib$`;
      return (
        `(allow file-read-metadata (subpath ${JSON.stringify(prefix + "/Cellar")}) ` +
        `(subpath ${JSON.stringify(prefix + "/opt")}) ` +
        `(subpath ${JSON.stringify(prefix + "/bin")}))` +
        `(allow file-read-data (regex ${JSON.stringify(library)}))`
      );
    })
    .join("");
}

// What the native profile's read boundary admits besides the workspace, the private state and the
// server-named toolchain roots (#3897): the system software every shell, interpreter and Git needs
// to start. `/System/Volumes/Data` and the user's home are deliberately absent, so a path spelled
// through the data-volume alias is as unreadable as the home-relative one.
const NATIVE_SYSTEM_READ_ROOTS = [
  ...MACOS_RUNTIME_READ_ROOTS,
  "/usr",
  "/bin",
  "/sbin",
  "/Library/Developer",
  "/Library/Frameworks",
  "/Library/Java",
  "/Library/Python",
  "/Library/Ruby",
  "/Applications/Xcode.app",
  "/private/etc",
  "/private/var/db/timezone",
  "/private/var/db/xcode_select_link",
  "/private/var/select",
] as const;
// `/etc`, `/var` and `/tmp` are symlinks into `/private`; resolving a path through them (the
// resolver reads `/etc/hosts`) needs the link itself, and nothing beneath it.
const NATIVE_SYMLINK_READS = ["/etc", "/var", "/tmp"] as const;
const NATIVE_DEVICE_READS = [
  "/dev/null",
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/tty",
] as const;
const NATIVE_TOOLCHAIN_ROOTS_MAX = 64;

const GATEWAY_FILESYSTEM_KEYS = new Set([
  "workspaceRoot",
  "workspaceAccess",
  "privateStateRoot",
  "runtimeReadRoot",
]);
const OPTIONAL_GATEWAY_FILESYSTEM_KEYS = new Set(["deniedReadRoots", "toolchainReadRoots"]);

function validRoot(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 4_096 &&
    isAbsolute(value) &&
    value !== "/" &&
    !/[\0\r\n]/u.test(value) &&
    resolve(value) === value
  );
}

/** Copy data only; an input accessor must never execute at the isolation boundary. */
export function copyRuntimeGatewayFilesystem(value: unknown): RuntimeGatewayFilesystem | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    if (Array.isArray(value)) return undefined;
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = new Set(Reflect.ownKeys(descriptors));
    if (![...GATEWAY_FILESYSTEM_KEYS].every((key) => keys.has(key))) return undefined;
    if (
      !Object.entries(descriptors).every(
        ([key, entry]) =>
          (GATEWAY_FILESYSTEM_KEYS.has(key) || OPTIONAL_GATEWAY_FILESYSTEM_KEYS.has(key)) &&
          Object.hasOwn(entry, "value"),
      )
    )
      return undefined;
    const record = Object.fromEntries(
      Object.entries(descriptors).map(([key, entry]) => [key, entry.value as unknown]),
    );
    return validGatewayFilesystem(record) ? Object.freeze(record) : undefined;
  } catch {
    return undefined;
  }
}

function validGatewayFilesystem(
  value: Record<string, unknown>,
): value is Record<string, unknown> & RuntimeGatewayFilesystem {
  if (
    (value.workspaceAccess !== "read-only" && value.workspaceAccess !== "read-write") ||
    !validRoot(value.workspaceRoot) ||
    !validRoot(value.privateStateRoot) ||
    !validRoot(value.runtimeReadRoot) ||
    !validDeniedReadRoots(value.deniedReadRoots) ||
    !validToolchainReadRoots(value.toolchainReadRoots)
  )
    return false;
  // The normal <workspace>/.keiko private metadata subtree remains writable. It must never
  // contain the workspace itself or overlap the immutable runtime capability.
  return (
    outsideRoot(value.privateStateRoot, value.workspaceRoot) &&
    outsideRoot(value.privateStateRoot, value.runtimeReadRoot) &&
    outsideRoot(value.runtimeReadRoot, value.privateStateRoot)
  );
}

function validDeniedReadRoots(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every((root) => typeof root === "string" && validRoot(root))
  );
}

function validToolchainReadRoots(value: unknown): boolean {
  if (value === undefined) return true;
  // A toolchain root is an install prefix (`/opt/homebrew`, `~/.nvm/versions/node/v24`), never a
  // top-level directory such as `/Users` or `/opt` that would open everything beneath it.
  return (
    Array.isArray(value) &&
    value.length <= NATIVE_TOOLCHAIN_ROOTS_MAX &&
    value.every((root) => typeof root === "string" && validRoot(root) && root.split("/").length > 2)
  );
}

function outsideRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === ".." || path.startsWith("../") || isAbsolute(path);
}

/**
 * Compose native service containment with the existing gateway network/exec owner. This limits
 * the process to the admitted root union. Sensitive/model access within that union still requires
 * the native permission hook; the runtime itself must read its own state and Git metadata.
 */
export function gatewayFilesystemSeatbeltRules(
  filesystem: RuntimeGatewayFilesystem,
  childExecutable: string,
): string {
  const closed = copyRuntimeGatewayFilesystem(filesystem);
  if (closed === undefined) throw new TypeError("gateway-seatbelt-filesystem-invalid");
  const roots = [closed.workspaceRoot, closed.privateStateRoot, closed.runtimeReadRoot];
  const reads = [...roots, ...MACOS_RUNTIME_READ_ROOTS, ...commandReadRoots(childExecutable)];
  return (
    "(deny file-read* file-write*)" +
    `(allow file-read* ${pathFilters("subpath", reads)} ${pathFilters("literal", READ_LITERALS)})` +
    `(allow file-read-metadata ${pathFilters("literal", roots.flatMap(ancestors))})` +
    `(allow file-write* (subpath ${JSON.stringify(closed.privateStateRoot)}) (literal "/dev/null"))`
  );
}

function nativeReadRoots(closed: RuntimeGatewayFilesystem): readonly string[] {
  return [
    ...NATIVE_SYSTEM_READ_ROOTS,
    ...(closed.toolchainReadRoots ?? []),
    closed.runtimeReadRoot,
  ];
}

/**
 * The native profile's filesystem rules (#3897). The boundary is a kernel READ allowlist, not only
 * a write restriction: the process and every descendant (shells, interpreters, Git, npm) read the
 * workspace, the run-private state (whose `tmp` is the runtime's TMPDIR), the runtime's own payload,
 * the system software and the server-named toolchain roots, and nothing else: the shared system
 * temporary directories are NOT admitted, because another process's files there are as unrelated
 * to the task as any other file outside the workspace. Writes are limited to the workspace and the
 * private state. The denied roots (credential stores, Keiko's own state) are unreadable even inside
 * an otherwise allowed tree, and credential-named files (`.env`, keys, tokens, the shared list in
 * keiko-contracts) are unreadable and unwritable wherever they sit, including inside the workspace.
 * Rule order matters: the last matching Seatbelt rule wins, so the workspace and private state are
 * re-allowed after the denied roots that may contain them, and the credential names are denied last
 * of all.
 */
export function nativeWorkspaceSeatbeltRules(filesystem: RuntimeGatewayFilesystem): string {
  const closed = copyRuntimeGatewayFilesystem(filesystem);
  if (closed?.workspaceAccess !== "read-write")
    throw new TypeError("native-seatbelt-filesystem-invalid");
  const reads = nativeReadRoots(closed);
  const own = [closed.workspaceRoot, closed.privateStateRoot];
  const denied = closed.deniedReadRoots ?? [];
  return (
    "(deny file-read* file-write*)" +
    `(allow file-read* ${pathFilters("subpath", [...reads, ...own])} ` +
    `${pathFilters("literal", [...READ_LITERALS, ...NATIVE_SYMLINK_READS, ...NATIVE_DEVICE_READS])} ` +
    '(regex #"^/dev/(ttys[0-9]+|fd/[0-9]+)$"))' +
    // Path resolution stats every ancestor of every admitted root (realpath, Git's repository
    // discovery); the ancestors expose their metadata only, never their entries or siblings.
    `(allow file-read-metadata ${pathFilters("literal", [...reads, ...own, "/System/Volumes/Data"].flatMap(ancestors))})` +
    `(allow file-write* ${pathFilters("subpath", own)} ` +
    '(literal "/dev/null") (regex #"^/dev/tty") (literal "/dev/stdout") (literal "/dev/stderr"))' +
    (denied.length === 0 ? "" : `(deny file-read* file-write* ${pathFilters("subpath", denied)})`) +
    // Keiko's managed task workspaces live inside its own state directory, which is a denied
    // root; the workspace is re-allowed after the denial like the private state (#3897 lab:
    // OpenCode 2.0.10 could not even realpath its workspace in the customer shape).
    `(allow file-read* file-write* ${pathFilters("subpath", own)})` +
    // A denied root may be an ancestor of the workspace and of the private state (Keiko's own
    // state directory holds both). Path resolution stats every ancestor, Git refuses a snapshot
    // `--git-dir` whose parent it cannot stat, and the runtime opens the workspace's parent to
    // canonicalize it (#3897 lab: "Invalid path ... Operation not permitted", then
    // "FileSystem.realPath" on the parent). The ancestor directory NODES are therefore readable
    // (their entry names), never their files or sibling subtrees: `literal` matches the directory
    // itself, and every denied subtree stays denied.
    `(allow file-read* ${pathFilters("literal", own.flatMap(ancestors))})` +
    CREDENTIAL_PATH_SEATBELT_RULE
  );
}

export function executionRootSeatbeltProfile(
  plan: IsolatedRunPlan,
  systemReadRoots: readonly string[],
): string {
  if (!isAbsolute(plan.cwd) || /[\0\r\n]/u.test(plan.cwd)) {
    throw new TypeError("seatbelt-execution-root-invalid");
  }
  const reads = [
    plan.cwd,
    ...systemReadRoots,
    ...MACOS_RUNTIME_READ_ROOTS,
    ...commandReadRoots(plan.command),
  ];
  return (
    "(version 1)(allow default)" +
    `(deny file-read* file-write* ${plan.network === "none" ? "network* " : ""}mach-lookup appleevent-send lsopen)` +
    "(deny signal process-info*)" +
    "(allow signal process-info* (target self) (target same-sandbox))" +
    installedLibraryReads(systemReadRoots) +
    `(allow file-read* ${pathFilters("subpath", reads)} ${pathFilters("literal", READ_LITERALS)})` +
    `(allow file-read-metadata ${pathFilters("literal", reads.flatMap(ancestors))})` +
    `(allow file-write* (subpath ${JSON.stringify(plan.cwd)}) (literal "/dev/null"))`
  );
}
