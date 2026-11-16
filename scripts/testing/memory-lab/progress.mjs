// Durable, ordered completed jobs shared by the corpus builder and runner (#4247). Only the
// identity digest is public; a sealed run supplies authenticated encryption for every job.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeContinuityJson } from "../coding-workbench-lab/chat-continuity-campaign.mjs";
import { readJsonFile } from "./anchor/private-files.mjs";

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function jobName(index) {
  return `${String(index).padStart(8, "0")}.json`;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readProgressObject(path, label) {
  if (!lstatSync(path).isFile()) throw new TypeError(`${label} must be a regular file`);
  const value = readJsonFile(path, label);
  if (!isObject(value)) throw new TypeError(`${label} is malformed`);
  return value;
}

function readResults(directory, identityDigest, total, codec, validate) {
  const manifest = readProgressObject(join(directory, "manifest.json"), "the progress manifest");
  if (
    manifest.schemaVersion !== 1 ||
    manifest.identityDigest !== identityDigest ||
    manifest.total !== total
  )
    throw new Error("the progress belongs to different inputs, configuration or code");
  const names = readdirSync(directory)
    .filter((name) => name.endsWith(".json") && name !== "manifest.json")
    .toSorted();
  if (names.length > total) throw new Error("the progress has too many completed jobs");
  return names.map((name, index) => {
    if (name !== jobName(index)) throw new Error("the progress has a missing or unknown job");
    const path = join(directory, name);
    const envelope = readProgressObject(path, "a completed progress job");
    const entry = codec === undefined ? envelope : codec.decode(envelope);
    if (!isObject(entry) || !Object.hasOwn(entry, "value"))
      throw new TypeError("a completed progress job is malformed");
    if (
      entry.identityDigest !== identityDigest ||
      entry.index !== index ||
      entry.digest !== digest(entry.value)
    )
      throw new Error("a completed progress job failed its integrity check");
    if (validate !== undefined && !validate(entry.value, index))
      throw new Error("a completed progress job does not match its planned input");
    return entry.value;
  });
}

/** Opens a fresh journal or explicitly resumes an identical job plan. Writes are atomic and private. */
export function openProgress({
  out,
  resume = false,
  identity,
  total,
  codec,
  validate,
  assertOwned = () => undefined,
}) {
  const directory = join(out, ".progress");
  const identityDigest = digest(identity);
  const present = existsSync(directory);
  if (present && !resume)
    throw new Error("unfinished progress exists; use --resume with the same options");
  if (!present && resume) throw new Error("no unfinished progress exists to resume");
  if (present && !lstatSync(directory).isDirectory())
    throw new Error("the progress must be a regular directory");
  const results = present ? readResults(directory, identityDigest, total, codec, validate) : [];
  return {
    results,
    assertOwned,
    append(value) {
      assertOwned();
      if (results.length >= total) throw new Error("the progress already holds every job");
      if (!existsSync(directory)) {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        writeContinuityJson(join(directory, "manifest.json"), {
          schemaVersion: 1,
          identityDigest,
          total,
        });
      }
      const path = join(directory, jobName(results.length));
      if (existsSync(path)) throw new Error("refusing to replace a completed progress job");
      const entry = { identityDigest, index: results.length, digest: digest(value), value };
      writeContinuityJson(path, codec === undefined ? entry : codec.encode(entry));
      results.push(value);
    },
    clear() {
      assertOwned();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
