#!/usr/bin/env node
// Waiver-scope gate: an OSV suppression may only cover build-time dependencies.
//
// `osv-scanner.toml` suppresses an advisory by ID, which silences it everywhere it appears — so a
// waiver written for a devDependency would keep hiding the same advisory if it later reached a
// SHIPPED dependency. The recorded justification for every entry is "not reachable in anything
// Keiko ships"; this gate makes that claim executable instead of aspirational.
//
// The check is deliberately indirect and therefore robust: `npm audit --omit=dev` reports advisories
// in the shipped graph only. If any suppressed ID shows up there, the waiver's premise is void and
// the gate fails, whatever the reason text claims.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(repoRoot, "osv-scanner.toml");

const MULTILINE_DELIMITER = '"""';

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

export function main(deps = {}) {
  const audit = deps.runAudit ?? runAudit;
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
  const shipped = shippedAdvisoryIds(audit());
  const violations = evaluateWaiverScope(suppressed, shipped);
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
if (invokedPath === fileURLToPath(import.meta.url)) main();
