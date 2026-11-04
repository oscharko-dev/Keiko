// Fetcher of the licensed real-conversation sets that anchor the MemoriaViva lab in reality (#4208).
//
//   node scripts/testing/memory-lab/anchor/fetch.mjs --out <dir> --set wildchat-de,oasst2-de
//   node scripts/testing/memory-lab/anchor/fetch.mjs --out <dir> --set wildchat-en --limit 2000
//   node scripts/testing/memory-lab/anchor/fetch.mjs --out <dir> --set longmemeval
//
// Sets (see sets.mjs): wildchat-de, wildchat-en, oasst2-de, oasst2-en and longmemeval. The paged sets
// come from the Hugging Face datasets-server `filter` API, 100 rows per call at most; the English
// slices hold hundreds of thousands of rows and need an explicit --limit. LongMemEval is one JSON
// file found through the Hub tree API and verified against its published size and SHA-256.
//
// Layout under --out, which must lie outside every git work tree (private-files.mjs):
//   <set>/pages/<offset>.json   the raw API response for the rows starting at that offset
//   <set>/fetch-manifest.json   dataset, filter, row count, fetch time, API URL template (no text)
//   LICENSES.md                 the license and citation of every set
//
// The fetcher is polite and resumable: one request at a time with a delay between requests, retries
// with exponential backoff on network errors, timeouts, 408, 422 (the datasets-server answers it
// sporadically while degraded), 425, 429 and 5xx (honoring Retry-After), and a page
// file that already holds the rows it would fetch is never requested again. Rows are stored as the
// API returned them; credential-shaped strings are the conversion step's business (convert.mjs).
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleepFor } from "node:timers/promises";
import { URL, fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { UsageError, runMain } from "../../coding-workbench-lab/lab-common.mjs";
import { FETCHER, requestJson } from "./http.mjs";
import { fetchLongMemEval } from "./longmemeval.mjs";
import {
  assertOutsideCheckout,
  ensurePrivateDirectory,
  writePrivateFile,
} from "./private-files.mjs";
import {
  ANCHOR_SETS,
  ANCHOR_SET_NAMES,
  DATASETS_SERVER,
  PAGE_SIZE,
  SOURCES,
  anchorSet,
  sourceOf,
} from "./sets.mjs";

// Observed in use: the first filter request of a set can take 90 s and a gateway answers 502 now and
// then, so the defaults are patient rather than fast.
const DEFAULTS = Object.freeze({
  delayMs: 1000,
  attempts: 8,
  backoffMs: 2000,
  maxBackoffMs: 60000,
  timeoutMs: 180000,
  downloadTimeoutMs: 1800000,
});

/** The datasets-server `filter` URL for the rows of a set starting at `offset`. */
export function pageUrl(set, offset, length) {
  const url = new URL(`${DATASETS_SERVER}/filter`);
  url.searchParams.set("dataset", set.dataset);
  url.searchParams.set("config", set.config);
  url.searchParams.set("split", set.split);
  url.searchParams.set("where", set.where);
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("length", String(length));
  return url.href;
}

function pageUrlTemplate(set) {
  return pageUrl(set, 0, PAGE_SIZE).replace("offset=0&", "offset={offset}&");
}

function isPage(value) {
  return Array.isArray(value?.rows) && Number.isSafeInteger(value.num_rows_total);
}

function pagePath(setDir, offset) {
  return join(setDir, "pages", `${String(offset)}.json`);
}

// A page file that cannot be read back is treated as missing and fetched again.
function readStoredPage(path) {
  if (!existsSync(path)) return undefined;
  try {
    const page = JSON.parse(readFileSync(path, "utf8"));
    return isPage(page) ? page : undefined;
  } catch {
    return undefined;
  }
}

// A stored page serves a request when it holds the rows asked for, or the set simply ends there.
function storedPageSuffices(page, offset, wanted) {
  return page.rows.length >= wanted || offset + page.rows.length >= page.num_rows_total;
}

async function obtainPage(set, context, state, wanted) {
  const path = pagePath(state.setDir, state.offset);
  const stored = readStoredPage(path);
  if (stored !== undefined && storedPageSuffices(stored, state.offset, wanted))
    return { page: stored, fromDisk: true };
  const what = `${state.name} offset=${String(state.offset)}`;
  const { text, value } = await requestJson(
    pageUrl(set, state.offset, wanted),
    what,
    context,
    isPage,
  );
  writePrivateFile(path, text);
  return { page: value, fromDisk: false };
}

// The next offset is the rows actually received: the API may return fewer rows than asked for.
function advance(state, page) {
  const consumed = state.offset + page.rows.length;
  const limitReached = state.limit !== undefined && consumed >= state.limit;
  return {
    ...state,
    offset: consumed,
    rowCount: state.rowCount + page.rows.length,
    pageCount: state.pageCount + 1,
    total: page.num_rows_total,
    partial: state.partial || page.partial === true,
    done: page.rows.length === 0 || consumed >= page.num_rows_total || limitReached,
  };
}

async function fetchPages(set, context, state) {
  const remaining = state.limit === undefined ? PAGE_SIZE : state.limit - state.offset;
  const { page, fromDisk } = await obtainPage(set, context, state, Math.min(PAGE_SIZE, remaining));
  const next = advance(state, page);
  context.log(
    `${state.name} offset=${String(state.offset)} rows=${String(page.rows.length)} total=${String(page.num_rows_total)}${fromDisk ? " (already on disk)" : ""}`,
  );
  if (next.done) return next;
  if (!fromDisk) await context.sleep(context.delayMs);
  return fetchPages(set, context, next);
}

function baseManifest(name, set, context) {
  const source = sourceOf(set);
  return {
    schemaVersion: 1,
    set: name,
    family: set.family,
    dataset: set.dataset,
    license: source.license,
    fetchedAt: context.now(),
    fetcher: FETCHER,
  };
}

async function fetchPagedSet(name, set, context, { setDir, limit }) {
  ensurePrivateDirectory(join(setDir, "pages"));
  const state = await fetchPages(set, context, {
    name,
    setDir,
    limit,
    offset: 0,
    rowCount: 0,
    pageCount: 0,
    total: 0,
    partial: false,
    done: false,
  });
  return {
    filter: set.where,
    config: set.config,
    split: set.split,
    rowCount: state.rowCount,
    numRowsTotal: state.total,
    limit: limit ?? null,
    partial: state.partial,
    pageCount: state.pageCount,
    pageSize: PAGE_SIZE,
    apiUrlTemplate: pageUrlTemplate(set),
  };
}

function resolveLimit(name, set, limit) {
  if (limit === undefined) {
    if (set.requiresLimit)
      throw new RangeError(
        `${name} needs --limit N: the English slice holds hundreds of thousands of rows and is never fetched whole`,
      );
    return undefined;
  }
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new RangeError("--limit must be a positive integer");
  return limit;
}

function codeSpan(text) {
  return `\`${text}\``;
}

/** The text of LICENSES.md: license, source and citation of every set the tooling can fetch. */
export function renderLicenses() {
  const sections = Object.entries(SOURCES).map(([family, source]) => {
    const names = ANCHOR_SET_NAMES.filter((name) => ANCHOR_SETS[name].family === family);
    return [
      `## ${source.title} (${names.map((name) => codeSpan(name)).join(", ")})`,
      "",
      `- Source: ${source.homepage}`,
      `- License: ${source.license} (${source.licenseName}), ${source.licenseUrl}`,
      `- About: ${source.description}`,
      `- Citation: ${source.citation}`,
      "",
    ].join("\n");
  });
  return [
    "# Licenses of the anchor conversation sets",
    "",
    "These files hold public conversation text fetched for local measurement of MemoriaViva (#4208).",
    "They are used on this machine only. They are not redistributed and never enter the repository,",
    "an issue, an evidence file or the Activity Log; reports carry aggregates only.",
    "",
    ...sections,
    "## Excluded: LoCoMo",
    "",
    "LoCoMo is licensed CC BY-NC 4.0 and stays out of product development. This tooling does not",
    "fetch it.",
    "",
  ].join("\n");
}

// Tuning values the caller left out fall back to DEFAULTS; the injectable seams fall back to the
// real fetch, timer, clock and console.
function createContext(options) {
  const tuning = Object.fromEntries(
    Object.keys(DEFAULTS)
      .filter((key) => options[key] !== undefined)
      .map((key) => [key, options[key]]),
  );
  return {
    ...DEFAULTS,
    ...tuning,
    fetchFn: options.fetchFn ?? globalThis.fetch,
    sleep: options.sleep ?? ((ms) => sleepFor(ms)),
    now: options.now ?? (() => new Date().toISOString()),
    log: options.log ?? ((line) => console.log(line)),
  };
}

/**
 * Fetches one set into `<out>/<name>` and returns its fetch manifest. Options: out (required), limit,
 * and injectable fetchFn, sleep, now, log plus delayMs, attempts, backoffMs, timeoutMs for tests.
 */
export async function fetchAnchorSet(name, options) {
  const set = anchorSet(name);
  const out = assertOutsideCheckout(options.out, "--out");
  const limit = resolveLimit(name, set, options.limit);
  const context = createContext(options);
  const setDir = join(out, name);
  ensurePrivateDirectory(out);
  // The licenses go down first, so data on disk never lacks them, whatever happens next.
  writePrivateFile(join(out, "LICENSES.md"), renderLicenses());
  const fetchSet = set.family === "longmemeval" ? fetchLongMemEval : fetchPagedSet;
  const specifics = await fetchSet(name, set, context, { setDir, limit });
  const manifest = { ...baseManifest(name, set, context), ...specifics };
  writePrivateFile(join(setDir, "fetch-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

const OPTIONS = {
  out: { type: "string" },
  set: { type: "string", multiple: true },
  limit: { type: "string" },
  "delay-ms": { type: "string" },
  attempts: { type: "string" },
  "backoff-ms": { type: "string" },
  "timeout-ms": { type: "string" },
  help: { type: "boolean", short: "h", default: false },
};

function usage() {
  return [
    "usage: node scripts/testing/memory-lab/anchor/fetch.mjs --out <dir> --set <names> [--limit N]",
    `  sets: ${ANCHOR_SET_NAMES.join(", ")} (comma-separated, or repeat --set)`,
    "  --out must lie outside every git work tree; the English slices need --limit",
    `  --delay-ms N (default ${String(DEFAULTS.delayMs)})  --attempts N (default ${String(DEFAULTS.attempts)})`,
    `  --backoff-ms N (default ${String(DEFAULTS.backoffMs)})  --timeout-ms N (default ${String(DEFAULTS.timeoutMs)})`,
  ].join("\n");
}

function optionalInteger(value, name, minimum) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum)
    throw new RangeError(`${name} must be an integer of at least ${String(minimum)}`);
  return parsed;
}

function withoutUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

/** CLI options to fetch options; a defect in them is a RangeError. */
export function normalizeFetchOptions(values) {
  if (typeof values.out !== "string" || values.out.length === 0)
    throw new RangeError("--out is required");
  const names = (values.set ?? [])
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim());
  if (names.length === 0) throw new RangeError("--set is required");
  for (const name of names) anchorSet(name);
  return {
    names: [...new Set(names)],
    options: withoutUndefined({
      out: resolve(values.out),
      limit: optionalInteger(values.limit, "--limit", 1),
      delayMs: optionalInteger(values["delay-ms"], "--delay-ms", 0),
      attempts: optionalInteger(values.attempts, "--attempts", 1),
      backoffMs: optionalInteger(values["backoff-ms"], "--backoff-ms", 0),
      timeoutMs: optionalInteger(values["timeout-ms"], "--timeout-ms", 1),
    }),
  };
}

async function fetchSequentially(names, options) {
  const [first, ...rest] = names;
  if (first === undefined) return [];
  const manifest = await fetchAnchorSet(first, options);
  return [manifest, ...(await fetchSequentially(rest, options))];
}

/** The CLI body; `overrides` lets tests inject fetchFn, sleep, now and log. Returns the exit code. */
export async function main(argv = process.argv.slice(2), overrides = {}) {
  const log = overrides.log ?? ((line) => console.log(line));
  let values;
  try {
    values = parseArgs({ args: argv, options: OPTIONS, strict: true }).values;
  } catch (error) {
    throw new UsageError(`${error.message}\n\n${usage()}`);
  }
  if (values.help) {
    log(usage());
    return 0;
  }
  const { names, options } = normalizeFetchOptions(values);
  const manifests = await fetchSequentially(names, { ...options, ...overrides, log });
  log(`PASS anchor-fetch sets=${manifests.map((manifest) => manifest.set).join(",")}`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runMain(() => main());
