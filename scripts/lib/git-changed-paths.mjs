import { execFileSync } from "node:child_process";

import { resolveHostExecutable } from "./host-executable.mjs";

export function listChangedGitPaths(baseRef, root) {
  const output = execFileSync(
    resolveHostExecutable("git"),
    ["diff", "--no-renames", "--name-only", "-z", `${baseRef}...HEAD`, "--"],
    { cwd: root, encoding: "utf8" },
  );
  return output.split("\0").filter((path) => path.length > 0);
}
