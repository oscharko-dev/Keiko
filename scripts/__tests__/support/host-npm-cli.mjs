import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

import { npmCliCandidates } from "../../standalone/npm/keiko-npm.mjs";

// The npm CLI script an npm on PATH runs: npm.cmd beside its node_modules, or a link to it.
function npmCliOnPath(folder) {
  const windows = join(folder, "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(join(folder, "npm.cmd")) && existsSync(windows)) return windows;
  const link = join(folder, "npm");
  return existsSync(link) && realpathSync(link).endsWith("npm-cli.js")
    ? realpathSync(link)
    : undefined;
}

/** The npm of the Node.js that runs the tests: the one `npm test` names, beside it, or on PATH. */
export function locateNpmCli(env = process.env) {
  const named = env.npm_execpath;
  if (named !== undefined && named.endsWith("npm-cli.js") && existsSync(named)) return named;
  const beside = npmCliCandidates(dirname(process.execPath)).find((path) => existsSync(path));
  if (beside !== undefined) return beside;
  for (const folder of (env.PATH ?? "").split(delimiter)) {
    const found = npmCliOnPath(folder);
    if (found !== undefined) return found;
  }
  throw new Error("no npm found for the Node.js that runs these tests");
}
