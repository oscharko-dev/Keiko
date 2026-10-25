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
const NATIVE_DENIED_READ_ROOTS_MAX = 64;
const NATIVE_PROTECTED_WRITE_ROOTS_MAX = 64;
const NATIVE_LINK_FREE_WRITE_ROOTS_MAX = 8;
const NATIVE_GIT_METADATA_READ_ROOTS_MAX = 4;
const NATIVE_EXTERNAL_READ_ROOTS_MAX = 8;

const GATEWAY_FILESYSTEM_KEYS = new Set([
  "workspaceRoot",
  "workspaceAccess",
  "privateStateRoot",
  "runtimeReadRoot",
]);
const OPTIONAL_GATEWAY_FILESYSTEM_KEYS = new Set([
  "deniedReadRoots",
  "toolchainReadRoots",
  "gitMetadataReadRoots",
  "externalReadRoots",
  "protectedWriteRoots",
  "linkFreeWriteRoots",
]);

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
    !validOptionalRoots(value)
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

function validOptionalRoots(value: Record<string, unknown>): boolean {
  return (
    validRootList(value.deniedReadRoots, NATIVE_DENIED_READ_ROOTS_MAX, () => true) &&
    // A toolchain root is an install prefix (`/opt/homebrew`, `~/.nvm/versions/node/v24`), never a
    // top-level directory such as `/Users` or `/opt` that would open everything beneath it.
    validRootList(
      value.toolchainReadRoots,
      NATIVE_TOOLCHAIN_ROOTS_MAX,
      (root) => root.split("/").length > 2,
    ) &&
    validGitMetadataReadRoots(value) &&
    validExternalReadRoots(value) &&
    validProtectedWriteRoots(value) &&
    validLinkFreeWriteRoots(value)
  );
}

/**
 * An accepted external reference (#3900 AC5) is read-only and lies outside the workspace and the
 * private state, never above either, and never a top-level directory such as `/Users`.
 */
function validExternalReadRoots(value: Record<string, unknown>): boolean {
  if (value.externalReadRoots === undefined) return true;
  const own = [value.workspaceRoot, value.privateStateRoot];
  return (
    value.workspaceAccess === "read-write" &&
    validRootList(
      value.externalReadRoots,
      NATIVE_EXTERNAL_READ_ROOTS_MAX,
      (root) =>
        root.split("/").length > 3 &&
        own.every(
          (path) => typeof path === "string" && outsideRoot(root, path) && outsideRoot(path, root),
        ),
    )
  );
}

/** A Git metadata root lies outside the workspace and the private state, never above either. */
function validGitMetadataReadRoots(value: Record<string, unknown>): boolean {
  if (value.gitMetadataReadRoots === undefined) return true;
  const own = [value.workspaceRoot, value.privateStateRoot];
  return (
    value.workspaceAccess === "read-write" &&
    validRootList(
      value.gitMetadataReadRoots,
      NATIVE_GIT_METADATA_READ_ROOTS_MAX,
      (root) =>
        root.split("/").length > 2 &&
        own.every(
          (path) => typeof path === "string" && outsideRoot(root, path) && outsideRoot(path, root),
        ),
    )
  );
}

/** A link-free root is a private-state directory of the writable native profile. */
function validLinkFreeWriteRoots(value: Record<string, unknown>): boolean {
  if (value.linkFreeWriteRoots === undefined) return true;
  const state = value.privateStateRoot;
  return (
    value.workspaceAccess === "read-write" &&
    typeof state === "string" &&
    validRootList(value.linkFreeWriteRoots, NATIVE_LINK_FREE_WRITE_ROOTS_MAX, (root) =>
      strictlyInside(state, root),
    )
  );
}

/** Own data only: a sparse slot reads as `undefined` and fails the string check. */
function validRootList(value: unknown, max: number, accept: (root: string) => boolean): boolean {
  if (value === undefined) return true;
  return (
    Array.isArray(value) &&
    value.length <= max &&
    Array.from(value as readonly unknown[]).every(
      (root) => typeof root === "string" && validRoot(root) && accept(root),
    )
  );
}

/**
 * A protected root guards a directory the profile otherwise writes, so it must be a strict
 * descendant of the workspace or the private state, and only the writable native profile has one.
 */
function validProtectedWriteRoots(value: Record<string, unknown>): boolean {
  if (value.protectedWriteRoots === undefined) return true;
  const writable = [value.workspaceRoot, value.privateStateRoot].filter(
    (root): root is string => typeof root === "string",
  );
  return (
    value.workspaceAccess === "read-write" &&
    validRootList(value.protectedWriteRoots, NATIVE_PROTECTED_WRITE_ROOTS_MAX, (root) =>
      writable.some((container) => strictlyInside(container, root)),
    )
  );
}

function outsideRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === ".." || path.startsWith("../") || isAbsolute(path);
}

function strictlyInside(root: string, candidate: string): boolean {
  return candidate !== root && !outsideRoot(root, candidate);
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
    // Accepted external references are read-only like a toolchain root: the denied roots and the
    // credential names that follow still win inside them (#3900 AC5).
    ...(closed.externalReadRoots ?? []),
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
    gitMetadataSeatbeltRules(closed) +
    protectedWriteSeatbeltRules(closed) +
    linkFreeWriteSeatbeltRules(closed) +
    CREDENTIAL_PATH_SEATBELT_RULE
  );
}

/**
 * A linked worktree's common Git directory, read-only. It is re-allowed after the denied roots
 * because a repository Keiko cloned can sit inside its own state directory. Its ancestor directory
 * NODES are readable too, like the ancestors of the workspace: Git and the runtime resolve the
 * repository's own working tree (the common directory's parent) with `realpath`, which opens each
 * node, and the original runtime fails to start an instance when that resolution is refused
 * (#3897, customer-shape qualification). A node shows its entry names only, never a file or a
 * sibling subtree. The credential names stay denied by the rule that follows every other one.
 */
function gitMetadataSeatbeltRules(closed: RuntimeGatewayFilesystem): string {
  const roots = closed.gitMetadataReadRoots ?? [];
  if (roots.length === 0) return "";
  return (
    `(allow file-read* ${pathFilters("subpath", roots)})` +
    `(allow file-read* ${pathFilters("literal", roots.flatMap(ancestors))})`
  );
}

/**
 * The run's OpenCode configuration directory holds the policy plugin and the private config, both
 * loaded from the writable private state. The runtime only reads them, so a final denial of every
 * write operation beneath each protected root (create, overwrite, truncate, chmod, rename, unlink,
 * link) leaves them as the server materialized them, whatever a shell child runs. Renaming or
 * removing an intermediate directory would move the protected root away, so the directories
 * between the writable root and the protected root lose create/unlink on themselves (their
 * other entries stay writable). The writable root itself cannot be renamed: its parent is not
 * writable.
 */
function protectedWriteSeatbeltRules(closed: RuntimeGatewayFilesystem): string {
  const roots = closed.protectedWriteRoots ?? [];
  if (roots.length === 0) return "";
  const writable = [closed.workspaceRoot, closed.privateStateRoot];
  const intermediates = roots.flatMap((root) => intermediateDirectories(root, writable));
  return (
    `(deny file-write* ${pathFilters("subpath", roots)})` +
    (intermediates.length === 0
      ? ""
      : `(deny file-write-create file-write-unlink ${pathFilters("literal", intermediates)})`)
  );
}

/**
 * A link-free root (the plan agent's private notes) keeps ordinary files and directories writable,
 * but a symbolic or hard link created inside it could make a note path name a workspace file the
 * policy exempted as a private note (#3897 review). The kernel therefore refuses every link inside
 * the root, the root's own removal or rename, and the creation or removal of the directories
 * between the private state and the root, so a checked path cannot be swapped after the check.
 */
function linkFreeWriteSeatbeltRules(closed: RuntimeGatewayFilesystem): string {
  const roots = closed.linkFreeWriteRoots ?? [];
  if (roots.length === 0) return "";
  const intermediates = roots.flatMap((root) =>
    intermediateDirectories(root, [closed.privateStateRoot]),
  );
  const inside = pathFilters("subpath", roots);
  return (
    `(deny file-write-create (require-all (vnode-type SYMLINK) (require-any ${inside})))` +
    `(deny file-link ${inside})` +
    `(deny file-write-unlink ${pathFilters("literal", roots)})` +
    (intermediates.length === 0
      ? ""
      : `(deny file-write-create file-write-unlink ${pathFilters("literal", intermediates)})`)
  );
}

function intermediateDirectories(root: string, writable: readonly string[]): readonly string[] {
  const container = writable
    .filter((writableRoot) => strictlyInside(writableRoot, root))
    .sort((a, b) => b.length - a.length)[0];
  if (container === undefined) return [];
  const directories: string[] = [];
  for (let current = dirname(root); current !== container; current = dirname(current))
    directories.push(current);
  return directories;
}

/**
 * The one process-authority rule for a Seatbelt profile that starts from `allow default` (ADR-0043,
 * #3901). A confined process and every descendant may signal and inspect itself and the processes
 * of its own sandbox, which covers shells cancelling their children, process groups, a runtime
 * stopping its tree and a descendant reparented to launchd. Any other process of the same OS user
 * is refused: a process outside the run, and the tree of another run, whose sandbox is a separate
 * instance even when the profile text is identical. The check is made on the sender, so the
 * unsandboxed server still stops the runtime it launched. The last matching rule wins, so the
 * `allow` follows the `deny`, and nothing in a profile that includes this rule may match
 * `signal` or `process-info*` afterwards.
 */
export const OWN_PROCESS_TARGETS_SEATBELT_RULE =
  "(deny signal process-info*)" +
  "(allow signal process-info* (target self) (target same-sandbox))";

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
    OWN_PROCESS_TARGETS_SEATBELT_RULE +
    installedLibraryReads(systemReadRoots) +
    `(allow file-read* ${pathFilters("subpath", reads)} ${pathFilters("literal", READ_LITERALS)})` +
    `(allow file-read-metadata ${pathFilters("literal", reads.flatMap(ancestors))})` +
    `(allow file-write* (subpath ${JSON.stringify(plan.cwd)}) (literal "/dev/null"))`
  );
}
