// Start, stop and the administrator's access step of a Keiko npm package (ADR-0121 D9).
//
// This file ships inside the package as system/keiko-npm.mjs and runs with the Node.js runtime next
// to it. Keiko itself is not in the package: the first start installs the exact version that
// package.json names from the npm registry the folder's .npmrc names (the public registry without
// one), checked against the integrity hashes in package-lock.json. A later start installs again
// only when the lockfile changed or an earlier installation did not finish.
//
// Only Node.js built-ins: the file must run before anything is installed.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_PATH = ["node_modules", "@oscharko-dev", "keiko"];
const INSTALLED_MARKER = ".keiko-npm-installed";
const CONFIG_NAME = "keiko.config.json";
// The data of every Keiko start form of this computer account: a new package folder, or the
// folder package, finds the chats and settings of the old one.
const STATE_DIR_NAME = ".keiko-standalone";

/** Prints one message in English and in German, as every start file does. */
function say(english, german) {
  console.log(english);
  console.log(german);
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

export function stateDir(env, home = homedir()) {
  const declared = env.KEIKO_STATE_DIR;
  return declared !== undefined && declared.length > 0 ? declared : join(home, STATE_DIR_NAME);
}

/** npm's cache, and with it npm's logs (<cache>/_logs), live in Keiko's data, not in ~/.npm. */
export function npmCacheDir(env, home = homedir()) {
  return join(stateDir(env, home), "npm-cache");
}

// --ignore-scripts: Keiko needs no install script, and none of its dependencies may run one here.
// The cache and the log are set on the command line, which no npm_config_* variable and no .npmrc
// overrides: npm writes nothing outside the folder and Keiko's data folder.
export function installArgs(npmCli, cacheDir) {
  return [
    npmCli,
    "ci",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-update-notifier",
    "--cache",
    cacheDir,
    "--logs-dir",
    join(cacheDir, "_logs"),
  ];
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

/** npm and the packages it installs find this folder's Node.js first. */
export function npmEnv(env, nodeDir) {
  const key = pathKey(env);
  const current = env[key];
  return { ...env, [key]: current ? `${nodeDir}${delimiter}${current}` : nodeDir };
}

/**
 * Keiko of a package performs no installation of its own: no setup, no Windows gateway service, no
 * update. A new version arrives as a new package (ADR-0121 D9).
 */
export function keikoEnv(env) {
  return env.KEIKO_PORTABLE_MANAGEMENT
    ? { ...env }
    : { ...env, KEIKO_PORTABLE_MANAGEMENT: "organization-managed" };
}

// A failed attempt keeps npm's log (<cache>/_logs) for the administrator, not the downloads.
function keepOnlyLog(cacheDir) {
  if (!existsSync(cacheDir)) return;
  for (const name of readdirSync(cacheDir)) {
    if (name !== "_logs") rmSync(join(cacheDir, name), { recursive: true, force: true });
  }
}

function install(root, nodeDir, env, run) {
  const npmCli = npmCliCandidates(nodeDir).find((candidate) => existsSync(candidate));
  if (npmCli === undefined) {
    say(
      'Keiko is incomplete: npm is missing in the folder "system".',
      'Keiko ist unvollstaendig: Im Ordner "system" fehlt npm.',
    );
    return false;
  }
  say(
    "Keiko is loaded from the npm registry. The first start can take a few minutes.",
    "Keiko wird aus der npm-Registry geladen. Der erste Start kann einige Minuten dauern.",
  );
  rmSync(join(root, "node_modules", INSTALLED_MARKER), { force: true });
  // Keiko creates its data folder owner-private; npm, which runs first, must not create it wider.
  mkdirSync(stateDir(env), { recursive: true, mode: 0o700 });
  const cacheDir = npmCacheDir(env);
  const result = run(process.execPath, installArgs(npmCli, cacheDir), {
    cwd: root,
    stdio: "inherit",
    env: npmEnv(env, nodeDir),
  });
  if (result.status !== 0 || !existsSync(keikoCliPath(root))) {
    say(
      "Keiko could not be loaded from the npm registry. Check the network connection and the file .npmrc in this folder, or tell your administrator.",
      "Keiko konnte nicht aus der npm-Registry geladen werden. Pruefe die Netzwerkverbindung und die Datei .npmrc in diesem Ordner oder sag deinem Administrator Bescheid.",
    );
    keepOnlyLog(cacheDir);
    return false;
  }
  // Every package is in node_modules now; the downloaded copies are not needed again.
  rmSync(cacheDir, { recursive: true, force: true });
  return true;
}

/** Installs Keiko unless the last complete installation was of this lockfile. */
export function ensureInstalled(root, nodeDir, env, run = spawnSync) {
  const digest = lockfileDigest(root);
  if (installationCurrent(root, digest)) return true;
  if (!install(root, nodeDir, env, run)) return false;
  writeFileSync(join(root, "node_modules", INSTALLED_MARKER), `${digest}\n`);
  return true;
}

function runKeiko(root, args, env, run) {
  const result = run(process.execPath, [keikoCliPath(root), ...args], {
    cwd: root,
    stdio: "inherit",
    env: keikoEnv(env),
  });
  return result.status ?? 1;
}

export function startArgs(root, env) {
  const args = ["start", "--state-dir", stateDir(env)];
  const config = join(root, CONFIG_NAME);
  return existsSync(config) ? [...args, "--provisioned-config", config] : args;
}

/** Installs Keiko when needed and starts it; returns Keiko's exit code. */
export function start(root, nodeDir, env, run = spawnSync) {
  if (!ensureInstalled(root, nodeDir, env, run)) return 1;
  return runKeiko(root, startArgs(root, env), env, run);
}

/** Stops a running Keiko; a folder Keiko was never loaded into has nothing to stop. */
export function stop(root, env, run = spawnSync) {
  if (!existsSync(keikoCliPath(root))) return 0;
  return runKeiko(root, ["stop", "--state-dir", stateDir(env)], env, run);
}

// Gateway Setup asks for one gateway token, so every key it sealed becomes that token.
function withToken(block, token) {
  if (block?.apiKeySecretRef === undefined) return block;
  const kept = Object.entries(block).filter(([field]) => field !== "apiKeySecretRef");
  return { ...Object.fromEntries(kept), apiKey: token };
}

/**
 * The configuration Gateway Setup saved on this computer, made usable on every other one: a key
 * sealed into this computer's vault (`apiKeySecretRef`) names nothing elsewhere, so it becomes the
 * token the administrator enters. Throws a message a person can act on.
 */
export function teamConfig(config, token) {
  if (!Array.isArray(config.providers) || config.providers.length === 0) {
    throw new Error("the configuration names no models");
  }
  const providers = config.providers.map((provider) => {
    if (typeof provider?.modelId !== "string" || typeof provider.baseUrl !== "string") {
      throw new TypeError("a model in the configuration names no modelId or baseUrl");
    }
    return withToken(provider, token);
  });
  return config.reranker === undefined
    ? { ...config, providers }
    : { ...config, providers, reranker: withToken(config.reranker, token) };
}

export function needsToken(config) {
  const blocks = [...(Array.isArray(config.providers) ? config.providers : []), config.reranker];
  return blocks.some((block) => block?.apiKeySecretRef !== undefined);
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

/**
 * The administrator's access step: writes the team's keiko.config.json from the configuration
 * Gateway Setup saved. Returns the exit code; a token that was needed and not entered throws.
 */
export async function saveConfig(root, env, readToken = readHidden) {
  const saved = join(stateDir(env), "ui", CONFIG_NAME);
  if (!existsSync(saved)) {
    say(
      "Set Keiko up first: start Keiko, complete Gateway Setup, stop Keiko, then run this again.",
      "Richte Keiko zuerst ein: Keiko starten, Gateway-Einrichtung abschliessen, Keiko beenden, dann dies erneut ausfuehren.",
    );
    return 1;
  }
  const config = JSON.parse(readFileSync(saved, "utf8"));
  const token = needsToken(config)
    ? await readToken("API token (not shown) / API-Token (wird nicht angezeigt): ")
    : "";
  if (needsToken(config) && token.length === 0) throw new Error("no token entered");
  const target = join(root, CONFIG_NAME);
  writeFileSync(target, `${JSON.stringify(teamConfig(config, token), null, 2)}\n`, { mode: 0o600 });
  chmodSync(target, 0o600);
  say(
    `Saved: ${CONFIG_NAME}. Everyone who starts this folder uses this gateway without entering anything. The file holds the token in plain text: share the folder with your team only.`,
    `Gespeichert: ${CONFIG_NAME}. Wer diesen Ordner startet, nutzt dieses Gateway, ohne etwas einzugeben. Die Datei enthaelt das Token im Klartext: Gib den Ordner nur an dein Team weiter.`,
  );
  return 0;
}

async function main(command) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const nodeDir = dirname(process.execPath);
  const env = process.env;
  if (command === "start") return start(root, nodeDir, env);
  if (command === "stop") return stop(root, env);
  if (command === "save-config") return saveConfig(root, env);
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

if (isEntryPoint(process.argv[1], import.meta.url)) {
  try {
    process.exitCode = await main(process.argv[2]);
  } catch (error) {
    console.error(`Keiko: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
