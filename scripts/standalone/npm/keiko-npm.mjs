// Start, stop and the administrator's access step of a Keiko npm package (ADR-0121 D9).
//
// This file ships inside the package as system/keiko-npm.mjs and runs with the Node.js runtime next
// to it. Keiko itself is not in the package: the first start installs the exact version that
// package.json names from the npm registry the folder's .npmrc names (the computer's npm
// configuration without one), checked against the integrity hashes in package-lock.json. A later
// start installs again only when the lockfile changed or an earlier installation did not finish.
//
// Only Node.js built-ins: the file must run before anything is installed.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";

const PACKAGE_PATH = ["node_modules", "@oscharko-dev", "keiko"];
const INSTALLED_MARKER = ".keiko-npm-installed";
const CONFIG_NAME = "keiko.config.json";
// The data of every Keiko start form of this computer account: a new package folder, or the
// folder package, finds the chats and settings of the old one.
const STATE_DIR_NAME = ".keiko-standalone";
// npm removes node_modules during `npm ci`, so the installation's lock and a Stop request made
// while it runs lie beside this file, not in node_modules.
const INSTALL_LOCK = ["system", "keiko-npm-install.lock"];
const STOP_REQUEST = ["system", "keiko-npm-stop.request"];

/** Prints one message in English and in German, as every start file does. */
function say(english, german) {
  console.log(english);
  console.log(german);
}

/** A refusal a person can act on, in English and in German. */
export class LauncherRefusal extends Error {
  constructor(english, german) {
    super(`${english}\n${german}`);
    this.name = "LauncherRefusal";
  }
}

/** Where npm's own command line lies next to a Node.js runtime: bin/../lib on macOS, beside on Windows. */
export function npmCliCandidates(nodeDir) {
  return [
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
  ];
}

export function keikoCliPath(root) {
  return join(root, ...PACKAGE_PATH, "dist", "cli", "index.js");
}

// A path with its deepest existing ancestor resolved through every link, so a link on the way
// cannot lead out of the home folder. An ancestor that cannot be resolved refuses.
function canonicalPath(path) {
  const tail = [];
  let current = path;
  while (lstatSync(current, { throwIfNoEntry: false }) === undefined) {
    const parent = dirname(current);
    if (parent === current) return path;
    tail.unshift(basename(current));
    current = parent;
  }
  return join(realpathSync(current), ...tail);
}

function insideOrEqual(path, folder) {
  return path === folder || path.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`);
}

/** The home folder Keiko's command line will see: os.homedir() reads HOME, on Windows USERPROFILE. */
export function homeOf(env, platform = process.platform) {
  const declared = platform === "win32" ? env.USERPROFILE : env.HOME;
  return declared !== undefined && declared.length > 0 ? declared : homedir();
}

/**
 * Keiko's data folder as one absolute path, inside the person's home folder: the start, npm and
 * Keiko all use this one path. A relative KEIKO_STATE_DIR is resolved once, here. A folder outside
 * the home folder is refused before anything is written, as `keiko start` refuses it.
 */
export function stateDir(env, home = homeOf(env), cwd = process.cwd()) {
  const declared = env.KEIKO_STATE_DIR;
  const selected =
    declared !== undefined && declared.length > 0
      ? resolve(cwd, declared)
      : join(resolve(home), STATE_DIR_NAME);
  if (!insideOrEqual(canonicalPath(selected), canonicalPath(resolve(home)))) {
    throw new LauncherRefusal(
      "KEIKO_STATE_DIR must name a folder inside your home folder.",
      "KEIKO_STATE_DIR muss einen Ordner in deinem Benutzerordner nennen.",
    );
  }
  return selected;
}

/** npm's log lives in Keiko's data, not in ~/.npm; npm itself keeps it to its last ten files. */
export function npmLogsDir(state) {
  return join(state, "npm-logs");
}

// --prefix: npm installs into exactly this folder, and reads this folder's .npmrc as its project
// configuration, even when a folder above it is an npm project or workspace root.
// --workspaces=false: npm installs no workspace of any project.
// --ignore-scripts: Keiko needs no install script, and none of its dependencies may run one here.
// --replace-registry-host=npmjs: the public addresses in the lockfile go to the configured registry.
// Everything is set on the command line, which no npm_config_* variable and no .npmrc overrides:
// npm writes nothing outside the folder and Keiko's data folder.
export function installArgs(npmCli, root, cacheDir, logsDir) {
  return [
    npmCli,
    "ci",
    "--prefix",
    root,
    "--workspaces=false",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-update-notifier",
    "--replace-registry-host=npmjs",
    "--cache",
    cacheDir,
    "--logs-dir",
    logsDir,
  ];
}

function npmrcEntries(text) {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith(";"))
    .map((line) => {
      const split = line.indexOf("=");
      return (split < 0 ? line : line.slice(0, split)).trim().toLowerCase();
    });
}

/**
 * Whether the folder's .npmrc names the registry, the one form a package supports: one global
 * `registry=` line. npm loads a lockfile's packages from the global registry only, so a scoped
 * registry (`@scope:registry=`) would never be asked; it is refused before any request.
 */
export function folderRegistry(root) {
  const path = join(root, ".npmrc");
  if (!existsSync(path)) return false;
  const keys = npmrcEntries(readFileSync(path, "utf8"));
  if (keys.some((key) => /^@[^:]+:registry$/u.test(key))) {
    throw new LauncherRefusal(
      "The file .npmrc names a registry for a scope (@scope:registry). An npm package loads Keiko from one registry: name it with one line registry=<address>.",
      "Die Datei .npmrc nennt eine Registry fuer einen Scope (@scope:registry). Ein npm-Paket laedt Keiko aus einer Registry: Nenne sie mit einer Zeile registry=<Adresse>.",
    );
  }
  const named = keys.filter((key) => key === "registry").length;
  if (named > 1) {
    throw new LauncherRefusal(
      "The file .npmrc names the registry more than once. Keep one line registry=<address>.",
      "Die Datei .npmrc nennt die Registry mehrfach. Behalte eine Zeile registry=<Adresse>.",
    );
  }
  return named === 1;
}

export function lockfileDigest(root) {
  return createHash("sha256")
    .update(readFileSync(join(root, "package-lock.json")))
    .digest("hex");
}

/** Installed means: the last complete installation was of exactly this lockfile, and Keiko is there. */
export function installationCurrent(root, digest) {
  const marker = join(root, "node_modules", INSTALLED_MARKER);
  if (!existsSync(marker) || !existsSync(keikoCliPath(root))) return false;
  return readFileSync(marker, "utf8").trim() === digest;
}

// Windows spells the search path `Path`; a second `PATH` beside it would be ignored by one child
// and not by another.
function pathKey(env) {
  return Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
}

/**
 * npm and the packages it installs find this folder's Node.js first. When the folder's .npmrc
 * names the registry, an inherited npm_config_registry, which npm would rank above it, is dropped:
 * the folder's registry is the administrator's choice for this package. Proxy and credential
 * settings stay as they are.
 */
export function npmEnv(env, nodeDir, registryNamed = false) {
  const key = pathKey(env);
  const current = env[key];
  const kept = Object.entries(env).filter(
    ([name]) => !registryNamed || name.toLowerCase() !== "npm_config_registry",
  );
  return {
    ...Object.fromEntries(kept),
    [key]: current ? `${nodeDir}${delimiter}${current}` : nodeDir,
  };
}

/**
 * Keiko of a package performs no installation of its own: no setup, no Windows gateway service, no
 * update. A new version arrives as a new package (ADR-0121 D9). The declaration is pinned, as the
 * in-place launcher of the folder package pins it: an inherited `user-local` does not apply here.
 */
export function keikoEnv(env) {
  return { ...env, KEIKO_PORTABLE_MANAGEMENT: "organization-managed" };
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function lockHolderAlive(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const pid = Number.parseInt(text, 10);
  return Number.isInteger(pid) && pid > 0 && processAlive(pid);
}

export function installLockPath(root) {
  return join(root, ...INSTALL_LOCK);
}

export function stopRequestPath(root) {
  return join(root, ...STOP_REQUEST);
}

/** Whether another start of this folder is installing Keiko right now. */
export function installerActive(root) {
  return lockHolderAlive(installLockPath(root));
}

/**
 * Makes this start the folder's one installer. Returns false while another start installs; a lock
 * whose start no longer runs (it crashed or was closed) is taken over.
 */
export function acquireInstallLock(root) {
  const path = installLockPath(root);
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, `${String(process.pid)}\n`);
      closeSync(fd);
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (lockHolderAlive(path)) return false;
      rmSync(path, { force: true });
    }
  }
  return false;
}

function releaseInstallLock(root) {
  rmSync(installLockPath(root), { force: true });
}

function runNpm(root, nodeDir, env, run) {
  const npmCli = npmCliCandidates(nodeDir).find((candidate) => existsSync(candidate));
  if (npmCli === undefined) {
    say(
      'Keiko is incomplete: npm is missing in the folder "system".',
      'Keiko ist unvollstaendig: Im Ordner "system" fehlt npm.',
    );
    return false;
  }
  const registryNamed = folderRegistry(root);
  const state = stateDir(env);
  say(
    "Keiko is loaded from the npm registry. The first start can take a few minutes.",
    "Keiko wird aus der npm-Registry geladen. Der erste Start kann einige Minuten dauern.",
  );
  rmSync(join(root, "node_modules", INSTALLED_MARKER), { force: true });
  // Keiko creates its data folder owner-private; npm, which runs first, must not create it wider.
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const logsDir = npmLogsDir(state);
  mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  // A cache of this attempt only, owner-private: nothing that was there before is touched, and the
  // downloads are not needed again once the packages are in node_modules.
  const cacheDir = mkdtempSync(join(state, "npm-cache-"));
  try {
    const result = run(process.execPath, installArgs(npmCli, root, cacheDir, logsDir), {
      cwd: root,
      stdio: "inherit",
      env: npmEnv(env, nodeDir, registryNamed),
    });
    if (result.status === 0 && existsSync(keikoCliPath(root))) return true;
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
  say(
    `Keiko could not be loaded from the npm registry. Check the network connection and the file .npmrc in this folder, or tell your administrator. npm's log: ${logsDir}`,
    `Keiko konnte nicht aus der npm-Registry geladen werden. Pruefe die Netzwerkverbindung und die Datei .npmrc in diesem Ordner oder sag deinem Administrator Bescheid. Das Protokoll von npm: ${logsDir}`,
  );
  return false;
}

/** Installs Keiko unless the last complete installation was of this lockfile; the caller holds the lock. */
export function ensureInstalled(root, nodeDir, env, run = spawnSync) {
  const digest = lockfileDigest(root);
  if (installationCurrent(root, digest)) return true;
  if (!runNpm(root, nodeDir, env, run)) return false;
  const fd = openSync(join(root, "node_modules", INSTALLED_MARKER), "w");
  writeSync(fd, `${digest}\n`);
  closeSync(fd);
  return true;
}

/** Why the system refused to start Keiko's process: only its error code, never a path. */
function reportStartRefused(error) {
  const code = typeof error?.code === "string" ? error.code : undefined;
  if (code === "ENOENT") {
    say(
      'Keiko is incomplete: the Node.js runtime is missing in the folder "system". Unpack the folder again.',
      'Keiko ist unvollstaendig: Im Ordner "system" fehlt die Node.js-Laufzeit. Entpacke den Ordner noch einmal.',
    );
    return;
  }
  say(
    `Keiko could not be started (${code ?? "unknown error"}).`,
    `Keiko konnte nicht gestartet werden (${code ?? "unbekannter Fehler"}).`,
  );
}

function runKeiko(root, args, env, run) {
  const result = run(process.execPath, [keikoCliPath(root), ...args], {
    cwd: root,
    stdio: "inherit",
    env: keikoEnv(env),
  });
  if (result.error !== undefined) {
    // No child ran, so nothing else would say why Start or Stop ended here.
    reportStartRefused(result.error);
    return 1;
  }
  return result.status ?? 1;
}

export function startArgs(root, env) {
  const args = ["start", "--state-dir", stateDir(env)];
  const config = join(root, CONFIG_NAME);
  return existsSync(config) ? [...args, "--provisioned-config", config] : args;
}

// The installation, owned by one start of this folder. A Stop made meanwhile keeps Keiko from
// starting afterwards; the request is read once the lock is released, so a Stop that still found
// the installer running is never missed. Returns "install-failed", "stopped" or "installed".
function installOwned(root, nodeDir, env, run) {
  rmSync(stopRequestPath(root), { force: true });
  let installed;
  try {
    installed = ensureInstalled(root, nodeDir, env, run);
  } finally {
    releaseInstallLock(root);
  }
  if (!installed) return "install-failed";
  if (!existsSync(stopRequestPath(root))) return "installed";
  rmSync(stopRequestPath(root), { force: true });
  return "stopped";
}

/** Installs Keiko when needed and starts it; returns Keiko's exit code. */
export function start(root, nodeDir, env, run = spawnSync) {
  const args = startArgs(root, env);
  if (!installationCurrent(root, lockfileDigest(root))) {
    if (!acquireInstallLock(root)) {
      say(
        "Keiko is being loaded by another start of this folder. Keiko opens when it is done.",
        "Keiko wird gerade von einem anderen Start dieses Ordners geladen. Keiko oeffnet sich, sobald er fertig ist.",
      );
      return 0;
    }
    const outcome = installOwned(root, nodeDir, env, run);
    if (outcome === "install-failed") return 1;
    if (outcome === "stopped") {
      say(
        "Keiko was stopped while it was being loaded and does not start.",
        "Keiko wurde beendet, waehrend es geladen wurde, und startet nicht.",
      );
      return 0;
    }
  }
  return runKeiko(root, args, env, run);
}

/**
 * Stops a running Keiko. While a start of this folder is still loading Keiko, the Stop is recorded
 * and that start does not open Keiko. A folder Keiko was never loaded into has nothing to stop.
 */
export function stop(root, env, run = spawnSync) {
  const state = stateDir(env);
  if (installerActive(root)) {
    const fd = openSync(stopRequestPath(root), "w");
    writeSync(fd, `${String(process.pid)}\n`);
    closeSync(fd);
    // Still loading after the request was written: that start reads it once it is done.
    if (installerActive(root)) {
      say(
        "Keiko is still being loaded. It will not start.",
        "Keiko wird noch geladen. Es startet nicht.",
      );
      return 0;
    }
    // The installation ended meanwhile; this Stop is an ordinary one.
    rmSync(stopRequestPath(root), { force: true });
  }
  if (!existsSync(keikoCliPath(root))) {
    say("Keiko is not running.", "Keiko laeuft nicht.");
    return 0;
  }
  return runKeiko(root, ["stop", "--state-dir", state], env, run);
}

// The gateway connection Gateway Setup verified, and what it built from it. One token covers only
// these blocks: a model or reranker with another endpoint, header or credential never receives it.
const DEFAULT_KEY_HEADER = "authorization";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A loop, not `/\/+$/`: a run of `/` before other text makes that pattern retry at every slash.
function withoutTrailingSlashes(value) {
  let end = value.length;
  while (end > 0 && value.codePointAt(end - 1) === 47 /* '/' */) end -= 1;
  return value.slice(0, end);
}

function baseUrlIdentity(value) {
  if (typeof value !== "string") return undefined;
  try {
    return withoutTrailingSlashes(new URL(value.trim()).href);
  } catch {
    return withoutTrailingSlashes(value.trim());
  }
}

function capabilityOf(config, modelId) {
  const capabilities = Array.isArray(config.capabilities) ? config.capabilities : [];
  return capabilities.find((capability) => isRecord(capability) && capability.id === modelId);
}

// The main chat connection, as Gateway Setup reads it: the first chat model (a model without a
// capability entry is a chat model), else the first model that is not a voice deployment.
function primaryProvider(config) {
  const kind = (provider) => capabilityOf(config, provider.modelId)?.kind;
  const providers = config.providers.filter(isRecord);
  return (
    providers.find((provider) => kind(provider) === undefined || kind(provider) === "chat") ??
    providers.find((provider) => kind(provider) !== "voice")
  );
}

function sameConnection(block, primary) {
  const header = (candidate) => (candidate.apiKeyHeaderName ?? DEFAULT_KEY_HEADER).toLowerCase();
  return (
    baseUrlIdentity(block.baseUrl) !== undefined &&
    baseUrlIdentity(block.baseUrl) === baseUrlIdentity(primary.baseUrl) &&
    header(block) === header(primary)
  );
}

// Gateway Setup marks what it built from the connection it verified: every chat and embedding model
// carries `catalogOrigin`, every voice deployment it found there a gateway-managed capability.
// A model entered with its own credential carries neither, even on the same endpoint.
function builtFromConnection(config, provider, primary) {
  if (provider === primary) return true;
  if (provider.endpointStyle !== primary.endpointStyle) return false;
  if (provider.apiVersion !== primary.apiVersion) return false;
  if (!sameConnection(provider, primary)) return false;
  const capability = capabilityOf(config, provider.modelId);
  return (
    provider.catalogOrigin !== undefined ||
    (capability?.kind === "voice" && capability.voiceProviderLocality === "gateway-managed")
  );
}

function blockName(block, fallback) {
  return typeof block?.modelId === "string" ? block.modelId : fallback;
}

/** The sealed blocks of a configuration: providers first, then a reranker, with their test. */
function sealedBlocks(config, primary) {
  const providers = Array.isArray(config.providers) ? config.providers.filter(isRecord) : [];
  const blocks = providers.map((provider) => ({
    block: provider,
    fallback: "a model",
    verified: () => builtFromConnection(config, provider, primary),
  }));
  if (isRecord(config.reranker)) {
    const reranker = config.reranker;
    blocks.push({
      block: reranker,
      fallback: "the reranker",
      verified: () => sameConnection(reranker, primary),
    });
  }
  return blocks.filter(({ block }) => block.apiKeySecretRef !== undefined);
}

/**
 * Which keys sealed on this computer the team token replaces (`token`), and which belong to another
 * connection (`foreign`, by model name). A reranker shares the token only on the gateway's own
 * endpoint and header, exactly where Gateway Setup wires a discovered one.
 */
export function credentialScope(config) {
  const providers = Array.isArray(config.providers) ? config.providers.filter(isRecord) : [];
  const primary = providers.length > 0 ? primaryProvider(config) : undefined;
  const token = new Set();
  const foreign = [];
  for (const { block, fallback, verified } of sealedBlocks(config, primary)) {
    if (primary !== undefined && verified()) token.add(block);
    else foreign.push(blockName(block, fallback));
  }
  return { token, foreign };
}

export function needsToken(config) {
  return credentialScope(config).token.size > 0;
}

function withToken(block, scope, token) {
  if (!scope.token.has(block)) return block;
  const kept = Object.entries(block).filter(([field]) => field !== "apiKeySecretRef");
  return { ...Object.fromEntries(kept), apiKey: token };
}

/**
 * The configuration Gateway Setup saved on this computer, made usable on every other one: a key
 * sealed into this computer's vault (`apiKeySecretRef`) names nothing elsewhere, so on the verified
 * gateway connection it becomes the token the administrator enters. A key of any other connection
 * refuses: one token must never reach a service it was not verified for. Throws a message a person
 * can act on.
 */
export function teamConfig(config, token) {
  if (!Array.isArray(config.providers) || config.providers.length === 0) {
    throw new Error("the configuration names no models");
  }
  for (const provider of config.providers) {
    if (typeof provider?.modelId !== "string" || typeof provider.baseUrl !== "string") {
      throw new TypeError("a model in the configuration names no modelId or baseUrl");
    }
  }
  const scope = credentialScope(config);
  if (scope.foreign.length > 0) {
    const names = scope.foreign.join(", ");
    throw new LauncherRefusal(
      `This configuration uses more than one credential: ${names} has its own connection. The access step writes one gateway token. Remove the other connection in Gateway Setup, or prepare keiko.config.json by hand with every key.`,
      `Diese Konfiguration nutzt mehr als einen Zugang: ${names} hat eine eigene Verbindung. Der Zugangsschritt schreibt ein Gateway-Token. Entferne die andere Verbindung in der Gateway-Einrichtung oder erstelle keiko.config.json von Hand mit allen Schluesseln.`,
    );
  }
  const providers = config.providers.map((provider) => withToken(provider, scope, token));
  return config.reranker === undefined
    ? { ...config, providers }
    : { ...config, providers, reranker: withToken(config.reranker, scope, token) };
}

const ENTER = new Set(["\r", "\n"]);
const ERASE = new Set(["\u007f", "\b"]);
const CANCEL = "\u0003";
const ESCAPE = "\u001b";

// ESC [ parameters final-byte (CSI) or ESC O final-byte (SS3): an arrow, Home or Delete key, never
// part of a token. Returns the next state, or undefined when the character is not part of a key:
// after a lone ESC (the Escape key itself) a character is typed as usual.
function escapeState(state, character) {
  if (state === "escape") {
    if (character === "[") return "csi";
    if (character === "O") return "ss3";
    return character === ESCAPE ? "escape" : undefined;
  }
  if (state === "ss3") return "none";
  const code = character.codePointAt(0);
  return code >= 0x40 && code <= 0x7e ? "none" : "csi";
}

function typeCharacter(token, character) {
  if (ERASE.has(character)) token.pop();
  else if (character.codePointAt(0) >= 0x20) token.push(character);
}

/**
 * Applies one chunk of raw terminal input to the token typed so far. A terminal may hand one key
 * over in two reads, so `escape` carries the state of an unfinished key into the next chunk.
 * Enter and Ctrl+C are never part of a key sequence, so they end the input in every state: an
 * unfinished key cannot swallow them and leave the terminal in raw mode.
 */
export function tokenInput(value, chunk, escape = "none") {
  const token = [...value];
  let state = escape;
  for (const character of chunk) {
    if (ENTER.has(character)) return { value: token.join(""), end: "enter", escape: "none" };
    if (character === CANCEL) return { value: "", end: "cancel", escape: "none" };
    const next = state === "none" ? undefined : escapeState(state, character);
    if (next !== undefined) state = next;
    else if (character === ESCAPE) state = "escape";
    else {
      state = "none";
      typeCharacter(token, character);
    }
  }
  return { value: token.join(""), end: undefined, escape: state };
}

/**
 * The token is typed or pasted without being shown. Enter ends it, Ctrl+C cancels; either way the
 * terminal leaves raw mode. `io` is the process's terminal unless a caller hands in another.
 */
export function readHidden(prompt, io = process) {
  const { stdin, stdout } = io;
  if (!stdin.isTTY) {
    return Promise.reject(
      new Error("no terminal to read the token from / kein Terminal fuer die Eingabe des Tokens"),
    );
  }
  stdout.write(prompt);
  return new Promise((resolveToken, rejectToken) => {
    let value = "";
    let escape = "none";
    const finish = (error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stdout.write("\n");
      if (error === undefined) resolveToken(value.trim());
      else rejectToken(error);
    };
    const onData = (chunk) => {
      const step = tokenInput(value, chunk, escape);
      value = step.value;
      escape = step.escape;
      if (step.end === "enter") finish();
      else if (step.end === "cancel") finish(new Error("cancelled / abgebrochen"));
    };
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.resume();
  });
}

/** Writes a new owner-private file completely and durably; it must not exist yet. */
export function writeNewPrivateFile(path, text) {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Replaces `target` in one step: the text goes into a new owner-private file beside it, which then
 * takes the target's name. An existing file never holds the new token under its old permissions,
 * and a failed write leaves it as it was.
 */
export function publishPrivateFile(target, text, writeNew = writeNewPrivateFile) {
  const temporary = join(
    dirname(target),
    `.${basename(target)}.${String(process.pid)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    writeNew(temporary, text);
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

// Keiko reads its configuration from KEIKO_CONFIG_FILE or KEIKO_UI_DATA_DIR when one is set, so
// Gateway Setup then saved it there, not in the data folder this step reads.
function configOverride(env) {
  return ["KEIKO_CONFIG_FILE", "KEIKO_UI_DATA_DIR"].find(
    (name) => env[name] !== undefined && env[name].length > 0,
  );
}

/**
 * The administrator's access step: writes the team's keiko.config.json from the configuration
 * Gateway Setup saved. Returns the exit code; a token that was needed and not entered throws.
 */
export async function saveConfig(root, env, io = {}) {
  const readToken = io.readToken ?? readHidden;
  const override = configOverride(env);
  if (override !== undefined) {
    say(
      `${override} is set, so Keiko keeps its configuration elsewhere. Unset it, start Keiko from this folder, complete Gateway Setup, stop Keiko, then run this again.`,
      `${override} ist gesetzt, daher speichert Keiko seine Konfiguration anderswo. Entferne die Variable, starte Keiko aus diesem Ordner, schliesse die Gateway-Einrichtung ab, beende Keiko und fuehre dies erneut aus.`,
    );
    return 1;
  }
  const saved = join(stateDir(env), "ui", CONFIG_NAME);
  if (!existsSync(saved)) {
    say(
      "Set Keiko up first: start Keiko, complete Gateway Setup, stop Keiko, then run this again.",
      "Richte Keiko zuerst ein: Keiko starten, Gateway-Einrichtung abschliessen, Keiko beenden, dann dies erneut ausfuehren.",
    );
    return 1;
  }
  const config = JSON.parse(readFileSync(saved, "utf8"));
  // Refuses another connection's key before the token is asked for.
  teamConfig(config, "");
  const token = needsToken(config)
    ? await readToken("API token (not shown) / API-Token (wird nicht angezeigt): ")
    : "";
  if (needsToken(config) && token.length === 0) throw new Error("no token entered");
  const text = `${JSON.stringify(teamConfig(config, token), null, 2)}\n`;
  publishPrivateFile(join(root, CONFIG_NAME), text, io.writeNew);
  say(
    `Saved: ${CONFIG_NAME}. Everyone who starts this folder uses this gateway without entering anything. The file holds the token in plain text: share the folder with your team only.`,
    `Gespeichert: ${CONFIG_NAME}. Wer diesen Ordner startet, nutzt dieses Gateway, ohne etwas einzugeben. Die Datei enthaelt das Token im Klartext: Gib den Ordner nur an dein Team weiter.`,
  );
  return 0;
}

/** Runs one command of a start file; `context` stands in for the process in tests. */
export async function main(command, context = {}) {
  const root = context.root ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const nodeDir = context.nodeDir ?? dirname(process.execPath);
  const env = context.env ?? process.env;
  const run = context.run ?? spawnSync;
  if (command === "start") return start(root, nodeDir, env, run);
  if (command === "stop") return stop(root, env, run);
  if (command === "save-config") return saveConfig(root, env, context.io);
  console.error("usage: keiko-npm.mjs start | stop | save-config");
  return 2;
}

/**
 * Whether Node.js runs this file as its program. Node.js resolves symbolic links for the module's
 * URL but not for argv[1], so a folder reached through a link (/tmp, a redirected Documents
 * folder, a subst drive) compares both resolved; a plain comparison would start nothing there.
 * Both sides use the same realpathSync the module loader uses, so they resolve alike.
 */
export function isEntryPoint(scriptPath, moduleUrl) {
  if (scriptPath === undefined || !existsSync(scriptPath)) return false;
  return realpathSync(scriptPath) === realpathSync(fileURLToPath(moduleUrl));
}

/** Runs the command and turns every failure into a message and exit code 1. */
export async function runCommand(command, context = {}) {
  try {
    return await main(command, context);
  } catch (error) {
    console.error(`Keiko: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  process.exitCode = await runCommand(process.argv[2]);
}
