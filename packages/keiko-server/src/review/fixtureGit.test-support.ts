// The absolute Git executable review fixtures spawn: resolved once through keiko-git's own trusted
// PATH scan, so no fixture launches a bare `git` that a writable PATH entry could shadow.

import { tmpdir } from "node:os";
import { resolveGitExecutable } from "@oscharko-dev/keiko-git";

function resolvedFixtureGit(): string {
  const resolution = resolveGitExecutable(process.env, tmpdir());
  if (!resolution.ok) throw new Error(`fixture git unavailable: ${resolution.reason}`);
  return resolution.path;
}

export const FIXTURE_GIT = resolvedFixtureGit();
