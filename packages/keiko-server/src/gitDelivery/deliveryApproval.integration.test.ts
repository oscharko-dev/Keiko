import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitDeliveryIssuedApproval } from "@oscharko-dev/keiko-contracts";
import type {
  GitPrCreateExecRequest,
  GitPrExecResult,
  GitPullRequestAdapter,
} from "@oscharko-dev/keiko-tools";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "../index.js";
import type { RouteContext, RouteResult } from "../routes.js";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import { createInMemoryGitDeliveryApprovalStore } from "./approvalStore.js";
import { createHandleCommitApproval, createHandleCommitExecute } from "./commitRoutes.js";
import { createHandlePrApproval, createHandlePrExecute } from "./prRoutes.js";
import { createHandlePushApproval, createHandlePushExecute } from "./pushRoutes.js";

const COMMIT_APPROVAL = "/api/git-delivery/commit/approval";
const COMMIT_EXECUTE = "/api/git-delivery/commit/execute";
const PUSH_APPROVAL = "/api/git-delivery/push/approval";
const PUSH_EXECUTE = "/api/git-delivery/push/execute";
const PR_APPROVAL = "/api/git-delivery/pr/approval";
const PR_EXECUTE = "/api/git-delivery/pr/execute";

let root: string;
let bareRemote: string;
let store: UiStore;
let projectId: string;

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function ctx(path: string, body: unknown): RouteContext {
  const req = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as IncomingMessage;
  req.method = "POST";
  req.headers = { "content-type": "application/json", "x-keiko-csrf": "1" };
  return {
    req,
    res: {} as ServerResponse,
    params: {},
    url: new URL(`http://127.0.0.1${path}`),
  };
}

function deps(): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
  };
}

function approvalFrom(result: RouteResult): GitDeliveryIssuedApproval["approval"] {
  expect(result.status).toBe(201);
  return (result.body as GitDeliveryIssuedApproval).approval;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-delivery-approval-repo-"));
  bareRemote = mkdtempSync(join(tmpdir(), "keiko-delivery-approval-bare-"));
  git(bareRemote, ["init", "--bare"]);
  git(root, ["init", "-b", "feat/approval-flow"]);
  git(root, ["config", "user.name", "Keiko Test"]);
  git(root, ["config", "user.email", "keiko@example.invalid"]);
  writeFileSync(join(root, "fixture.txt"), "baseline\n", "utf8");
  git(root, ["add", "fixture.txt"]);
  git(root, ["commit", "-m", "chore: baseline"]);
  git(root, ["remote", "add", "origin", bareRemote]);
  git(root, ["push", "-u", "origin", "feat/approval-flow"]);
  writeFileSync(join(root, "fixture.txt"), "baseline\napproved change\n", "utf8");
  git(root, ["add", "fixture.txt"]);
  store = createInMemoryUiStore();
  projectId = store.createProject(root, "approval integration").path;
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(bareRemote, { recursive: true, force: true });
});

describe("separately approved Git delivery", () => {
  it("performs a real commit and push, then binds the exact injected PR effect", async () => {
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const common = { approvalStore };
    const commitRequest = {
      schemaVersion: "1",
      projectId,
      message: "feat: exercise separate delivery approval",
      allowEmpty: false,
    };
    const originalHead = git(root, ["rev-parse", "HEAD"]);
    const commitApproval = approvalFrom(
      await createHandleCommitApproval({ execution: common })(
        ctx(COMMIT_APPROVAL, { ...commitRequest, confirmed: true }),
        deps(),
      ),
    );
    const commitResult = await createHandleCommitExecute({ execution: common })(
      ctx(COMMIT_EXECUTE, { ...commitRequest, approval: commitApproval }),
      deps(),
    );
    expect(commitResult).toMatchObject({ status: 200, body: { status: "succeeded" } });
    const committedHead = git(root, ["rev-parse", "HEAD"]);
    expect(committedHead).not.toBe(originalHead);
    expect(git(root, ["log", "-1", "--pretty=%s"])).toBe(commitRequest.message);

    const replay = await createHandleCommitExecute({ execution: common })(
      ctx(COMMIT_EXECUTE, { ...commitRequest, approval: commitApproval }),
      deps(),
    );
    expect(replay.status).toBe(400);
    expect(git(root, ["rev-parse", "HEAD"])).toBe(committedHead);

    const pushRequest = {
      schemaVersion: "1",
      projectId,
      remoteAlias: "origin",
      remoteBranchName: "feat/approval-flow",
      sourceBranchName: "feat/approval-flow",
      forcePush: false,
      setUpstreamTracking: false,
    };
    const pushApproval = approvalFrom(
      await createHandlePushApproval({ execution: common })(
        ctx(PUSH_APPROVAL, { ...pushRequest, confirmed: true }),
        deps(),
      ),
    );
    const pushResult = await createHandlePushExecute({ execution: common })(
      ctx(PUSH_EXECUTE, { ...pushRequest, approval: pushApproval }),
      deps(),
    );
    expect(pushResult).toMatchObject({ status: 200, body: { status: "succeeded" } });
    expect(git(bareRemote, ["rev-parse", "refs/heads/feat/approval-flow"])).toBe(committedHead);

    const creates: GitPrCreateExecRequest[] = [];
    const adapter: GitPullRequestAdapter = {
      createPullRequest: (request): Promise<GitPrExecResult> => {
        creates.push(request);
        return Promise.resolve({
          schemaVersion: "1",
          outcome: "succeeded",
          durationMs: 1,
          createdPrExternalId: "2258",
        });
      },
      updatePullRequest: () => Promise.reject(new Error("unexpected update")),
    };
    const prExecution = {
      ...common,
      prAdapterFactory: (): GitPullRequestAdapter => adapter,
    };
    const prRequest = {
      schemaVersion: "1",
      projectId,
      kind: "pr-create",
      ownerAndRepo: "oscharko-dev/Keiko",
      headBranchName: "feat/approval-flow",
      baseBranchName: "dev",
      title: "feat: separately approved delivery",
      body: "Exercises the bound pull request provider effect.",
      isDraft: true,
    };
    const prApproval = approvalFrom(
      await createHandlePrApproval({ execution: prExecution })(
        ctx(PR_APPROVAL, { ...prRequest, confirmed: true }),
        deps(),
      ),
    );
    const prResult = await createHandlePrExecute({ execution: prExecution })(
      ctx(PR_EXECUTE, { ...prRequest, approval: prApproval }),
      deps(),
    );
    expect(prResult).toMatchObject({
      status: 200,
      body: { status: "succeeded", createdPrExternalId: "2258" },
    });
    expect(creates).toEqual([
      {
        ownerAndRepo: prRequest.ownerAndRepo,
        headBranchName: prRequest.headBranchName,
        baseBranchName: prRequest.baseBranchName,
        title: prRequest.title,
        body: prRequest.body,
        isDraft: true,
      },
    ]);
  });
});
