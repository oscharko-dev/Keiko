// Read-only report of what an OpenCode upgrade changes for Keiko. It fetches the two tagged protocol
// schemas, source trees and release notes, reuses the server's own projection and inventory diffs,
// and prints the facts the upgrade runbook asks for, including the ready-to-paste pin entry.
// It writes nothing and needs a prior `npm run build:packages`.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

import { projectOpenCodeV2ProtocolSurface } from "../packages/keiko-server/dist/coding-runtime/opencodeProtocolSurface.js";
import {
  diffOpenCodeConfigurationPaths,
  diffOpenCodeServiceOperations,
  extractOpenCodeConfigurationPaths,
  extractOpenCodeServiceOperations,
} from "../packages/keiko-server/dist/coding-runtime/opencodeServiceInventory.js";

const PINS = JSON.parse(
  readFileSync(
    new URL("../packages/keiko-contracts/src/opencode-runtime-pins.json", import.meta.url),
    "utf8",
  ),
);
const API_BASE = `https://api.github.com/repos/${PINS.upstream.owner}/${PINS.upstream.repository}`;
const RAW_BASE = `https://raw.githubusercontent.com/${PINS.upstream.owner}/${PINS.upstream.repository}`;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
/** Source areas where a change usually needs a Keiko decision; everything else is listed by count. */
const WATCHED_SOURCES = Object.freeze([
  ["Database migrations", /^packages\/core\/src\/database\/migration\/[^/]+\.ts$/u],
  ["Built-in tools", /^packages\/core\/src\/tool\/plugin\/[^/]+\.ts$/u],
  ["Built-in plugins", /^packages\/core\/src\/plugin\/[^/]+\.ts$/u],
  ["Provider plugins", /^packages\/core\/src\/plugin\/provider\/[^/]+(?:\/index)?\.ts$/u],
  ["Configuration schema", /^packages\/schema\/src\/config\/[^/]+\.ts$/u],
]);

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** The versions after `from` up to and including `to`, oldest first. */
export function versionsBetween(tags, from, to) {
  return tags
    .map((tag) => tag.replace(/^refs\/tags\/v/u, ""))
    .filter((version) => VERSION_PATTERN.test(version))
    .filter((version) => compareVersions(version, from) > 0 && compareVersions(version, to) <= 0)
    .sort(compareVersions);
}

const HEADING = /^(#{1,6})\s(.*)$/u;
const BREAKING_HEADING = /^#{1,6}\s+breaking\s+changes?\b/iu;
const LIST_ENTRY = /^[-*]\s(.*)$/u;
const UNPLACED_BREAK = "the note mentions a breaking change outside a section: read it";

function sectionLines(lines, start) {
  const level = HEADING.exec(lines[start])[1].length;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => {
    const heading = HEADING.exec(line);
    return heading !== null && heading[1].length <= level;
  });
  return end === -1 ? rest : rest.slice(0, end);
}

const captured = (pattern, line) => pattern.exec(line)?.at(-1)?.trim();

/**
 * The entries of a release note's breaking section: its headings, or its list when it has none.
 * Upstream's spelling varies between releases, and a mention no section explains is still named.
 */
export function breakingChanges(notes) {
  const lines = notes.split("\n").map((line) => line.trim());
  const start = lines.findIndex((line) => BREAKING_HEADING.test(line));
  if (start === -1) return /\bbreaking\b/iu.test(notes) ? [UNPLACED_BREAK] : [];
  const section = sectionLines(lines, start);
  const headings = section.map((line) => captured(HEADING, line)).filter(Boolean);
  return headings.length > 0
    ? headings
    : section.map((line) => captured(LIST_ENTRY, line)).filter(Boolean);
}

function changedKeys(previous, next) {
  const before = previous ?? {};
  const after = next ?? {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .sort((left, right) => left.localeCompare(right));
}

function operationNames(paths) {
  return Object.entries(paths ?? {}).flatMap(([path, item]) =>
    Object.keys(item)
      .filter((method) => HTTP_METHODS.has(method))
      .map((method) => `${method.toUpperCase()} ${path}`),
  );
}

function operationOf(paths, name) {
  const separator = name.indexOf(" ");
  const method = name.slice(0, separator).toLowerCase();
  return paths?.[name.slice(separator + 1)]?.[method];
}

/** What changed inside the structural projections of the endpoints Keiko admits. */
export function admittedSurfaceDiff(previous, next) {
  const before = previous.projection;
  const after = next.projection;
  const beforeNames = new Set(operationNames(before.paths));
  const afterNames = new Set(operationNames(after.paths));
  const shared = [...beforeNames].filter((name) => afterNames.has(name));
  return {
    admittedCount: beforeNames.size,
    missing: [...beforeNames].filter((name) => !afterNames.has(name)),
    changedOperations: shared.filter(
      (name) =>
        JSON.stringify(operationOf(before.paths, name)) !==
        JSON.stringify(operationOf(after.paths, name)),
    ),
    changedSchemas: changedKeys(before.components?.schemas, after.components?.schemas),
  };
}

const byCodePoint = (left, right) => (left < right ? -1 : Number(left > right));

/** Added, removed and modified paths of two `git/trees` listings. */
export function sourceTreeDiff(previous, next) {
  const before = new Map(previous.map((entry) => [entry.path, entry.sha]));
  const after = new Map(next.map((entry) => [entry.path, entry.sha]));
  return {
    added: [...after.keys()].filter((path) => !before.has(path)).sort(byCodePoint),
    removed: [...before.keys()].filter((path) => !after.has(path)).sort(byCodePoint),
    modified: [...after.keys()]
      .filter((path) => before.has(path) && before.get(path) !== after.get(path))
      .sort(byCodePoint),
  };
}

const UPSTREAM_TEXT_MAX = 200;

// Release notes, paths and operation names are upstream's text and this report is read by people
// and agents: no escape sequence or hidden character reaches a terminal, and no entry runs on.
function dataOnly(value) {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, "?").slice(0, UPSTREAM_TEXT_MAX);
}

function bullets(values) {
  return values.length === 0 ? ["- none"] : values.map((value) => `- ${dataOnly(value)}`);
}

function watchedSections(tree) {
  return WATCHED_SOURCES.flatMap(([title, pattern]) => {
    const added = tree.added.filter((path) => pattern.test(path));
    const removed = tree.removed.filter((path) => pattern.test(path));
    // An area upstream moved would otherwise read as an area that did not change.
    const summary = (tree.paths ?? []).some((path) => pattern.test(path))
      ? `${String(added.length)} added, ${String(removed.length)} removed`
      : "no file matches here any more, find where it moved";
    return [
      `### ${title}: ${summary}`,
      "",
      ...bullets([
        ...added.map((path) => `added ${path}`),
        ...removed.map((path) => `removed ${path}`),
      ]),
      "",
    ];
  });
}

function admittedSection(admitted) {
  return [
    "## Admitted endpoints",
    "",
    `${String(admitted.admittedCount)} admitted, ${String(admitted.missing.length)} missing, ${String(admitted.changedOperations.length)} with a changed operation, ${String(admitted.changedSchemas.length)} referenced schemas changed.`,
    "",
    "Missing:",
    ...bullets(admitted.missing),
    "",
    "Changed operations:",
    ...bullets(admitted.changedOperations),
    "",
    "Changed referenced schemas:",
    ...bullets(admitted.changedSchemas),
    "",
  ];
}

function inventorySection(operations, configuration) {
  const moved = operations.changed.map(
    (item) => `${item.operationId}: ${item.previous} -> ${item.next}`,
  );
  return [
    "## Service inventory: each needs a disposition",
    "",
    `Operations added (${String(operations.added.length)}):`,
    ...bullets(operations.added),
    "",
    `Operations removed (${String(operations.removed.length)}):`,
    ...bullets(operations.removed),
    "",
    `Operations moved (${String(operations.changed.length)}):`,
    ...bullets(moved),
    "",
    `Settings added (${String(configuration.added.length)}):`,
    ...bullets(configuration.added),
    "",
    `Settings removed (${String(configuration.removed.length)}):`,
    ...bullets(configuration.removed),
    "",
  ];
}

/** Renders the facts as Markdown; a pure function of already fetched data. */
export function renderUpgradeReport(input) {
  const { from, to, pin, notes, operations, configuration, admitted, tree } = input;
  const breaking = notes.flatMap(({ version, breaking: titles }) =>
    titles.map((title) => `${version}: ${title}`),
  );
  return [
    `# OpenCode upgrade report: ${from} to ${to}`,
    "",
    `Releases: ${notes.map((note) => note.version).join(", ")}`,
    "",
    "## Pin entry for opencode-runtime-pins.json",
    "",
    "```json",
    JSON.stringify(pin, null, 2),
    "```",
    "",
    "## Upstream breaking changes",
    "",
    ...bullets(breaking),
    "",
    ...admittedSection(admitted),
    ...inventorySection(operations, configuration),
    "## Source areas to review",
    "",
    `${String(tree.added.length)} files added, ${String(tree.removed.length)} removed, ${String(tree.modified.length)} modified.`,
    "",
    ...watchedSections(tree),
    "The CLI commands, tool registry and persistence schema come from the real binary: see docs/coding-runtime/opencode-upgrade.md.",
    "",
  ].join("\n");
}

function requestHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
  };
}

const request = (deps, url) => deps.fetchFn(url, { headers: requestHeaders(deps.token) });

async function fetched(deps, url) {
  const response = await request(deps, url);
  if (!response.ok) throw new Error(`${url} answered ${String(response.status)}`);
  return response;
}

const fetchJson = async (deps, url) => (await fetched(deps, url)).json();
const fetchText = async (deps, url) => (await fetched(deps, url)).text();

async function tagFacts(deps, version) {
  const tag = `v${version}`;
  const [schemaText, commit, tree] = await Promise.all([
    fetchText(deps, `${RAW_BASE}/${tag}/${PINS.upstream.schemaPath}`),
    fetchJson(deps, `${API_BASE}/commits/${tag}`),
    fetchJson(deps, `${API_BASE}/git/trees/${tag}?recursive=1`),
  ]);
  if (tree.truncated === true) throw new Error(`the source tree of ${tag} was truncated`);
  const document = JSON.parse(schemaText);
  return {
    version,
    tag,
    commit: commit.sha,
    rawSchemaSha256: createHash("sha256").update(schemaText).digest("hex"),
    document,
    projection: projectOpenCodeV2ProtocolSurface(document),
    files: tree.tree.filter((entry) => entry.type === "blob"),
  };
}

async function releaseNotes(deps, version) {
  const url = `${API_BASE}/releases/tags/v${version}`;
  const response = await request(deps, url);
  // A tag need not have a release; that is a fact to read, neither a failure nor "no break".
  if (response.status === 404) return { version, breaking: ["no release note: read the commits"] };
  if (!response.ok) throw new Error(`${url} answered ${String(response.status)}`);
  const release = await response.json();
  return { version, breaking: breakingChanges(release.body ?? "") };
}

/** Fetches everything for one report; injectable so the test stays offline. */
export async function buildUpgradeReport(to, deps) {
  const from = PINS.pins[0].version;
  // This endpoint answers every matching tag at once and has no pages (1106 at 2.2.5).
  const tags = await fetchJson(deps, `${API_BASE}/git/matching-refs/tags/v`);
  const versions = versionsBetween(
    tags.map((tag) => tag.ref),
    from,
    to,
  );
  if (!versions.includes(to)) throw new Error(`${to} is not a release after ${from}`);
  const [previous, next, notes] = await Promise.all([
    tagFacts(deps, from),
    tagFacts(deps, to),
    Promise.all(versions.map((version) => releaseNotes(deps, version))),
  ]);
  return renderUpgradeReport({
    from,
    to,
    notes,
    pin: {
      version: next.version,
      tag: next.tag,
      commit: next.commit,
      rawSchemaSha256: next.rawSchemaSha256,
      protocolSurfaceSha256: next.projection.digest,
    },
    operations: diffOpenCodeServiceOperations(
      extractOpenCodeServiceOperations(previous.document),
      extractOpenCodeServiceOperations(next.document),
    ),
    configuration: diffOpenCodeConfigurationPaths(
      extractOpenCodeConfigurationPaths(previous.document),
      extractOpenCodeConfigurationPaths(next.document),
    ),
    admitted: admittedSurfaceDiff(previous.projection, next.projection),
    tree: {
      ...sourceTreeDiff(previous.files, next.files),
      paths: next.files.map((entry) => entry.path),
    },
  });
}

function parseTarget(argv) {
  const [flag, value, ...rest] = argv;
  if (flag !== "--to" || value === undefined || rest.length > 0) {
    throw new Error("usage: npm run opencode:upgrade-report -- --to <version>");
  }
  const version = value.replace(/^v/u, "");
  if (!VERSION_PATTERN.test(version)) throw new Error("--to must be a release version");
  return version;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const report = await buildUpgradeReport(parseTarget(process.argv.slice(2)), {
      fetchFn: globalThis.fetch,
      token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
    });
    process.stdout.write(report);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
