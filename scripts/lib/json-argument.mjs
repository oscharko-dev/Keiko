// The JSON file a command-line check reads from its one argument (#4519).
//
// A report or evidence check names its input as `argv[2]`. A missing argument is a usage error
// (exit code 2) and an unreadable or invalid file a failure (exit code 1), each reported on one
// `<name>: FAIL` line, so every such check fails the same way.

import { readJsonFile } from "./json.mjs";

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
    return { value: readJsonFile(file) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    io.error(`${name}: FAIL the ${input} could not be read (${detail})`);
    return { exitCode: 1 };
  }
}
