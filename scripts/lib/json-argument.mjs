// The JSON file a command-line check reads from its one argument (#4519).
//
// A report or evidence check names its input as `argv[2]`. A missing argument is a usage error
// (exit code 2) and an unreadable, invalid or misplaced file a failure (exit code 1), each reported
// on one `<name>: FAIL` line, so every such check fails the same way.
//
// The argument is untrusted: a check reads only a `.json` file whose canonical path lies in the
// working directory, the home folder or the temporary folder, never a file elsewhere that a crafted
// argument or a link points at (SonarCloud jssecurity:S8707).

import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";

import { readJsonFile } from "./json.mjs";

/**
 * The canonical permitted folders. A filesystem root is none of them: a working directory of `/`,
 * as in a container, would otherwise admit every `.json` file on the machine.
 */
export function permittedRoots(folders = [process.cwd(), homedir(), tmpdir()]) {
  return folders.map((folder) => realpathSync(folder)).filter((root) => root !== parse(root).root);
}

/**
 * The canonical path of `file` when it is a `.json` file inside one of `roots` (canonical paths),
 * or undefined. A missing file throws, as reading it would.
 */
export function permittedJsonPath(file, roots = permittedRoots()) {
  const candidate = realpathSync(resolve(file));
  if (!candidate.endsWith(".json")) return undefined;
  // `relative` holds for any root, the filesystem root included: a path inside it never climbs out
  // through `..` and is never absolute (another drive on Windows), and the root itself is no file.
  for (const root of roots) {
    const inside = relative(root, candidate);
    const climbs = inside === ".." || inside.startsWith(`..${sep}`);
    if (inside !== "" && !climbs && !isAbsolute(inside)) return candidate;
  }
  return undefined;
}

/**
 * Reads the JSON file named by `argv[2]`. Returns `{ value }` with the parsed content, or
 * `{ exitCode }` after reporting why it could not.
 */
export function readJsonArgument(argv, io, { name, input }) {
  const file = argv[2];
  if (file === undefined || file === "") {
    io.error(`${name}: FAIL usage: node scripts/${name}.mjs <${input}.json>`);
    return { exitCode: 2 };
  }
  try {
    const path = permittedJsonPath(file);
    if (path === undefined) {
      io.error(
        `${name}: FAIL the ${input} must be a .json file in the working directory, the home folder or the temporary folder`,
      );
      return { exitCode: 1 };
    }
    return { value: readJsonFile(path) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    io.error(`${name}: FAIL the ${input} could not be read (${detail})`);
    return { exitCode: 1 };
  }
}
