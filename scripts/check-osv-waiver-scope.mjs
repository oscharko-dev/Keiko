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
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(repoRoot, "osv-scanner.toml");

// Minimal reader for the one construct this gate cares about. A TOML parser is not a dependency
// worth adding for `id = "..."` lines inside [[IgnoredVulns]] blocks.
export function readSuppressedIds(toml) {
  const ids = [];
  let inBlock = false;
  for (const raw of toml.split("\n")) {
    const line = raw.trim();
    // Any section header ends the current block — a plain [Section] as much as a [[Table]] one.
    // Only checking for "[[" left a following `id =` attributed to the previous IgnoredVulns entry.
    if (line.startsWith("[")) {
      inBlock = line === "[[IgnoredVulns]]";
      continue;
    }
    if (!inBlock) continue;
    const match = /^id\s*=\s*"([^"]+)"/u.exec(line);
    if (match !== null) ids.push(match[1]);
  }
  return ids;
}

export function shippedAdvisoryIds(auditJson) {
  const report = JSON.parse(auditJson);
  const ids = new Set();
  for (const advisory of Object.values(report.vulnerabilities ?? {})) {
    for (const via of advisory.via ?? []) {
      if (typeof via !== "object" || via === null) continue;
      // npm reports the advisory as a GitHub advisory URL; its last segment is the GHSA id.
      const identifier = typeof via.url === "string" ? via.url.split("/").pop() : undefined;
      if (identifier !== undefined && identifier.length > 0) ids.add(identifier);
    }
  }
  return ids;
}

export function evaluateWaiverScope(suppressedIds, shippedIds) {
  return suppressedIds.filter((id) => shippedIds.has(id));
}

function runAudit() {
  try {
    return execFileSync("npm", ["audit", "--json", "--omit=dev"], {
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

function main() {
  if (!existsSync(configPath)) {
    console.log("osv-waiver-scope: PASS — no osv-scanner.toml, nothing suppressed.");
    return;
  }
  const suppressed = readSuppressedIds(readFileSync(configPath, "utf8"));
  if (suppressed.length === 0) {
    console.log("osv-waiver-scope: PASS — no suppressions recorded.");
    return;
  }
  const shipped = shippedAdvisoryIds(runAudit());
  const violations = evaluateWaiverScope(suppressed, shipped);
  if (violations.length > 0) {
    for (const id of violations) {
      console.error(
        `osv-waiver-scope: FAIL - ${id} is suppressed in osv-scanner.toml but reaches a SHIPPED ` +
          "dependency. A waiver may only cover build-time tooling; remove the entry and fix or " +
          "escalate the advisory.",
      );
    }
    process.exit(1);
  }
  console.log(
    `osv-waiver-scope: PASS — ${String(suppressed.length)} suppression(s), none reaching the shipped graph.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
