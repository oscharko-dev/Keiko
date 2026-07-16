#!/usr/bin/env node

// One-command producer for both committed editor evidence documents (ADR-0139 D3):
// the D12 paired performance comparison (docs/release/1209-perf-evidence.json) and the
// editor release bundle evidence (docs/release/1209-bundle-evidence.json).
//
// The measurement itself is Linux-authoritative. On Linux this script provisions two clean
// checkouts (pinned baseline + current HEAD), runs the official D12 producer, refreshes the
// bundle evidence from a fresh production build, validates everything with the independent
// checker, and copies the two documents back into the invoking repository. On other hosts it
// fails closed with the exact container invocation (documented in docs/qa/perf-evidence.md).

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { BASELINE_COMMIT } from "./run-d12-perf-comparison.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_FILES = [
  "docs/release/1209-perf-evidence.json",
  "docs/release/1209-bundle-evidence.json",
];

export const CONTAINER_REMEDIATION = [
  "The D12 editor evidence is Linux-authoritative. Run the producer inside the pinned container:",
  '  docker run --rm --privileged --shm-size=2g -v "$PWD":/repo -w /repo node:24.18.0-bookworm \\',
  "    bash -c 'apt-get update -qq && apt-get install -y -qq bubblewrap && \\",
  "      npx --yes --ignore-scripts playwright@1.61.1 install --with-deps chromium && \\",
  "      node scripts/regenerate-d12-evidence.mjs'",
  "(A bind mount installs Linux binaries into node_modules; re-run `npm install` on the host afterwards.)",
].join("\n");

function makeRun(exec) {
  return (command, args, options = {}) =>
    exec(resolveHostExecutable(command), args, { stdio: "inherit", ...options });
}

function makeCapture(exec) {
  return (command, args, options = {}) =>
    exec(resolveHostExecutable(command), args, { encoding: "utf8", ...options }).trim();
}

function makeHasCommit(exec) {
  return (root, commit) => {
    try {
      exec(resolveHostExecutable("git"), ["cat-file", "-e", `${commit}^{commit}`], {
        cwd: root,
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  };
}

function makeOriginUrl(exec) {
  return () =>
    exec(resolveHostExecutable("git"), ["remote", "get-url", "origin"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
}

function resolveDependencies(overrides) {
  const exec = overrides.exec ?? execFileSync;
  return {
    capture: makeCapture(exec),
    copyFile: copyFileSync,
    hasCommit: makeHasCommit(exec),
    log: (message) => console.log(message),
    makeWorkdir: () => mkdtempSync(join(tmpdir(), "keiko-d12-regen-")),
    originUrl: makeOriginUrl(exec),
    platform: process.platform,
    run: makeRun(exec),
    ...overrides,
  };
}

function bundleInputCommand(root, output, candidate) {
  return {
    args: ["scripts/build-d12-bundle-input.mjs", "--root", root, "--output", output],
    cwd: candidate,
  };
}

function comparisonCommand(baseline, candidate, out) {
  return {
    args: [
      "scripts/run-d12-perf-comparison.mjs",
      "--baseline-root",
      baseline,
      "--candidate-root",
      candidate,
      "--baseline-bundle",
      join(out, "baseline-bundle.json"),
      "--candidate-bundle",
      join(out, "candidate-bundle.json"),
      "--artifacts-root",
      join(out, "d12-perf-runs"),
      "--output",
      join(candidate, "docs/release/1209-perf-evidence.json"),
    ],
    cwd: candidate,
  };
}

export function buildRegenerationPlan({ headCommit, workdir }) {
  const baseline = join(workdir, "baseline");
  const candidate = join(workdir, "candidate");
  const out = join(workdir, "out");
  return {
    baseline,
    candidate,
    checkouts: [
      { commit: headCommit, root: candidate },
      { commit: BASELINE_COMMIT, root: baseline },
    ],
    commands: [
      bundleInputCommand(baseline, join(out, "baseline-bundle.json"), candidate),
      bundleInputCommand(candidate, join(out, "candidate-bundle.json"), candidate),
      comparisonCommand(baseline, candidate, out),
      { args: ["scripts/editor-release-evidence.mjs", "--json"], cwd: candidate },
      { args: ["scripts/check-perf-evidence.mjs", "--target", "editor"], cwd: candidate },
      { args: ["scripts/editor-bundle-size.mjs"], cwd: candidate },
    ],
    out,
  };
}

function provisionCheckout(deps, root, commit) {
  deps.run("git", ["clone", "--quiet", "--no-checkout", repoRoot, root]);
  // The clone's origin is the local repoRoot, which may itself be a shallow worktree, so
  // `git fetch --unshallow` from it cannot recover a commit the host lacks (e.g. the pinned
  // baseline). Fetch any missing commit from the host's TRUE origin remote (GitHub) instead;
  // the candidate HEAD is always present locally, so only a shallow-host baseline needs this.
  if (!deps.hasCommit(root, commit)) {
    deps.run("git", ["fetch", "--quiet", deps.originUrl(), commit], { cwd: root });
  }
  deps.run("git", ["checkout", "--quiet", commit], { cwd: root });
}

export function regenerateEvidence(overrides = {}) {
  const deps = resolveDependencies(overrides);
  if (deps.platform !== "linux") {
    return { ok: false, remediation: CONTAINER_REMEDIATION };
  }
  const headCommit = deps.capture("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  const plan = buildRegenerationPlan({ headCommit, workdir: deps.makeWorkdir() });
  deps.log(`Regenerating editor evidence for ${headCommit} (baseline ${BASELINE_COMMIT}).`);
  for (const checkout of plan.checkouts) provisionCheckout(deps, checkout.root, checkout.commit);
  for (const step of plan.commands) deps.run("node", step.args, { cwd: step.cwd });
  for (const file of EVIDENCE_FILES) {
    deps.copyFile(join(plan.candidate, file), join(repoRoot, file));
  }
  deps.log(`Refreshed ${EVIDENCE_FILES.join(" and ")} — review and commit them.`);
  return { ok: true, headCommit };
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = regenerateEvidence();
  if (!result.ok) {
    console.error(result.remediation);
    process.exitCode = 1;
  }
}
