import { basename, dirname, isAbsolute } from "node:path";
import type { IsolatedRunPlan } from "./types.js";

const MACOS_RUNTIME_READ_ROOTS = [
  "/System",
  "/System/Volumes/Preboot/Cryptexes/OS",
  "/Library/Apple",
  "/private/var/db/dyld",
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
