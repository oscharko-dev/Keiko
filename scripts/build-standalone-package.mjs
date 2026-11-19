// Build a Keiko standalone folder package from a portable release archive.
//
// A standalone package is one folder a person unzips and starts by double-click: no installer, no
// administrator rights, no managed setup, no Node.js on the machine, nothing downloaded at start.
// It is the reviewed portable payload, every file unchanged, with a thin layer around it:
//
//   Keiko/
//     Start Keiko.command | Start Keiko.cmd     start in place with the bundled Node.js
//     Stop Keiko.command  | Stop Keiko.cmd
//     README.txt  LIESMICH.txt
//     keiko.config.json                         only with --config (an administrator's package)
//     system/standalone.json                    what this package was built from
//     system/Keiko/...                          the portable payload, unchanged
//
// The payload is never modified, so every check the product performs on it keeps passing. The
// start files run `keiko start` directly instead of the native launcher, which would perform the
// managed install this delivery form exists to avoid (ADR-0121 D9).
//
// The archive is verified against a SHA-256 the caller must supply; an unverified archive is
// refused. Files this script writes carry no download mark, so the result starts on a machine that
// received it over an internal share even when the source archive was a browser download.
//
// `--layout nested` builds the second form of the same package: the verified archive itself as
// `Keiko.zip`, the payload's own Node.js as `node/`, a `package.json`/`package-lock.json`/`.npmrc`
// that pin and describe it, a README and `start`/`stop` files. The start file checks `Keiko.zip`
// against `Keiko.zip.sha256`, unpacks it into `system/` once and then starts exactly as above.

import { Buffer } from "node:buffer";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256FileChunked } from "./lib/digest.mjs";
import { folderChecksumText, folderPackageArchiveName } from "./lib/folder-package-release.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";
import { credentialScope, teamConfig } from "./standalone/npm/keiko-npm.mjs";
import {
  extractZipArchiveEntries,
  readZipArchiveEntryNames,
  writeZipArchiveFromDirectory,
} from "./lib/zip-archive.mjs";

const TEMPLATE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "standalone");
const PACKAGE_NAME = "@oscharko-dev/keiko";
const PACKAGE_ROOT_NAME = "Keiko";
const PAYLOAD_ROOT_PREFIX = "Keiko/";
const NESTED_ARCHIVE_NAME = "Keiko.zip";
const NODE_SOURCE_NAME = "NODE_RUNTIME_SOURCE.json";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
// Windows refuses paths beyond 260 characters when the archive is extracted with Explorer. The
// package's own longest entry stays well below that, so a user folder such as
// C:\Users\<name>\Documents\ still fits in front of it.
export const WINDOWS_MAX_ENTRY_NAME_LENGTH = 180;

const MACOS_RESOURCES = ["Keiko", "Keiko.app", "Contents", "Resources"];
const MACOS_LAYOUT = Object.freeze({
  os: "macos",
  resources: MACOS_RESOURCES,
  node: [...MACOS_RESOURCES, "runtime", "node", "bin", "node"],
  nodeRuntime: [...MACOS_RESOURCES, "runtime", "node"],
  startName: "Start Keiko.command",
  stopName: "Stop Keiko.command",
  startTemplate: "macos-start.sh",
  stopTemplate: "macos-stop.sh",
  nestedStartName: "start.sh",
  nestedStopName: "stop.sh",
  nestedStartTemplate: "nested-macos-start.sh",
  nestedStopTemplate: "nested-macos-stop.sh",
});
const WINDOWS_LAYOUT = Object.freeze({
  os: "windows",
  resources: ["Keiko"],
  node: ["Keiko", "runtime", "node", "node.exe"],
  nodeRuntime: ["Keiko", "runtime", "node"],
  startName: "Start Keiko.cmd",
  stopName: "Stop Keiko.cmd",
  startTemplate: "windows-start.cmd",
  stopTemplate: "windows-stop.cmd",
  nestedStartName: "start.cmd",
  nestedStopName: "stop.cmd",
  nestedStartTemplate: "nested-windows-start.cmd",
  nestedStopTemplate: "nested-windows-stop.cmd",
});

/**
 * The two package layouts. `folder` carries the payload unpacked below `system/`. `nested` carries
 * the verified release archive itself as `Keiko.zip` beside its own `node/` runtime; its start file
 * unpacks the archive into `system/` on the first start (ADR-0121 D9).
 */
export const STANDALONE_LAYOUTS = Object.freeze(["folder", "nested"]);

/** The targets a standalone package exists for (ADR-0183: macOS and Windows). */
export const STANDALONE_TARGETS = Object.freeze({
  "macos-arm64": MACOS_LAYOUT,
  "macos-x64": MACOS_LAYOUT,
  "windows-x64": WINDOWS_LAYOUT,
});

const USAGE = `Usage:
  node scripts/build-standalone-package.mjs --target TARGET --archive PATH
       (--sha256 HEX | --sha256sums PATH) --out-dir PATH
       [--layout folder|nested] [--config PATH [--api-key-env NAME]] [--keep-folder]

  --target       ${Object.keys(STANDALONE_TARGETS).join(" | ")}
  --layout       folder (default): the payload unpacked below system/
                 nested: node/, Keiko.zip, package.json, package-lock.json, .npmrc, README.md and
                 start/stop files; the start file unpacks Keiko.zip on the first start
  --archive      the portable release archive for that target (keiko-<target>.zip)
  --sha256       the archive's expected SHA-256, or
  --sha256sums   a SHA256SUMS file that names the archive
  --out-dir      where the package is written
  --config       a keiko.config.json to place in the package (administrator's package; it holds
                 credentials and must never be published)
  --api-key-env  the environment variable that holds the team's API key. Gateway Setup stores a
                 config without its key ("apiKeySecretRef"); with this flag every such reference
                 becomes that key, so the config works on another person's computer
  --keep-folder  also keep the assembled folder next to the archive
`;

export class StandaloneBuildError extends Error {}

function refuse(message) {
  throw new StandaloneBuildError(message);
}

const VALUE_FLAGS = Object.freeze({
  "--target": "target",
  "--archive": "archive",
  "--sha256": "sha256",
  "--sha256sums": "sha256sums",
  "--out-dir": "outDir",
  "--config": "config",
  "--api-key-env": "apiKeyEnv",
  "--layout": "layout",
});

function readFlagValue(argv, index) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) refuse(`${argv[index]} needs a value`);
  return value;
}

/** Parses the command line into options; unknown flags are refused. */
export function parseStandaloneArgs(argv) {
  const options = { keepFolder: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--keep-folder") {
      options.keepFolder = true;
    } else if (Object.hasOwn(VALUE_FLAGS, flag)) {
      options[VALUE_FLAGS[flag]] = readFlagValue(argv, index);
      index += 1;
    } else {
      refuse(`unknown argument ${String(flag)}`);
    }
  }
  return options;
}

function requireOption(options, name, flag) {
  const value = options[name];
  if (typeof value !== "string" || value.length === 0) refuse(`${flag} is required`);
  return value;
}

/** The expected digest of the archive: given directly, or read from a SHA256SUMS file. */
export function expectedArchiveSha256(options, archivePath) {
  if (options.sha256 !== undefined && options.sha256sums !== undefined) {
    refuse("pass either --sha256 or --sha256sums, not both");
  }
  if (options.sha256 !== undefined) return validSha256(options.sha256.toLowerCase(), "--sha256");
  if (options.sha256sums === undefined) {
    refuse("--sha256 or --sha256sums is required: an unverified archive is not packaged");
  }
  const name = basename(archivePath);
  for (const line of readFileSync(options.sha256sums, "utf8").split(/\r?\n/u)) {
    const entry = sha256sumsEntry(line);
    if (entry?.name === name) return entry.sha256;
  }
  return refuse(`${basename(options.sha256sums)} does not name ${name}`);
}

// One line of a SHA256SUMS file: the digest, blanks, an optional `*` (binary mode), the file name.
// Read by position, not by a pattern: the digest has a fixed width.
function sha256sumsEntry(line) {
  const text = line.trim();
  const sha256 = text.slice(0, 64).toLowerCase();
  const rest = text.slice(64);
  if (!SHA256_PATTERN.test(sha256) || rest.trimStart() === rest) return undefined;
  const name = rest.trimStart();
  return { sha256, name: name.startsWith("*") ? name.slice(1) : name };
}

function validSha256(value, label) {
  if (!SHA256_PATTERN.test(value)) refuse(`${label} is not a SHA-256 digest`);
  return value;
}

function verifyArchive(archivePath, expected) {
  if (!existsSync(archivePath) || !statSync(archivePath).isFile()) {
    refuse(`archive not found: ${archivePath}`);
  }
  const actual = sha256FileChunked(archivePath);
  if (actual !== expected) {
    refuse(`archive checksum mismatch: expected ${expected}, got ${actual}`);
  }
  return actual;
}

function assertPayloadEntryNames(archivePath, target, sizeSourceEntries) {
  const names = readZipArchiveEntryNames(archivePath, { requireRegularEntries: true });
  if (names.length === 0) refuse("the archive is empty");
  const foreign = names.find((name) => !name.startsWith(PAYLOAD_ROOT_PREFIX));
  if (foreign !== undefined) refuse(`the archive is not a portable payload: ${foreign}`);
  if (sizeSourceEntries) assertWindowsPathBudget(names, target);
}

// Checked on the source names, before anything is written: every payload entry lands below
// `Keiko/system/` in the package.
function assertWindowsPathBudget(payloadNames, target) {
  if (STANDALONE_TARGETS[target].os !== "windows") return;
  const prefixLength = `${PACKAGE_ROOT_NAME}/system/`.length;
  const longest = payloadNames.reduce((max, name) => Math.max(max, prefixLength + name.length), 0);
  if (longest > WINDOWS_MAX_ENTRY_NAME_LENGTH) {
    refuse(
      `the longest path in the package has ${String(longest)} characters; Windows needs ${String(WINDOWS_MAX_ENTRY_NAME_LENGTH)} or fewer`,
    );
  }
}

// An editor may save UTF-8 with a byte order mark; the document is the text after it.
function readTextWithoutByteOrderMark(path) {
  const text = readFileSync(path, "utf8");
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

function readJsonObject(path, label) {
  let parsed;
  try {
    parsed = JSON.parse(readTextWithoutByteOrderMark(path));
  } catch (error) {
    throw new StandaloneBuildError(`${label} is not valid JSON`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    refuse(`${label} is not a JSON object`);
  }
  return parsed;
}

/** Proves the extracted payload is the portable payload of the requested target. */
export function inspectPayload(systemRoot, target) {
  const layout = STANDALONE_TARGETS[target];
  const resources = join(systemRoot, ...layout.resources);
  const manifestPath = join(resources, ".portable", "setup-manifest.json");
  if (!existsSync(manifestPath)) refuse("the archive carries no portable setup manifest");
  const manifest = readJsonObject(manifestPath, "the portable setup manifest");
  if (manifest.packageName !== PACKAGE_NAME) refuse("the archive is not a Keiko portable payload");
  if (manifest.platformTarget !== target) {
    refuse(`the archive is built for ${String(manifest.platformTarget)}, not for ${target}`);
  }
  const packageVersion = manifest.packageVersion;
  if (typeof packageVersion !== "string" || !VERSION_PATTERN.test(packageVersion)) {
    refuse("the portable setup manifest names no package version");
  }
  for (const required of [layout.node, [...layout.resources, "app", "dist", "cli", "index.js"]]) {
    if (!existsSync(join(systemRoot, ...required))) {
      refuse(`the payload is incomplete: ${required.join("/")} is missing`);
    }
  }
  return { packageVersion };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function teamApiKey(apiKeyEnv, env) {
  if (apiKeyEnv === undefined) return undefined;
  const value = env[apiKeyEnv];
  if (typeof value !== "string" || value.length === 0) {
    refuse(`--api-key-env: the environment variable ${apiKeyEnv} is not set`);
  }
  return value;
}

// Gateway Setup seals a key into the vault of the computer it ran on and leaves a reference in the
// config. On another person's computer that reference names nothing, so a package may not carry
// one: on the gateway connection Gateway Setup verified it becomes the team's key, by the same rule
// as the npm package's access step (system/keiko-npm.mjs). A key of any other connection refuses:
// the team's key must never reach a service it was not verified for.
function withTeamApiKeys(config, apiKeyEnv, env) {
  const scope = credentialScope(config);
  if (scope.foreign.length > 0) {
    refuse(
      `the provisioned config refers to keys sealed on this computer for another connection (${scope.foreign.join(", ")}); one team key covers only the gateway connection Gateway Setup verified, so write that connection's key into the file instead`,
    );
  }
  // Read only now: a configuration that holds another connection's key refused above, before the
  // team's key was looked up.
  const apiKey = teamApiKey(apiKeyEnv, env);
  if (scope.token.size === 0) return undefined;
  if (apiKey === undefined) {
    refuse(
      "the provisioned config refers to a key sealed on this computer (apiKeySecretRef); pass --api-key-env NAME with the team's key",
    );
  }
  return teamConfig(config, apiKey);
}

/**
 * The gateway configuration an administrator's package carries: a config with providers, none of
 * which refers to a credential that exists only on the administrator's own computer.
 */
export function readProvisionedConfig(configPath, apiKeyEnv = undefined, env = process.env) {
  if (!existsSync(configPath) || !statSync(configPath).isFile()) {
    refuse(`config not found: ${configPath}`);
  }
  const config = readJsonObject(configPath, "the provisioned config");
  if (!Array.isArray(config.providers) || config.providers.length === 0) {
    refuse("the provisioned config names no providers");
  }
  config.providers.forEach((provider, index) => {
    assertProviderOutline(provider, index);
  });
  const team = withTeamApiKeys(config, apiKeyEnv, env);
  // The administrator's own text when nothing was sealed (without a byte order mark).
  return Buffer.from(
    team === undefined
      ? readTextWithoutByteOrderMark(configPath)
      : `${JSON.stringify(team, null, 2)}\n`,
    "utf8",
  );
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

// The outline every provider needs wherever it runs. The full check is the gateway's own loader,
// which Keiko applies before it adopts the file; this catches a mistyped file before it ships.
function assertProviderOutline(provider, index) {
  if (!isRecord(provider))
    refuse(`the provisioned config's provider ${String(index)} is not an object`);
  for (const field of ["modelId", "baseUrl"]) {
    if (!isNonEmptyString(provider[field])) {
      refuse(`the provisioned config's provider ${String(index)} names no ${field}`);
    }
  }
  if (provider.apiKey !== undefined && !isNonEmptyString(provider.apiKey)) {
    refuse(`the provisioned config's provider ${String(index)} carries an empty apiKey`);
  }
}

function templateText(name, layout) {
  const text = readFileSync(join(TEMPLATE_ROOT, name), "utf8");
  // cmd.exe reads batch files reliably only with CRLF line endings, and Notepad shows them so.
  return layout.os === "windows" ? text.replaceAll(/\r?\n/gu, "\r\n") : text;
}

export function writePackageFile(path, content, mode) {
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
}

function writeWrapperLayer(packageRoot, layout) {
  const executable = 0o755;
  const readable = 0o644;
  const files = [
    [layout.startName, layout.startTemplate, executable],
    [layout.stopName, layout.stopTemplate, executable],
    ["README.txt", "readme.en.txt", readable],
    ["LIESMICH.txt", "readme.de.txt", readable],
  ];
  for (const [name, template, mode] of files) {
    writePackageFile(join(packageRoot, name), templateText(template, layout), mode);
  }
}

function writeStandaloneManifest(packageRoot, record) {
  writePackageFile(
    join(packageRoot, "system", "standalone.json"),
    `${JSON.stringify(record, null, 2)}\n`,
    0o644,
  );
}

/** The pinned Node.js runtime the payload carries, as its staging recorded it. */
export function readNodeRuntimeSource(systemRoot, target) {
  const sourcePath = join(systemRoot, ...STANDALONE_TARGETS[target].nodeRuntime, NODE_SOURCE_NAME);
  if (!existsSync(sourcePath)) refuse("the payload does not record its Node.js runtime");
  const source = readJsonObject(sourcePath, "the Node.js runtime record");
  const version =
    typeof source.nodeVersion === "string" ? source.nodeVersion.replace(/^v/u, "") : "";
  if (!VERSION_PATTERN.test(version)) refuse("the Node.js runtime record names no version");
  if (typeof source.sha256 !== "string" || !SHA256_PATTERN.test(source.sha256)) {
    refuse("the Node.js runtime record names no SHA-256");
  }
  return { version, sha256: source.sha256, fileName: String(source.fileName ?? "") };
}

// The package's own manifest. It names what the folder holds and pins the Node.js version; it has
// no dependencies, so npm has nothing to fetch for it, and `.npmrc` keeps npm offline anyway.
function nestedPackageJson(record, layout) {
  const command = layout.os === "windows" ? (name) => name : (name) => `sh ${name}`;
  return {
    name: `keiko-standalone-${record.platformTarget}`,
    version: record.packageVersion,
    private: true,
    description: `Keiko ${record.packageVersion} with its own Node.js ${record.nodeRuntime.version}. Start with ${layout.nestedStartName}, stop with ${layout.nestedStopName}.`,
    engines: { node: record.nodeRuntime.version },
    scripts: {
      start: command(layout.nestedStartName),
      stop: command(layout.nestedStopName),
    },
    keiko: {
      packageName: PACKAGE_NAME,
      packageVersion: record.packageVersion,
      platformTarget: record.platformTarget,
      archive: { name: NESTED_ARCHIVE_NAME, ...record.sourceArchive },
      nodeRuntime: record.nodeRuntime,
      provisionedConfig: record.provisionedConfig,
    },
  };
}

// What `npm install` writes for a package without dependencies: the lock pins the root alone.
function nestedPackageLock(packageJson) {
  return {
    name: packageJson.name,
    version: packageJson.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: packageJson.name, version: packageJson.version, engines: packageJson.engines },
    },
  };
}

const NESTED_NPMRC = `# Keiko brings everything it needs. npm never downloads anything for this folder.
offline=true
engine-strict=true
package-lock=true
audit=false
fund=false
update-notifier=false
`;

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeNestedManifests(packageRoot, record, layout) {
  const packageJson = nestedPackageJson(record, layout);
  writePackageFile(join(packageRoot, "package.json"), jsonText(packageJson), 0o644);
  writePackageFile(
    join(packageRoot, "package-lock.json"),
    jsonText(nestedPackageLock(packageJson)),
    0o644,
  );
  writePackageFile(join(packageRoot, ".npmrc"), NESTED_NPMRC, 0o644);
}

function writeNestedWrapperLayer(packageRoot, layout) {
  const files = [
    [layout.nestedStartName, layout.nestedStartTemplate, 0o755],
    [layout.nestedStopName, layout.nestedStopTemplate, 0o755],
    ["README.md", "nested-readme.md", 0o644],
  ];
  for (const [name, template, mode] of files) {
    writePackageFile(join(packageRoot, name), templateText(template, layout), mode);
  }
}

// The archive goes in as it is, with its digest beside it: the start file checks the one against
// the other before it unpacks anything. Its bytes are written anew rather than copied: a file copy
// carries the source's download mark along (the Zone.Identifier stream on Windows, the quarantine
// attribute on macOS), and the unpacked payload would inherit it.
function writeNestedArchive(packageRoot, archivePath, archiveSha256) {
  const target = join(packageRoot, NESTED_ARCHIVE_NAME);
  writePackageFile(target, readFileSync(archivePath), 0o644);
  if (sha256FileChunked(target) !== archiveSha256)
    refuse("Keiko.zip does not match the verified archive");
  writePackageFile(
    join(packageRoot, `${NESTED_ARCHIVE_NAME}.sha256`),
    `${archiveSha256}  ${NESTED_ARCHIVE_NAME}\n`,
    0o644,
  );
}

// The bundled runtime is the payload's own Node.js, copied with its licence and source record, so
// the folder runs on the exact version the payload was qualified with.
function copyNodeRuntime(inspectRoot, packageRoot, layout) {
  const nodeRoot = join(packageRoot, "node");
  cpSync(join(inspectRoot, ...layout.nodeRuntime), nodeRoot, { recursive: true });
  const executable = join(nodeRoot, ...layout.node.slice(layout.nodeRuntime.length));
  if (!existsSync(executable)) refuse("the copied Node.js runtime has no executable");
  if (layout.os !== "windows") chmodSync(executable, 0o755);
}

function assembleNestedPackage(input) {
  const { archivePath, target, workRoot, archiveSha256, configBytes } = input;
  const layout = STANDALONE_TARGETS[target];
  const packageRoot = join(workRoot, PACKAGE_ROOT_NAME);
  const inspectRoot = join(workRoot, ".inspect");
  mkdirSync(packageRoot, { recursive: true });
  extractZipArchiveEntries(archivePath, inspectRoot, { requireRegularEntries: true });
  const { packageVersion } = inspectPayload(inspectRoot, target);
  const nodeRuntime = readNodeRuntimeSource(inspectRoot, target);
  copyNodeRuntime(inspectRoot, packageRoot, layout);
  rmSync(inspectRoot, { recursive: true, force: true });
  writeNestedArchive(packageRoot, archivePath, archiveSha256);
  writeNestedWrapperLayer(packageRoot, layout);
  if (configBytes !== undefined) {
    writePackageFile(join(packageRoot, "keiko.config.json"), configBytes, 0o600);
  }
  writeNestedManifests(
    packageRoot,
    {
      platformTarget: target,
      packageVersion,
      nodeRuntime,
      sourceArchive: { source: basename(archivePath), sha256: archiveSha256 },
      provisionedConfig: configBytes !== undefined,
    },
    layout,
  );
  return { packageRoot, packageVersion };
}

function assemblePackage(input) {
  const { archivePath, target, workRoot, archiveSha256, configBytes } = input;
  const layout = STANDALONE_TARGETS[target];
  const packageRoot = join(workRoot, PACKAGE_ROOT_NAME);
  const systemRoot = join(packageRoot, "system");
  mkdirSync(systemRoot, { recursive: true });
  extractZipArchiveEntries(archivePath, systemRoot, { requireRegularEntries: true });
  const { packageVersion } = inspectPayload(systemRoot, target);
  writeWrapperLayer(packageRoot, layout);
  if (configBytes !== undefined) {
    writePackageFile(join(packageRoot, "keiko.config.json"), configBytes, 0o600);
  }
  writeStandaloneManifest(packageRoot, {
    schemaVersion: 1,
    kind: "keiko-standalone-package",
    platformTarget: target,
    packageVersion,
    sourceArchive: { name: basename(archivePath), sha256: archiveSha256 },
    provisionedConfig: configBytes !== undefined,
  });
  return { packageRoot, packageVersion };
}

/**
 * The checked build input every package form shares. `form` names the kept folder
 * (`keiko-<target>-<form>`): `standalone` here, `npm` for the npm package.
 */
function resolveBuildInput(options, form) {
  const target = requireOption(options, "target", "--target");
  if (!Object.hasOwn(STANDALONE_TARGETS, target)) {
    refuse(`unsupported target ${target}: use ${Object.keys(STANDALONE_TARGETS).join(", ")}`);
  }
  const archivePath = resolve(requireOption(options, "archive", "--archive"));
  const outDir = resolve(requireOption(options, "outDir", "--out-dir"));
  const expected = expectedArchiveSha256(options, archivePath);
  if (options.apiKeyEnv !== undefined && options.config === undefined) {
    refuse("--api-key-env needs --config");
  }
  const configBytes =
    options.config === undefined
      ? undefined
      : readProvisionedConfig(resolve(options.config), options.apiKeyEnv, options.env);
  const keptFolder =
    options.keepFolder === true ? join(outDir, `keiko-${target}-${form}`) : undefined;
  // Before any work: a kept folder is never replaced, and its absence is cheap to check now.
  if (keptFolder !== undefined && existsSync(keptFolder)) {
    refuse(`--keep-folder: ${keptFolder} already exists; remove it first`);
  }
  return { target, archivePath, outDir, expected, configBytes, keptFolder };
}

function publishFolder(packageRoot, keptFolder) {
  mkdirSync(keptFolder);
  renameSync(packageRoot, join(keptFolder, PACKAGE_ROOT_NAME));
  return join(keptFolder, PACKAGE_ROOT_NAME);
}

/**
 * The build every folder form shares. It checks the archive, lets the form's `assemble` build the
 * package in a private work directory, writes the ZIP and its checksum file, and keeps the folder
 * when asked. `assemble` receives the checked input and returns `{ packageRoot, packageVersion }`.
 * Every source entry name is checked for the payload shape and containment; its Windows path
 * length is sized here only for a form that ships the whole payload (`sizeSourceEntries`). A form
 * that ships a part of it sizes what it wrote, so an entry it discards cannot refuse the package.
 */
export function buildFolderPackage(options, form, assemble, { sizeSourceEntries = true } = {}) {
  const { target, archivePath, outDir, expected, configBytes, keptFolder } = resolveBuildInput(
    options,
    form,
  );
  const archiveSha256 = verifyArchive(archivePath, expected);
  assertPayloadEntryNames(archivePath, target, sizeSourceEntries);
  mkdirSync(outDir, { recursive: true });
  const workRoot = mkdtempSync(join(outDir, `.${form}-work-`));
  try {
    const { packageRoot, packageVersion } = assemble({
      archivePath,
      target,
      workRoot,
      archiveSha256,
      configBytes,
    });
    const provisioned = configBytes !== undefined;
    const outputPath = join(outDir, folderPackageArchiveName(target, form, provisioned));
    writeZipArchiveFromDirectory(packageRoot, outputPath, {
      rootName: PACKAGE_ROOT_NAME,
      requireRegularEntries: true,
    });
    const outputSha256 = sha256FileChunked(outputPath);
    writeFileSync(`${outputPath}.sha256`, folderChecksumText(outputSha256, basename(outputPath)));
    const folder = keptFolder === undefined ? undefined : publishFolder(packageRoot, keptFolder);
    return { target, packageVersion, outputPath, outputSha256, folder, provisioned };
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

/** Builds the standalone package and returns what was written. */
export function buildStandalonePackage(options) {
  const layout = options.layout ?? "folder";
  if (!STANDALONE_LAYOUTS.includes(layout)) {
    refuse(`unsupported layout ${layout}: use ${STANDALONE_LAYOUTS.join(", ")}`);
  }
  const result =
    layout === "nested"
      ? buildFolderPackage(options, "standalone-nested", assembleNestedPackage)
      : buildFolderPackage(options, "standalone", assemblePackage);
  return { ...result, layout };
}

function reportFolderPackage(form, result) {
  console.log(`PASS ${form} package ${result.target} (Keiko ${result.packageVersion})`);
  console.log(`  archive: ${result.outputPath}`);
  console.log(`  sha256:  ${result.outputSha256}`);
  if (result.folder !== undefined) console.log(`  folder:  ${result.folder}`);
  if (result.provisioned) {
    console.log(
      "  This package holds credentials. Distribute it internally only; never publish it.",
    );
  }
}

/**
 * The command line every folder form shares: `--help` prints `usage`, a refused build prints one
 * FAIL line under `command` and exits 1, any other error is thrown.
 */
export function runFolderPackageCli(argv, { form, command, usage, build }) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage);
    return 0;
  }
  try {
    reportFolderPackage(form, build(parseStandaloneArgs(argv)));
    return 0;
  } catch (error) {
    if (!(error instanceof StandaloneBuildError)) throw error;
    console.error(`FAIL ${command}: ${error.message}`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = runFolderPackageCli(process.argv.slice(2), {
    form: "standalone",
    command: "build-standalone-package",
    usage: USAGE,
    build: buildStandalonePackage,
  });
}
