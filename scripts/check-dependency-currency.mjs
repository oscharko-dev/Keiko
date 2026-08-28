#!/usr/bin/env node
// Dependency-currency gate (#2296, epic #2291).
//
// Epic #2291 closed its implementation waves with a prose decision matrix and nothing that read it
// back. Six weeks later that matrix documented an ESLint lane pinned at 9.39.5 and a Monaco line
// pinned at 0.55 while the repository actually resolved ESLint 10.9.1 and Monaco 0.56.0, and it
// still named `actions/setup-node` v6.4.0 and `github/codeql-action` v4.37.0 after both had moved.
// Every one of those rows read as a reviewed decision and was in fact a stale sentence. This gate
// exists so the #2296 closeout document cannot rot the same way: it is the executable half of that
// document.
//
// Deliberately narrow, deterministic and offline. It answers exactly one question — "does the
// committed disposition still describe what this checkout resolves?" — and never asks whether a
// newer version exists. Registry currency is a live question with a temporally unstable answer;
// Dependabot and the #2296 refresh own it, and a gate that reached the network would fail closed on
// a registry hiccup instead of on a real drift.
//
// Three fail-closed checks:
//
//   1. Every governed dependency row resolves in `package-lock.json` for its declared scope, and
//      the resolved version equals the documented version exactly.
//   2. Every documented GitHub Action row matches the pins in `.github/workflows` and
//      `.github/actions`: same commit SHA, same version comment.
//   3. Completeness in both directions — every action pinned in a workflow has a row, and all pins
//      of one action repository agree on a single SHA and comment. That last part is why
//      `github/codeql-action/init` and `/analyze` cannot drift apart: Dependabot does not group
//      an action's sub-actions, so bumping one and not the other is a version-mismatch CI failure
//      that nothing else in this repository catches.
//
// Reports metadata only: package names, scopes, versions, action refs and counts — never file
// bodies or credentials.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { parse } from "yaml";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonFile } from "./lib/json.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const CLOSEOUT_DOCUMENT = join("docs", "release", "2296-dependency-security-closeout.md");
export const LOCKFILE = "package-lock.json";
const WORKFLOW_DIRS = [join(".github", "workflows"), join(".github", "actions")];

// `current` — resolved version is the newest reviewed release for this scope.
// `patch-deferred` — a newer compatible release exists and is intentionally not taken yet.
// `major-deferred` — a newer major exists behind a separately governed migration.
// `unsupported` — the newer release cannot be adopted on this runtime or peer graph.
const DISPOSITIONS = new Set(["current", "patch-deferred", "major-deferred", "unsupported"]);

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
// Applied to a parsed step's `uses` VALUE, never to a raw file line: a pinned reference inside a
// YAML comment or a `run:` heredoc is not a step this repository executes, and counting one would
// let the completeness check pass on an action no workflow actually uses.
const USES_REFERENCE = /^([A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+)@([0-9a-f]{40})$/u;
const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

function tableCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  if (/^\|[\s:|-]*$/u.test(trimmed)) return null;
  return trimmed
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
}

function unquote(cell) {
  return cell.replace(/^`|`$/gu, "").trim();
}

// Rows are identified by their own shape rather than by locating a heading, so reordering or
// re-titling sections in the document cannot silently drop a table out of enforcement.
export function parseDependencyRows(markdown) {
  const rows = [];
  for (const line of markdown.split(/\r?\n/)) {
    const cells = tableCells(line);
    if (cells === null || cells.length < 4) continue;
    if (!DISPOSITIONS.has(cells[3])) continue;
    // Action rows carry a disposition in the same column. Their third cell is a commit SHA, which
    // no dependency version can be, so this keeps the two row shapes disjoint without requiring
    // either table to sit under a particular heading.
    if (SHA_PATTERN.test(unquote(cells[2]))) continue;
    rows.push({
      name: unquote(cells[0]),
      scope: unquote(cells[1]),
      version: unquote(cells[2]),
      disposition: cells[3],
    });
  }
  return rows;
}

// The full row schema is required, disposition included. Accepting a row on its SHA alone would
// let the reviewed decision be deleted, mistyped, or replaced with prose while the gate stayed
// green — the decision record is the artifact being enforced, not just the pin.
export function parseActionRows(markdown) {
  const rows = [];
  for (const line of markdown.split(/\r?\n/)) {
    const cells = tableCells(line);
    if (cells === null || cells.length < 4) continue;
    const sha = unquote(cells[2]);
    if (!SHA_PATTERN.test(sha)) continue;
    if (!DISPOSITIONS.has(cells[3])) continue;
    rows.push({
      action: unquote(cells[0]),
      version: unquote(cells[1]),
      sha,
      disposition: cells[3],
    });
  }
  return rows;
}

// A SHA-shaped row whose disposition is missing or invalid is a corrupted decision record, not an
// absent one, so it must fail loudly rather than silently drop out of enforcement.
export function malformedActionRows(markdown) {
  const malformed = [];
  for (const line of markdown.split(/\r?\n/)) {
    const cells = tableCells(line);
    if (cells === null || cells.length < 3) continue;
    if (!SHA_PATTERN.test(unquote(cells[2]))) continue;
    if (cells.length >= 4 && DISPOSITIONS.has(cells[3])) continue;
    malformed.push(unquote(cells[0]));
  }
  return malformed;
}

function workspaceDeclares(workspace, name) {
  return DEPENDENCY_SECTIONS.some((section) => {
    const declared = workspace[section];
    return typeof declared === "object" && declared !== null && name in declared;
  });
}

// A workspace may override a dependency locally; npm then places it under the workspace's own
// node_modules and the hoisted root copy is a different resolution. Checking the root copy for a
// workspace-scoped row would compare the wrong node, so the local path wins when it exists.
//
// The hoisted fallback is only valid while that workspace still DECLARES the dependency. Without
// that condition a row outlives its own subject: drop `monaco-editor` from keiko-ui while another
// workspace keeps the same hoisted version and the stale keiko-ui disposition passes forever, and
// a misspelled scope never fails at all. Both now resolve to undefined and fail closed.
export function resolveInstalledVersion(lockPackages, name, scope) {
  const hoisted = lockPackages[`node_modules/${name}`]?.version;
  if (scope === "root") return hoisted;
  const workspace = lockPackages[`packages/${scope}`];
  if (workspace === undefined) return undefined;
  const local = lockPackages[`packages/${scope}/node_modules/${name}`];
  if (local?.version !== undefined) return local.version;
  return workspaceDeclares(workspace, name) ? hoisted : undefined;
}

export function dependencyFailures(rows, lockPackages) {
  const failures = [];
  for (const row of rows) {
    const installed = resolveInstalledVersion(lockPackages, row.name, row.scope);
    if (installed === undefined) {
      failures.push(`${row.name} (${row.scope}): documented but absent from the resolved graph`);
      continue;
    }
    if (installed !== row.version) {
      failures.push(
        `${row.name} (${row.scope}): documented ${row.version}, lockfile resolves ${installed}`,
      );
    }
  }
  return failures;
}

function actionRepository(reference) {
  const [owner, name] = reference.split("/");
  return `${owner}/${name}`;
}

// A workflow's steps live under `jobs.<id>.steps`; a composite action's under `runs.steps`.
function documentSteps(document) {
  const steps = [];
  for (const job of Object.values(document?.jobs ?? {})) {
    if (Array.isArray(job?.steps)) steps.push(...job.steps);
  }
  if (Array.isArray(document?.runs?.steps)) steps.push(...document.runs.steps);
  return steps;
}

// The version comment is not part of the parsed `uses` value, so it is recovered from the line that
// declares this exact reference. A pin without one yields an empty comment, which then fails the
// comparison against the documented row — the intended fail-closed outcome.
function versionCommentFor(text, reference) {
  const escaped = reference.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
  return new RegExp(String.raw`${escaped}\s*#\s*(\S+)`, "u").exec(text)?.[1] ?? "";
}

// Collects one entry per action REPOSITORY, keeping every distinct (sha, comment) pair seen for it.
export function collectWorkflowPins(files) {
  const pins = new Map();
  for (const { name, text } of files) {
    for (const step of documentSteps(parse(text))) {
      if (typeof step?.uses !== "string") continue;
      const reference = step.uses.trim();
      const match = USES_REFERENCE.exec(reference);
      if (match === null) continue;
      const repository = actionRepository(match[1]);
      const seen = pins.get(repository) ?? new Map();
      const key = `${match[2]} ${versionCommentFor(text, reference)}`;
      seen.set(key, [...(seen.get(key) ?? []), name]);
      pins.set(repository, seen);
    }
  }
  return pins;
}

function splitPinFailure(repository, seen) {
  const variants = [...seen.keys()].sort((left, right) => left.localeCompare(right));
  return (
    `${repository}: pinned at ${variants.length} different refs across workflows ` +
    `(${variants.map((variant) => variant.split(" ")[1]).join(", ")}) — ` +
    "an action's sub-actions must move together"
  );
}

export function actionFailures(rows, pins) {
  const failures = [];
  const documented = new Map(rows.map((row) => [actionRepository(row.action), row]));
  for (const [repository, seen] of pins) {
    if (seen.size > 1) {
      failures.push(splitPinFailure(repository, seen));
      continue;
    }
    const row = documented.get(repository);
    if (row === undefined) {
      failures.push(`${repository}: pinned in a workflow but absent from the closeout document`);
      continue;
    }
    const [key] = [...seen.keys()];
    if (key !== `${row.sha} ${row.version}`) {
      failures.push(
        `${repository}: documented ${row.version}@${row.sha.slice(0, 12)}, workflows pin ` +
          `${key.split(" ")[1]}@${key.split(" ")[0].slice(0, 12)}`,
      );
    }
  }
  for (const [repository] of documented) {
    if (!pins.has(repository)) {
      failures.push(`${repository}: documented but no workflow pins it`);
    }
  }
  return failures;
}

function collectYamlFiles(directory, accumulator) {
  if (!existsSync(directory)) return accumulator;
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      collectYamlFiles(path, accumulator);
      continue;
    }
    if (!/\.ya?ml$/u.test(entry)) continue;
    accumulator.push({ name: relative(repoRoot, path), text: readFileSync(path, "utf8") });
  }
  return accumulator;
}

export function defaultSeams() {
  return {
    readDocument: () => readFileSync(join(repoRoot, CLOSEOUT_DOCUMENT), "utf8"),
    readLock: () => readJsonFile(join(repoRoot, LOCKFILE)).packages,
    readWorkflows: () =>
      WORKFLOW_DIRS.reduce(
        (files, directory) => collectYamlFiles(join(repoRoot, directory), files),
        [],
      ),
  };
}

export function evaluate(seams) {
  const markdown = seams.readDocument();
  const dependencyRows = parseDependencyRows(markdown);
  const actionRows = parseActionRows(markdown);
  const failures = [];
  if (dependencyRows.length === 0) {
    failures.push("closeout document declares no governed dependency rows");
  }
  if (actionRows.length === 0) {
    failures.push("closeout document declares no GitHub Action rows");
  }
  for (const action of malformedActionRows(markdown)) {
    failures.push(`${action}: action row has no valid disposition`);
  }
  failures.push(
    ...dependencyFailures(dependencyRows, seams.readLock()),
    ...actionFailures(actionRows, collectWorkflowPins(seams.readWorkflows())),
  );
  return { failures, dependencyRows: dependencyRows.length, actionRows: actionRows.length };
}

export function main(seams = defaultSeams()) {
  let result;
  try {
    result = evaluate(seams);
  } catch (error) {
    // Fail closed: an unreadable document or lockfile is a drift signal, never a silent pass.
    process.stderr.write(`dependency-currency: FAIL — ${String(error.message ?? error)}\n`);
    return 1;
  }
  if (result.failures.length > 0) {
    process.stderr.write("dependency-currency: FAIL\n");
    for (const failure of result.failures) process.stderr.write(`  - ${failure}\n`);
    process.stderr.write(`\nUpdate ${CLOSEOUT_DOCUMENT} so it describes this checkout.\n`);
    return 1;
  }
  process.stdout.write(
    `dependency-currency: PASS — ${result.dependencyRows} governed dependency rows and ` +
      `${result.actionRows} action rows match this checkout.\n`,
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
