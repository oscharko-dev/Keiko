// Build a Keiko npm package: one folder that starts Keiko by double-click and loads it from npm.
//
// Where installing is forbidden but an internal npm registry is the approved way in, the npm
// package carries only the Node.js runtime and a lockfile; Keiko arrives from the registry at the
// first start (ADR-0121 D9). Nothing is installed on the computer and no administrator rights are
// needed:
//
//   Keiko/
//     Start Keiko.command | Start Keiko.cmd     install on first start, then `keiko start`
//     Stop Keiko.command  | Stop Keiko.cmd
//     README.txt  LIESMICH.txt
//     package.json  package-lock.json            the exact Keiko version and every checksum
//     .npmrc                                     the administrator's registry (not shipped)
//     keiko.config.json                          only with --config, or saved by the administrator
//     system/node/...                            Node.js and npm from the release archive, unchanged
//     system/native/usearch.node                 the retrieval addon from the release archive, unchanged
//     system/keiko-npm.mjs                       start, stop and the administrator's access step
//     system/Zugang speichern.command | .cmd     writes keiko.config.json for the whole team
//     system/npm-package.json                    what this package was built from
//
// The Node.js runtime is taken from the verified portable release archive of the same version, so
// it is the one the folder package ships: byte for byte the signed nodejs.org build. The lockfile is
// resolved against the public registry; npm rewrites its host to the registry an .npmrc names and
// keeps checking every integrity hash.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  STANDALONE_TARGETS,
  StandaloneBuildError,
  WINDOWS_MAX_ENTRY_NAME_LENGTH,
  buildFolderPackage,
  inspectPayload,
  runFolderPackageCli,
  writePackageFile,
} from "./build-standalone-package.mjs";
import { sha256File } from "./lib/digest.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";
import { extractZipArchiveEntries } from "./lib/zip-archive.mjs";

const TEMPLATE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "standalone", "npm");
const PACKAGE_NAME = "@oscharko-dev/keiko";
const PACKAGE_ROOT_NAME = "Keiko";
const PUBLIC_REGISTRY = "https://registry.npmjs.org/";
const SAVE_CONFIG_NAME = "Zugang speichern";

const NPM_CLI = Object.freeze({
  macos: ["lib", "node_modules", "npm", "bin", "npm-cli.js"],
  windows: ["node_modules", "npm", "bin", "npm-cli.js"],
});

const USAGE = `Usage:
  node scripts/build-standalone-npm-package.mjs --target TARGET --archive PATH
       (--sha256 HEX | --sha256sums PATH) --out-dir PATH
       [--config PATH [--api-key-env NAME]] [--keep-folder]

  --target       ${Object.keys(STANDALONE_TARGETS).join(" | ")}
  --archive      the portable release archive for that target (keiko-<target>.zip); the package
                 takes its Node.js runtime and its Keiko version from it
  --sha256       the archive's expected SHA-256, or
  --sha256sums   a SHA256SUMS file that names the archive
  --out-dir      where the package is written
  --config       a keiko.config.json to place in the package (it holds credentials and must never
                 be published)
  --api-key-env  the environment variable that holds the team's API key (see
                 build-standalone-package.mjs)
  --keep-folder  also keep the assembled folder next to the archive

Resolving the lockfile needs the public npm registry.
`;

function refuse(message) {
  throw new StandaloneBuildError(message);
}

function templateText(name, os) {
  const text = readFileSync(join(TEMPLATE_ROOT, name), "utf8");
  // cmd.exe reads batch files reliably only with CRLF line endings, and Notepad shows them so.
  // The start logic is a Node.js module and stays as it is on every platform.
  return os === "windows" && !name.endsWith(".mjs") ? text.replaceAll(/\r?\n/gu, "\r\n") : text;
}

function wrapperFiles(os) {
  const windows = os === "windows";
  const start = windows
    ? ["Start Keiko.cmd", "windows-start.cmd"]
    : ["Start Keiko.command", "macos-start.sh"];
  const stop = windows
    ? ["Stop Keiko.cmd", "windows-stop.cmd"]
    : ["Stop Keiko.command", "macos-stop.sh"];
  const save = windows
    ? [`system/${SAVE_CONFIG_NAME}.cmd`, "windows-save-config.cmd"]
    : [`system/${SAVE_CONFIG_NAME}.command`, "macos-save-config.sh"];
  return [
    [...start, 0o755],
    [...stop, 0o755],
    [...save, 0o755],
    ["README.txt", "readme.en.txt", 0o644],
    ["LIESMICH.txt", "readme.de.txt", 0o644],
    ["system/keiko-npm.mjs", "keiko-npm.mjs", 0o644],
  ];
}

function writeWrapperLayer(packageRoot, os) {
  for (const [name, template, mode] of wrapperFiles(os)) {
    writePackageFile(join(packageRoot, ...name.split("/")), templateText(template, os), mode);
  }
}

/** Moves the release's Node.js runtime into the package and returns npm's command line in it. */
function adoptNodeRuntime(payloadRoot, packageRoot, layout) {
  const source = join(payloadRoot, ...layout.resources, "runtime", "node");
  const destination = join(packageRoot, "system", "node");
  renameSync(source, destination);
  const npmCli = join(destination, ...NPM_CLI[layout.os]);
  if (!existsSync(npmCli)) refuse("the archive's Node.js runtime carries no npm");
  return npmCli;
}

// Keiko's approximate nearest-neighbour search runs on the USearch addon the portable payload
// carries verified (ADR-0164); npm installs no copy of it. The package keeps the payload's addon
// and its license where Keiko looks for the addon next to this Node.js runtime: two levels above
// node on macOS (system/node/bin/node), one above node.exe on Windows (system/node/node.exe).
const RETRIEVAL_RUNTIME = Object.freeze([
  [
    ["runtime", "native", "usearch.node"],
    ["system", "native", "usearch.node"],
  ],
  [
    ["runtime", "licenses", "usearch", "LICENSE"],
    ["system", "licenses", "usearch", "LICENSE"],
  ],
]);

function adoptRetrievalRuntime(payloadRoot, packageRoot, layout) {
  for (const [from, to] of RETRIEVAL_RUNTIME) {
    const source = join(payloadRoot, ...layout.resources, ...from);
    if (!existsSync(source)) refuse(`the archive carries no ${from.join("/")}`);
    const destination = join(packageRoot, ...to);
    mkdirSync(dirname(destination), { recursive: true });
    renameSync(source, destination);
  }
}

export function packageJsonText(packageVersion) {
  const manifest = {
    name: "keiko-npm-package",
    private: true,
    description: "Starts Keiko from the npm registry. See LIESMICH.txt or README.txt.",
    dependencies: { [PACKAGE_NAME]: packageVersion },
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** npm of the build sees no configuration of the person who runs it, nor of a calling npm script. */
export function isolatedNpmEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.toLowerCase().startsWith("npm_config_")),
  );
}

/**
 * npm resolves only the lockfile, from the public registry, with the given empty configurations.
 * `--prefix` and `--workspaces=false` keep npm in the package folder: from a folder inside another
 * npm project or workspace, npm would otherwise write that project's lockfile instead.
 */
export function lockfileResolutionArgs(npmCli, packageRoot, userConfig, globalConfig) {
  return [
    npmCli,
    "install",
    "--prefix",
    packageRoot,
    "--workspaces=false",
    "--package-lock-only",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--registry",
    PUBLIC_REGISTRY,
    "--userconfig",
    userConfig,
    "--globalconfig",
    globalConfig,
  ];
}

/** Resolves package-lock.json against the public registry with the package's own npm. */
export function resolveLockfile(packageRoot, npmCli) {
  const isolation = mkdtempSync(join(tmpdir(), "keiko-npm-package-"));
  try {
    // npm refuses one file as both its user and its global configuration.
    const emptyUserConfig = join(isolation, "user-npmrc");
    const emptyGlobalConfig = join(isolation, "global-npmrc");
    writeFileSync(emptyUserConfig, "");
    writeFileSync(emptyGlobalConfig, "");
    const result = spawnSync(
      process.execPath,
      lockfileResolutionArgs(npmCli, packageRoot, emptyUserConfig, emptyGlobalConfig),
      { cwd: packageRoot, env: isolatedNpmEnv(process.env), encoding: "utf8" },
    );
    if (result.status !== 0) {
      refuse(`npm could not resolve the lockfile: ${String(result.stderr).trim().slice(-400)}`);
    }
  } finally {
    rmSync(isolation, { recursive: true, force: true });
  }
}

function lockEntryProblem(name, entry) {
  if (entry.link === true) return `${name} is a link`;
  if (entry.inBundle === true) return undefined;
  if (typeof entry.resolved !== "string" || !entry.resolved.startsWith(PUBLIC_REGISTRY)) {
    return `${name} does not come from the public registry`;
  }
  if (typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-")) {
    return `${name} carries no sha512 integrity`;
  }
  return undefined;
}

/**
 * The lockfile a package may ship: it installs exactly this Keiko version, and every package it
 * names comes from the public registry with a sha512 integrity that npm checks while installing.
 */
export function assertLockfile(lockText, packageVersion) {
  let lock;
  try {
    lock = JSON.parse(lockText);
  } catch (error) {
    throw new StandaloneBuildError("package-lock.json is not valid JSON", { cause: error });
  }
  const packages = lock?.packages;
  if (typeof packages !== "object" || packages === null)
    refuse("package-lock.json names no packages");
  if (packages[`node_modules/${PACKAGE_NAME}`]?.version !== packageVersion) {
    refuse(`package-lock.json does not install ${PACKAGE_NAME} ${packageVersion}`);
  }
  for (const [name, entry] of Object.entries(packages)) {
    if (name === "") continue;
    const problem = lockEntryProblem(name, entry);
    if (problem !== undefined) refuse(`package-lock.json: ${problem}`);
  }
}

function packageEntryNames(root, prefix = PACKAGE_ROOT_NAME) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map(
      (entry) =>
        `${prefix}/${relative(root, join(entry.parentPath, entry.name)).split(sep).join("/")}`,
    );
}

function assertWindowsPathBudget(packageRoot, os) {
  if (os !== "windows") return;
  const longest = packageEntryNames(packageRoot).reduce(
    (max, name) => Math.max(max, name.length),
    0,
  );
  if (longest > WINDOWS_MAX_ENTRY_NAME_LENGTH) {
    refuse(
      `the longest path in the package has ${String(longest)} characters; Windows needs ${String(WINDOWS_MAX_ENTRY_NAME_LENGTH)} or fewer`,
    );
  }
}

function assemblePackage(input) {
  const { archivePath, target, workRoot, archiveSha256, configBytes, createLockfile } = input;
  const layout = STANDALONE_TARGETS[target];
  const payloadRoot = join(workRoot, "payload");
  const packageRoot = join(workRoot, PACKAGE_ROOT_NAME);
  mkdirSync(payloadRoot, { recursive: true });
  mkdirSync(join(packageRoot, "system"), { recursive: true });
  extractZipArchiveEntries(archivePath, payloadRoot, { requireRegularEntries: true });
  const { packageVersion } = inspectPayload(payloadRoot, target);
  const npmCli = adoptNodeRuntime(payloadRoot, packageRoot, layout);
  adoptRetrievalRuntime(payloadRoot, packageRoot, layout);
  rmSync(payloadRoot, { recursive: true, force: true });
  writePackageFile(join(packageRoot, "package.json"), packageJsonText(packageVersion), 0o644);
  createLockfile(packageRoot, npmCli);
  const lockPath = join(packageRoot, "package-lock.json");
  if (!existsSync(lockPath)) refuse("npm wrote no package-lock.json");
  assertLockfile(readFileSync(lockPath, "utf8"), packageVersion);
  writeWrapperLayer(packageRoot, layout.os);
  if (configBytes !== undefined) {
    writePackageFile(join(packageRoot, "keiko.config.json"), configBytes, 0o600);
  }
  writePackageFile(
    join(packageRoot, "system", "npm-package.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        kind: "keiko-npm-package",
        platformTarget: target,
        packageVersion,
        sourceArchive: { name: basename(archivePath), sha256: archiveSha256 },
        lockfileSha256: sha256File(lockPath),
        provisionedConfig: configBytes !== undefined,
      },
      null,
      2,
    )}\n`,
    0o644,
  );
  assertWindowsPathBudget(packageRoot, layout.os);
  return { packageRoot, packageVersion };
}

/** Builds the npm package and returns what was written. */
export function buildNpmPackage(options) {
  const createLockfile = options.createLockfile ?? resolveLockfile;
  return buildFolderPackage(options, "npm", (input) =>
    assemblePackage({ ...input, createLockfile }),
  );
}

if (isMainModule(import.meta.url)) {
  process.exitCode = runFolderPackageCli(process.argv.slice(2), {
    form: "npm",
    command: "build-standalone-npm-package",
    usage: USAGE,
    build: buildNpmPackage,
  });
}
