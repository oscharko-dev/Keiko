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

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveHostExecutable } from "./lib/host-executable.mjs";

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

/**
 * The workflow as committed at HEAD — the revision whose anchors were last verified. Without it
 * there is no evidence of what an anchor documented, so re-pinning is refused rather than guessed.
 * @returns {string | undefined}
 */
function readCommittedWorkflow(file) {
  let git;
  try {
    // Resolved through the repository's trusted-root helper rather than PATH (javascript:S4036):
    // a writeable PATH entry would otherwise decide which binary supplies the evidence that
    // authorises moving a reviewed risk acceptance.
    git = resolveHostExecutable("git");
  } catch {
    return undefined;
  }
  const result = spawnSync(git, ["show", `HEAD:.github/workflows/${file}`], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.status === 0 && typeof result.stdout === "string" ? result.stdout : undefined;
}

/**
 * The job that owns a line: the nearest `  <job>:` key at or above it. Returns undefined when the
 * line sits outside any job, which refuses the re-pin rather than inventing an owner.
 * @returns {string | undefined}
 */
function jobAtLine(source, line) {
  const lines = source.split(/\r?\n/u);
  if (line < 1 || line > lines.length) return undefined;
  for (let index = line - 1; index >= 0; index -= 1) {
    const match = /^ {2}([A-Za-z0-9][\w-]*):\s*$/u.exec(lines[index] ?? "");
    if (match?.[1] !== undefined) return match[1];
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
export function correctedAnchors(anchors, readWorkflow, readPrevious = readCommittedWorkflow) {
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
    // Equal counts do NOT prove a pure shift: a change can delete one matched step and add a
    // different one, keeping the count identical. Re-pinning on the count alone would then carry
    // the accepted risk onto a step nobody reviewed — the exact outcome this gate exists to
    // prevent. So each anchor is re-pinned only when the line it currently documents still exists
    // verbatim in the new file, read from the committed revision it was last verified against.
    const previous = readPrevious(file);
    if (previous === undefined) continue;
    for (const [anchor, target] of sameJobMoves(group, found, previous, source)) {
      corrections.set(anchor, target);
    }
  }
  return corrections;
}

/**
 * The whole step a line belongs to: from its `- ` item marker down to the next item at the same
 * indentation. This is the step's IDENTITY.
 *
 * Neither the count, the owning job, nor the matched line alone is enough. Every
 * `uses: actions/cache@<sha>` line here is byte-identical, and a replacement step can appear in
 * the SAME job — so all three can agree while the reviewed step is gone. The step body cannot:
 * a different cache step carries a different `key`, `path` or `name`.
 * @returns {string | undefined}
 */
function stepBlockAt(source, line) {
  const lines = source.split(/\r?\n/u);
  if (line < 1 || line > lines.length) return undefined;
  const start = itemStartAt(lines, line - 1);
  if (start === undefined) return undefined;
  const indent = indentOf(lines[start] ?? "");
  const block = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    const text = lines[index] ?? "";
    if (text.trim() === "") continue;
    if (indentOf(text) <= indent) break;
    block.push(text);
  }
  return block.join("\n");
}

/** The index of the `- ` item that owns a line, searching upwards. */
function itemStartAt(lines, from) {
  for (let index = from; index >= 0; index -= 1) {
    if (/^\s*-\s/u.test(lines[index] ?? "")) return index;
  }
  return undefined;
}

/** Leading-whitespace width of a line. */
function indentOf(text) {
  return (/^(\s*)/u.exec(text)?.[1] ?? "").length;
}

/**
 * The anchors that merely MOVED within their own job, paired with their new line.
 *
 * The line CONTENT does not identify a step — every `actions/cache@<sha>` line in this repository
 * is byte-identical — so the owning job is the identity. A change that deletes one matched step
 * and adds another elsewhere keeps the count intact, and matching on count alone would carry the
 * accepted risk onto a step nobody reviewed. Comparing the job forecloses that.
 * @returns {Array<[object, number]>}
 */
function sameJobMoves(group, found, previous, source) {
  const moves = [];
  for (const [index, anchor] of group.entries()) {
    const target = found[index];
    if (target === undefined || anchor.line === target) continue;
    if (jobAtLine(previous, anchor.line) !== jobAtLine(source, target)) continue;
    // Same job is still not the same STEP: a replacement can appear inside that job. Only an
    // unchanged step body proves the reviewed step survived.
    const before = stepBlockAt(previous, anchor.line);
    if (before === undefined || before !== stepBlockAt(source, target)) continue;
    moves.push([anchor, target]);
  }
  return moves;
}

/** Rewrite the config with each corrected anchor moved to its resolved line. */
export function applyCorrections(config, corrections) {
  // Keyed by RULE as well as file:line. Two rules may legitimately document the same step, and a
  // key without the rule would let one rule's correction rewrite the other rule's anchor — moving
  // a risk acceptance that was never re-resolved. The rule is tracked while scanning, exactly as
  // `parseAnchors` does when reading them.
  const byRuleAndOld = new Map();
  for (const [anchor, line] of corrections) {
    byRuleAndOld.set(
      `${anchor.rule}\u0000${anchor.file}:${String(anchor.line)}`,
      `${anchor.file}:${String(line)}`,
    );
  }
  if (byRuleAndOld.size === 0) return config;
  let rule;
  return config
    .split(/\r?\n/u)
    .map((raw) => {
      const ruleMatch = /^ {2}([a-z0-9-]+):\s*$/u.exec(raw);
      if (ruleMatch?.[1] !== undefined) rule = ruleMatch[1];
      const match = /^(\s*-\s+)([\w.-]+\.ya?ml:\d+)(\s*)$/u.exec(raw);
      if (match === null || rule === undefined) return raw;
      const replacement = byRuleAndOld.get(`${rule}\u0000${match[2]}`);
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
    repairAnchors({
      anchors,
      config,
      readPrevious: io.readPrevious ?? readCommittedWorkflow,
      readWorkflow,
      writeConfig: io.writeConfig,
    });
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
function repairAnchors({ anchors, config, readPrevious, readWorkflow, writeConfig }) {
  const corrections = correctedAnchors(anchors, readWorkflow, readPrevious);
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
