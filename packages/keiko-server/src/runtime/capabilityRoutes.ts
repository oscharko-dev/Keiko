import {
  detectWorkspaceAt,
  type WorkspaceFs,
  type WorkspaceInfo,
} from "@oscharko-dev/keiko-workspace";
import { errorBody, type RouteContext, type RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { resolveAppSessionReadAuthority } from "../coding-app-session/appSessionReadAuthority.js";
import { resolveRequestRoot, runFilesHandler } from "../files.js";
import { resolveManagedTaskWorkspaceRoot } from "../task-workspace/workspace-root-access.js";
import {
  detectRuntimeCapabilities,
  type RuntimeCapabilityDetectorOptions,
} from "./capabilityDetector.js";

export type RuntimeCapabilityRouteOptions = Omit<
  RuntimeCapabilityDetectorOptions,
  "workspace" | "fs"
> & {
  readonly detectWorkspace?: ((root: string, fs: WorkspaceFs) => WorkspaceInfo) | undefined;
};

function badRoot(): RouteResult {
  return {
    status: 400,
    body: errorBody("BAD_REQUEST", "The root query parameter must be a non-empty local path."),
  };
}

function workspaceNotRegistered(): RouteResult {
  return {
    status: 403,
    body: errorBody(
      "WORKSPACE_NOT_REGISTERED",
      "The workspace directory is not a registered project.",
    ),
  };
}

export async function handleRuntimeCapabilities(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  options: RuntimeCapabilityRouteOptions = {},
): Promise<RouteResult> {
  const rawRoot = ctx.url.searchParams.get("root");
  if (rawRoot === null) {
    return {
      status: 200,
      body: deps.redactor(
        detectRuntimeCapabilities({
          env: deps.env,
          ...options,
        }),
      ),
    };
  }
  const root = rawRoot.trim();
  if (root.length === 0) {
    return badRoot();
  }
  const registered = deps.store.listProjects().some((project) => project.path === root);
  // Preserve the route's existing content-free rejection for arbitrary unregistered roots. A
  // launcher-paired caller may additionally present a persisted managed task worktree, which is
  // re-proven below by the shared request-root boundary.
  if (!registered && resolveAppSessionReadAuthority(deps, ctx.req) === undefined) {
    return workspaceNotRegistered();
  }
  return runFilesHandler(async () => {
    const resolved = await resolveRequestRoot(ctx, deps, root);
    if (!registered && resolveManagedTaskWorkspaceRoot(deps, root) === undefined) {
      return workspaceNotRegistered();
    }
    const workspace = (options.detectWorkspace ?? detectWorkspaceAt)(
      resolved.access.canonicalRoot,
      resolved.access.fs,
    );
    const body = detectRuntimeCapabilities({
      env: deps.env,
      ...options,
      workspace,
      fs: resolved.access.fs,
    });
    return { status: 200, body: deps.redactor(body) };
  });
}
