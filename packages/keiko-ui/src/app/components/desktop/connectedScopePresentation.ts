import type { I18nTranslate } from "@/lib/i18n";
import type { ChatConnectedScope } from "@/lib/types";

export function scopePathBasename(path: string): string {
  const segments = path.replaceAll("\\", "/").split("/");
  return segments.findLast((segment) => segment.length > 0) ?? path;
}

export function stripTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.codePointAt(end - 1) === 0x2f) end -= 1;
  return path.slice(0, end);
}

function scopePath(scope: ChatConnectedScope, relative: string): string {
  const root =
    scope.root === undefined ? undefined : stripTrailingSlashes(scope.root.replaceAll("\\", "/"));
  return root === undefined || root.length === 0 ? relative : `${root}/${relative}`;
}

export function connectedScopeFullPath(scope: ChatConnectedScope): string | undefined {
  if (scope.kind === "workspace-root") return scope.root;
  return scope.relativePaths.map((path) => scopePath(scope, path)).join(", ") || scope.root;
}

function middleTruncated(value: string): string {
  return value.length <= 64 ? value : `${value.slice(0, 30)}…${value.slice(-30)}`;
}

function connectedFilesLabel(
  scope: ChatConnectedScope,
  rootName: string,
  t: I18nTranslate,
): string {
  if (scope.relativePaths.length === 1) {
    const name = scopePathBasename(scope.relativePaths[0] ?? "");
    return name.length === 0 ? t("scope.pill.connectedFile") : t("scope.pill.file", { name });
  }
  return rootName.length === 0
    ? t("scope.pill.filesConnected", { count: scope.relativePaths.length })
    : t("scope.pill.filesInFolder", { count: scope.relativePaths.length, name: rootName });
}

export function connectedScopeLabel(scope: ChatConnectedScope, t: I18nTranslate): string {
  const rootName = scope.root === undefined ? "" : scopePathBasename(scope.root);
  if (scope.kind === "files") return connectedFilesLabel(scope, rootName, t);
  if (scope.kind === "directory") {
    const relative = scope.relativePaths[0] ?? "";
    const name = rootName.length === 0 ? scopePathBasename(relative) : `${rootName}/${relative}`;
    return name.length === 0
      ? t("scope.pill.connectedFolder")
      : t("scope.pill.folder", { name: middleTruncated(name) });
  }
  return rootName.length === 0
    ? t("scope.pill.repositoryScope")
    : t("scope.pill.folder", { name: rootName });
}

export function connectedScopeBoundary(scope: ChatConnectedScope, t: I18nTranslate): string {
  const key =
    scope.kind === "workspace-root"
      ? "scope.boundary.noun.repository"
      : scope.kind === "directory"
        ? "scope.boundary.noun.folder"
        : "scope.boundary.noun.fileScope";
  return t("scope.boundary.description", { noun: t(key) });
}

export function connectedScopeSignature(scopes: readonly ChatConnectedScope[]): string {
  return JSON.stringify(scopes.map((scope) => [scope.kind, scope.root, scope.relativePaths]));
}
