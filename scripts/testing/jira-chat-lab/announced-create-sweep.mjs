// A repeatable, model-free sweep over the evidence a lab session kept (#4355 AC4, #4369): how often a
// stored FINAL answer announces a created Jira issue although its own turn holds no created receipt
// (the product's own detector, from the built dist), and how often the product corrected a turn, by
// closed kind (the `chat.tool-turn.corrected` events of the retained activity-log segments).
// Counts and closed kinds only: no answer text, path or issue key ever enters the output.
// Usage: node announced-create-sweep.mjs <session-directory> [--until <ISO instant>] [--out <file.md>]
// `--until` keeps only turns stored and segments started up to that instant (to reproduce an earlier sweep).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { URL } from "node:url";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { isMainModule } from "../../lib/is-main-module.mjs";

const DETECTOR = new URL(
  "../../../packages/keiko-server/dist/chat-tool-announced-create.js",
  import.meta.url,
);
const STATE_PREFIX = "keiko-jira-live-chat-";
const SEGMENT_STAMP = /^activity-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\d*Z-/u;
const CORRECTED = '"op":"chat.tool-turn.corrected"';
const KIND = /"correctionKind":"([a-z-]+)"/u;

/** The stored turns of one retained Chat state: each user message's exchanges and its chat's final answer. */
function storedTurns(statePath) {
  const database = new DatabaseSync(join(statePath, "ui.db"), { readOnly: true });
  try {
    const known = database
      .prepare("select name from sqlite_master where type = 'table' and name = 'chat_messages'")
      .all();
    if (known.length === 0) return undefined;
    const answers = new Map();
    for (const row of database
      .prepare(
        "select chat_id, content from chat_messages where role = 'assistant' order by timestamp",
      )
      .all())
      answers.set(row.chat_id, String(row.content));
    return database
      .prepare(
        "select chat_id, tool_transcript_json, timestamp from chat_messages where role = 'user' order by timestamp",
      )
      .all()
      .map((row) => ({
        answer: answers.get(row.chat_id) ?? "",
        exchanges: row.tool_transcript_json
          ? (JSON.parse(row.tool_transcript_json).exchanges ?? [])
          : [],
        at: Number(row.timestamp),
      }));
  } finally {
    database.close();
  }
}

const segmentStart = (name) => {
  const match = SEGMENT_STAMP.exec(name);
  return match === null
    ? undefined
    : Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`);
};

/** Counts the corrected events of one segment into `kinds`. */
function countCorrected(path, kinds) {
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.includes(CORRECTED)) continue;
    const kind = KIND.exec(line)?.[1] ?? "none";
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
}

/** The `chat.tool-turn.corrected` events of the segments by closed kind (a segment that started after `until` is skipped). */
export function correctedByKind(logDirectory, until) {
  const kinds = new Map();
  const starts = [];
  const names = existsSync(logDirectory)
    ? readdirSync(logDirectory).filter((file) => file.endsWith(".jsonl"))
    : [];
  let segments = 0;
  for (const name of names) {
    const started = segmentStart(name);
    if (until !== undefined && started !== undefined && started > until) continue;
    segments += 1;
    if (started !== undefined) starts.push(started);
    countCorrected(join(logDirectory, name), kinds);
  }
  const total = [...kinds.values()].reduce((sum, count) => sum + count, 0);
  return { kinds, segments, first: min(starts), last: max(starts), total };
}

const min = (values) => (values.length === 0 ? undefined : Math.min(...values));
const max = (values) => (values.length === 0 ? undefined : Math.max(...values));

/** The sweep: states, stored user turns, announcements without a receipt, corrected events, covered range. */
export function sweep({ session, detector, until }) {
  const stateNames = readdirSync(session)
    .filter((name) => name.startsWith(STATE_PREFIX))
    .sort();
  let turns = 0;
  let readable = 0;
  let announced = 0;
  let first;
  let last;
  for (const name of stateNames) {
    const stored = storedTurns(join(session, name));
    if (stored === undefined) continue;
    readable += 1;
    for (const turn of stored.filter((item) => until === undefined || item.at <= until)) {
      turns += 1;
      first = Math.min(first ?? turn.at, turn.at);
      last = Math.max(last ?? turn.at, turn.at);
      if (detector(turn.exchanges, turn.answer, []) > 0) announced += 1;
    }
  }
  const logs = correctedByKind(join(session, "chat-read-logs", "logs"), until);
  return { states: stateNames.length, readable, turns, announced, first, last, logs };
}

const iso = (ms) => (ms === undefined ? "none" : new Date(ms).toISOString());

/** The report: counts and closed kinds only. */
export function renderSweep(result, { distCommit, headCommit, session, until }) {
  const kinds = [...result.logs.kinds.entries()].sort(([a], [b]) => a.localeCompare(b));
  return [
    "# Announced-create sweep (#4355 AC4, model-free)",
    "",
    `- product dist: built from worktree HEAD \`${headCommit}\`, last commit touching \`packages/\`: \`${distCommit}\``,
    `- session directory: \`${session}\``,
    `- cut-off: ${until === undefined ? "none (everything kept)" : iso(until)}`,
    `- chat states: ${String(result.states)} (${String(result.readable)} with a readable chat database)`,
    `- stored user turns swept: ${String(result.turns)}`,
    `- final answers announcing a created issue without a created receipt in their turn: ${String(result.announced)}`,
    `- activity-log segments read: ${String(result.logs.segments)}; \`chat.tool-turn.corrected\` events: ${String(result.logs.total)}`,
    ...kinds.map(([kind, count]) => `  - ${kind}: ${String(count)}`),
    `- of kind announced-create: ${String(result.logs.kinds.get("announced-create") ?? 0)}`,
    `- turns stored between ${iso(result.first)} and ${iso(result.last)}`,
    `- segments started between ${iso(result.logs.first)} and ${iso(result.logs.last)}`,
    "",
    "Detector: `announcedCreateCount` of the built `chat-tool-announced-create.js`, applied to each stored final",
    "answer with the exchanges of its own turn. No answer text, path or key is recorded here.",
    "",
  ].join("\n");
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { until: { type: "string" }, out: { type: "string" } },
  });
  const [directory] = positionals;
  if (directory === undefined)
    throw new TypeError("Usage: announced-create-sweep.mjs <session-directory>");
  const until = values.until === undefined ? undefined : Date.parse(values.until);
  if (until !== undefined && Number.isNaN(until))
    throw new TypeError("--until must be an ISO instant");
  const { announcedCreateCount } = await import(DETECTOR.href);
  const session = resolve(directory);
  const result = sweep({ session, detector: announcedCreateCount, until });
  const text = renderSweep(result, {
    distCommit: git("log", "-1", "--format=%h", "--", "packages"),
    headCommit: git("rev-parse", "--short", "HEAD"),
    session,
    until,
  });
  if (values.out === undefined) console.log(text);
  else writeFileSync(resolve(values.out), text);
}

if (isMainModule(import.meta.url)) await main();
