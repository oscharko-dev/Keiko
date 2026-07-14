import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";

interface RuntimeLibrary {
  readonly capsulePath: string;
  readonly source: string;
}

interface E2eDapOperatorProvisioningOptions {
  readonly adapterFixturePath: string;
  readonly stateDir: string;
}

function requiredLinux(): void {
  if (process.platform !== "linux") {
    throw new Error(
      "Issue #2348 DAP E2E requires Linux Bubblewrap enforcement; run it in the Linux release environment.",
    );
  }
}

function requiredExecutable(path: string): string {
  const resolved = realpathSync(path);
  const stat = lstatSync(resolved);
  if (!stat.isFile() || (stat.mode & 0o111) === 0) {
    throw new Error("Issue #2348 DAP E2E requires an executable Bubblewrap binary.");
  }
  return resolved;
}

function copyExecutable(source: string, target: string): string {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(source, target);
  chmodSync(target, 0o755);
  return target;
}

function copyEmpty(target: string): string {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync("/dev/null", target);
  chmodSync(target, 0o600);
  return target;
}

function artifact(
  hostPath: string,
  approvedRoot: string,
  capsulePath: string,
): Record<string, string> {
  return { approvedRoot, capsulePath, hostPath };
}

function runtimeLibraryPaths(node: string): readonly RuntimeLibrary[] {
  const output = execFileSync("ldd", [node], { encoding: "utf8" });
  const paths = output
    .split("\n")
    .map((line) => /(?:=>\s*)?(\/\S+)/u.exec(line)?.[1])
    .filter((path): path is string => path !== undefined)
    .map((path) => ({ capsulePath: path, source: realpathSync(path) }));
  const unique = new Map(paths.map((entry) => [entry.capsulePath, entry.source]));
  return [...unique.entries()].map(([capsulePath, source]) => ({ capsulePath, source }));
}

function nodeRuntimeClosure(node: string, closureRoot: string): readonly Record<string, string>[] {
  const values = runtimeLibraryPaths(node);
  const artifacts: Record<string, string>[] = [];
  for (const [index, library] of values.entries()) {
    const target = join(closureRoot, `runtime-library-${String(index)}`);
    mkdirSync(closureRoot, { recursive: true, mode: 0o700 });
    copyFileSync(library.source, target);
    artifacts.push(artifact(target, closureRoot, library.capsulePath));
  }
  if (artifacts.length === 0) {
    throw new Error("Issue #2348 DAP E2E requires a closed Node runtime library closure.");
  }
  return artifacts;
}

function npmCliSource(): string {
  const configured = process.env.npm_execpath;
  const candidate = configured ?? execFileSync("/usr/bin/which", ["npm"], { encoding: "utf8" });
  return requiredExecutable(candidate.trim());
}

function copyNpmRuntime(runtimeRoot: string): {
  readonly npm: string;
  readonly closure: readonly Record<string, string>[];
} {
  const sourceCli = npmCliSource();
  const sourceRoot = realpathSync(join(dirname(sourceCli), ".."));
  const targetRoot = join(runtimeRoot, "npm-package");
  cpSync(sourceRoot, targetRoot, { dereference: true, recursive: true });
  const npm = join(targetRoot, "bin", "npm-cli.js");
  chmodSync(npm, 0o755);
  return {
    npm,
    closure: [
      artifact(join(targetRoot, "lib"), targetRoot, "/opt/keiko-runtime/npm/lib"),
      artifact(join(targetRoot, "node_modules"), targetRoot, "/opt/keiko-runtime/npm/node_modules"),
      artifact(join(targetRoot, "package.json"), targetRoot, "/opt/keiko-runtime/npm/package.json"),
    ],
  };
}

/** Builds the explicit, Linux-only operator document used by real DAP E2E paths. */
export function createE2eDapOperatorProvisioning(
  options: E2eDapOperatorProvisioningOptions,
): string {
  requiredLinux();
  mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
  const operatorDir = join(options.stateDir, "operator-dap");
  const binRoot = join(operatorDir, "bin");
  const runtimeRoot = join(operatorDir, "runtime");
  const configRoot = join(operatorDir, "config");
  const closureRoot = join(operatorDir, "closure");
  copyExecutable(options.adapterFixturePath, join(binRoot, "keiko-dap"));
  const node = copyExecutable(realpathSync(process.execPath), join(runtimeRoot, "node"));
  const npmRuntime = copyNpmRuntime(runtimeRoot);
  const shell = copyExecutable(realpathSync("/bin/sh"), join(runtimeRoot, "shell"));
  const userConfig = copyEmpty(join(configRoot, "npm-user-config"));
  const globalConfig = copyEmpty(join(configRoot, "npm-global-config"));
  const configuredBwrap = process.env.KEIKO_E2E_BWRAP_PATH ?? "/usr/bin/bwrap";
  if (!existsSync(configuredBwrap)) {
    throw new Error("Issue #2348 DAP E2E requires KEIKO_E2E_BWRAP_PATH or /usr/bin/bwrap.");
  }
  const bwrap = requiredExecutable(configuredBwrap);
  return JSON.stringify({
    schemaVersion: 1,
    adapter: {
      executableName: "keiko-dap",
      executableArgs: ["--server", "/run/keiko-debug/dap.sock"],
      trustedRoots: [binRoot],
      approvedPath: binRoot,
      envAllowlist: ["LANG", "LC_ALL"],
      fixedEnv: {},
    },
    launch: {
      adapterApprovedRoot: binRoot,
      node: artifact(node, runtimeRoot, "/opt/keiko-runtime/node"),
      npm: artifact(npmRuntime.npm, runtimeRoot, "/opt/keiko-runtime/npm/bin/npm-cli.js"),
      shell: artifact(shell, runtimeRoot, "/opt/keiko-runtime/shell"),
      npmUserConfig: artifact(userConfig, configRoot, "/opt/keiko-debug/npm-user-config"),
      npmGlobalConfig: artifact(globalConfig, configRoot, "/opt/keiko-debug/npm-global-config"),
      backend: artifact(bwrap, dirname(bwrap), "/opt/keiko-backend/bwrap"),
      runtimeClosure: [...nodeRuntimeClosure(node, closureRoot), ...npmRuntime.closure],
    },
  });
}
