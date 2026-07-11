import { afterEach } from "vitest";

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

canonicalizeWindowsPath(process.env);
const state = globalThis as ProcessEnvironmentState;
state[ORIGINAL_PATH] ??= process.env.PATH;

afterEach(() => {
  canonicalizeWindowsPath(process.env, process.platform, state[ORIGINAL_PATH]);
});
