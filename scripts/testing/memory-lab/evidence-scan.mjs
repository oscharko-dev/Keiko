// The scan behind "lab output contains only synthetic data" (#4207). Every evidence file of a run is
// read after it is written, and what must never be in one is looked for: this machine's home directory,
// user name and host name, an absolute path, an endpoint outside this machine, a key shape, and any
// secret of the operator's gateway configuration. A finding names the file and the kind and never the
// value, so the scan cannot itself carry what it found.
//
//   node scripts/testing/memory-lab/evidence-scan.mjs --dir <directory> [--gateway <config file>]
//
// Kept instance state is not evidence: it is the operator's own, it never leaves the run directory,
// and a run over real conversations refuses to keep it. What a model said or a learner stored may name
// a website, so an endpoint is not looked for inside those fields; everything else is.
import { readFileSync, readdirSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { extname, join, relative } from "node:path";
import { URL, fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runMain } from "../coding-workbench-lab/lab-common.mjs";
import { valueShapeFindings } from "./corpus/values.mjs";

export const SCAN_FILE = "evidence-scan.json";
const TEXT_EXTENSIONS = new Set([".json", ".md", ".txt", ".log", ".tsv"]);
const SKIPPED_DIRECTORIES = new Set(["state", "node_modules"]);
const MODEL_TEXT_FIELDS = new Set(["answer", "body", "memoryBodies", "user", "assistant"]);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const RESERVED_DOMAIN = /(?:^|\.)(?:example\.(?:com|org|net)|[^.]+\.(?:example|invalid|test))$/u;
const SECRET_FIELD = /key|token|secret|password|credential/iu;
const MIN_SECRET_LENGTH = 8;
const MIN_NAME_LENGTH = 3;
const ABSOLUTE_PATH =
  /(?<![\w/.:-])\/(?:Users|home|root|private|tmp|var|opt|etc|Volumes|mnt)\/[^\s"'`)]+|\b[A-Za-z]:\\[^\s"'`)]+/u;
const URL_SHAPE = /\bhttps?:\/\/[^\s"'`)<>\]]+/gu;
const KEY_KINDS = new Set(["api-key", "provider-token"]);

/** What identifies this machine and its operator: never to appear in a report. */
export function machineIdentity() {
  return { home: homedir(), userName: userInfo().username, hostName: hostname() };
}

function wholeWord(text, word) {
  if (word.length < MIN_NAME_LENGTH) return false;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

function isOutsideEndpoint(url) {
  try {
    const { hostname: host } = new URL(url);
    return !LOOPBACK.has(host) && !RESERVED_DOMAIN.test(host);
  } catch {
    return true;
  }
}

function kindsIn(text, field, context) {
  const kinds = [];
  const { identity, secrets } = context;
  if (text.includes(identity.home)) kinds.push("home-path");
  if (wholeWord(text, identity.userName)) kinds.push("user-name");
  if (wholeWord(text, identity.hostName)) kinds.push("host-name");
  if (ABSOLUTE_PATH.test(text)) kinds.push("absolute-path");
  if (secrets.some((secret) => text.includes(secret))) kinds.push("configured-secret");
  if (valueShapeFindings(text).some((found) => !found.allowed && KEY_KINDS.has(found.kind)))
    kinds.push("key-shape");
  if (
    !MODEL_TEXT_FIELDS.has(field) &&
    (text.match(URL_SHAPE) ?? []).some((url) => isOutsideEndpoint(url))
  )
    kinds.push("endpoint");
  return kinds;
}

function visit(value, field, onText) {
  if (typeof value === "string") onText(value, field);
  else if (Array.isArray(value)) for (const item of value) visit(item, field, onText);
  else if (value !== null && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      onText(key, key);
      visit(item, key, onText);
    }
}

function kindsOfFile(path, context) {
  const text = readFileSync(path, "utf8");
  const found = new Set();
  const onText = (value, field) => {
    for (const kind of kindsIn(value, field, context)) found.add(kind);
  };
  if (extname(path) !== ".json") {
    onText(text, "");
    return found;
  }
  try {
    visit(JSON.parse(text), "", onText);
  } catch {
    onText(text, "");
  }
  return found;
}

function evidenceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : evidenceFiles(path);
    return entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name)) && entry.name !== SCAN_FILE
      ? [path]
      : [];
  });
}

/**
 * Every finding in the evidence under `directory`, as `{ file, kind }` with the path relative to it.
 * `options.identity` replaces this machine's (for tests), `options.secrets` adds literal secrets.
 */
export function scanEvidence(directory, options = {}) {
  const context = {
    identity: options.identity ?? machineIdentity(),
    secrets: options.secrets ?? [],
  };
  const files = evidenceFiles(directory).toSorted();
  const findings = files.flatMap((path) =>
    [...kindsOfFile(path, context)]
      .toSorted()
      .map((kind) => ({ file: relative(directory, path), kind })),
  );
  return { schemaVersion: 1, filesScanned: files.length, findings };
}

/** The secrets a gateway configuration holds: strings under a key-like field. Never reported. */
export function secretsOfConfig(path) {
  const secrets = new Set();
  const config = JSON.parse(readFileSync(path, "utf8"));
  visit(config, "", (value, field) => {
    if (value !== field && SECRET_FIELD.test(field) && value.length >= MIN_SECRET_LENGTH)
      secrets.add(value);
  });
  return [...secrets];
}

function main() {
  const { values } = parseArgs({
    options: { dir: { type: "string" }, gateway: { type: "string" } },
  });
  if (values.dir === undefined) throw new RangeError("--dir is required");
  const secrets = values.gateway === undefined ? [] : secretsOfConfig(values.gateway);
  const scan = scanEvidence(values.dir, { secrets });
  for (const finding of scan.findings) console.log(`finding ${finding.kind} ${finding.file}`);
  console.log(
    `${scan.findings.length === 0 ? "PASS" : "FAIL"} evidence-scan files=${String(scan.filesScanned)} findings=${String(scan.findings.length)}`,
  );
  return scan.findings.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runMain(main);
