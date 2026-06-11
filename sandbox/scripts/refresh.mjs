import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
export const sandboxRoot = resolve(dirname(scriptPath), "..");
export const repoRoot = resolve(sandboxRoot, "..");

function run(command, args, cwd) {
  console.log(`[sandbox] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
    },
  });

  if (result.status !== 0) {
    const code = result.status === null ? result.signal : result.status;
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd} (${String(code)})`);
  }
}

export function refreshSandbox() {
  run("npm", ["install", "--no-audit", "--no-fund", "--package-lock=false"], repoRoot);
  run("npm", ["run", "build"], repoRoot);
  run("npm", ["run", "build:ui"], repoRoot);
  run("npm", ["install", "--no-audit", "--no-fund"], sandboxRoot);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    refreshSandbox();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
