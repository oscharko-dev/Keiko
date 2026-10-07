import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { IsolatedRunPlan, RuntimeGatewayFilesystem } from "./types.js";

const MACOS_RUNTIME_READ_ROOTS = [
  "/System",
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

const GATEWAY_FILESYSTEM_KEYS = new Set([
  "workspaceRoot",
  "workspaceAccess",
  "privateStateRoot",
  "runtimeReadRoot",
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
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  try {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== GATEWAY_FILESYSTEM_KEYS.size) return undefined;
    if (
      !Object.entries(descriptors).every(
        ([key, entry]) => GATEWAY_FILESYSTEM_KEYS.has(key) && Object.hasOwn(entry, "value"),
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
    value.workspaceAccess !== "read-only" ||
    !validRoot(value.workspaceRoot) ||
    !validRoot(value.privateStateRoot) ||
    !validRoot(value.runtimeReadRoot)
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
    "(deny file-read* file-write* network* mach-lookup appleevent-send lsopen)" +
    `(allow file-read* ${pathFilters("subpath", reads)} ${pathFilters("literal", READ_LITERALS)})` +
    `(allow file-read-metadata ${pathFilters("literal", ancestors(plan.cwd))})` +
    `(allow file-write* (subpath ${JSON.stringify(plan.cwd)}) (literal "/dev/null"))`
  );
}
