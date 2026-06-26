import { detectWorkspaceAt, type WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { errorBody, type RouteContext, type RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { resolveRoot, runFilesHandler } from "../files.js";
import {
  detectRuntimeCapabilities,
  type RuntimeCapabilityDetectorOptions,
} from "./capabilityDetector.js";

export type RuntimeCapabilityRouteOptions = Omit<RuntimeCapabilityDetectorOptions, "workspace"> & {
  readonly detectWorkspace?: ((root: string) => WorkspaceInfo) | undefined;
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
  if (!deps.store.listProjects().some((project) => project.path === root)) {
    return workspaceNotRegistered();
  }
  return runFilesHandler(async () => {
    const resolved = await resolveRoot(deps.store, root, deps.redactor);
    const workspace = (options.detectWorkspace ?? detectWorkspaceAt)(resolved.realRoot);
    const body = detectRuntimeCapabilities({
      env: deps.env,
      ...options,
      workspace,
    });
    return { status: 200, body: deps.redactor(body) };
  });
}
