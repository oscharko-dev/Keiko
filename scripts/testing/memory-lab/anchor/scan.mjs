// The scan behind "no real text in the repository, issues, evidence or Activity Log" (#4208). The real
// conversation text is indexed, privately and hashed, and the named targets are searched for any run of
// words from it. The result names files and counts and never a word of what matched.
//
//   node scripts/testing/memory-lab/anchor/scan.mjs --fetched <dir> [--scenarios <dir>]... \
//        [--git <work tree>]... [--target <file or dir>]... [--allow-oversized]
//
// A run of RUN_WORDS words is hashed at every STRIDE words of the source and at every word of a target,
// so any copied passage of at least RUN_WORDS + STRIDE - 1 words is found, and a shorter one is not:
// a short sentence is indistinguishable from ordinary language, which the report says. Only prose
// counts: a run needs two function words, so what real conversations share with this repository by
// being on the web at all (an HTML head, a browser's user agent, a download URL) is no finding. Issues are
// searched through a directory the operator exports them to (docs/qa/memoria-viva-lab-anchor.md). The
// Activity Log is checked per unit by the runner itself (log-text.mjs), because a run over real text
// keeps no state to search afterwards.
//
// A scan that searched nothing proves nothing, so an empty index, no target and a target without one
// readable file fail. A file too large to index or to search is a gap the scan cannot close: it fails
// unless the operator accepts the gap by name with --allow-oversized, and the count stays in the output.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runMain } from "../../coding-workbench-lab/lab-common.mjs";
import { assertOutsideCheckout, readJsonFile } from "./private-files.mjs";

const RUN_WORDS = 10;
const STRIDE = 3;
const MIN_TEXT_CHARS = 60;
const MAX_TARGET_BYTES = 8_000_000;

function wordsOf(text) {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function hashOf(words, start) {
  const digest = createHash("md5")
    .update(words.slice(start, start + RUN_WORDS).join(" "))
    .digest();
  return digest.readUIntBE(0, 6);
}

// A passage a person wrote has these words; markup, identifiers and metadata do not.
const FUNCTION_WORDS = new Set(
  (
    "the a an and or of to in is it i you my your for on with that this was are be not " +
    "der die das und oder ich du mein dein nicht ist ein eine zu mit für von im den dem"
  ).split(" "),
);
const MIN_FUNCTION_WORDS = 2;

function isProse(words, start) {
  let count = 0;
  for (let at = start; at < start + RUN_WORDS; at += 1)
    if (FUNCTION_WORDS.has(words[at])) count += 1;
  return count >= MIN_FUNCTION_WORDS;
}

function addText(index, text) {
  const words = wordsOf(text);
  for (let start = 0; start + RUN_WORDS <= words.length; start += STRIDE)
    if (isProse(words, start)) index.add(hashOf(words, start));
}

function strings(value, onText) {
  if (typeof value === "string") onText(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, onText);
  else if (value !== null && typeof value === "object")
    for (const item of Object.values(value)) strings(item, onText);
}

function jsonFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return jsonFiles(path);
    return entry.isFile() && entry.name.endsWith(".json") ? [path] : [];
  });
}

/**
 * The hashed index of every long string in the JSON files under the directories. Everything is
 * indexed, the assistant's text too, because a copied passage is a copied passage. A file too large to
 * index as a whole (the LongMemEval download, whose conversations are synthetic) is left to its
 * converted scenarios, which `directories` may name, and is counted as `oversized`.
 */
export function buildRealTextIndex(directories) {
  const index = new Set();
  const addLong = (text) => {
    if (text.length >= MIN_TEXT_CHARS) addText(index, text);
  };
  let files = 0;
  let oversized = 0;
  for (const directory of directories)
    for (const path of jsonFiles(directory)) {
      if (statSync(path).size > MAX_TARGET_BYTES * 10) {
        oversized += 1;
        continue;
      }
      strings(readJsonFile(path, "conversation file"), addLong);
      files += 1;
    }
  return { index, files, oversized };
}

/** How many runs of words in `text` come from the index. */
export function countHits(index, text) {
  const words = wordsOf(text);
  let hits = 0;
  for (let start = 0; start + RUN_WORDS <= words.length; start += 1)
    if (index.has(hashOf(words, start))) hits += 1;
  return hits;
}

function readableText(path) {
  const bytes = readFileSync(path);
  return bytes.includes(0) ? undefined : bytes.toString("utf8");
}

function trackedFiles(workTree) {
  return execFileSync("git", ["-C", workTree, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  })
    .split("\0")
    .filter((name) => name.length > 0)
    .map((name) => join(workTree, name));
}

function filesOf(target) {
  if (statSync(target).isFile()) return [target];
  return readdirSync(target, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() || entry.isFile() ? filesOf(join(target, entry.name)) : [],
  );
}

/** Searches the files of one target; returns the counts and the files with hits, by relative path. */
export function scanTarget(index, root, files) {
  const hits = [];
  let scanned = 0;
  let skipped = 0;
  let oversized = 0;
  for (const path of files) {
    if (statSync(path).size > MAX_TARGET_BYTES) {
      oversized += 1;
      continue;
    }
    const text = readableText(path);
    if (text === undefined) {
      skipped += 1;
      continue;
    }
    scanned += 1;
    const count = countHits(index, text);
    if (count > 0) hits.push({ file: relative(root, path), runs: count });
  }
  return { scanned, skipped, oversized, hits };
}

function report(name, result) {
  for (const hit of result.hits) console.log(`hit ${name} ${hit.file} runs=${String(hit.runs)}`);
  console.log(
    `${name}: files=${String(result.scanned)} skipped=${String(result.skipped)} oversized=${String(result.oversized)} with-hits=${String(result.hits.length)}`,
  );
  if (result.scanned === 0) throw new RangeError(`a ${name} target holds no readable file`);
  return result;
}

function verdictOf(results, oversizedSources, allowOversized) {
  const sum = (field) => results.reduce((total, result) => total + result[field], 0);
  const hits = results.reduce((total, result) => total + result.hits.length, 0);
  const oversized = oversizedSources + sum("oversized");
  const gap = oversized > 0 && !allowOversized;
  if (gap)
    console.log(`unsearched oversized=${String(oversized)}: name --allow-oversized to accept`);
  console.log(
    `${hits === 0 && !gap ? "PASS" : "FAIL"} real-text-scan files-with-hits=${String(hits)} oversized=${String(oversized)}`,
  );
  return hits === 0 && !gap ? 0 : 1;
}

/** The CLI body; returns the exit code. */
export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      fetched: { type: "string" },
      scenarios: { type: "string", multiple: true, default: [] },
      git: { type: "string", multiple: true, default: [] },
      target: { type: "string", multiple: true, default: [] },
      "allow-oversized": { type: "boolean", default: false },
    },
  });
  if (values.fetched === undefined) throw new RangeError("--fetched is required");
  if (values.git.length === 0 && values.target.length === 0)
    throw new RangeError("name at least one --git work tree or --target to scan");
  const sources = [values.fetched, ...values.scenarios].map((path) =>
    assertOutsideCheckout(path, "--fetched"),
  );
  const { index, files, oversized } = buildRealTextIndex(sources);
  if (index.size === 0)
    throw new RangeError("the real-text index is empty, so the scan would prove nothing");
  console.log(
    `indexed files=${String(files)} oversized=${String(oversized)} runs=${String(index.size)} words-per-run=${String(RUN_WORDS)}`,
  );
  const results = [
    ...values.git.map((tree) => report("git", scanTarget(index, tree, trackedFiles(tree)))),
    ...values.target.map((target) => report("target", scanTarget(index, target, filesOf(target)))),
  ];
  return verdictOf(results, oversized, values["allow-oversized"]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runMain(() => main());
