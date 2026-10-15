import type { Chat, ChatConnectedScope } from "@/lib/types";
import { normalizedRepositoryPath } from "./chatRepositoryReference";
import { effectiveScopes } from "./hooks/workspaceActions";

export const MAX_REPOSITORY_FOCUS_PATHS = 50;

export function mergeRepositoryFileScope(
  chat: Chat,
  root: string,
  path: string,
  now: () => number = Date.now,
): { readonly scopes: readonly ChatConnectedScope[]; readonly changed: boolean } {
  const filePath = normalizedRepositoryPath(path);
  if (filePath.length === 0) {
    throw new Error("EMPTY_REPOSITORY_FILE_SELECTION");
  }
  const currentScopes = effectiveScopes(chat);
  const nextScopes: ChatConnectedScope[] = [];
  let merged = false;
  let changed = false;

  for (const scope of currentScopes) {
    const scopeRoot = scope.root ?? chat.projectPath;
    if (scope.kind === "files" && scopeRoot === root) {
      merged = true;
      if (scope.relativePaths.includes(filePath)) {
        nextScopes.push(scope);
        continue;
      }
      if (scope.relativePaths.length >= MAX_REPOSITORY_FOCUS_PATHS) {
        throw new Error("REPOSITORY_FILE_SCOPE_LIMIT");
      }
      nextScopes.push({
        ...scope,
        root,
        relativePaths: [...scope.relativePaths, filePath],
        connectedAtMs: now(),
      });
      changed = true;
      continue;
    }
    nextScopes.push(scope);
  }

  if (!merged) {
    nextScopes.push({
      kind: "files",
      root,
      relativePaths: [filePath],
      connectedAtMs: now(),
    });
    changed = true;
  }

  return { scopes: nextScopes, changed };
}
