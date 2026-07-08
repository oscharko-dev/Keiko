// Deterministic unit coverage for the Node governed GitHub pull request adapter (Issue #477) —
// AC1/AC4/AC5. Uses a scripted fake spawn so the success, GitHub-error-classification, and draft-toggle
// branches (PATCH → node-id GET → GraphQL mutation) are exercised without a real `gh` process, and
// asserts that the EXACT governed `gh api` argv reaches the spawn boundary — there is no path to an
// arbitrary command.

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { describe, expect, it } from "vitest";
import { makeFakeChild, makeWorkspace } from "./_support.js";
import { createNodeGitPullRequestAdapter } from "./git-pr-node.js";
import type { HomeProvider, SpawnFn } from "./exec.js";
import type {
  GitPrCreateExecRequest,
  GitPrUpdateExecRequest,
  GitPullRequestAdapter,
} from "./git-pr-gateway.js";

const FAKE_HOME: HomeProvider = { make: () => "/tmp/keiko-fake-home", cleanup: () => undefined };

interface SpawnStep {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exit?: number;
  readonly throwError?: boolean;
}

interface ScriptedSpawn {
  readonly fn: SpawnFn;
  readonly calls: () => readonly { command: string; args: readonly string[] }[];
}

// A spawn that returns a FRESH fake child per invocation, each pre-loaded with scripted stdout/exit and
// fired on the next tick (after runCommand attaches its listeners). Handles the multi-call draft-toggle
// chain deterministically.
function scriptedSpawn(steps: readonly SpawnStep[]): ScriptedSpawn {
  let i = 0;
  const calls: { command: string; args: readonly string[] }[] = [];
  const fn: SpawnFn = (command, args, _options: SpawnOptions): ChildProcess => {
    calls.push({ command, args: [...args] });
    const step = steps[i] ?? {};
    i += 1;
    const child = makeFakeChild();
    setImmediate(() => {
      if (step.throwError === true) {
        child.emit("error", new Error("spawn failed"));
        return;
      }
      if (step.stdout !== undefined) child.stdout.emit("data", Buffer.from(step.stdout));
      if (step.stderr !== undefined) child.stderr.emit("data", Buffer.from(step.stderr));
      child.emit("close", step.exit ?? 0, null);
    });
    return child as unknown as ChildProcess;
  };
  return { fn, calls: () => calls };
}

function makeAdapter(spawn: ScriptedSpawn): GitPullRequestAdapter {
  const { info } = makeWorkspace();
  return createNodeGitPullRequestAdapter({
    workspace: info,
    processEnv: { PATH: "/usr/bin" },
    now: () => 0,
    spawn: spawn.fn,
    home: FAKE_HOME,
    resolveExecutable: () => "gh",
  });
}

const CREATE: GitPrCreateExecRequest = {
  ownerAndRepo: "oscharko-dev/Keiko",
  headBranchName: "claude/issue-477-x",
  baseBranchName: "dev",
  title: "feat: governed pr",
  body: "body",
  isDraft: false,
};

function updateReq(over: Partial<GitPrUpdateExecRequest> = {}): GitPrUpdateExecRequest {
  return {
    ownerAndRepo: "oscharko-dev/Keiko",
    prExternalId: "1499",
    baseBranchName: "dev",
    title: "feat: updated",
    body: "updated body",
    convertToDraft: false,
    convertFromDraft: false,
    ...over,
  };
}

describe("node PR adapter — createPullRequest", () => {
  it("spawns the governed `gh api POST /pulls --jq .number` and returns the provider PR number", async () => {
    const spawn = scriptedSpawn([{ stdout: "1499\n", exit: 0 }]);
    const result = await makeAdapter(spawn).createPullRequest(CREATE);
    expect(result.outcome).toBe("succeeded");
    expect(result.createdPrExternalId).toBe("1499");
    const call = spawn.calls()[0];
    expect(call?.command).toBe("gh");
    expect(call?.args.slice(0, 4)).toEqual([
      "api",
      "--method",
      "POST",
      "/repos/oscharko-dev/Keiko/pulls",
    ]);
    expect(call?.args).toContain("--jq");
  });

  it("classifies a GitHub permission error from a non-zero exit", async () => {
    const spawn = scriptedSpawn([{ stderr: "gh: HTTP 403: Resource not accessible", exit: 1 }]);
    const result = await makeAdapter(spawn).createPullRequest(CREATE);
    expect(result.outcome).toBe("failed");
    expect(result.rejectionReason).toBe("permission-denied");
    expect(result.errorCode).toBe("provider-rejected");
  });

  it("classifies a validation error from a non-zero exit", async () => {
    const spawn = scriptedSpawn([
      { stderr: "gh: Validation Failed (HTTP 422): no commits between dev and head", exit: 1 },
    ]);
    const result = await makeAdapter(spawn).createPullRequest(CREATE);
    expect(result.outcome).toBe("failed");
    expect(result.rejectionReason).toBe("validation-error");
  });

  it("maps a thrown spawn to an internal-error failure", async () => {
    const spawn = scriptedSpawn([{ throwError: true }]);
    const result = await makeAdapter(spawn).createPullRequest(CREATE);
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe("internal-error");
  });

  it("rejects an invalid owner/repo before any spawn", async () => {
    const spawn = scriptedSpawn([{ exit: 0 }]);
    const result = await makeAdapter(spawn).createPullRequest({
      ...CREATE,
      ownerAndRepo: "noslash",
    });
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe("internal-error");
    expect(spawn.calls()).toHaveLength(0);
  });
});

describe("node PR adapter — updatePullRequest", () => {
  it("runs a single PATCH when no draft transition is requested", async () => {
    const spawn = scriptedSpawn([{ exit: 0 }]);
    const result = await makeAdapter(spawn).updatePullRequest(updateReq());
    expect(result.outcome).toBe("succeeded");
    expect(result.createdPrExternalId).toBe("1499");
    expect(spawn.calls()).toHaveLength(1);
    expect(spawn.calls()[0]?.args.slice(0, 4)).toEqual([
      "api",
      "--method",
      "PATCH",
      "/repos/oscharko-dev/Keiko/pulls/1499",
    ]);
  });

  it("performs the mark-ready GraphQL transition: PATCH → node-id GET → mutation", async () => {
    const spawn = scriptedSpawn([
      { exit: 0 }, // PATCH
      { stdout: "PR_kwDO123\n", exit: 0 }, // node-id GET
      { exit: 0 }, // graphql mutation
    ]);
    const result = await makeAdapter(spawn).updatePullRequest(
      updateReq({ convertFromDraft: true }),
    );
    expect(result.outcome).toBe("succeeded");
    expect(spawn.calls()).toHaveLength(3);
    const mutation = spawn.calls()[2];
    expect(mutation?.args[0]).toBe("api");
    expect(mutation?.args[1]).toBe("graphql");
    expect(mutation?.args.some((a) => a.includes("markPullRequestReadyForReview"))).toBe(true);
  });

  it("performs the convert-to-draft GraphQL transition", async () => {
    const spawn = scriptedSpawn([{ exit: 0 }, { stdout: "PR_kwDO123\n", exit: 0 }, { exit: 0 }]);
    const result = await makeAdapter(spawn).updatePullRequest(updateReq({ convertToDraft: true }));
    expect(result.outcome).toBe("succeeded");
    expect(spawn.calls()[2]?.args.some((a) => a.includes("convertPullRequestToDraft"))).toBe(true);
  });

  it("fails the update when the node-id lookup is rejected", async () => {
    const spawn = scriptedSpawn([
      { exit: 0 }, // PATCH succeeds
      { stderr: "gh: Not Found (HTTP 404)", exit: 1 }, // node-id GET fails
    ]);
    const result = await makeAdapter(spawn).updatePullRequest(
      updateReq({ convertFromDraft: true }),
    );
    expect(result.outcome).toBe("failed");
    expect(result.rejectionReason).toBe("not-found");
    expect(spawn.calls()).toHaveLength(2);
  });

  it("fails the update when the GraphQL draft mutation is rejected", async () => {
    const spawn = scriptedSpawn([
      { exit: 0 }, // PATCH
      { stdout: "PR_kwDO123\n", exit: 0 }, // node-id GET
      { stderr: "gh: HTTP 422: Unprocessable", exit: 1 }, // graphql mutation fails
    ]);
    const result = await makeAdapter(spawn).updatePullRequest(updateReq({ convertToDraft: true }));
    expect(result.outcome).toBe("failed");
    expect(result.rejectionReason).toBe("validation-error");
    expect(spawn.calls()).toHaveLength(3);
  });
});

describe("node PR adapter — output parsing edge cases", () => {
  it("fails the create when exit is 0 but stdout is not a PR number", async () => {
    // A "created" PR the caller cannot reference is a contract breach, not a success: `--jq
    // .number` emits `null` when the response shape is unexpected, and the UI would render a
    // successful outcome pointing at nothing.
    const spawn = scriptedSpawn([{ stdout: "not-a-number\n", exit: 0 }]);
    const result = await makeAdapter(spawn).createPullRequest(CREATE);
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe("internal-error");
    expect(result.createdPrExternalId).toBeUndefined();
  });

  it("fails the create when the response number is jq null", async () => {
    const spawn = scriptedSpawn([{ stdout: "null\n", exit: 0 }]);
    const result = await makeAdapter(spawn).createPullRequest(CREATE);
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe("internal-error");
  });

  it("fails the draft transition when the node id is malformed", async () => {
    const spawn = scriptedSpawn([
      { exit: 0 }, // PATCH
      { stdout: "not a node id!\n", exit: 0 }, // node-id GET returns a malformed id
    ]);
    const result = await makeAdapter(spawn).updatePullRequest(
      updateReq({ convertFromDraft: true }),
    );
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe("internal-error");
  });
});
