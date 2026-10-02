#!/usr/bin/env node
// Waiver-scope gate: an OSV suppression may only cover build-time dependencies.
//
// `osv-scanner.toml` suppresses an advisory by ID, which silences it everywhere it appears — so a
// waiver written for a devDependency would keep hiding the same advisory if it later reached a
// SHIPPED dependency. The recorded justification for every entry is "not reachable in anything
// Keiko ships"; this gate makes that claim executable instead of aspirational.
//
// The check is deliberately indirect and therefore robust: it asks which advisories affect the
// shipped graph only, and if any suppressed ID shows up there, the waiver's premise is void and the
// gate fails, whatever the reason text claims. Two independent sources answer: `npm audit
// --omit=dev`, and the OSV database the suppressed scanner itself reads, queried for every package
// the lockfile does not flag dev. npm's feed alone is not enough: it can lag a newly reviewed
// advisory by hours or days (GHSA-vfj7-8cjw-p6xm and GHSA-ch52-4w7c-c8xp were in OSV within
// minutes of their GitHub review on 2026-10-02 and still absent from npm audit that night), and a
// waiver is recorded precisely when OSV reports its advisory — so npm alone would vouch for it
// without being able to see it.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(repoRoot, "osv-scanner.toml");
const lockfilePath = join(repoRoot, "package-lock.json");

const MULTILINE_DELIMITER = '"""';
const NODE_MODULES = "node_modules/";
const OSV_QUERY_BATCH_URL = "https://api.osv.dev/v1/querybatch";
// OSV's documented ceiling for the queries of one batch request.
const OSV_BATCH_LIMIT = 1000;
const OSV_TIMEOUT_MS = 60_000;

// Minimal reader for the one construct this gate cares about. A TOML parser is not a dependency
// worth adding for `id = "..."` lines inside [[IgnoredVulns]] blocks.
function opensMultilineString(line) {
  if (!/^[A-Za-z_][\w-]*\s*=\s*"""/u.test(line)) return false;
  return !line.slice(line.indexOf(MULTILINE_DELIMITER) + 3).includes(MULTILINE_DELIMITER);
}

// TOML basic and literal strings, with or without a trailing inline comment. Returns undefined
// when the line is not an id assignment at all.
function parseIdLine(line) {
  const match = /^id\s*=\s*(?:"([^"]+)"|'([^']+)')\s*(?:#.*)?$/u.exec(line);
  if (match !== null) return match[1] ?? match[2];
  // An `id` this reader cannot decode must not be dropped silently: an unread suppression is one
  // this gate would never validate against the shipped graph.
  if (/^id\s*=/u.test(line)) throw new Error(`unsupported id syntax in osv-scanner.toml: ${line}`);
  return undefined;
}

// A trailing inline comment, removed without a regex: an unanchored `\s*#.*$` re-tries every start
// position on a line that has no `#` at all, which is quadratic on long lines (S8786).
function withoutInlineComment(line) {
  const hash = line.indexOf("#");
  return (hash === -1 ? line : line.slice(0, hash)).trim();
}

// One line of the file, against the reader's state. Returns an id to collect, or undefined.
function readLine(line, state) {
  if (state.inMultiline) {
    if (line.includes(MULTILINE_DELIMITER)) state.inMultiline = false;
    return undefined;
  }
  if (opensMultilineString(line)) {
    state.inMultiline = true;
    return undefined;
  }
  if (line.length === 0 || line.startsWith("#")) return undefined;
  // Any section header ends the current block — a plain [Section] as much as a [[Table]] one.
  if (line.startsWith("[")) {
    state.inBlock = withoutInlineComment(line) === "[[IgnoredVulns]]";
    return undefined;
  }
  return state.inBlock ? parseIdLine(line) : undefined;
}

export function readSuppressedIds(toml) {
  const ids = [];
  const state = { inBlock: false, inMultiline: false };
  for (const raw of toml.split("\n")) {
    const id = readLine(raw.trim(), state);
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

// A malformed report must not read as "no advisories in the shipped graph" — that is precisely the
// answer that would let every waiver pass. npm always emits a vulnerabilities object.
function vulnerabilityMap(auditJson) {
  const report = JSON.parse(auditJson);
  if (typeof report !== "object" || report === null || Array.isArray(report)) {
    throw new Error("npm audit did not return a JSON object");
  }
  if (typeof report.vulnerabilities !== "object" || report.vulnerabilities === null) {
    throw new Error("npm audit output has no vulnerabilities map");
  }
  return report.vulnerabilities;
}

// npm reports each advisory as a GitHub advisory URL; its last segment is the GHSA id.
function advisoryIdFrom(via) {
  if (typeof via !== "object" || via === null) return undefined;
  if (typeof via.url !== "string") return undefined;
  const identifier = via.url.split("/").pop();
  return identifier !== undefined && identifier.length > 0 ? identifier : undefined;
}

export function shippedAdvisoryIds(auditJson) {
  const ids = new Set();
  for (const advisory of Object.values(vulnerabilityMap(auditJson))) {
    if (typeof advisory !== "object" || advisory === null) continue;
    for (const via of Array.isArray(advisory.via) ? advisory.via : []) {
      const identifier = advisoryIdFrom(via);
      if (identifier !== undefined) ids.add(identifier);
    }
  }
  return ids;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The installed package one lockfile entry describes, when `npm install --omit=dev` keeps it. npm
// flags an entry `dev` only when nothing but devDependencies reach it — the same set `npm audit
// --omit=dev` leaves out; `optional` and `devOptional` entries stay in a production install. Links
// are this repository's own workspaces, and keys outside node_modules/ are their sources: no
// registry publishes either.
function shippedPackage(path, entry) {
  const at = path.lastIndexOf(NODE_MODULES);
  if (at === -1 || entry.dev === true || entry.link === true) return undefined;
  if (typeof entry.version !== "string") {
    throw new TypeError(`package-lock.json entry ${path} has no version to look up`);
  }
  // An aliased install records the real package under `name`; its key is only the alias.
  const name = typeof entry.name === "string" ? entry.name : path.slice(at + NODE_MODULES.length);
  return { name, version: entry.version };
}

// Every package a production install of this lockfile contains, once per name and version.
export function shippedPackages(lockJson) {
  const lock = JSON.parse(lockJson);
  if (!isRecord(lock) || !isRecord(lock.packages)) {
    throw new TypeError("package-lock.json has no packages map");
  }
  const shipped = new Map();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!isRecord(entry)) throw new TypeError(`package-lock.json entry ${path} is not an object`);
    const found = shippedPackage(path, entry);
    if (found !== undefined) shipped.set(`${found.name}@${found.version}`, found);
  }
  return [...shipped.values()];
}

// The advisory ids of one query's result. A page token announces advisories the answer left out.
function resultIds(result) {
  if (!isRecord(result))
    throw new TypeError("OSV querybatch returned a result that is not an object");
  if (result.next_page_token !== undefined) {
    throw new Error("OSV querybatch returned an incomplete result");
  }
  const vulnerabilities = result.vulns ?? [];
  if (!Array.isArray(vulnerabilities)) {
    throw new TypeError("OSV querybatch returned advisories that are not a list");
  }
  return vulnerabilities.map((vulnerability) => {
    if (!isRecord(vulnerability) || typeof vulnerability.id !== "string") {
      throw new TypeError("OSV querybatch returned an advisory without an id");
    }
    return vulnerability.id;
  });
}

// One batch answer, read completely or not at all: a result list that does not line up with the
// queries, or a result that is incomplete, would let a suppressed id go unseen — the one answer
// this gate must never mistake for a pass.
function collectOsvIds(answer, queryCount, ids) {
  if (!isRecord(answer) || !Array.isArray(answer.results)) {
    throw new TypeError("OSV querybatch did not return a results list");
  }
  if (answer.results.length !== queryCount) {
    throw new Error("OSV querybatch answered a different number of queries than were asked");
  }
  for (const result of answer.results) {
    for (const id of resultIds(result)) ids.add(id);
  }
}

async function postOsvBatch(body) {
  const response = await globalThis.fetch(OSV_QUERY_BATCH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: globalThis.AbortSignal.timeout(OSV_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`OSV querybatch answered HTTP ${String(response.status)}`);
  return response.json();
}

// The advisory ids OSV records against the given npm packages.
export async function osvAdvisoryIds(packages, post = postOsvBatch) {
  const ids = new Set();
  for (let start = 0; start < packages.length; start += OSV_BATCH_LIMIT) {
    const batch = packages.slice(start, start + OSV_BATCH_LIMIT);
    const queries = batch.map(({ name, version }) => ({
      package: { ecosystem: "npm", name },
      version,
    }));
    collectOsvIds(await post({ queries }), queries.length, ids);
  }
  return ids;
}

export function evaluateWaiverScope(suppressedIds, shippedIds) {
  return suppressedIds.filter((id) => shippedIds.has(id));
}

function runAudit() {
  try {
    return execFileSync(resolveHostExecutable("npm"), ["audit", "--json", "--omit=dev"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    // npm audit exits non-zero when it finds advisories; the JSON is still on stdout.
    if (typeof error.stdout === "string" && error.stdout.length > 0) return error.stdout;
    throw error;
  }
}

// Both sources, so a suppressed id either one places in the shipped graph is a violation.
async function shippedIds(deps) {
  const audit = deps.runAudit ?? runAudit;
  const readLockfile = deps.readLockfile ?? (() => readFileSync(lockfilePath, "utf8"));
  const queryOsv = deps.queryOsv ?? osvAdvisoryIds;
  const ids = shippedAdvisoryIds(audit());
  for (const id of await queryOsv(shippedPackages(readLockfile()))) ids.add(id);
  return ids;
}

export async function main(deps = {}) {
  const readConfig = deps.readConfig ?? (() => readFileSync(configPath, "utf8"));
  const exists = deps.configExists ?? (() => existsSync(configPath));
  if (!exists()) {
    console.log("osv-waiver-scope: PASS — no osv-scanner.toml, nothing suppressed.");
    return;
  }
  const suppressed = readSuppressedIds(readConfig());
  if (suppressed.length === 0) {
    console.log("osv-waiver-scope: PASS — no suppressions recorded.");
    return;
  }
  const violations = evaluateWaiverScope(suppressed, await shippedIds(deps));
  if (violations.length > 0) {
    for (const id of violations) {
      console.error(
        `osv-waiver-scope: FAIL - ${id} is suppressed in osv-scanner.toml but reaches a SHIPPED ` +
          "dependency. A waiver may only cover build-time tooling; remove the entry and fix or " +
          "escalate the advisory.",
      );
    }
    if (deps.exit !== undefined) return deps.exit(1);
    process.exit(1);
  }
  console.log(
    `osv-waiver-scope: PASS — ${String(suppressed.length)} suppression(s), none reaching the shipped graph.`,
  );
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) await main();
