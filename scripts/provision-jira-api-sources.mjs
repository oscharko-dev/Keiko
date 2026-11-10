#!/usr/bin/env node
// Fetch exact upstream bytes on demand instead of redistributing full Atlassian specifications.
import { Buffer } from "node:buffer";
import { lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonFile } from "./lib/json.mjs";
import {
  JiraApiInventoryError,
  jiraApiSourcePath,
  readJiraApiSource,
  requireJiraCacheDirectory,
  requireJiraInventory,
  validateJiraApiProvenance,
  validateJiraApiSourceBytes,
} from "./lib/jira-api-sources.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function responseBytes(response, maximum) {
  requireJiraInventory(response.status === 200 && response.redirected !== true, "download-status");
  requireJiraInventory(response.body !== null, "download-body");
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    // NOSONAR javascript:S9382 -- each read consumes the same stream and remaining byte budget.
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      requireJiraInventory(length <= maximum, "download-byte-bound");
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks, length);
  } finally {
    await reader.cancel();
  }
}

function cacheDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  requireJiraCacheDirectory(path);
}

function existingSource(directory, source) {
  const path = jiraApiSourcePath(directory, source);
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry === undefined) return false;
  requireJiraInventory(entry.isFile() && !entry.isSymbolicLink(), "source-cache-file");
  try {
    readJiraApiSource(directory, source);
    return true;
  } catch (error) {
    if (error instanceof JiraApiInventoryError && error.message === "source-digest") return false;
    throw error;
  }
}

function installSource(directory, source, bytes) {
  validateJiraApiSourceBytes(source, bytes);
  const target = jiraApiSourcePath(directory, source);
  const staging = mkdtempSync(join(dirname(target), ".download-"));
  try {
    const temporary = join(staging, "source.json");
    writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
    requireJiraCacheDirectory(directory);
    requireJiraCacheDirectory(dirname(target));
    renameSync(temporary, target);
    readJiraApiSource(directory, source);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function provisionSource(directory, source, fetchSource) {
  cacheDirectory(join(directory, source.release));
  if (existingSource(directory, source)) return 0;
  const response = await fetchSource(source.url, {
    redirect: "error",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    headers: { accept: "application/json" },
    signal: globalThis.AbortSignal.timeout(60_000),
  });
  installSource(directory, source, await responseBytes(response, source.bytes));
  return 1;
}

/** No implicit provisioning in tests or offline gates; callers explicitly choose this network step. */
export async function provisionJiraApiSources({
  provenance = readJsonFile(
    join(REPO_ROOT, "docs/local-knowledge/jira-api-coverage/provenance.json"),
  ),
  cache = join(REPO_ROOT, ".jira-api-sources"),
  fetchSource = globalThis.fetch,
} = {}) {
  validateJiraApiProvenance(provenance);
  cacheDirectory(cache);
  const outcomes = await Promise.allSettled(
    provenance.sources.map((source) => provisionSource(cache, source, fetchSource)),
  );
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  if (rejected !== undefined) throw rejected.reason;
  return {
    verifiedSources: outcomes.length,
    downloadedSources: outcomes.reduce((count, outcome) => count + outcome.value, 0),
  };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = await provisionJiraApiSources();
    console.log(
      `provision-jira-api-sources: PASS (${result.verifiedSources} verified, ${result.downloadedSources} downloaded)`,
    );
  } catch (error) {
    const reason =
      error instanceof JiraApiInventoryError ? error.message : "download-or-cache-failed";
    console.error(`provision-jira-api-sources: FAIL (${reason})`);
    process.exitCode = 1;
  }
}
