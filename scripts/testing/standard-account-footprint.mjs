#!/usr/bin/env node
// What a standard account created or changed outside its own areas (#4520).
//
// The macOS promise says a person without administrator rights installs and starts Keiko without
// writing anywhere but their own folders. After a run of qualify-macos-standard-account-forms.mjs,
// this script walks the whole writable data volume as root and lists every entry that changed after
// a marker file the job wrote before the account acted. It ignores the account's own areas: its home
// and the per-user folder macOS assigns it under /var/folders (its temporary and cache folders). Of
// the rest, an entry counts against the promise when the account owns it (it created or replaced
// it), or when it is a file the account may write by its mode bits (it may have changed it). Every
// other change belongs to a program of another account and is counted, not attributed. Entries a
// run created and removed again leave nothing behind and are not seen.
//
// It must run as root, so it can read every folder. Output: one line per counted class, the first
// attributed paths of the runner, and an evidence file; it exits 1 when anything is attributed.

import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { readFlagPairs } from "../lib/flag-pairs.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";

export const EVIDENCE_KIND = "keiko-standard-account-footprint";
export const EVIDENCE_SCHEMA_VERSION = 1;
/** The writable volume of a Mac since macOS 10.15; the system volume is sealed and read-only. */
export const DATA_VOLUME = "/System/Volumes/Data";
const ACCOUNT_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/u;
const LISTED_PATHS = 20;
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

/** The account's ids and its own areas: its home and the per-user folder under /var/folders. */
export function accountAreas(account, run = output) {
  const uid = Number(run("id", ["-u", account]));
  const gids = run("id", ["-G", account]).split(/\s+/u).map(Number);
  const home = run("dscl", [".", "-read", `/Users/${account}`, "NFSHomeDirectory"])
    .replace(/^NFSHomeDirectory:\s*/u, "")
    .trim();
  // DARWIN_USER_DIR is <per-user folder>/0/; its parent also holds the T (temporary) and C
  // (cache) folders of the account.
  const userDir = run("sudo", ["-u", account, "getconf", "DARWIN_USER_DIR"]);
  if (!Number.isInteger(uid) || home === "" || userDir === "") refuse("the account is unknown");
  return { uid, gids, roots: [home, dirname(userDir.replace(/\/+$/u, ""))] };
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
 * The class of one changed entry: `owned` (the account owns it), `writable` (a regular file the
 * account may write), `others` (a change the account could not have made), or `gone` (removed
 * since).
 */
export function classifyEntry(path, account, stat = lstatSync) {
  let stats;
  try {
    stats = stat(path);
  } catch {
    return "gone";
  }
  if (stats.uid === account.uid) return "owned";
  // A regular file only: a socket or a folder of another account changes without the account.
  if (stats.isFile() && writableBy(stats, account)) return "writable";
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

/** Counts each class and keeps the first attributed paths. */
export function summarize(paths, classify) {
  const counts = { owned: 0, writable: 0, others: 0, gone: 0 };
  const attributed = [];
  for (const path of paths) {
    const kind = classify(path);
    counts[kind] += 1;
    if ((kind === "owned" || kind === "writable") && attributed.length < LISTED_PATHS) {
      attributed.push(`${kind}: ${path}`);
    }
  }
  return { counts, attributed, violationCount: counts.owned + counts.writable };
}

/**
 * Runs `find` over one volume and returns the changed entries and how many folders it could not
 * read. A folder root cannot read (a privacy-protected folder of another account) is counted; find
 * then exits 1, which is not a failure of the walk itself.
 */
export function findChanged(volume, prunedRoots, marker) {
  const found = spawnSync("find", findArguments(volume, prunedRoots, marker), {
    encoding: "utf8",
    maxBuffer: 512 << 20,
    timeout: FIND_TIMEOUT_MS,
  });
  if (found.error !== undefined) refuse(`find did not finish: ${found.error.message}`);
  const unreadable = String(found.stderr)
    .split("\n")
    .filter((line) => line.trim() !== "").length;
  if (found.status !== 0 && unreadable === 0) refuse(`find exited ${String(found.status)}`);
  return { paths: String(found.stdout).split("\0").filter(Boolean), unreadable };
}

function changedEntries(options, areas) {
  const pruned = areas.roots.map((root) => onDataVolume(root));
  const marker = resolve(options.marker);
  statSync(marker);
  return { ...findChanged(DATA_VOLUME, pruned, marker), prunedCount: pruned.length };
}

/** Walks the data volume and returns the evidence. */
export function runFootprint(options) {
  if (process.getuid?.() !== 0) refuse("run as root: only root can read every folder");
  const started = performance.now();
  const areas = accountAreas(options.account);
  const { paths, unreadable, prunedCount } = changedEntries(options, areas);
  const summary = summarize(paths, (path) => classifyEntry(path, areas));
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    kind: EVIDENCE_KIND,
    account: options.account,
    volume: DATA_VOLUME,
    prunedAreaCount: prunedCount,
    changedEntryCount: paths.length,
    unreadableFolderCount: unreadable,
    counts: summary.counts,
    violationCount: summary.violationCount,
    attributed: summary.attributed,
    passed: summary.violationCount === 0,
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
      `changed after the marker: ${String(evidence.changedEntryCount)} entries; owned by ${options.account}: ${String(counts.owned)}; writable by it: ${String(counts.writable)}; by other accounts: ${String(counts.others)}; removed since: ${String(counts.gone)}; unreadable folders: ${String(evidence.unreadableFolderCount)}`,
    );
    for (const line of evidence.attributed) console.log(`attributed ${line}`);
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
