// The region probe of the review harvest (Issue #4132): asks a local Git object store what the
// pull request did to one file after a review comment, commit by commit along the first-parent
// chain from the reviewed commit to the final head.
//
// Local, not the GitHub API: the retired harvest paid one REST call per commit per pull request
// for patches, which does not fit a 2,000-pull-request history into an hourly budget. A bare
// repository holding every `refs/pull/*/head` (see docs/qa/review-agent-measurement.md) answers
// the same question with zero API calls. Every diff is pinned — Myers, indent heuristic, no
// renames, no external diff or textconv, user and system Git configuration ignored, merges diffed
// against their first parent — so the same objects always produce the same hunks on every machine.

import { devNull } from "node:os";

import { spawnHostExecutable } from "./host-command.mjs";
import { parseUnifiedHunks } from "./review-harvest-records.mjs";

const PINNED_DIFF_OPTIONS = [
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--no-renames",
  "--diff-algorithm=myers",
  "--indent-heuristic",
  "-U0",
];
const BINARY_DIFF = /^Binary files .* differ$/mu;
const COMMIT_HEADER = /^([0-9a-f]{40})(?: \(from [0-9a-f]{40}\))?$/u;
const MISSING_OBJECT = /^([0-9a-f]{40}) missing$/u;

function gitEnvironment() {
  return { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, LC_ALL: "C" };
}

function defaultRun(args, input) {
  return spawnHostExecutable("git", args, {
    env: gitEnvironment(),
    ...(input === undefined ? {} : { input }),
  });
}

function succeeded(result) {
  return (result.error === undefined || result.error === null) && result.status === 0;
}

/** The change one diff text describes: a binary change is whole-file, otherwise its hunks. */
function changeFromDiffText(text) {
  if (BINARY_DIFF.test(text)) return { kind: "whole-file" };
  return { kind: "hunks", hunks: parseUnifiedHunks(text) };
}

/** The change one `git diff` answer describes, or `unavailable` when Git could not produce it. */
export function changeFromDiffResult(result) {
  return succeeded(result) ? changeFromDiffText(String(result.stdout)) : { kind: "unavailable" };
}

/** `rev-list --parents` lines into commits, oldest first, marking merges. */
export function parseFirstParentChain(text) {
  return String(text)
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [sha, ...parents] = line.split(" ");
      return { sha, firstParent: parents[0] ?? null, merge: parents.length > 1 };
    });
}

/** `diff-tree --stdin --always` output into one change per commit, keyed by commit id. */
export function parseDiffTreeOutput(text) {
  const sections = new Map();
  let current;
  for (const line of String(text).split("\n")) {
    const header = COMMIT_HEADER.exec(line);
    if (header !== null) {
      current = header[1];
      sections.set(current, []);
    } else if (current !== undefined) {
      sections.get(current).push(line);
    }
  }
  return new Map([...sections].map(([sha, lines]) => [sha, changeFromDiffText(lines.join("\n"))]));
}

function historyOf(run, gitDir, chain, path) {
  const result = run(
    [
      "--git-dir",
      gitDir,
      "diff-tree",
      "--stdin",
      "--always",
      "-p",
      "--diff-merges=first-parent",
      ...PINNED_DIFF_OPTIONS,
      "--",
      path,
    ],
    `${chain.map((commit) => commit.sha).join("\n")}\n`,
  );
  if (!succeeded(result)) return { kind: "unavailable" };
  const changes = parseDiffTreeOutput(result.stdout);
  const steps = chain.map((commit) => ({
    merge: commit.merge,
    change: changes.get(commit.sha) ?? { kind: "hunks", hunks: [] },
  }));
  return { kind: "steps", steps };
}

function cumulativeOf(run, gitDir, from, to, path) {
  const change = changeFromDiffResult(
    run(["--git-dir", gitDir, "diff", ...PINNED_DIFF_OPTIONS, from, to, "--", path]),
  );
  return change.kind === "unavailable" ? change : { kind: "cumulative", change };
}

function memoize(compute) {
  const cache = new Map();
  return (key, ...args) => {
    if (!cache.has(key)) cache.set(key, compute(...args));
    return cache.get(key);
  };
}

function missingObjects(run, gitDir, oids) {
  const check = run(["--git-dir", gitDir, "cat-file", "--batch-check"], `${oids.join("\n")}\n`);
  return String(check.stdout ?? "")
    .split("\n")
    .flatMap((line) => MISSING_OBJECT.exec(line)?.[1] ?? []);
}

/**
 * A memoized probe over `gitDir`. `run` is injectable so the tests answer with fixture output;
 * production runs the host `git` with a scrubbed configuration. The probe answers
 * `{ kind: "steps" }` along a linear first-parent chain, `{ kind: "cumulative" }` when a
 * force-push took the reviewed commit off the chain, and `{ kind: "unavailable" }` when an
 * object is missing.
 *
 * `probe.prepare(oids)` checks one page's commits in a single `cat-file --batch-check`; with
 * `fetchMissing` it fetches every missing one by object id from `origin` in one read, so a
 * reviewed commit a later force-push made unreachable can still be measured.
 */
export function createGitRegionProbe(gitDir, run = defaultRun, { fetchMissing = false } = {}) {
  const chainOf = memoize((from, to) => {
    const result = run([
      "--git-dir",
      gitDir,
      "rev-list",
      "--first-parent",
      "--reverse",
      "--parents",
      `${from}..${to}`,
    ]);
    return succeeded(result) ? parseFirstParentChain(result.stdout) : null;
  });
  const probe = memoize((from, to, path) => {
    const chain = chainOf(`${from}..${to}`, from, to);
    if (chain === null) return { kind: "unavailable" };
    if (chain.length === 0 || chain[0].firstParent !== from) {
      return cumulativeOf(run, gitDir, from, to, path);
    }
    return historyOf(run, gitDir, chain, path);
  });
  const ask = ({ from, to, path }) => probe(`${from}\u0000${to}\u0000${path}`, from, to, path);
  ask.prepare = (oids) => {
    if (!fetchMissing || oids.length === 0) return;
    const missing = missingObjects(run, gitDir, oids);
    if (missing.length === 0) return;
    run(["--git-dir", gitDir, "fetch", "--no-tags", "--quiet", "origin", ...missing]);
  };
  return ask;
}
