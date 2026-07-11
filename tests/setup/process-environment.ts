import { afterEach, beforeEach } from "vitest";

const ORIGINAL_PATH = Symbol.for("keiko.tests.original-windows-path");

interface ProcessEnvironmentState {
  [ORIGINAL_PATH]?: string | undefined;
}

export function canonicalizeWindowsPath(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  fallbackPath?: string,
): void {
  if (platform !== "win32" || environment.PATH !== undefined) return;
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path");
  const pathValue = pathKey === undefined ? fallbackPath : environment[pathKey];
  if (pathValue !== undefined) environment.PATH = pathValue;
}

export function restoreWindowsPath(
  environment: NodeJS.ProcessEnv,
  originalPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "win32" && originalPath !== undefined) environment.PATH = originalPath;
}

canonicalizeWindowsPath(process.env);
const state = globalThis as ProcessEnvironmentState;
state[ORIGINAL_PATH] ??= process.env.PATH;

beforeEach(() => {
  restoreWindowsPath(process.env, state[ORIGINAL_PATH]);
});

afterEach(() => {
  restoreWindowsPath(process.env, state[ORIGINAL_PATH]);
});
