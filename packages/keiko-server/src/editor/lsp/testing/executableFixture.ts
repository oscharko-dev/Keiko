import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function executableFixtureName(
  name: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? `${name}.CMD` : name;
}

export function writeExecutableFixture(
  directory: string,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const path = join(directory, executableFixtureName(name, platform));
  writeFileSync(path, platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n");
  if (process.platform !== "win32") chmodSync(path, 0o755);
  return path;
}

export function writeNodeExecutableFixture(
  directory: string,
  name: string,
  source: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const scriptPath = join(directory, `${name}.fixture.cjs`);
  writeFileSync(scriptPath, source);
  const executablePath = join(directory, executableFixtureName(name, platform));
  const launcher =
    platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`;
  writeFileSync(executablePath, launcher);
  if (process.platform !== "win32") chmodSync(executablePath, 0o755);
  return executablePath;
}
