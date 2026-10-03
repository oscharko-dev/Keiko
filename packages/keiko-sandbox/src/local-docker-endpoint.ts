// Docker's selected local context must survive the command boundary's empty HOME without
// forwarding the user's credential-bearing Docker configuration to the CLI or container.
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

export type LocalDockerEndpoint =
  | { readonly kind: "available"; readonly host: string }
  | {
      readonly kind: "unavailable";
      readonly reason: "docker-local-context-unavailable" | "docker-context-unsupported";
    };

const MAX_CONFIG_BYTES = 65_536;
const WINDOWS_LOCAL_ENDPOINT = "npipe:////./pipe/docker_engine";

/** Contains only the closed refusal code; never the configuration error, path, or address. */
export class LocalDockerEndpointUnavailableError extends TypeError {
  readonly reason = "docker-local-context-unavailable" as const;
  readonly code = this.reason;

  constructor() {
    super("docker-local-context-unavailable");
    this.name = "LocalDockerEndpointUnavailableError";
  }
}

function defaultHost(platform: NodeJS.Platform): string {
  return platform === "win32" ? WINDOWS_LOCAL_ENDPOINT : "unix:///var/run/docker.sock";
}

function outsideWorkspace(path: string, root: string): string {
  const canonical = realpathSync(path);
  const rel = relative(realpathSync(root), canonical);
  if (rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))) {
    throw new TypeError("docker-context-in-workspace");
  }
  return canonical;
}

function readBoundedObject(path: string, root: string): Record<string, unknown> {
  const canonical = outsideWorkspace(path, root);
  const fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES)
      throw new TypeError("docker-context-invalid");
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    if (length > MAX_CONFIG_BYTES) throw new TypeError("docker-context-too-large");
    const value: unknown = JSON.parse(buffer.subarray(0, length).toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError("docker-context-invalid");
    }
    return value as Record<string, unknown>;
  } finally {
    closeSync(fd);
  }
}

function configuredDirectory(
  env: NodeJS.ProcessEnv,
  root: string,
  platform: NodeJS.Platform,
): string | undefined {
  const home = env.HOME ?? (platform === "win32" ? env.USERPROFILE : undefined);
  const directory = env.DOCKER_CONFIG ?? (home === undefined ? undefined : join(home, ".docker"));
  if (directory === undefined) return undefined;
  try {
    return outsideWorkspace(directory, root);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function currentContext(directory: string | undefined, root: string): string {
  if (directory === undefined) return "default";
  try {
    const value = readBoundedObject(join(directory, "config.json"), root).currentContext;
    if (value === undefined || value === "") return "default";
    if (typeof value !== "string" || value.length > 1024)
      throw new TypeError("docker-context-invalid");
    return value;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "default";
    throw error;
  }
}

function contextHost(
  directory: string | undefined,
  context: string,
  root: string,
  platform: NodeJS.Platform,
): string {
  if (context === "default") return defaultHost(platform);
  if (directory === undefined || context.length > 1024)
    throw new TypeError("docker-context-invalid");
  const key = createHash("sha256").update(context).digest("hex");
  const value = readBoundedObject(join(directory, "contexts", "meta", key, "meta.json"), root);
  const endpoints = value.Endpoints;
  if (typeof endpoints !== "object" || endpoints === null)
    throw new TypeError("docker-context-invalid");
  const docker = (endpoints as Record<string, unknown>).docker;
  if (typeof docker !== "object" || docker === null) throw new TypeError("docker-context-invalid");
  const host = (docker as Record<string, unknown>).Host;
  if (typeof host !== "string") throw new TypeError("docker-context-invalid");
  return host;
}

function selectedHost(env: NodeJS.ProcessEnv, root: string, platform: NodeJS.Platform): string {
  if (env.DOCKER_CONTEXT === "default") return defaultHost(platform);
  if (env.DOCKER_CONTEXT)
    return contextHost(
      configuredDirectory(env, root, platform),
      env.DOCKER_CONTEXT,
      root,
      platform,
    );
  if (env.DOCKER_HOST) return env.DOCKER_HOST;
  const directory = configuredDirectory(env, root, platform);
  return contextHost(directory, currentContext(directory, root), root, platform);
}

/** Canonical local Unix sockets or the exact Windows local pipe; never a remote engine. */
export function resolveLocalDockerEndpoint(
  env: NodeJS.ProcessEnv,
  workspaceRoot: string,
  platform: NodeJS.Platform = process.platform,
): LocalDockerEndpoint {
  try {
    const host = selectedHost(env, workspaceRoot, platform);
    if (platform === "win32" && host === WINDOWS_LOCAL_ENDPOINT) {
      return { kind: "available", host };
    }
    if (!host.startsWith("unix:///") || host.length > 4096 || host.includes("\0")) {
      return { kind: "unavailable", reason: "docker-context-unsupported" };
    }
    const socket = outsideWorkspace(host.slice("unix://".length), workspaceRoot);
    if (!statSync(socket).isSocket()) throw new TypeError("docker-context-invalid");
    return { kind: "available", host: `unix://${socket}` };
  } catch {
    throw new LocalDockerEndpointUnavailableError();
  }
}
