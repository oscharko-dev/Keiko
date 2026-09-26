// Workflow branch-trigger parity gate (audit KEIKO-0955).
//
// ci.yml, codeql.yml, dependency-review.yml and workflow-hygiene.yml each carry a hand-maintained
// list of the branches
// they trigger on. Nothing compared them, and they drifted: codeql.yml was missing nine long-lived
// integration branches and dependency-review.yml ten, so pushes to those branches — and pull
// requests targeting them — ran the full CI matrix while being neither code-scanned nor
// dependency-reviewed. The gap was invisible because every one of those branches eventually merges
// into `dev`, which IS listed everywhere, so the final merge was covered and nothing ever went red.
//
// This gate makes those lists one fact. It compares the SETS, so ordering and comment churn are
// free, and it names the offending file and the exact missing/extra branches on failure.
//
// Deliberately not asserted here: `merge_group` and `schedule` triggers, which ADR-0139 D7 scopes
// to `dev` on purpose, and codeql.yml's `schedule` cron, which has no branch list at all.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// ci.yml is the reference: it is the required check, and its list is the one the protected-branch
// gate's own case statement is kept in step with.
export const REFERENCE = { file: "ci.yml", triggers: ["push", "pull_request"] };
export const FOLLOWERS = [
  { file: "codeql.yml", triggers: ["push", "pull_request"] },
  { file: "dependency-review.yml", triggers: ["pull_request"] },
  // workflow-hygiene.yml carries the same list and is a required context, so it drifts the same
  // way (review finding on #3159). A branch missing here runs no actionlint, no pinned-SHA check,
  // no zizmor and no OSV scan.
  { file: "workflow-hygiene.yml", triggers: ["push", "pull_request"] },
];

/**
 * Extract the `branches:` list belonging to one top-level trigger of a workflow file.
 *
 * Hand-rolled rather than pulled from a YAML library because this gate must run in the same
 * dependency-free way as its siblings in scripts/, and the shape it reads is a fixed two-level
 * indent the repository's own format:check keeps stable.
 *
 * @param {string} source raw workflow YAML
 * @param {string} trigger top-level trigger name, e.g. "push"
 * @returns {string[] | null} the branch patterns, or null when the trigger declares none
 */
export function readBranchList(source, trigger) {
  const lines = source.split("\n");
  const triggerAt = lines.indexOf(`  ${trigger}:`);
  if (triggerAt === -1) return null;

  const branches = [];
  let inBranches = false;
  for (const line of lines.slice(triggerAt + 1)) {
    // A non-indented or two-space-indented line ends this trigger's block.
    if (line.trim() !== "" && !line.startsWith("    ")) break;
    if (line === "    branches:") {
      inBranches = true;
      continue;
    }
    if (!inBranches) continue;
    const entry = /^ {6}- (.+)$/u.exec(line);
    if (entry === null) {
      // Any other four-space key ends the branches list (e.g. a sibling `paths:`).
      if (/^ {4}\S/u.test(line)) break;
      continue;
    }
    branches.push(entry[1].trim().replace(/^"(.*)"$/u, "$1"));
  }
  return inBranches ? branches : null;
}

/**
 * Compare every follower's branch set against the reference's.
 *
 * @param {(file: string) => string} readWorkflow resolves a workflow file's source
 * @returns {{ failures: Array<{file: string, trigger: string, missing: string[], extra: string[]}>,
 *             referenceSize: number }}
 */
export function checkWorkflowBranchParity(readWorkflow) {
  const failures = [];
  const listsFor = ({ file, triggers }) =>
    triggers.map((trigger) => {
      const branches = readBranchList(readWorkflow(file), trigger);
      if (branches === null || branches.length === 0) {
        failures.push({ file, trigger, missing: [], extra: [], noList: true });
        return { trigger, branches: new Set() };
      }
      return { trigger, branches: new Set(branches) };
    });

  const referenceLists = listsFor(REFERENCE);
  const expected = referenceLists[0].branches;

  const compare = (file, { trigger, branches }) => {
    const missing = [...expected].filter((branch) => !branches.has(branch));
    const extra = [...branches].filter((branch) => !expected.has(branch));
    if (missing.length > 0 || extra.length > 0) failures.push({ file, trigger, missing, extra });
  };

  // The reference file must first agree with itself: push and pull_request cannot diverge either.
  for (const list of referenceLists.slice(1)) compare(REFERENCE.file, list);
  for (const follower of FOLLOWERS) {
    for (const list of listsFor(follower)) compare(follower.file, list);
  }

  return { failures, referenceSize: expected.size };
}

/** @returns {number} process exit code */
export function runCli(workflowsDir) {
  const readWorkflow = (file) => readFileSync(join(workflowsDir, file), "utf8");
  const { failures, referenceSize } = checkWorkflowBranchParity(readWorkflow);

  if (failures.length > 0) {
    console.error(
      "check-workflow-branch-parity: FAIL — branch trigger lists have drifted from " +
        `${REFERENCE.file}. A branch missing from codeql.yml is not code-scanned; a branch missing ` +
        "from dependency-review.yml has no dependency diff reviewed.",
    );
    for (const { file, trigger, missing, extra, noList } of failures) {
      console.error(`  ${file} (${trigger}):`);
      if (noList === true) console.error("    - declares no branch list at all");
      for (const branch of missing) console.error(`    - missing: ${branch}`);
      for (const branch of extra) console.error(`    - not in ${REFERENCE.file}: ${branch}`);
    }
    return 1;
  }

  console.log(
    `check-workflow-branch-parity: PASS — ${String(referenceSize)} branches listed identically ` +
      `across ${String(FOLLOWERS.length + 1)} workflows.`,
  );
  return 0;
}

// Run as a CLI unless imported by a test. `pathToFileURL` (not manual `file://` interpolation) is
// required for this comparison to hold on a path containing a space, `%`, `#`, `?`, or a Windows
// drive letter — all of which import.meta.url always encodes canonically.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runCli(join(process.cwd(), ".github", "workflows")));
}
