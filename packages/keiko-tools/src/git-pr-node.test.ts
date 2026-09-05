// Deterministic unit coverage for the Node governed GitHub pull request adapter (Issue #477) —
// AC1/AC4/AC5. Uses a scripted fake spawn so the success, GitHub-error-classification, and draft-toggle
// branches (PATCH → node-id GET → GraphQL mutation) are exercised without a real `gh` process, and
// asserts that the EXACT governed `gh api` argv reaches the spawn boundary — there is no path to an
// arbitrary command.

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { describe, expect, it } from "vitest";
import { makeFakeChild, makeWorkspace, recordingSpawn } from "./_support.js";
import { createNodeGitPullRequestAdapter } from "./git-pr-node.js";
import type { HomeProvider, SpawnFn } from "./exec.js";
import type { GitPrCreateExecRequest, GitPrUpdateExecRequest } from "./git-pr-gateway.js";

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

function makeAdapter(spawn: ScriptedSpawn): ReturnType<typeof createNodeGitPullRequestAdapter> {
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

const PR_IDENTITY = {
  number: 1499,
  externalId: "PR_kwDO123",
  url: "https://github.com/oscharko-dev/Keiko/pull/1499",
  repository: "oscharko-dev/Keiko",
  headRepository: "oscharko-dev/Keiko",
  headRef: CREATE.headBranchName,
  headSha: "a".repeat(40),
  baseRef: "dev",
  baseSha: "b".repeat(40),
  state: "open",
  isDraft: true,
} as const;

describe("node PR adapter — canonical reconciliation reads", () => {
  it("reads the complete body-free provider identity by number", async () => {
    const spawn = scriptedSpawn([{ stdout: JSON.stringify(PR_IDENTITY) }]);

    const result = await makeAdapter(spawn).readPullRequest({
      ownerAndRepo: CREATE.ownerAndRepo,
      prExternalId: "1499",
    });

    expect(result).toEqual({ ok: true, value: PR_IDENTITY });
    expect(spawn.calls()[0]?.args).toContain("/repos/oscharko-dev/Keiko/pulls/1499");
    expect(spawn.calls()[0]?.args).toContain("github.com");
  });

  it("reads all-state head matches without pagination or body fields", async () => {
    const spawn = scriptedSpawn([{ stdout: JSON.stringify([PR_IDENTITY]) }]);

    const result = await makeAdapter(spawn).findPullRequestsByHead({
      ownerAndRepo: CREATE.ownerAndRepo,
      headBranchName: CREATE.headBranchName,
    });

    expect(result).toEqual({ ok: true, value: [PR_IDENTITY] });
    const args = spawn.calls()[0]?.args ?? [];
    expect(args.some((arg) => arg.includes("state=all") && arg.includes("per_page=2"))).toBe(true);
    expect(args).not.toContain("--paginate");
    expect(args.at(-1)).not.toMatch(/title|body|user|email/u);
  });

  it.each([
    { number: 0 },
    { number: 1.1 },
    { number: 10 ** 10 },
    { number: 1500 },
    { externalId: "" },
    { externalId: "x".repeat(256) },
    { externalId: "not a node id" },
    { url: "https://github.com.evil.test/oscharko-dev/Keiko/pull/1499" },
    { url: "https://github.com/oscharko-dev/Keiko/pull/1499?token=value" },
    { repository: "elsewhere/project" },
    { headRepository: null },
    { headRepository: "owner/../user" },
    { headRef: "HEAD^" },
    { baseRef: "refs/tags/dev" },
    { headSha: "a".repeat(7) },
    { baseSha: "b".repeat(41) },
    { state: "merged" },
    { isDraft: "true" },
    { body: "unexpected body must not leave the adapter" },
  ])("refuses an invalid or mismatched remote identity %j", async (overrides) => {
    const spawn = scriptedSpawn([{ stdout: JSON.stringify({ ...PR_IDENTITY, ...overrides }) }]);
    const result = await makeAdapter(spawn).readPullRequest({
      ownerAndRepo: CREATE.ownerAndRepo,
      prExternalId: "1499",
    });
    expect(result).toEqual({ ok: false, reason: "invalid-response" });
  });

  it.each([
    { value: null },
    { value: {} },
    { value: [PR_IDENTITY, PR_IDENTITY, PR_IDENTITY] },
    { value: [{ ...PR_IDENTITY, headRef: "other" }] },
  ])("refuses malformed, over-limit or unrelated head results %j", async ({ value }) => {
    const spawn = scriptedSpawn([{ stdout: JSON.stringify(value) }]);
    const result = await makeAdapter(spawn).findPullRequestsByHead({
      ownerAndRepo: CREATE.ownerAndRepo,
      headBranchName: CREATE.headBranchName,
    });
    expect(result).toEqual({ ok: false, reason: "invalid-response" });
  });

  it.each([
    { value: [] },
    {
      value: [
        PR_IDENTITY,
        { ...PR_IDENTITY, number: 1500, url: PR_IDENTITY.url.replace("1499", "1500") },
      ],
    },
  ])("preserves zero matches and ambiguous multiple matches %j", async ({ value }) => {
    const spawn = scriptedSpawn([{ stdout: JSON.stringify(value) }]);
    const result = await makeAdapter(spawn).findPullRequestsByHead({
      ownerAndRepo: CREATE.ownerAndRepo,
      headBranchName: CREATE.headBranchName,
    });
    expect(result).toEqual({ ok: true, value });
  });

  it("re-reads a remote branch as its exact commit SHA", async () => {
    const value = {
      ref: `refs/heads/${CREATE.headBranchName}`,
      sha: PR_IDENTITY.headSha,
      type: "commit",
    };
    const spawn = scriptedSpawn([{ stdout: JSON.stringify(value) }]);
    const result = await makeAdapter(spawn).readBranchHead({
      ownerAndRepo: CREATE.ownerAndRepo,
      headBranchName: CREATE.headBranchName,
    });
    expect(result).toEqual({ ok: true, value: PR_IDENTITY.headSha });
    expect(spawn.calls()[0]?.args).toContain(
      "/repos/oscharko-dev/Keiko/git/ref/heads/claude%2Fissue-477-x",
    );
  });

  it.each([
    { ref: "refs/tags/other", sha: PR_IDENTITY.headSha, type: "commit" },
    { ref: `refs/heads/${CREATE.headBranchName}`, sha: PR_IDENTITY.headSha, type: "tag" },
    { ref: `refs/heads/${CREATE.headBranchName}`, sha: "HEAD", type: "commit" },
  ])("refuses a remote reference that is not the requested commit branch %j", async (value) => {
    const spawn = scriptedSpawn([{ stdout: JSON.stringify(value) }]);
    const result = await makeAdapter(spawn).readBranchHead({
      ownerAndRepo: CREATE.ownerAndRepo,
      headBranchName: CREATE.headBranchName,
    });
    expect(result).toEqual({ ok: false, reason: "invalid-response" });
  });

  it("classifies remote absence without admitting the provider error body", async () => {
    const spawn = scriptedSpawn([{ stderr: "gh: Not Found (HTTP 404)", exit: 1 }]);
    const result = await makeAdapter(spawn).readBranchHead({
      ownerAndRepo: CREATE.ownerAndRepo,
      headBranchName: CREATE.headBranchName,
    });
    expect(result).toEqual({ ok: false, reason: "not-found" });
  });

  it("rejects invalid operands before spawning", async () => {
    const spawn = scriptedSpawn([]);
    const adapter = makeAdapter(spawn);
    expect(
      await adapter.findPullRequestsByHead({ ownerAndRepo: "owner/..", headBranchName: "main" }),
    ).toEqual({ ok: false, reason: "invalid-response" });
    expect(
      await adapter.readBranchHead({
        ownerAndRepo: CREATE.ownerAndRepo,
        headBranchName: "refs/tags/a",
      }),
    ).toEqual({ ok: false, reason: "invalid-response" });
    expect(
      await adapter.readPullRequest({ ownerAndRepo: CREATE.ownerAndRepo, prExternalId: "1/merge" }),
    ).toEqual({ ok: false, reason: "invalid-response" });
    expect(spawn.calls()).toEqual([]);
  });
});

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
  it("creates an issue-bound PR on canonical GitHub and returns its complete identity", async () => {
    const spawn = scriptedSpawn([{ stdout: JSON.stringify(PR_IDENTITY) }]);
    const result = await makeAdapter(spawn).createPullRequest({
      ...CREATE,
      isDraft: true,
      canonicalGitHubIdentity: true,
    });
    expect(result).toMatchObject({
      outcome: "succeeded",
      createdPrExternalId: "1499",
      createdPrIdentity: PR_IDENTITY,
    });
    expect(spawn.calls()[0]?.args).toContain("--hostname");
    expect(spawn.calls()[0]?.args).toContain("github.com");
  });
  it.each([
    ["legacy number", 1499],
    ["unknown payload field", { ...PR_IDENTITY, body: "untrusted content" }],
    ["wrong repository", { ...PR_IDENTITY, repository: "elsewhere/repo" }],
    ["fork head", { ...PR_IDENTITY, headRepository: "elsewhere/Keiko" }],
    ["wrong head", { ...PR_IDENTITY, headRef: "different-head" }],
    ["wrong base", { ...PR_IDENTITY, baseRef: "main" }],
    ["ready instead of draft", { ...PR_IDENTITY, isDraft: false }],
    ["closed PR", { ...PR_IDENTITY, state: "closed" }],
    ["abbreviated SHA", { ...PR_IDENTITY, headSha: "aaaaaaa" }],
  ])("does not claim canonical create success for %s", async (_name, value) => {
    const spawn = scriptedSpawn([{ stdout: JSON.stringify(value) }]);
    const result = await makeAdapter(spawn).createPullRequest({
      ...CREATE,
      isDraft: true,
      canonicalGitHubIdentity: true,
    });
    expect(result).toMatchObject({ outcome: "failed", errorCode: "internal-error" });
    expect(result.createdPrIdentity).toBeUndefined();
    expect(result.createdPrExternalId).toBeUndefined();
  });

  it("binds response validation to the request captured before asynchronous execution", async () => {
    const request = { ...CREATE, isDraft: true, canonicalGitHubIdentity: true as const };
    const spawn = scriptedSpawn([{ stdout: JSON.stringify(PR_IDENTITY) }]);
    const operation = makeAdapter(spawn).createPullRequest(request);
    request.headBranchName = "changed-during-provider-call";
    request.isDraft = false;
    expect(await operation).toMatchObject({ outcome: "succeeded", createdPrIdentity: PR_IDENTITY });
  });

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

// ─── Governed remote lane ──────────────────────────────────────────────────────────────────────
// Every `gh api` call must run under the GOVERNED REMOTE env profile. Under the fully isolated
// default profile `gh` sees neither GH_TOKEN/GITHUB_TOKEN nor a HOME that contains ~/.config/gh, so
// it cannot authenticate and every governed pull request operation fails.

const REMOTE_PARENT_ENV: NodeJS.ProcessEnv = {
  PATH: "/usr/bin",
  HOME: "/Users/dev",
  GH_TOKEN: "gho_pr_lane_token_value",
  GH_HOST: "github.example.com",
  AWS_SECRET_ACCESS_KEY: "aws-pr-lane-must-not-see-this",
};

async function prLaneEnv(): Promise<Record<string, string>> {
  const rec = recordingSpawn();
  const { info } = makeWorkspace();
  const ad = createNodeGitPullRequestAdapter({
    workspace: info,
    processEnv: REMOTE_PARENT_ENV,
    now: () => 0,
    spawn: rec.fn,
    resolveExecutable: () => "gh",
  });
  const pending = ad.createPullRequest(CREATE);
  rec.child.stdout.emit("data", Buffer.from(JSON.stringify({ number: 7 })));
  rec.child.emit("close", 0, null);
  await pending;
  return rec.calls()[0]?.options.env ?? {};
}

describe("node git pull request adapter — `gh` can authenticate", () => {
  it("forwards the GitHub token and the real HOME so gh resolves its own credentials", async () => {
    const env = await prLaneEnv();
    expect(env.GH_TOKEN).toBe("gho_pr_lane_token_value");
    expect(env.HOME).toBe("/Users/dev");
    expect(env.GH_HOST).toBe("github.example.com");
  });

  it("still copies by name only — an unrelated ambient secret never reaches gh", async () => {
    const env = await prLaneEnv();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });
});

describe("node PR adapter — exact body-only reads and writes", () => {
  it("preserves exact markdown and emits only a canonical body patch", async () => {
    const body = "# Template\r\nCloses #42\r\n";
    const spawn = scriptedSpawn([
      {
        stdout: JSON.stringify({ identity: PR_IDENTITY, body, updatedAt: "2026-09-05T00:00:00Z" }),
      },
      { stdout: "1499" },
    ]);
    const adapter = makeAdapter(spawn);
    expect(
      await adapter.readPullRequestBody({
        ownerAndRepo: CREATE.ownerAndRepo,
        prExternalId: "1499",
      }),
    ).toMatchObject({ ok: true, value: { body } });
    expect(
      await adapter.updatePullRequestBody({
        ownerAndRepo: CREATE.ownerAndRepo,
        prExternalId: "1499",
        body,
      }),
    ).toMatchObject({ outcome: "succeeded" });
    expect(spawn.calls()[1]?.args).toEqual([
      "api",
      "--hostname",
      "github.com",
      "--method",
      "PATCH",
      "/repos/oscharko-dev/Keiko/pulls/1499",
      "-f",
      `body=${body}`,
      "--jq",
      ".number",
    ]);
  });
  it("refuses redacted exact body even when credential replacement has the same byte length", async () => {
    const credential = "1234567890";
    const spawn = scriptedSpawn([
      {
        stdout: JSON.stringify({
          identity: PR_IDENTITY,
          body: credential,
          updatedAt: "2026-09-05T00:00:00Z",
        }),
      },
    ]);
    const { info } = makeWorkspace();
    const adapter = createNodeGitPullRequestAdapter({
      workspace: info,
      processEnv: { PATH: "/usr/bin", GH_TOKEN: credential },
      spawn: spawn.fn,
      home: FAKE_HOME,
      resolveExecutable: () => "gh",
    });
    expect(
      await adapter.readPullRequestBody({
        ownerAndRepo: CREATE.ownerAndRepo,
        prExternalId: "1499",
      }),
    ).toEqual({ ok: false, reason: "invalid-response" });
    expect(spawn.calls()).toHaveLength(1);
  });
  it("refuses forbidden patch fields without spawning", async () => {
    const spawn = scriptedSpawn([]);
    const input = {
      ownerAndRepo: CREATE.ownerAndRepo,
      prExternalId: "1499",
      body: "text",
      title: "bad",
    };
    expect(await makeAdapter(spawn).updatePullRequestBody(input)).toMatchObject({
      outcome: "failed",
    });
    expect(spawn.calls()).toHaveLength(0);
  });
});
