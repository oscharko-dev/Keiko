import { realpath } from "node:fs/promises";

import { resolveGitMembership, type GitProcessRunner } from "@oscharko-dev/keiko-git";

export interface ResolvedChatRepository {
  readonly repositoryRoot: string;
}

/** Resolves a chat's already-validated project root to the repository root it belongs to. */
export async function resolveChatRepository(
  projectPath: string,
  runner: GitProcessRunner,
  timeoutMs: number,
): Promise<ResolvedChatRepository | undefined> {
  let root: string;
  try {
    root = await realpath(projectPath);
  } catch {
    return undefined;
  }
  const membership = await resolveGitMembership(root, runner, { timeoutMs });
  if (!membership.ok || membership.membership.prefix !== "") return undefined;
  const repositoryRoot = await realpath(membership.membership.repositoryRoot).catch(
    () => membership.membership.repositoryRoot,
  );
  return { repositoryRoot };
}
