#!/usr/bin/env node
// What a standard account created or changed outside its own areas (#4520).
//
// The macOS promise says a person without administrator rights installs and starts Keiko without
// writing anywhere but their own folders. After a run of qualify-macos-standard-account-forms.mjs,
// this script walks the whole writable data volume as root and lists every entry that changed after
// a marker file the job wrote before the account acted. It ignores the account's own areas: its home
// and the per-user folder macOS assigns it under /var/folders (its temporary and cache folders). Of
// the rest, an entry counts against the promise when the account owns it: the account created or
// replaced it. Two kinds of change are listed but not attributed:
//   - an entry the account owns inside one of the three folders macOS's own services keep for it
//     (trustd's and sfanalytics' under its GeneratedUID, mds's under its uid; see inSystemArea):
//     like /var/folders, an area the system assigns the account, not one a program it runs chooses;
//   - a regular file of another account that the account may also write by its mode bits: a change
//     to it cannot be told apart from that account's own change (on a hosted runner, the runner
//     account works through the whole job).
// Every other change belongs to a program of another account and is counted. Entries a run created
// and removed again leave nothing behind and are not seen.
//
// It must run as root, so it can read every folder. Output: one line per counted class, the listed
// paths, and an evidence file; it exits 1 when the account owns an entry outside its areas.

import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { readFlagPairs } from "../lib/flag-pairs.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";

const EVIDENCE_KIND = "keiko-standard-account-footprint";
const EVIDENCE_SCHEMA_VERSION = 2;
/** The writable volume of a Mac since macOS 10.15; the system volume is sealed and read-only. */
export const DATA_VOLUME = "/System/Volumes/Data";
const ACCOUNT_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/u;
const GUID_PATTERN = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/iu;
const LISTED_PATHS = 200;
const LISTED_KINDS = Object.freeze(["owned", "systemArea", "shared"]);
const FIND_TIMEOUT_MS = 30 * 60 * 1000;

const USAGE = `Usage (as root, after the account acted):
  sudo node scripts/testing/standard-account-footprint.mjs --account NAME --marker FILE
       [--evidence FILE]

  --account   the standard account whose writes are checked
  --marker    a file written before the account acted; later changes are examined
  --evidence  the evidence file (default: print only)
`;

export class FootprintRefusal extends Error {}

function refuse(message) {
  throw new FootprintRefusal(message);
}

/** Parses the command line; anything unknown or malformed is refused. */
export function parseFootprintArgs(argv) {
  const flags = { "--account": "account", "--marker": "marker", "--evidence": "evidence" };
  const options = readFlagPairs(argv, flags, {}, refuse);
  if (typeof options.account !== "string" || !ACCOUNT_PATTERN.test(options.account)) {
    refuse("--account must name an account");
  }
  if (options.marker === undefined) refuse("--marker is required");
  return options;
}

/** The path of a folder on the data volume, as `find` reaches it there (firmlinks resolved). */
export function onDataVolume(path, volume = DATA_VOLUME) {
  const real = realpathSync(path);
  return real.startsWith(`${volume}/`) ? real : join(volume, real);
}

function output(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) refuse(`${command} ${args.join(" ")} failed`);
  return String(result.stdout).trim();
}

function directoryValue(run, account, key) {
  return run("dscl", [".", "-read", `/Users/${account}`, key])
    .replace(new RegExp(`^${key}:\\s*`, "u"), "")
    .trim();
}

/**
 * The account's ids, its GeneratedUID and its own areas: its home and the per-user folder under
 * /var/folders.
 */
export function accountAreas(account, run = output) {
  const uid = Number(run("id", ["-u", account]));
  const gids = run("id", ["-G", account])
    .split(/\s+/u)
    .map((gid) => Number(gid));
  const home = directoryValue(run, account, "NFSHomeDirectory");
  const guid = directoryValue(run, account, "GeneratedUID");
  // DARWIN_USER_DIR is <per-user folder>/0/; its parent also holds the T (temporary) and C
  // (cache) folders of the account.
  const userDir = run("sudo", ["-u", account, "getconf", "DARWIN_USER_DIR"]);
  if (!Number.isInteger(uid) || home === "" || userDir === "" || !GUID_PATTERN.test(guid)) {
    refuse("the account is unknown");
  }
  return { uid, gids, guid, roots: [home, dirname(userDir.replace(/\/+$/u, ""))] };
}

/**
 * Whether the mode bits let the account write an entry (owner, group or other write bit). Access
 * control lists are not read: on a hosted runner no folder outside the account's areas grants it
 * one, and an entry it created through one is owned by it and counted as `owned`.
 */
export function writableBy(stats, { uid, gids }) {
  if (stats.uid === uid) return (stats.mode & 0o200) !== 0;
  if (gids.includes(stats.gid)) return (stats.mode & 0o020) !== 0;
  return (stats.mode & 0o002) !== 0;
}

/**
 * Whether an entry lies in one of the folders macOS's own services keep for the account and create
 * as the account: trustd's trust cache and sfanalytics' analytics under its GeneratedUID, mds's
 * messages under its uid. Only these exact parents count; anything else the account owns below
 * /private/var, `/private/var/tmp/<uid>` included, is `owned`.
 */
export function inSystemArea(path, { uid, guid }, volume = DATA_VOLUME) {
  // The data volume compares names without case, and a GeneratedUID is the same in either case.
  const entry = path.toUpperCase();
  const parents = [
    `${volume}/private/var/protected/trustd/private/${guid}`,
    `${volume}/private/var/protected/sfanalytics/${guid}`,
    `${volume}/private/var/db/mds/messages/${String(uid)}`,
  ].map((parent) => parent.toUpperCase());
  return parents.some((parent) => entry === parent || entry.startsWith(`${parent}/`));
}

/** A walk passes without a violation, and only when it read every folder: one it could not read hides what is in it. */
export function walkPassed(violationCount, unreadableFolderCount) {
  return violationCount === 0 && unreadableFolderCount === 0;
}

/** The entry's own metadata, or undefined when it is no longer there. */
function inspectEntry(path, stat) {
  try {
    return stat(path);
  } catch (error) {
    // Only an entry that is no longer there is gone; any other failure leaves it uninspected.
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    refuse(`a changed entry could not be inspected (${code})`);
  }
}

/**
 * The class of one changed entry: `owned` (the account owns it outside its areas), `systemArea`
 * (it owns it in a folder the system keeps for it), `shared` (a regular file of another account
 * that the account may also write), `others` (a change the account could not have made), or `gone`
 * (removed since).
 */
export function classifyEntry(path, account, stat = lstatSync) {
  const stats = inspectEntry(path, stat);
  if (stats === undefined) return "gone";
  if (stats.uid === account.uid) return inSystemArea(path, account) ? "systemArea" : "owned";
  // A regular file only: a socket or a folder of another account changes without the account.
  if (stats.isFile() && writableBy(stats, account)) return "shared";
  return "others";
}

/** The `find` arguments: the data volume, the account's areas pruned, changes after the marker. */
export function findArguments(volume, prunedRoots, marker) {
  const prune = prunedRoots.flatMap((root, index) => [...(index > 0 ? ["-o"] : []), "-path", root]);
  return [
    volume,
    "-xdev",
    "(",
    ...prune,
    ")",
    "-prune",
    "-o",
    "(",
    "-newer",
    marker,
    "-o",
    "-cnewer",
    marker,
    ")",
    "-print0",
  ];
}

/** Counts each class and lists the owned, system-area and shared paths, up to a bound each. */
export function summarize(paths, classify) {
  const counts = { owned: 0, systemArea: 0, shared: 0, others: 0, gone: 0 };
  const listed = Object.fromEntries(LISTED_KINDS.map((kind) => [kind, []]));
  for (const path of paths) {
    const kind = classify(path);
    counts[kind] += 1;
    if (listed[kind] !== undefined && listed[kind].length < LISTED_PATHS) listed[kind].push(path);
  }
  return { counts, listed, violationCount: counts.owned };
}

// What find may report without the walk losing an entry the account could have written: a folder
// it may not read (a privacy-protected folder of another account) and an entry removed while it
// walked (it left nothing behind). Any other diagnostic means a part of the volume went unexamined.
const UNREADABLE_DIAGNOSTIC = /: (?:Permission denied|Operation not permitted)$/u;
const VANISHED_DIAGNOSTIC = /: No such file or directory$/u;

/** Sorts find's diagnostics; an unknown one refuses the walk instead of passing a partial one. */
export function classifyDiagnostics(stderr) {
  const counts = { unreadable: 0, vanished: 0 };
  for (const line of String(stderr).split("\n")) {
    if (line.trim() === "") continue;
    if (UNREADABLE_DIAGNOSTIC.test(line)) counts.unreadable += 1;
    else if (VANISHED_DIAGNOSTIC.test(line)) counts.vanished += 1;
    else refuse(`find reported an error that leaves the walk incomplete: ${line}`);
  }
  return counts;
}

/**
 * Runs `find` over one volume and returns the changed entries and how many folders it could not
 * read or saw vanish. find exits 1 after such a diagnostic, which is not a failure of the walk.
 */
export function findChanged(volume, prunedRoots, marker, run = spawnSync) {
  const found = run("find", findArguments(volume, prunedRoots, marker), {
    encoding: "utf8",
    maxBuffer: 512 << 20,
    timeout: FIND_TIMEOUT_MS,
  });
  if (found.error !== undefined) refuse(`find did not finish: ${found.error.message}`);
  const { unreadable, vanished } = classifyDiagnostics(found.stderr);
  if (found.status !== 0 && unreadable + vanished === 0) {
    refuse(`find exited ${String(found.status)}`);
  }
  return { paths: String(found.stdout).split("\0").filter(Boolean), unreadable, vanished };
}

function changedEntries(options, areas) {
  const pruned = areas.roots.map((root) => onDataVolume(root));
  const marker = resolve(options.marker);
  statSync(marker);
  return { ...findChanged(DATA_VOLUME, pruned, marker), prunedCount: pruned.length };
}

/** Walks the data volume and returns the evidence. */
function runFootprint(options) {
  if (process.getuid?.() !== 0) refuse("run as root: only root can read every folder");
  const started = performance.now();
  const areas = accountAreas(options.account);
  const { paths, unreadable, vanished, prunedCount } = changedEntries(options, areas);
  const summary = summarize(paths, (path) => classifyEntry(path, areas));
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    kind: EVIDENCE_KIND,
    account: options.account,
    volume: DATA_VOLUME,
    prunedAreaCount: prunedCount,
    changedEntryCount: paths.length,
    unreadableFolderCount: unreadable,
    vanishedDuringWalkCount: vanished,
    counts: summary.counts,
    violationCount: summary.violationCount,
    listed: summary.listed,
    passed: walkPassed(summary.violationCount, unreadable),
    durationMs: Math.round(performance.now() - started),
  };
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  try {
    const options = parseFootprintArgs(argv);
    const evidence = runFootprint(options);
    if (options.evidence !== undefined) {
      writeFileSync(resolve(options.evidence), `${JSON.stringify(evidence, null, 2)}\n`);
    }
    const { counts } = evidence;
    console.log(
      `changed after the marker: ${String(evidence.changedEntryCount)} entries; owned by ${options.account} outside its areas: ${String(counts.owned)}; in folders the system keeps for it: ${String(counts.systemArea)}; files of other accounts it may also write: ${String(counts.shared)}; by other accounts: ${String(counts.others)}; removed since: ${String(counts.gone)}; unreadable folders: ${String(evidence.unreadableFolderCount)}; vanished during the walk: ${String(evidence.vanishedDuringWalkCount)}`,
    );
    for (const kind of LISTED_KINDS) {
      for (const path of evidence.listed[kind]) console.log(`${kind}: ${path}`);
    }
    console.log(
      `${evidence.passed ? "PASS" : "FAIL"} nothing outside the account's own areas was created or changed`,
    );
    return evidence.passed ? 0 : 1;
  } catch (error) {
    if (!(error instanceof FootprintRefusal)) throw error;
    console.error(`FAIL standard-account-footprint: ${error.message}`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
