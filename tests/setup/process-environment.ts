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
  if (platform !== "win32") return;
  const pathKeys = Object.keys(environment).filter((key) => key.toLowerCase() === "path");
  const pathValue =
    environment.PATH ??
    pathKeys.map((key) => environment[key]).find((value) => value !== undefined);
  for (const key of pathKeys) {
    if (key !== "PATH") Reflect.deleteProperty(environment, key);
  }
  if (pathValue !== undefined) environment.PATH = pathValue;
  else if (fallbackPath !== undefined) environment.PATH = fallbackPath;
}

export function restoreWindowsPath(
  environment: NodeJS.ProcessEnv,
  originalPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32" || originalPath === undefined) return;
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === "path") Reflect.deleteProperty(environment, key);
  }
  environment.PATH = originalPath;
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
