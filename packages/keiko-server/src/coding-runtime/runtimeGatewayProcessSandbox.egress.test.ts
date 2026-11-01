// #3897: the native profile's kernel network disposition reaches the wrapper the supervisor spawns
// and the body-free spawned-confinement line, in both directions. A new file rather than an edit
// to the existing suites, which pin the gateway profile.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeGatewayConfinement } from "@oscharko-dev/keiko-sandbox";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import {
  prepareRuntimeGatewayProcessSandbox,
  recordRuntimeGatewayConfinementSpawned,
} from "./runtimeGatewayProcessSandbox.js";
import type { RuntimeSupervisorLaunchRequest } from "./runtimeProcessSupervisor.js";
import { WINDOWS_HOST } from "../symlinkFixture.test-support.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  readonly workspace: string;
  readonly state: string;
  readonly runtime: string;
}

function fixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-native-egress-evidence-")));
  roots.push(root);
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  const runtime = join(root, "runtime");
  for (const directory of [workspace, state, runtime]) mkdirSync(directory);
  chmodSync(state, 0o700);
  return { workspace, state, runtime };
}

function native(
  paths: Fixture,
  egress: "inherited" | "loopback-only" | undefined,
): ReturnType<typeof createRuntimeGatewayConfinement> {
  return createRuntimeGatewayConfinement({
    gatewayUrl: "http://127.0.0.1:1983/api/coding-sidecar/gateway",
    runId: "run-3897-egress",
    treeBindingId: "a".repeat(64),
    envelopeDigest: "b".repeat(64),
    runtimeArtifactDigest: "c".repeat(64),
    modelProfileDigest: "d".repeat(64),
    profile: "keiko-native",
    ...(egress === undefined ? {} : { egress }),
    filesystem: {
      workspaceRoot: paths.workspace,
      workspaceAccess: "read-write",
      privateStateRoot: paths.state,
      runtimeReadRoot: paths.runtime,
    },
  });
}

function request(paths: Fixture): RuntimeSupervisorLaunchRequest {
  return {
    runId: "run-3897-egress",
    recoveryHandle: "c".repeat(32),
    treeBindingId: "a".repeat(64),
    executable: join(paths.runtime, "opencode"),
    args: ["serve"],
    cwd: paths.workspace,
    env: {},
    qualification: {
      platform: "darwin",
      arch: "arm64",
      backend: "macos-app-sandbox",
      releaseReceipt: `sha256:${"b".repeat(64)}`,
    },
    launchProfile: {
      upstreamEditAuthority: false,
      upstreamShellAuthority: false,
      upstreamGitAuthority: false,
      upstreamDeliveryAuthority: false,
      upstreamConnectorAuthority: false,
      upstreamBrowserAuthority: false,
      unrestrictedNetworkAuthority: false,
    },
    runtimeSource: "keiko-sidecar",
    modelSource: "keiko-model-gateway",
    authorityEnvelopeDigest: "b".repeat(64),
    egressPolicy: { kind: "loopback-only", reviewedEgressReceipt: `sha256:${"b".repeat(64)}` },
  };
}

function wrapperProfile(paths: Fixture, policy: ReturnType<typeof native>): string {
  const decision = prepareRuntimeGatewayProcessSandbox({
    request: request(paths),
    executable: join(paths.runtime, "opencode"),
    cwd: paths.workspace,
    runtimeRoots: [paths.runtime],
    policy,
    gitExecutable: undefined,
    availability: {
      bubblewrap: false,
      unshare: false,
      seatbelt: true,
      docker: false,
      podman: false,
    },
    platform: "darwin",
  });
  return decision.args[1] ?? "";
}

// The native filesystem capability describes the POSIX Seatbelt/namespace backends and validates
// its roots with `path.posix` (keiko-sandbox seatbelt-execution-root), so a Windows host's
// drive-letter temp roots can never form a valid native policy; those cases run on POSIX hosts.
const itWithPosixNativeRoots = it.skipIf(WINDOWS_HOST);

describe("native profile egress disposition (#3897)", () => {
  itWithPosixNativeRoots.each([
    ["loopback-only", true],
    [undefined, true],
    ["inherited", false],
  ] as const)("wraps a run with %s egress; kernel network deny is %s", (egress, denied) => {
    const paths = fixture();
    const profile = wrapperProfile(paths, native(paths, egress));
    expect(profile.includes("(deny network*)")).toBe(denied);
    expect(profile.includes('(allow network-outbound (remote ip "localhost:*"))')).toBe(denied);
  });

  itWithPosixNativeRoots.each(["loopback-only", "inherited"] as const)(
    "records the %s disposition on the spawned-confinement line",
    (egress) => {
      const paths = fixture();
      const activityLog = createBufferedServerLogSink();
      recordRuntimeGatewayConfinementSpawned(
        activityLog,
        "run-3897-egress",
        "seatbelt",
        native(paths, egress),
        undefined,
      );
      const event = activityLog.events.find(
        (record) => record.op === "runtime.confinement.spawned",
      );
      if (event === undefined) throw new Error("expected spawned-confinement evidence");
      expect(
        expectActivityLogProof(
          "runtime.confinement.spawned.emitted-line",
          formatActivityLogProofLine(event),
        ),
      ).toMatchObject({
        correlationId: "run-3897-egress",
        profile: "keiko-native",
        childExecutablePolicy: "toolchain-inherited",
        egressDisposition: egress,
      });
    },
  );

  it("records no disposition for the gateway profile, whose network is always the gateway alone", () => {
    const activityLog = createBufferedServerLogSink();
    recordRuntimeGatewayConfinementSpawned(
      activityLog,
      "run-3897-egress",
      "seatbelt",
      createRuntimeGatewayConfinement({
        gatewayUrl: "http://127.0.0.1:1983/api/coding-sidecar/gateway",
        runId: "run-3897-egress",
        treeBindingId: "a".repeat(64),
        envelopeDigest: "b".repeat(64),
        runtimeArtifactDigest: "c".repeat(64),
        modelProfileDigest: "d".repeat(64),
      }),
      undefined,
    );
    const event = activityLog.events.find((record) => record.op === "runtime.confinement.spawned");
    expect(event?.extra).not.toHaveProperty("egressDisposition");
  });
});
