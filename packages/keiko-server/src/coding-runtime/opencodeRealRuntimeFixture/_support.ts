import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveGitExecutable } from "@oscharko-dev/keiko-git";
import { resolveDarwinGitExecutable } from "@oscharko-dev/keiko-sandbox";

/**
 * What an original-runtime suite (`*.real.test.ts`) needs from its host, whichever platform runs it.
 * On Windows those suites start the runtime without a wrapper, because confinement needs the
 * installed gateway service (ADR-0043 D18). Such a run proves persistence against a text-only stub,
 * and no boundary on that host.
 */
export function fixtureGitExecutable(): string {
  if (process.platform === "darwin") return resolveDarwinGitExecutable().path;
  if (process.platform !== "win32") return "/usr/bin/git";
  const git = resolveGitExecutable(process.env, tmpdir());
  if (!git.ok) throw new Error(`fixture-git-unavailable:${git.reason}`);
  return git.path;
}

/** What the runtime needs from the host beyond its profile; the supervisor pins SystemRoot itself. */
export function fixtureHostEnvironment(git: string): Record<string, string> {
  if (process.platform !== "win32") return { PATH: `${dirname(git)}:/usr/bin:/bin` };
  const systemRoot = process.env.SystemRoot;
  if (systemRoot === undefined) throw new Error("fixture-system-root-missing");
  return { PATH: dirname(git), SystemRoot: systemRoot };
}

/** Git with no user or system configuration, whatever the host has set. */
export function fixtureGitEnvironment(root: string, git: string): Record<string, string> {
  // An empty file rather than the null device: Git for Windows cannot open `\\.\nul` as a config.
  const globalConfig = join(root, "empty.gitconfig");
  writeFileSync(globalConfig, "");
  return {
    HOME: root,
    PATH: dirname(git),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
  };
}
