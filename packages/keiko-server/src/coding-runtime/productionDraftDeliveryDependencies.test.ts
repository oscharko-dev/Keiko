import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-contracts";
import { createNodeEvidenceStore } from "@oscharko-dev/keiko-evidence";
import {
  createNodeGitWorktreeAdapter,
  createNodeGitPublishAdapter,
  createNodeGitPullRequestAdapter,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import { resolveGitHubIssue } from "../coding-context/githubIssueResolution.js";
import { githubIssueReaderRepositoryId } from "../coding-context/githubIssueReaderAuthorization.js";
import type { DraftDeliveryRunContext } from "../gitDelivery/draftDeliveryTypes.js";
import { resolveProjectWorkspace } from "../gitDelivery/execution.js";
import type { ServerLogEvent } from "../observability/server-log.js";
import { createInMemoryUiStore } from "../store/index.js";
import { runMigrations } from "../store/schema.js";
import { buildActiveWorkspacePointerStoreOverDatabase } from "../task-workspace/active-store.js";
import { createWorkspaceLifecycleService } from "../task-workspace/lifecycle.js";
import { createWorkspaceMutexRegistry } from "../task-workspace/mutex.js";
import { createWorkspaceProvisioningService } from "../task-workspace/provisioning.js";
import { buildWorkspaceInstanceStoreOverDatabase } from "../task-workspace/store.js";
import { createCodingRuntimeSnapshotStore } from "./codingRuntimeSnapshotStore.js";
import {
  createProductionDraftDeliveryDependencies,
  createProductionJourneyReader,
  type DraftDeliveryCompositionDeps,
} from "./productionDraftDeliveryDependencies.js";

vi.mock("@oscharko-dev/keiko-tools/internal/git-mutation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@oscharko-dev/keiko-tools/internal/git-mutation")>();
  return {
    ...actual,
    createNodeGitPublishAdapter: vi.fn(actual.createNodeGitPublishAdapter),
    createNodeGitPullRequestAdapter: vi.fn(actual.createNodeGitPullRequestAdapter),
  };
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const digest = "a".repeat(64);
const at = "2026-09-05T00:00:00.000Z";
function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  }).trim();
}
function repository(): { scratch: string; root: string } {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "keiko-draft-deps-")));
  cleanups.push(() => {
    rmSync(scratch, { recursive: true, force: true });
  });
  const root = join(scratch, "repository");
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Keiko Fixture");
  git(root, "config", "user.email", "fixture@keiko.example");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "code.txt"), "initial\n");
  git(root, "add", "code.txt");
  git(root, "commit", "-qm", "initial");
  git(root, "remote", "add", "origin", "https://github.com/owner/repo.git");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  return { scratch, root };
}
interface FixtureServices {
  db: DatabaseSync;
  env: NodeJS.ProcessEnv;
  evidenceStore: ReturnType<typeof createNodeEvidenceStore>;
  managedRoot: string;
  provisioning: ReturnType<typeof createWorkspaceProvisioningService>;
  lifecycle: ReturnType<typeof createWorkspaceLifecycleService>;
}
function services(scratch: string): FixtureServices {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  cleanups.push(() => {
    db.close();
  });
  const env = { PATH: process.env.PATH ?? "", HOME: scratch, XDG_CONFIG_HOME: scratch };
  const common = {
    store: buildWorkspaceInstanceStoreOverDatabase(db),
    activePointerStore: buildActiveWorkspacePointerStoreOverDatabase(db),
    evidenceStore: createNodeEvidenceStore(join(scratch, "evidence")),
    managedRoot: join(scratch, "task-workspaces"),
    createAdapter: (workspace: WorkspaceInfo): ReturnType<typeof createNodeGitWorktreeAdapter> =>
      createNodeGitWorktreeAdapter({ workspace, processEnv: env }),
    redactString: (value: string): string => value,
    now: Date.now,
    newId: (() => {
      let id = 0;
      return (): string => `fixture-${String(id++)}`;
    })(),
    mutex: createWorkspaceMutexRegistry(),
  };
  const provisioning = createWorkspaceProvisioningService(common);
  const lifecycle = createWorkspaceLifecycleService({ ...common, provisioning });
  return {
    db,
    env,
    evidenceStore: common.evidenceStore,
    managedRoot: common.managedRoot,
    provisioning,
    lifecycle,
  };
}
interface Fixture {
  scratch: string;
  root: string;
  service: FixtureServices;
  store: ReturnType<typeof createInMemoryUiStore>;
  object: {
    id: string;
    nodeId: string;
    state: string;
    isPullRequest: boolean;
    title: string;
    body: string;
    comments: number;
    url: string;
  };
  readJson: Mock<(argv: readonly string[]) => Promise<unknown>>;
  events: ServerLogEvent[];
  deps: DraftDeliveryCompositionDeps;
  snapshots: ReturnType<typeof createCodingRuntimeSnapshotStore>;
  context: DraftDeliveryRunContext;
  abort: AbortController;
  stillAuthorized: Mock<() => boolean>;
  factory: NonNullable<ReturnType<typeof createProductionDraftDeliveryDependencies>>;
}
async function fixture(): Promise<Fixture> {
  const { scratch, root } = repository();
  const service = services(scratch);
  const store = createInMemoryUiStore();
  cleanups.push(() => {
    store.close();
  });
  store.createProject(root, "fixture");
  const repositoryId = githubIssueReaderRepositoryId(root);
  if (repositoryId === undefined) throw new Error("Fixture repository required");
  store.updateGitHubIssueReaderAuthorization(repositoryId, true, 0);
  const object = {
    id: "123",
    nodeId: "I_fixture42",
    state: "open",
    isPullRequest: false,
    title: "Private issue title",
    body: "Private issue body",
    comments: 0,
    url: "https://github.com/owner/repo/issues/42",
  };
  const readJson = vi.fn((argv: readonly string[]): Promise<unknown> =>
    Promise.resolve(argv[1]?.includes("comments?") ? [] : object),
  );
  const events: ServerLogEvent[] = [];
  const deps: DraftDeliveryCompositionDeps = {
    store,
    env: service.env,
    evidenceStore: service.evidenceStore,
    redactor: (value): unknown => value,
    managedTaskWorkspaceRoot: service.managedRoot,
    workspaceProvisioning: service.provisioning,
    workspaceLifecycle: service.lifecycle,
    codingContextGitHubPort: { readJson },
    activityLog: {
      write: (event): void => {
        events.push(event);
      },
    },
  };
  const accepted = await resolveGitHubIssue(deps, {
    repositoryRoot: root,
    issueRef: "#42",
    correlationId: "accept-42",
  });
  if (!accepted.ok) throw new Error(`Fixture issue failed: ${accepted.failure}`);
  const { instance } = await service.provisioning.provision({
    repositoryRequestPath: root,
    taskId: "task-42",
    baseBranch: "main",
    requestedBy: "fixture",
  });
  await service.lifecycle.setActive({
    workspaceId: instance.workspaceId,
    requestedBy: "fixture",
    acquireLock: false,
  });
  const workspace = resolveProjectWorkspace(deps, instance.managedWorktreePath);
  if (workspace === undefined) throw new Error("Fixture managed workspace required");
  const snapshots = createCodingRuntimeSnapshotStore(service.db);
  snapshots.create({
    schemaVersion: "1",
    runId: "run-42",
    state: "running",
    revision: 0,
    requestedMode: "governed-assist",
    runtimeSource: "keiko-sidecar",
    modelSource: "keiko-model-gateway",
    createdAt: at,
    updatedAt: at,
    taskDigest: digest,
    workspaceDigest: digest,
    operatorDigest: digest,
    authorityDigest: digest,
    bindingDigest: digest,
    provenanceDigest: digest,
    toolCallCount: 0,
    patchByteCount: 0,
    modelRequestCount: 0,
    issueBinding: accepted.binding,
  });
  const abort = new AbortController();
  const stillAuthorized = vi.fn((): boolean => true);
  const context: DraftDeliveryRunContext = {
    runId: "run-42",
    taskId: instance.taskId,
    workspaceId: instance.workspaceId,
    envelopeDigest: digest,
    runtimeAuthorityDigest: digest,
    workspaceDigest: digest,
    repositoryDigest: accepted.binding.remoteDigest,
    workspace,
    baseRef: instance.baseBranch,
    headRef: instance.taskBranch,
    correlationId: "delivery-42",
    issueBinding: accepted.binding,
    issueBindingDigest: accepted.binding.bindingDigest,
    signal: abort.signal,
    stillAuthorized,
    buffersClean: (): boolean => true,
  };
  const factory = createProductionDraftDeliveryDependencies(deps, snapshots);
  if (factory === undefined) throw new Error("Fixture production factory required");
  events.length = 0;
  readJson.mockClear();
  return {
    scratch,
    root,
    service,
    store,
    object,
    readJson,
    events,
    deps,
    snapshots,
    context,
    abort,
    stillAuthorized,
    factory,
  };
}

describe("production draft delivery dependencies", () => {
  it("requires durable snapshots and the active-workspace owner", async () => {
    const f = await fixture();
    expect(createProductionDraftDeliveryDependencies(f.deps, undefined)).toBeUndefined();
    expect(
      createProductionDraftDeliveryDependencies(
        { ...f.deps, workspaceLifecycle: undefined },
        f.snapshots,
      ),
    ).toBeUndefined();
  });
  it("resolves the original checkout's accepted issue and records body-free target evidence", async () => {
    const f = await fixture();
    expect(
      f.store.readGitHubIssueReaderAuthorization(
        githubIssueReaderRepositoryId(f.context.workspace.root) ?? "missing",
      ),
    ).toBeUndefined();
    expect(await f.factory.resolveTarget(f.context)).toEqual({
      ok: true,
      repository: "owner/repo",
    });
    expect(f.readJson).toHaveBeenCalledTimes(2);
    expect(f.factory.snapshots).toBe(f.snapshots);
    expect(f.factory.mutationDeps).toBe(f.deps);
    expect(f.factory.execution?.processEnv).toBe(f.deps.env);
    expect(f.events.at(-1)).toMatchObject({
      op: "git.draft-target.resolved",
      correlationId: "delivery-42",
      extra: {
        state: "ready",
        reason: "completed",
        issueBindingDigest: f.context.issueBinding.bindingDigest,
      },
    });
    for (const secret of [
      f.root,
      f.context.workspace.root,
      f.object.title,
      f.object.body,
      f.object.url,
    ])
      expect(JSON.stringify(f.events)).not.toContain(secret);
  });
  it.each([
    "taskId",
    "workspaceId",
    "runId",
    "workspaceDigest",
    "runtimeAuthorityDigest",
    "repositoryDigest",
    "baseRef",
    "headRef",
    "issueBindingDigest",
  ] as const)("refuses changed trusted %s before provider reads", async (key) => {
    const f = await fixture();
    expect(await f.factory.resolveTarget({ ...f.context, [key]: "changed" })).toEqual({
      ok: false,
      reason: "authority-denied",
    });
    expect(f.readJson).not.toHaveBeenCalled();
  });
  it.each([
    { state: "closed" },
    { nodeId: "I_transferred" },
    { body: "Changed revision" },
    { comments: 1 },
    { isPullRequest: true },
  ] as const)("refuses fresh provider issue drift %j", async (change) => {
    const f = await fixture();
    Object.assign(f.object, change);
    expect(await f.factory.resolveTarget(f.context)).toEqual({ ok: false, reason: "issue-drift" });
  });
  it("refuses transferred provenance and a changed default base", async () => {
    const f = await fixture();
    f.object.url = "https://github.com/foreign/repo/issues/42";
    expect(await f.factory.resolveTarget(f.context)).toEqual({ ok: false, reason: "remote-drift" });
    f.object.url = "https://github.com/owner/repo/issues/42";
    git(f.root, "update-ref", "refs/remotes/origin/trunk", "HEAD");
    git(f.root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    expect(await f.factory.resolveTarget(f.context)).toEqual({ ok: false, reason: "issue-drift" });
  });
  it.each(["https://github.com/foreign/repo.git", "https://evil.example/owner/repo.git"])(
    "refuses effective push redirection to %s",
    async (url) => {
      const f = await fixture();
      git(f.root, "config", "remote.origin.pushurl", url);
      expect(await f.factory.resolveTarget(f.context)).toEqual({
        ok: false,
        reason: "remote-drift",
      });
      expect(f.readJson).not.toHaveBeenCalled();
    },
  );
  it.each([
    "https://user@github.com/owner/repo.git",
    "https://github.com:443/owner/repo.git",
    "ssh://other@github.com/owner/repo.git",
    "ssh://git@github.com:22/owner/repo.git",
    "git://github.com/owner/repo.git",
  ])("refuses unsupported push transport %s", async (url) => {
    const f = await fixture();
    git(f.root, "config", "remote.origin.pushurl", url);
    expect(await f.factory.resolveTarget(f.context)).toEqual({ ok: false, reason: "remote-drift" });
  });
  it("cannot create a publish adapter without a fresh target proof for this exact effect context", async () => {
    const f = await fixture();
    expect(() =>
      f.factory.publishSeams(f.context).publishAdapterFactory?.(f.context.workspace),
    ).toThrow("authority-denied");
  });
  it.each([
    "https://github.com/owner/repo",
    "git@github.com:owner/repo",
    "ssh://git@github.com/owner/repo",
  ])("pins the selected supported transport %s only after a complete check", async (url) => {
    const f = await fixture();
    git(f.root, "config", "remote.origin.pushurl", url);
    expect(await f.factory.resolveTarget(f.context)).toEqual({
      ok: true,
      repository: "owner/repo",
    });
    f.factory.publishSeams(f.context).publishAdapterFactory?.(f.context.workspace);
    expect(vi.mocked(createNodeGitPublishAdapter).mock.calls.at(-1)?.[0].verifiedRemoteUrl).toBe(
      `${url}.git`,
    );
    expect(() =>
      f.factory.publishSeams({ ...f.context }).publishAdapterFactory?.(f.context.workspace),
    ).toThrow("authority-denied");
    f.object.body = "Changed accepted content";
    expect(await f.factory.resolveTarget(f.context)).toEqual({ ok: false, reason: "issue-drift" });
    expect(() =>
      f.factory.publishSeams(f.context).publishAdapterFactory?.(f.context.workspace),
    ).toThrow("authority-denied");
  });
  it("rejects duplicate effective push URLs even when both name the accepted repository", async () => {
    const f = await fixture();
    for (let n = 0; n < 2; n += 1)
      git(f.root, "config", "--add", "remote.origin.pushurl", "https://github.com/owner/repo.git");
    expect(await f.factory.resolveTarget(f.context)).toEqual({ ok: false, reason: "remote-drift" });
  });
  it("observes user pushInsteadOf redirects through the actual push reader", async () => {
    const f = await fixture();
    writeFileSync(
      join(f.scratch, ".gitconfig"),
      '[url "https://github.com/foreign/"]\n  pushInsteadOf = https://github.com/owner/\n',
    );
    expect(await f.factory.resolveTarget(f.context)).toEqual({ ok: false, reason: "remote-drift" });
  });
  it("refuses a push destination changed during the upstream issue read", async () => {
    const f = await fixture();
    f.readJson.mockImplementation((argv) => {
      git(f.root, "config", "remote.origin.pushurl", "https://github.com/foreign/repo.git");
      return Promise.resolve(argv[1]?.includes("comments?") ? [] : f.object);
    });
    expect(await f.factory.resolveTarget(f.context)).toEqual({ ok: false, reason: "remote-drift" });
  });
  it.each(["cancelled", "failed", "succeeded", "stopping", "taken-over"] as const)(
    "refuses terminal or terminating runtime state %s",
    async (state) => {
      const f = await fixture();
      f.snapshots.transition(f.context.runId, { state, revision: 1, updatedAt: at });
      expect(await f.factory.resolveTarget(f.context)).toEqual({
        ok: false,
        reason: "authority-denied",
      });
      expect(f.readJson).not.toHaveBeenCalled();
    },
  );
  it("classifies an upstream outage separately from an issue change", async () => {
    const f = await fixture();
    f.readJson.mockRejectedValue(new Error("private provider error"));
    expect(await f.factory.resolveTarget(f.context)).toEqual({
      ok: false,
      reason: "provider-failed",
    });
    expect(f.events.at(-1)).toMatchObject({
      op: "git.draft-target.resolved",
      correlationId: "delivery-42",
      extra: { state: "blocked", reason: "provider-failed" },
    });
    expect(JSON.stringify(f.events)).not.toContain("private provider error");
  });
  it("rejects a frozen binding mutated without changing its accepted digest", async () => {
    const f = await fixture();
    const issueBinding = { ...f.context.issueBinding, contentRevisionDigest: "b".repeat(64) };
    expect(await f.factory.resolveTarget({ ...f.context, issueBinding })).toEqual({
      ok: false,
      reason: "authority-denied",
    });
    expect(f.readJson).not.toHaveBeenCalled();
  });
  it("retains the original checkout grant when that registered project uses a symlink alias", async () => {
    const f = await fixture();
    const alias = join(f.scratch, "registered-alias");
    symlinkSync(f.root, alias, "dir");
    f.store.deleteProject(f.root);
    f.store.createProject(alias, "alias");
    expect(await f.factory.resolveTarget(f.context)).toEqual({
      ok: true,
      repository: "owner/repo",
    });
  });
  it("rejects a checkout removed from the registry", async () => {
    const f = await fixture();
    f.store.deleteProject(f.root);
    expect(await f.factory.resolveTarget(f.context)).toEqual({
      ok: false,
      reason: "authority-denied",
    });
    expect(f.readJson).not.toHaveBeenCalled();
  });
  it("records a classified active-workspace proof failure without exposing its text", async () => {
    const f = await fixture();
    vi.spyOn(f.service.lifecycle, "getActive").mockImplementation(() => {
      throw new Error("private path /private/repository");
    });
    expect(await f.factory.resolveTarget(f.context)).toEqual({
      ok: false,
      reason: "authority-denied",
    });
    expect(f.events.at(-1)).toMatchObject({
      op: "git.draft-target.resolved",
      errorKind: "internal",
      correlationId: "delivery-42",
    });
    expect(JSON.stringify(f.events)).not.toContain("private path");
  });
  it("rechecks a revoked grant after asynchronous issue resolution", async () => {
    const f = await fixture();
    f.readJson.mockImplementation((argv) => {
      f.store.updateGitHubIssueReaderAuthorization(f.context.issueBinding.repositoryId, false, 0);
      return Promise.resolve(argv[1]?.includes("comments?") ? [] : f.object);
    });
    expect(await f.factory.resolveTarget(f.context)).toEqual({
      ok: false,
      reason: "authority-denied",
    });
  });
  it("rechecks a workspace switch during asynchronous issue resolution", async () => {
    const f = await fixture();
    f.readJson.mockImplementation(async (argv) => {
      await f.service.lifecycle.pause({
        workspaceId: f.context.workspaceId,
        requestedBy: "fixture",
      });
      return Promise.resolve(argv[1]?.includes("comments?") ? [] : f.object);
    });
    expect(await f.factory.resolveTarget(f.context)).toEqual({
      ok: false,
      reason: "authority-denied",
    });
  });
  it("refuses missing registration, revocation, and cancellation before reading", async () => {
    const f = await fixture();
    f.stillAuthorized.mockReturnValue(false);
    expect(await f.factory.resolveTarget(f.context)).toEqual({
      ok: false,
      reason: "authority-denied",
    });
    f.stillAuthorized.mockReturnValue(true);
    f.abort.abort();
    expect(await f.factory.resolveTarget(f.context)).toEqual({
      ok: false,
      reason: "authority-denied",
    });
    expect(f.readJson).not.toHaveBeenCalled();
  });
  it("keeps explicit adapter factories bound to the accepted workspace and live authority", async () => {
    const f = await fixture();
    expect(await f.factory.resolveTarget(f.context)).toEqual({
      ok: true,
      repository: "owner/repo",
    });
    f.readJson.mockClear();
    const push = f.factory.publishSeams(f.context);
    const pr = f.factory.pullRequestSeams(f.context);
    expect(push.policyPacks).toBeUndefined();
    expect(pr.policyPacks).toBeUndefined();
    expect(typeof f.factory.inspectionAdapter(f.context)?.readPullRequest).toBe("function");
    expect(typeof push.publishAdapterFactory?.(f.context.workspace).publish).toBe("function");
    expect(typeof pr.prAdapterFactory?.(f.context.workspace).createPullRequest).toBe("function");
    expect(() => push.publishAdapterFactory?.({ ...f.context.workspace, root: f.root })).toThrow(
      "authority-denied",
    );
    expect(() =>
      pr.prAdapterFactory?.({ ...f.context.workspace, ignoreLines: ["hostile"] }),
    ).toThrow("authority-denied");
    const publishArgs = vi.mocked(createNodeGitPublishAdapter).mock.calls.at(-1)?.[0];
    const prArgs = vi.mocked(createNodeGitPullRequestAdapter).mock.calls.at(-1)?.[0];
    if (publishArgs === undefined || prArgs === undefined)
      throw new Error("Fixture adapter deps required");
    expect(publishArgs.verifiedRemoteUrl).toBe("https://github.com/owner/repo.git");
    for (const args of [publishArgs, prArgs]) {
      expect(args.workspace).toBe(f.context.workspace);
      expect(args.processEnv).toBe(f.deps.env);
      expect(args.signal).toBe(f.abort.signal);
      expect(typeof args.onTerminated).toBe("function");
    }
    expect(f.readJson).not.toHaveBeenCalled();
  });
  it("correlates immutable push preparation failures through the existing body-free activity port", async () => {
    const f = await fixture();
    expect((await f.factory.resolveTarget(f.context)).ok).toBe(true);
    f.factory.publishSeams(f.context).publishAdapterFactory?.(f.context.workspace);
    const args = vi.mocked(createNodeGitPublishAdapter).mock.calls.at(-1)?.[0];
    args?.onPreparationFailure?.(
      new Error("private push failure /private/repository https://secret.example/token"),
    );
    expect(f.events.at(-1)).toMatchObject({
      op: "git.draft-push.preparation",
      correlationId: "delivery-42",
      level: "warn",
      errorKind: "internal",
      extra: { runId: "run-42", state: "failed" },
    });
    expect(JSON.stringify(f.events)).not.toContain("private push failure");
    expect(JSON.stringify(f.events)).not.toContain("https://secret.example");
  });
  it("preserves liveness at the gateway and adapter's actual spawn boundary", async () => {
    const f = await fixture();
    expect((await f.factory.resolveTarget(f.context)).ok).toBe(true);
    f.readJson.mockClear();
    const push = f.factory.publishSeams(f.context);
    const pr = f.factory.pullRequestSeams(f.context);
    push.publishAdapterFactory?.(f.context.workspace);
    const publishArgs = vi.mocked(createNodeGitPublishAdapter).mock.calls.at(-1)?.[0];
    expect(push.beforeRemoteDispatch?.()).toBe(true);
    expect(publishArgs?.beforeRemoteDispatch?.()).toBe(true);
    f.stillAuthorized.mockReturnValue(false);
    expect(push.beforeRemoteDispatch?.()).toBe(false);
    expect(publishArgs?.beforeRemoteDispatch?.()).toBe(false);
    expect(pr.beforeRemoteDispatch?.()).toBe(false);
    expect(f.factory.inspectionAdapter(f.context)).toBeUndefined();
    expect(() => push.publishAdapterFactory?.(f.context.workspace)).toThrow("authority-denied");
    expect(f.readJson).not.toHaveBeenCalled();
  });
});

describe("production journey reader (#3389 AC5/AC6)", () => {
  it("builds a read-only reader from the per-checkout grant alone, independent of any run", async () => {
    const f = await fixture();
    const repositoryId = githubIssueReaderRepositoryId(f.root);
    if (repositoryId === undefined) throw new Error("Fixture repository required");
    expect(
      createProductionJourneyReader(f.deps, { repositoryId, correlationId: "journey-1" }),
    ).toBeDefined();
  });
  it("denies for an unregistered or never-granted repository id", async () => {
    const f = await fixture();
    expect(
      createProductionJourneyReader(f.deps, {
        repositoryId: "repo_0000000000000000",
        correlationId: "journey-1",
      }),
    ).toBeUndefined();
  });
  it("denies once the per-checkout grant is revoked, without needing a live run or workspace", async () => {
    const f = await fixture();
    const repositoryId = githubIssueReaderRepositoryId(f.root);
    if (repositoryId === undefined) throw new Error("Fixture repository required");
    f.store.updateGitHubIssueReaderAuthorization(repositoryId, false, 1);
    expect(
      createProductionJourneyReader(f.deps, { repositoryId, correlationId: "journey-1" }),
    ).toBeUndefined();
  });
  it("re-checks the grant per call rather than caching the answer the reader was built with", async () => {
    const f = await fixture();
    const repositoryId = githubIssueReaderRepositoryId(f.root);
    if (repositoryId === undefined) throw new Error("Fixture repository required");
    expect(
      createProductionJourneyReader(f.deps, { repositoryId, correlationId: "journey-1" }),
    ).toBeDefined();
    f.store.updateGitHubIssueReaderAuthorization(repositoryId, false, 1);
    expect(
      createProductionJourneyReader(f.deps, { repositoryId, correlationId: "journey-1" }),
    ).toBeUndefined();
  });
});
