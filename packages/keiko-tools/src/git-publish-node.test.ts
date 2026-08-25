// Deterministic unit coverage for the Node governed remote publish adapter (Issue #476).
// The integration suite next to it proves the argv and the rejection classification against a real
// local-filesystem remote; this suite pins the ENV the push is spawned with, which no
// filesystem-remote test can observe because a local remote needs no credentials.
//
// A governed `git push` must run under the GOVERNED REMOTE env profile. Under the fully isolated
// default profile the child gets an empty HOME and no SSH agent, so it has no ~/.ssh, no credential
// helper and no ~/.git-credentials — "Publish upstream" cannot authenticate against any real remote.

import { describe, expect, it } from "vitest";
import { makeWorkspace, recordingSpawn } from "./_support.js";
import { createNodeGitPublishAdapter } from "./git-publish-node.js";
import type { GitPublishExecRequest } from "./git-publish-gateway.js";

const PUSH: GitPublishExecRequest = {
  remoteAlias: "origin",
  sourceBranchName: "claude/issue-2843",
  remoteBranchName: "claude/issue-2843",
  setUpstreamTracking: true,
};

const REMOTE_PARENT_ENV: NodeJS.ProcessEnv = {
  PATH: "/usr/bin",
  HOME: "/Users/dev",
  SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
  SSH_AGENT_PID: "4242",
  GH_TOKEN: "gho_publish_lane_token_value",
  LC_ALL: "de_DE.UTF-8",
  AWS_SECRET_ACCESS_KEY: "aws-publish-lane-must-not-see-this",
};

async function publishLaneEnv(): Promise<Record<string, string>> {
  const rec = recordingSpawn();
  const { info } = makeWorkspace();
  const adapter = createNodeGitPublishAdapter({
    workspace: info,
    processEnv: REMOTE_PARENT_ENV,
    now: () => 0,
    spawn: rec.fn,
    resolveExecutable: () => "git",
  });
  const pending = adapter.publish(PUSH);
  rec.child.emit("close", 0, null);
  await pending;
  return rec.calls()[0]?.options.env ?? {};
}

async function publishLaneArgs(): Promise<readonly string[]> {
  const rec = recordingSpawn();
  const { info } = makeWorkspace();
  const adapter = createNodeGitPublishAdapter({
    workspace: info,
    processEnv: REMOTE_PARENT_ENV,
    now: () => 0,
    spawn: rec.fn,
    resolveExecutable: () => "git",
  });
  const pending = adapter.publish(PUSH);
  rec.child.emit("close", 0, null);
  await pending;
  return rec.calls()[0]?.args ?? [];
}

describe("node git publish adapter — the push can authenticate", (): void => {
  it("neutralizes executable repository config before the governed push", async (): Promise<void> => {
    const args = await publishLaneArgs();
    expect(args).toContain("core.fsmonitor=false");
    expect(args).toContain(`core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`);
    expect(args).toContain("credential.helper=");
    expect(args).toContain("protocol.ext.allow=never");
    expect(args.at(-2)).toBe("origin");
  });

  it("forwards the real HOME so the user's SSH configuration is reachable", async () => {
    const env = await publishLaneEnv();
    expect(env.HOME).toBe("/Users/dev");
    expect(env.USERPROFILE).toBe("/Users/dev");
  });

  it("forwards the SSH agent so an agent-held key can sign the transport handshake", async () => {
    const env = await publishLaneEnv();
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/ssh-agent.sock");
    expect(env.SSH_AGENT_PID).toBe("4242");
  });

  it("forwards the GitHub token gh's git credential helper reads over HTTPS", async () => {
    const env = await publishLaneEnv();
    expect(env.GH_TOKEN).toBe("gho_publish_lane_token_value");
  });

  it("pins every interactive credential path closed so a missing credential fails, never hangs", async () => {
    const env = await publishLaneEnv();
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_ASKPASS).toBe("/dev/null");
    expect(env.SSH_ASKPASS_REQUIRE).toBe("never");
    expect(env.GCM_INTERACTIVE).toBe("never");
    expect(env.GIT_SSH_COMMAND).toContain("-oBatchMode=yes");
    expect(env.GIT_SSH_COMMAND).toContain("-oStrictHostKeyChecking=yes");
  });

  it("pins the C locale over an inherited one so the rejection classifier keeps matching", async () => {
    const env = await publishLaneEnv();
    expect(env.LC_ALL).toBe("C");
  });

  it("still copies by name only — an unrelated ambient secret never reaches the push", async () => {
    const env = await publishLaneEnv();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });
});
