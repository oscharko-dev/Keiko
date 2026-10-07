#!/usr/bin/env node
// Raw body-free timeline of one run and the child requests it spawned, straight from the Activity
// Log segments: time (UTC), level, last six characters of the correlation id, operation and its
// closed fields. Envelope and stack fields are omitted; read them with `keiko support analyze`.
import { isMainModule } from "../../lib/is-main-module.mjs";
import {
  flatten,
  readActivityEvents,
  resolveLogDirectory,
  selectRunEvents,
} from "./activity-log-events.mjs";
import { normalizeRunSuffix, parseCli, runMain } from "./lab-common.mjs";

const USAGE = [
  "usage: node rawtl.mjs <run-id | trailing digits> [op-substring,...] [--log-dir <dir>]",
  "",
  "Prints only events whose operation contains one of the comma-separated substrings, if given,",
  "for example: node rawtl.mjs 5189946359293240 gateway.retry,edit.refused",
  "The log directory is --log-dir, else KEIKO_LAB_LOG_DIR, else <KEIKO_STATE_DIR or ./.keiko/dev>/logs.",
].join("\n");

const ENVELOPE_FIELDS = new Set([
  "ts",
  "schemaVersion",
  "registryVersion",
  "schemaDigest",
  "catalogDigest",
  "buildClass",
  "releaseClass",
  "platformClass",
  "productVersion",
  "compatibilityState",
  "writerCapability",
  "pid",
  "instanceId",
  "seq",
  "level",
  "category",
  "op",
  "completeness",
  "loss",
  "correlationId",
  "parentCorrelationId",
  "extra",
  "frames",
  "causeChain",
  "runId",
]);
const MAX_FIELDS_CHARS = 230;

function renderValue(value) {
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function timelineLine(event) {
  const flat = flatten(event);
  const fields = Object.entries(flat)
    .filter(([key]) => !ENVELOPE_FIELDS.has(key))
    .map(([key, value]) => `${key}=${renderValue(value)}`)
    .join(" ");
  const time = (event.ts ?? "").slice(11, 23);
  const level = (event.level ?? "").slice(0, 4).padEnd(4);
  const correlation = (event.correlationId ?? "").slice(-6).padEnd(6);
  return `${time} ${level} ${correlation} ${(event.op ?? "").padEnd(46)} ${fields.slice(0, MAX_FIELDS_CHARS)}`;
}

async function main() {
  const cli = parseCli({
    usage: USAGE,
    options: { "log-dir": { type: "string" } },
    positionals: true,
  });
  if (cli.help) return 0;
  const suffix = normalizeRunSuffix(cli.positionals[0]);
  const only = cli.positionals[1]?.split(",").filter((part) => part !== "");
  const events = selectRunEvents(
    await readActivityEvents(resolveLogDirectory(cli.values["log-dir"])),
    suffix,
  );
  const shown = events.filter(
    (event) => only === undefined || only.some((part) => (event.op ?? "").includes(part)),
  );
  for (const event of shown) console.log(timelineLine(event));
  return events.length === 0 ? 1 : 0;
}

if (isMainModule(import.meta.url)) runMain(main);
