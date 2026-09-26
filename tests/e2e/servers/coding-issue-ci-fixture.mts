import { readFileSync, writeFileSync } from "node:fs";
import type { CommandResult } from "@oscharko-dev/keiko-tools";
import {
  readGitCiFacts,
  type GitCiProviderReader,
  type GitCiFactsResult,
} from "../../../packages/keiko-tools/src/git-ci-facts.js";
import {
  buildGitCiReadArgv,
  GIT_CI_READ_KINDS,
  type GitCiReadKind,
  type GitCiReadTarget,
} from "../../../packages/keiko-tools/src/git-ci-read-argv.js";
import type { GitPullRequestIdentity } from "@oscharko-dev/keiko-contracts/runtime/git-pull-request";
import { ciProviderPath, type CiProviderState } from "../support/coding-issue-ci.js";
import { deliveryProviderState, DELIVERY_REPOSITORY } from "../support/coding-issue-delivery.js";
import type { DeliveryProviderState } from "./coding-issue-delivery-transport.mjs";

function response(value: unknown, exitCode = 0, stderr = ""): CommandResult {
  return {
    command: "gh",
    args: [],
    exitCode,
    signal: null,
    stdout: JSON.stringify(value),
    stderr,
    durationMs: 0,
    timedOut: false,
    truncated: false,
  };
}
function readState(stateDir: string): CiProviderState {
  return JSON.parse(readFileSync(ciProviderPath(stateDir), "utf8")) as CiProviderState;
}
function checks(pr: GitPullRequestIdentity, state: CiProviderState): unknown {
  const common = {
    headSha: pr.headSha,
    appId: 7,
    startedAt: "2026-09-05T00:00:00.000Z",
    completedAt: "2026-09-05T00:00:01.000Z",
    suiteId: 20,
    annotationCount: 0,
  };
  return {
    total: 2,
    values: [
      {
        ...common,
        id: 10,
        name: "required-build",
        ...checkOutcome(state.mode),
      },
      { ...common, id: 11, name: "advisory-analysis", status: "completed", conclusion: "failure" },
    ],
  };
}
function checkOutcome(mode: CiProviderState["mode"]): {
  readonly status: string;
  readonly conclusion: string | null;
} {
  if (mode === "pending") return { status: "in_progress", conclusion: null };
  return { status: "completed", conclusion: mode === "failed" ? "failure" : "success" };
}

function values(
  pr: GitPullRequestIdentity,
  state: CiProviderState,
): Record<GitCiReadKind, unknown> {
  const identity = {
    ...pr,
    ...(state.mode === "wrong-pr" ? { number: pr.number + 1 } : {}),
    ...(state.mode === "wrong-head" ? { headSha: "f".repeat(40) } : {}),
  };
  return {
    "pull-request": {
      identity,
      repositoryId: 41,
      mergeable: true,
      mergeState: "clean",
      merged: false,
    },
    branch: { name: pr.baseRef, protected: true, sha: pr.baseSha },
    "branch-protection": {
      checks: { checks: [{ context: "required-build", app_id: 7 }], contexts: [] },
      reviewCount: 1,
      strict: false,
    },
    "branch-rules": [],
    "check-runs": checks(pr, state),
    "commit-statuses": [],
    "workflow-runs": { total: 0, values: [] },
    reviews: [],
  };
}
function exactTarget(pr: GitPullRequestIdentity, target: GitCiReadTarget): boolean {
  return (
    target.ownerAndRepo === DELIVERY_REPOSITORY &&
    target.prExternalId === String(pr.number) &&
    target.headSha === pr.headSha &&
    target.baseBranchName === pr.baseRef
  );
}
/** Only deterministic upstream JSON is substituted; the production page reader and evaluator run unchanged. */
export function createCiFixtureReader(stateDir: string): GitCiProviderReader {
  return {
    readFacts: async (target): Promise<GitCiFactsResult> => {
      const state = readState(stateDir);
      const provider = JSON.parse(
        readFileSync(deliveryProviderState(stateDir), "utf8"),
      ) as DeliveryProviderState;
      const pr = provider.pullRequests.find(
        (candidate) => String(candidate.number) === target.prExternalId,
      );
      if (pr === undefined || !exactTarget(pr, target)) {
        writeFileSync(
          ciProviderPath(stateDir),
          JSON.stringify({ ...state, rejectedTargets: state.rejectedTargets + 1 }),
        );
        throw new Error("ci-fixture-target-denied");
      }
      writeFileSync(ciProviderPath(stateDir), JSON.stringify({ ...state, reads: state.reads + 1 }));
      const payloads = values(pr, state);
      return readGitCiFacts({
        target,
        run: (argv): Promise<CommandResult> => {
          const kind = GIT_CI_READ_KINDS.find(
            (candidate) =>
              JSON.stringify(buildGitCiReadArgv(candidate, target, 1)) === JSON.stringify(argv),
          );
          if (kind === undefined)
            return Promise.resolve(response(null, 73, "fixture-target-denied"));
          if (kind === "branch-protection" && state.mode === "visibility-unknown")
            return Promise.resolve(response(null, 1, "gh: Not Found (HTTP 404)"));
          return Promise.resolve(response(payloads[kind]));
        },
      });
    },
  };
}
