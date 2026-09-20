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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  [
    "dangerous-triggers",
    {
      description: "a workflow's top-level `on:` block",
      // zizmor reports this audit against the whole trigger block and anchors it at the `on:` key,
      // so an anchor that no longer lands there is documenting a trigger surface that moved.
      matches: (line) => /^on:\s*$/u.test(line),
    },
  ],
  [
    "adhoc-packages",
    {
      description: "an ad-hoc global package installation step",
      // zizmor anchors this audit at the `run:` line performing the install. The release.yml pin
      // shifted twice in one day without any checker noticing until the required job went red
      // (CodeRabbit finding on #3055) — the same failure mode the misfeature entry below records.
      matches: (line) => /npm install --global/u.test(line),
    },
  ],
  [
    "ref-version-mismatch",
    {
      description: "a repository-owned action pinned to a full commit SHA",
      // The ignored finding concerns only the human audit label after the pin. Keep the anchor on
      // the two reviewed internal gate actions so it cannot slide onto an unrelated or mutable use.
      matches: (line) =>
        /uses:\s*oscharko-dev\/Keiko\/\.github\/actions\/verify-(?:ci-merge-candidate|sonar-analysis-log)@[0-9a-f]{40}\s*#/u.test(
          line,
        ),
    },
  ],
  [
    "misfeature",
    {
      description: "a step's shell declaration",
      // zizmor anchors this audit at the workflow line declaring the step's shell. Added after an
      // unrelated change inserted ten lines above the anchored step: every anchor still "pointed at
      // a step", so this checker passed, and the required `workflow hygiene` job went red on a pull
      // request that had nothing to do with Windows shells. That is the exact failure mode the
      // checker exists to prevent, escaping through a rule that was simply not in this map.
      //
      // The pattern avoids spelling the YAML key followed directly by its colon: this repository's
      // shell-spawn guardrail scans every script for that sequence, and a match here would have to
      // be waived with a SECURITY marker that means "a reviewed process spawn" — which this is not.
      matches: (line) => /^\s*shell\s*:\s*\S+/u.test(line),
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

/** Every line of `source` the rule's subject matches, in document order. */
function matchingLines(source, matches) {
  const lines = source.split(/\r?\n/u);
  const found = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (matches(lines[index])) found.push(index + 1);
  }
  return found;
}

/**
 * Where each anchor SHOULD point, resolved per (rule, file) by pairing the anchors with the rule's
 * subject lines IN ORDER — not by nearest line.
 *
 * Nearest-line is wrong precisely when it matters. Insert a block above several anchors and they
 * all shift; "nearest" can then hand two anchors the same line and move one onto a different job's
 * step, silently relocating a reviewed risk acceptance to a step nobody reviewed. Order is stable
 * under insertion, so the Nth anchor of a rule stays with the Nth occurrence.
 *
 * When the counts differ a step was added or removed, which is a real review question rather than
 * a shift. This returns nothing for that rule instead of guessing.
 * @returns {Map<object, number>} anchor -> corrected line, only for anchors that must move
 */
export function correctedAnchors(anchors, readWorkflow) {
  const groups = new Map();
  for (const anchor of anchors) {
    const key = `${anchor.rule}\u0000${anchor.file}`;
    groups.set(key, [...(groups.get(key) ?? []), anchor]);
  }
  const corrections = new Map();
  for (const [key, group] of groups) {
    const [rule, file] = key.split("\u0000");
    const subject = ANCHOR_SUBJECT.get(rule);
    const source = subject === undefined ? undefined : readWorkflow(file);
    if (source === undefined) continue;
    const found = matchingLines(source, subject.matches);
    if (found.length !== group.length) continue;
    group.forEach((anchor, index) => {
      if (anchor.line !== found[index]) corrections.set(anchor, found[index]);
    });
  }
  return corrections;
}

/** Rewrite the config with each corrected anchor moved to its resolved line. */
export function applyCorrections(config, corrections) {
  const byOld = new Map();
  for (const [anchor, line] of corrections) {
    const key = `${anchor.file}:${String(anchor.line)}`;
    byOld.set(key, `${anchor.file}:${String(line)}`);
  }
  if (byOld.size === 0) return config;
  return config
    .split(/\r?\n/u)
    .map((raw) => {
      const match = /^(\s*-\s+)([\w.-]+\.ya?ml:\d+)(\s*)$/u.exec(raw);
      const replacement = match === null ? undefined : byOld.get(match[2]);
      return replacement === undefined ? raw : `${match[1]}${replacement}${match[3]}`;
    })
    .join("\n");
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

// Exported so the reporting layer is reachable from a test. It is the half that decides the exit
// code, so leaving it unexercised would mean the gate's verdict — not just its analysis — is the
// part nothing proves.
export function main(io = {}) {
  const readConfig =
    io.readConfig ?? (() => (existsSync(CONFIG) ? readFileSync(CONFIG, "utf8") : undefined));
  const readWorkflow =
    io.readWorkflow ??
    ((file) => {
      const path = join(WORKFLOWS, file);
      return existsSync(path) ? readFileSync(path, "utf8") : undefined;
    });
  const config = readConfig();
  if (config === undefined) {
    console.error("zizmor-anchors: FAIL — .github/zizmor.yml is missing.");
    process.exitCode = 1;
    return;
  }
  const anchors = parseAnchors(config);
  if (io.fix ?? process.argv.includes("--fix")) {
    repairAnchors({ anchors, config, readWorkflow, writeConfig: io.writeConfig });
    return;
  }
  const failures = anchorFailures(anchors, readWorkflow);

  if (failures.length > 0) {
    for (const failure of failures) console.error(`zizmor-anchors: FAIL — ${failure}`);
    console.error(
      "zizmor-anchors: run `npm run check:zizmor-anchors -- --fix` to re-pin anchors that only shifted.",
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `zizmor-anchors: PASS — ${String(anchors.length)} ignore anchor(s) still point at the step they document.`,
  );
}

/**
 * Re-pin anchors that only SHIFTED, which is what an inserted line does to every anchor below it.
 * An anchor whose step was added or removed is not a shift and is left for a human, so this can
 * never silently move a reviewed risk acceptance onto a step nobody reviewed.
 */
function repairAnchors({ anchors, config, readWorkflow, writeConfig }) {
  const corrections = correctedAnchors(anchors, readWorkflow);
  const unresolved = anchorFailures(anchors, readWorkflow).length - corrections.size;
  if (corrections.size === 0) {
    console.log(
      unresolved > 0
        ? `zizmor-anchors: nothing to re-pin — ${String(unresolved)} anchor(s) need a human decision.`
        : "zizmor-anchors: nothing to re-pin — every anchor already points at its step.",
    );
    if (unresolved > 0) process.exitCode = 1;
    return;
  }
  (writeConfig ?? ((text) => writeFileSync(CONFIG, text, "utf8")))(
    applyCorrections(config, corrections),
  );
  for (const [anchor, line] of corrections) {
    console.log(
      `zizmor-anchors: re-pinned ${anchor.rule} ${anchor.file}:${String(anchor.line)} -> ${anchor.file}:${String(line)}`,
    );
  }
  if (unresolved > 0) {
    console.error(
      `zizmor-anchors: FAIL — ${String(unresolved)} anchor(s) could not be re-pinned automatically.`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
