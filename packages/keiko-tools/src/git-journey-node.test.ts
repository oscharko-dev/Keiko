import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { makeFakeChild, makeWorkspace } from "./_support.js";
import { createNodeGitJourneyReader, type NodeGitCiReaderDeps } from "./git-merge-node.js";
import type { SpawnFn } from "./exec.js";
import { payload, TARGET } from "./git-journey-test-support.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(afterRespond?: () => void): {
  readonly deps: NodeGitCiReaderDeps;
  readonly calls: string[][];
} {
  const { root, info } = makeWorkspace();
  roots.push(root);
  const calls: string[][] = [];
  const spawn: SpawnFn = (_command, args): ChildProcess => {
    calls.push([...args]);
    const child = makeFakeChild();
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from(JSON.stringify(payload())));
      afterRespond?.();
      child.emit("close", 0, null);
    });
    return child as unknown as ChildProcess;
  };
  return {
    calls,
    deps: {
      workspace: info,
      processEnv: { PATH: "/usr/bin", GH_HOST: "wrong.example" },
      now: () => 0,
      resolveExecutable: () => "gh",
      spawn,
      stillAuthorized: () => true,
    },
  };
}
describe("journey observation through the existing governed Node boundary", () => {
  it("executes two fixed canonical queries and exposes no merge or issue-close action", async () => {
    const f = fixture();
    const reader = createNodeGitJourneyReader(f.deps);
    expect(Object.keys(reader)).toEqual(["readJourney"]);
    expect(await reader.readJourney(TARGET)).toMatchObject({
      status: "observed",
      reviewConversations: { unresolved: 1 },
    });
    expect(f.calls).toHaveLength(2);
    for (const args of f.calls) {
      expect(args.slice(0, 6)).toEqual([
        "api",
        "--hostname",
        "github.com",
        "--method",
        "POST",
        "graphql",
      ]);
      expect(args[7]).toContain("query KeikoJourneyObservation");
      expect(args.join(" ")).not.toMatch(/\b(?:mutation|body|closeIssue|mergePullRequest)\b/u);
    }
  });
  it("denies before spawn when authority is absent and discards late revoked facts", async () => {
    let live = false;
    const f = fixture(() => {
      live = false;
    });
    const reader = createNodeGitJourneyReader({ ...f.deps, stillAuthorized: () => live });
    expect(await reader.readJourney(TARGET)).toMatchObject({
      failure: { reason: "authority-denied" },
    });
    expect(f.calls).toHaveLength(0);
    live = true;
    expect(await reader.readJourney(TARGET)).toMatchObject({
      failure: { reason: "authority-denied" },
    });
    expect(f.calls).toHaveLength(1);
  });
  it("keeps one deadline across both passes and subsequent reads", async () => {
    let now = 0;
    const f = fixture(() => {
      now = 30_001;
    });
    const reader = createNodeGitJourneyReader({ ...f.deps, now: () => now });
    expect(await reader.readJourney(TARGET)).toMatchObject({ failure: { reason: "timeout" } });
    expect(await reader.readJourney(TARGET)).toMatchObject({ failure: { reason: "timeout" } });
    expect(f.calls).toHaveLength(1);
  });
  it("does not spawn after cancellation", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    const reader = createNodeGitJourneyReader({ ...f.deps, signal: controller.signal });
    expect(await reader.readJourney(TARGET)).toMatchObject({ failure: { reason: "cancelled" } });
    expect(f.calls).toHaveLength(0);
  });
});
