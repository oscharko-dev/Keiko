import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { makeFakeChild, makeWorkspace } from "./_support.js";
import { createNodeGitCiReader, type NodeGitCiReaderDeps } from "./git-merge-node.js";
import type { SpawnFn } from "./exec.js";

import { failureFacts } from "./git-ci-failure-context-test-support.js";

const TARGET = {
  ownerAndRepo: "owner/repo",
  prExternalId: "17",
  baseBranchName: "dev",
  headSha: "a".repeat(40),
};
const PR = {
  identity: {
    number: 17,
    externalId: "PR_17",
    url: "https://github.com/owner/repo/pull/17",
    repository: "owner/repo",
    headRepository: "owner/repo",
    headRef: "feature/issue-1",
    headSha: TARGET.headSha,
    baseRef: "dev",
    baseSha: "b".repeat(40),
    state: "open",
    isDraft: true,
  },
  repositoryId: 41,
  mergeable: true,
  mergeState: "clean",
  merged: false,
};
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function content(args: readonly string[]): unknown {
  const endpoint = args[5] ?? "";
  if (endpoint.endsWith("/pulls/17")) return PR;
  if (endpoint.endsWith("/branches/dev"))
    return { name: "dev", protected: true, sha: PR.identity.baseSha };
  if (endpoint.endsWith("/protection")) return { checks: null, reviewCount: 0, strict: false };
  if (endpoint.includes("/check-runs?") || endpoint.includes("/actions/runs?"))
    return { total: 0, values: [] };
  return [];
}
interface Fixture {
  readonly deps: NodeGitCiReaderDeps;
  readonly calls: string[][];
  readonly onTerminated: Mock;
}
function fixture(onRespond?: () => void): Fixture {
  const { root, info } = makeWorkspace();
  roots.push(root);
  const calls: string[][] = [];
  const spawn: SpawnFn = (_command, args): ChildProcess => {
    calls.push([...args]);
    const child = makeFakeChild();
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from(JSON.stringify(content(args))));
      onRespond?.();
      child.emit("close", 0, null);
    });
    return child as unknown as ChildProcess;
  };
  const onTerminated = vi.fn();
  const deps: NodeGitCiReaderDeps = {
    workspace: info,
    processEnv: { PATH: "/usr/bin", GH_HOST: "wrong.example" },
    now: () => 0,
    resolveExecutable: () => "gh",
    spawn,
    onTerminated,
    stillAuthorized: () => true,
  };
  return { deps, calls, onTerminated };
}
describe("CI facts through the existing Node governed command boundary", () => {
  it("retains the original observation deadline when fetching failure details", async () => {
    let now = 0;
    const test = fixture();
    const reader = createNodeGitCiReader({ ...test.deps, now: (): number => now });
    expect((await reader.readFacts(TARGET)).status).toBe("observed");
    const before = test.calls.length;
    now = 30_001;
    expect(await reader.readFailureContext?.(failureFacts())).toMatchObject({
      status: "unavailable",
      failure: { reason: "timeout" },
    });
    expect(test.calls).toHaveLength(before);
  });
  it("rejects a nonfinite initial deadline even if the next clock reading is valid", async () => {
    const test = fixture();
    let reads = 0;
    const result = await createNodeGitCiReader({
      ...test.deps,
      now: () => (reads++ === 0 ? Number.NaN : 0),
    }).readFacts(TARGET);
    expect(result).toMatchObject({ status: "unavailable", failure: { reason: "timeout" } });
    expect(test.calls).toHaveLength(0);
  });
  it("uses only canonical read commands without reporting normal exits as forced terminations", async () => {
    const test = fixture();
    const result = await createNodeGitCiReader(test.deps).readFacts(TARGET);
    expect(result.status).toBe("observed");
    expect(test.calls.length).toBeGreaterThan(5);
    expect(test.onTerminated).not.toHaveBeenCalled();
    for (const args of test.calls)
      expect(args.slice(0, 5)).toEqual(["api", "--hostname", "github.com", "--method", "GET"]);
  });
  it("threads an actual cancellation termination through the existing evidence port", async () => {
    vi.spyOn(process, "kill").mockReturnValue(true);
    const controller = new AbortController();
    const test = fixture(() => {
      controller.abort();
    });
    const result = await createNodeGitCiReader({
      ...test.deps,
      signal: controller.signal,
    }).readFacts(TARGET);
    expect(result).toMatchObject({ status: "unavailable", failure: { reason: "cancelled" } });
    expect(test.onTerminated).toHaveBeenCalledOnce();
    expect(test.onTerminated).toHaveBeenCalledWith(expect.objectContaining({ reason: "abort" }));
  });
  it("denies a missing live authority before any executable starts", async () => {
    const test = fixture();
    const result = await createNodeGitCiReader({
      ...test.deps,
      stillAuthorized: () => false,
    }).readFacts(TARGET);
    expect(result).toMatchObject({
      status: "unavailable",
      failure: { reason: "authority-denied" },
    });
    expect(test.calls).toHaveLength(0);
  });
  it("discards a result if authority expires while the provider responds", async () => {
    let allowed = true;
    const test = fixture(() => {
      allowed = false;
    });
    const result = await createNodeGitCiReader({
      ...test.deps,
      stillAuthorized: () => allowed,
    }).readFacts(TARGET);
    expect(result).toMatchObject({
      status: "unavailable",
      failure: { reason: "authority-denied" },
    });
    expect(test.calls).toHaveLength(1);
  });
  it("applies the whole-observation deadline independently of command timeout", async () => {
    let time = 0;
    const test = fixture(() => {
      time = 30_001;
    });
    const result = await createNodeGitCiReader({
      ...test.deps,
      now: () => time,
    }).readFacts(TARGET);
    expect(result).toMatchObject({ status: "unavailable", failure: { reason: "timeout" } });
    expect(test.calls).toHaveLength(1);
  });
});
