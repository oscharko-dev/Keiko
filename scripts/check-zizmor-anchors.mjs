#!/usr/bin/env node
// Verifies that every `<workflow>:<line>` anchor in `.github/zizmor.yml` still points at the step it
// was written for.
//
// zizmor's ignore list addresses findings by LINE NUMBER. That makes every risk acceptance in
// `.github/zizmor.yml` a reference into a file other people edit for unrelated reasons: inserting a
// single line above an anchored step silently re-points the anchor, the ignore stops matching, and
// the required `zizmor` job goes red on a pull request that never touched security configuration.
// The zizmor.yml header asks the reader to re-run zizmor locally after such an edit — this makes
// that instruction executable, and prints the corrected numbers instead of only reporting drift.
//
// The check is deliberately narrow: it does not re-implement zizmor's rules, it only asserts that
// each anchor still lands on a step of the kind its rule is about. Getting a `zizmor` verdict
// remains zizmor's job.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(repoRoot, ".github", "zizmor.yml");
const WORKFLOWS = join(repoRoot, ".github", "workflows");

// The step shape each rule's ignores are expected to anchor to. A rule absent from this map is not
// position-checked — the anchor is still reported, so a new rule shows up rather than being skipped.
const ANCHOR_SUBJECT = new Map([
  [
    "cache-poisoning",
    {
      description: "a save-capable `uses: actions/cache@…` step",
      // `actions/cache/restore` cannot write a cache, so zizmor does not flag it and an anchor
      // pointing at one would be a silent no-op rather than a risk acceptance.
      matches: (line) => /uses:\s*actions\/cache@/u.test(line),
    },
  ],
]);

export function parseAnchors(config) {
  const anchors = [];
  let rule;
  for (const raw of config.split(/\r?\n/u)) {
    const ruleMatch = /^ {2}([a-z0-9-]+):\s*$/u.exec(raw);
    if (ruleMatch?.[1] !== undefined) rule = ruleMatch[1];
    const anchorMatch = /^\s*-\s+([\w.-]+\.ya?ml):(\d+)\s*$/u.exec(raw);
    if (anchorMatch !== null && rule !== undefined) {
      anchors.push({ rule, file: anchorMatch[1], line: Number(anchorMatch[2]) });
    }
  }
  return anchors;
}

/** The nearest line at or after `from` that satisfies `matches`, or undefined. */
function nearestMatch(lines, from, matches) {
  for (let offset = 0; offset < lines.length; offset += 1) {
    for (const candidate of [from + offset, from - offset]) {
      if (candidate < 1 || candidate > lines.length) continue;
      if (matches(lines[candidate - 1])) return candidate;
    }
  }
  return undefined;
}

export function anchorFailures(anchors, readWorkflow) {
  const failures = [];
  for (const { rule, file, line } of anchors) {
    const subject = ANCHOR_SUBJECT.get(rule);
    if (subject === undefined) continue;
    const source = readWorkflow(file);
    if (source === undefined) {
      failures.push(`${rule}: ${file}:${String(line)} names a workflow that does not exist.`);
      continue;
    }
    const lines = source.split(/\r?\n/u);
    if (line <= lines.length && subject.matches(lines[line - 1])) continue;
    const corrected = nearestMatch(lines, line, subject.matches);
    const hint =
      corrected === undefined
        ? "no such step exists in that workflow any more — remove the anchor or re-verify the rule"
        : `the nearest one is line ${String(corrected)} — update the anchor to ${file}:${String(corrected)}`;
    failures.push(
      `${rule}: ${file}:${String(line)} no longer points at ${subject.description}; ${hint}.`,
    );
  }
  return failures;
}

function main() {
  if (!existsSync(CONFIG)) {
    console.error("zizmor-anchors: FAIL — .github/zizmor.yml is missing.");
    process.exitCode = 1;
    return;
  }
  const anchors = parseAnchors(readFileSync(CONFIG, "utf8"));
  const failures = anchorFailures(anchors, (file) => {
    const path = join(WORKFLOWS, file);
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  });

  if (failures.length > 0) {
    for (const failure of failures) console.error(`zizmor-anchors: FAIL — ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `zizmor-anchors: PASS — ${String(anchors.length)} ignore anchor(s) still point at the step they document.`,
  );
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
