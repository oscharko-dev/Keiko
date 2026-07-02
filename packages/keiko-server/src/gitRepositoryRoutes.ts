import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { stat } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";
import type { IncomingMessage } from "node:http";
import type { RouteContext, RouteResult } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";
import { errorBody } from "./routes.js";
import { pathIsDenied } from "./files-deny.js";
import {
  assertUiDbOutsideProject,
  isProjectAvailable,
  validateProjectPath,
  type Project,
} from "./store/index.js";

const MAX_BODY_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const CLONE_TIMEOUT_MS = 120_000;

class BodyTooLargeError extends Error {
  public constructor() {
    super("body too large");
    this.name = "BodyTooLargeError";
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        if (!capped) {
          capped = true;
          chunks.length = 0;
          reject(new BodyTooLargeError());
          req.resume();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!capped) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected JSON object");
  }
  return parsed as Record<string, unknown>;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = optionalString(body, key);
  if (value === undefined) throw new Error(`${key} is required`);
  return value;
}

function projectWithAvailability(project: Project): Project & { readonly available: boolean } {
  return { ...project, available: isProjectAvailable(project) };
}

function invalid(message: string): RouteResult {
  return { status: 400, body: errorBody("BAD_REQUEST", message) };
}

function forbidden(message: string): RouteResult {
  return { status: 403, body: errorBody("DENIED", message) };
}

function repositoryUrlAllowed(input: string): boolean {
  if (containsControlCharacter(input)) return false;
  if (/^git@[^:\s]+:[^\s]+$/u.test(input)) return true;
  try {
    const url = new URL(input);
    if (url.username !== "" || url.password !== "") return false;
    return url.protocol === "https:" || url.protocol === "ssh:";
  } catch {
    return false;
  }
}

function containsControlCharacter(input: string): boolean {
  for (const char of input) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

async function assertDestination(candidate: string): Promise<RouteResult | string> {
  if (!isAbsolute(candidate)) return invalid("Destination path must be absolute.");
  const normalized = normalize(candidate);
  if (pathIsDenied(normalized)) {
    return forbidden("The destination path is excluded from Keiko's safe repository surface.");
  }
  try {
    await stat(normalized);
    return invalid("Destination path already exists.");
  } catch {
    // Expected: git clone creates the final directory.
  }
  const parent = dirname(normalized);
  if (pathIsDenied(parent)) {
    return forbidden("The destination parent is excluded from Keiko's safe repository surface.");
  }
  try {
    const info = await stat(parent);
    if (!info.isDirectory()) return invalid("Destination parent must be a directory.");
  } catch {
    return invalid("Destination parent must exist.");
  }
  return normalized;
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
  };
}

type CloneRepositoryRunner = (
  repositoryUrl: string,
  destinationPath: string,
) => Promise<RouteResult | null>;

const cloneRepository: CloneRepositoryRunner = function cloneRepository(
  repositoryUrl: string,
  destinationPath: string,
): Promise<RouteResult | null> {
  return new Promise((resolveResult) => {
    const child = spawn("git", ["clone", "--", repositoryUrl, destinationPath], {
      cwd: dirname(destinationPath),
      env: gitEnv(),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    monitorCloneProcess(child, resolveResult);
  });
};

function cloneFailure(truncated: boolean): RouteResult {
  return {
    status: truncated ? 504 : 409,
    body: errorBody(
      truncated ? "GIT_CLONE_TIMEOUT" : "GIT_CLONE_FAILED",
      truncated
        ? "Repository clone did not finish within the bounded execution window."
        : "Repository clone failed. Check the URL, credentials, and destination path.",
    ),
  };
}

function monitorCloneProcess(
  child: ReturnType<typeof spawn>,
  resolveResult: (result: RouteResult | null) => void,
): void {
  let outputBytes = 0;
  let truncated = false;
  let settled = false;
  const timer = setTimeout(() => {
    truncated = true;
    child.kill("SIGTERM");
  }, CLONE_TIMEOUT_MS);
  const capture = (chunk: Buffer): void => {
    outputBytes += chunk.byteLength;
    if (outputBytes > MAX_OUTPUT_BYTES) {
      truncated = true;
      child.kill("SIGTERM");
    }
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  child.on("error", () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolveResult({
      status: 503,
      body: errorBody("GIT_UNAVAILABLE", "Git is not available on this host."),
    });
  });
  child.on("close", (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (code === 0) {
      resolveResult(null);
      return;
    }
    resolveResult(cloneFailure(truncated));
  });
}

export function createCloneRepositoryHandler(
  cloneRunner: CloneRepositoryRunner = cloneRepository,
): (ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult> {
  return async (ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> => {
    try {
      const body = await readJsonObject(ctx.req);
      const repositoryUrl = requireString(body, "repositoryUrl");
      const destinationInput = requireString(body, "destinationPath");
      const name = optionalString(body, "name");
      if (!repositoryUrlAllowed(repositoryUrl)) {
        return invalid(
          "Repository URL must be HTTPS, SSH, or git@host:path without embedded secrets.",
        );
      }
      const destination = await assertDestination(destinationInput);
      if (typeof destination !== "string") return destination;
      assertUiDbOutsideProject(deps.uiDbPath, destination);
      const cloneResult = await cloneRunner(repositoryUrl, destination);
      if (cloneResult !== null) return cloneResult;
      const normalizedPath = validateProjectPath(destination, { mustExist: true });
      const project = deps.store.createProject(normalizedPath, name);
      return { status: 201, body: { project: projectWithAvailability(project) } };
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return { status: 413, body: errorBody("PAYLOAD_TOO_LARGE", "Request body is too large.") };
      }
      return invalid("The clone request is invalid.");
    }
  };
}

export const handleCloneRepository = createCloneRepositoryHandler();
