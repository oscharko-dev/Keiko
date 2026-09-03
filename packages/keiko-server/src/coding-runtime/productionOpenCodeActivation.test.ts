import { mkdtempSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import type { ServerLogEvent } from "../observability/index.js";
import { resolveProductionOpenCodeActivation } from "./productionOpenCodeActivation.js";
import type { SecureWorkspaceTextReadPort } from "./secureWorkspaceTextRead.js";
import { stageDevLaneFixture, type DevLaneFixture } from "./devLaneFixture/_support.js";
import type { DevLaneOpenCodeTarget } from "./devLanePortableCodingRuntime.js";

const secureRead: SecureWorkspaceTextReadPort = {
  readText: () => Promise.resolve({ ok: false, reason: "denied" }),
};

const roots: string[] = [];

function devLaneFixture(target?: DevLaneOpenCodeTarget): DevLaneFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-activation-")));
  roots.push(root);
  return stageDevLaneFixture(root, target);
}

interface ActivationOverrides {
  readonly withSecureRead?: boolean;
  readonly withWorkspaceRoot?: boolean;
  readonly stateDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly activity?: ServerLogEvent[];
}

function activationInput(
  env: NodeJS.ProcessEnv,
  overrides: ActivationOverrides = {},
): Parameters<typeof resolveProductionOpenCodeActivation>[0] {
  return {
    env,
    // Deterministic host identity: these cases exercise supported dev lanes on every CI host.
    platform: overrides.platform ?? "darwin",
    arch: overrides.arch ?? "arm64",
    runtimeStateDir: overrides.stateDir ?? join(tmpdir(), "keiko-runtime-state"),
    runtimeEvidence: { observe: () => undefined },
    gatewayReadiness: {
      waitForObservedRequest: () => Promise.resolve(false),
      verifyObserved: () => undefined,
      clear: () => undefined,
    },
    activityLog: {
      write: (event: ServerLogEvent): void => {
        overrides.activity?.push(event);
      },
    },
    ...(overrides.withSecureRead === true ? { secureWorkspaceTextRead: secureRead } : {}),
    ...(overrides.withWorkspaceRoot === false
      ? {}
      : { resolveWorkspaceRoot: () => "/tmp/keiko-workspace" }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("production OpenCode activation", () => {
  it("names platform-unqualified without a discoverable runtime on this platform", () => {
    const result = resolveProductionOpenCodeActivation(
      activationInput(
        { KEIKO_UI_PORT: "1983", KEIKO_CLI_BIN_PATH: "/nonexistent/entry.js" },
        {
          withSecureRead: true,
        },
      ),
    );
    expect(result.ports).toBeUndefined();
    expect(result.unavailableReason).toBe("platform-unqualified");
  });

  it("fails closed with runtime-disabled when the kill switch is set, before discovery", () => {
    const staged = devLaneFixture();
    for (const token of ["1", "true", "on", "YES", "enabled"]) {
      const result = resolveProductionOpenCodeActivation(
        activationInput({
          ...staged.env,
          KEIKO_UI_PORT: "1983",
          KEIKO_CODING_SIDECAR_DISABLED: token,
        }),
      );
      expect(result.ports).toBeUndefined();
      expect(result.unavailableReason).toBe("runtime-disabled");
    }
  });

  it("names loopback-unavailable when the runtime resolves but KEIKO_UI_PORT is invalid", () => {
    const staged = devLaneFixture();
    for (const port of [undefined, "", "0", "-1", "65536", "not-a-port"]) {
      const env = { ...staged.env };
      if (port !== undefined) env.KEIKO_UI_PORT = port;
      const result = resolveProductionOpenCodeActivation(activationInput(env));
      expect(result.ports).toBeUndefined();
      expect(result.unavailableReason).toBe("loopback-unavailable");
    }
  });

  it("maps dev-lane structural refusals onto the content-free dev-lane-refused reason", () => {
    const staged = devLaneFixture();
    unlinkSync(join(staged.root, "tsconfig.packages.json"));
    const result = resolveProductionOpenCodeActivation(
      activationInput({ ...staged.env, KEIKO_UI_PORT: "1983" }),
    );
    expect(result.unavailableReason).toBe("dev-lane-refused");
  });

  it("surfaces precise payload reasons from dev-lane discovery", () => {
    const staged = devLaneFixture();
    unlinkSync(staged.paths.executable);
    const result = resolveProductionOpenCodeActivation(
      activationInput({ ...staged.env, KEIKO_UI_PORT: "1983" }),
    );
    expect(result.unavailableReason).toBe("payload-missing");
  });

  it("records body-free dev-lane refusal evidence", () => {
    const staged = devLaneFixture();
    const activity: ServerLogEvent[] = [];
    unlinkSync(staged.paths.executable);

    const result = resolveProductionOpenCodeActivation(
      activationInput({ ...staged.env, KEIKO_UI_PORT: "1983" }, { activity }),
    );

    expect(result.unavailableReason).toBe("payload-missing");
    expect(activity).toEqual([
      {
        category: "process",
        op: "coding-runtime.dev-lane.refused",
        correlationId: UNKNOWN_CORRELATION_ID,
        extra: { lane: "dev-checkout", reason: "payload-missing" },
      },
    ]);
  });

  it("names secure-read-unavailable when workspace-root resolution is not composed", () => {
    const staged = devLaneFixture();
    const result = resolveProductionOpenCodeActivation(
      activationInput({ ...staged.env, KEIKO_UI_PORT: "1983" }, { withWorkspaceRoot: false }),
    );
    expect(result.ports).toBeUndefined();
    expect(result.unavailableReason).toBe("secure-read-unavailable");
  });

  it("activates the staged dev lane through production discovery with all prerequisites", () => {
    const staged = devLaneFixture();
    const stateDir = join(staged.root, "runtime-state");
    const result = resolveProductionOpenCodeActivation(
      activationInput({ ...staged.env, KEIKO_UI_PORT: "1983" }, { stateDir }),
    );
    expect(result.unavailableReason).toBeUndefined();
    expect(result.ports).toBeDefined();
    expect(result.ports?.backend).toBeDefined();
    expect(result.ports?.secureWorkspaceTextRead).toBeDefined();
    expect(result.ports?.editorAgentClient).toBeDefined();
  });

  it("activates the staged Windows dev lane through the production composition", () => {
    const staged = devLaneFixture("windows-x64");
    const stateDir = join(staged.root, "runtime-state");
    const activity: ServerLogEvent[] = [];
    const result = resolveProductionOpenCodeActivation(
      activationInput(
        { ...staged.env, KEIKO_UI_PORT: "1983" },
        { platform: "win32", arch: "x64", stateDir, activity },
      ),
    );

    expect(result.unavailableReason).toBeUndefined();
    expect(result.ports?.backend).toBeDefined();
    expect(result.ports?.secureWorkspaceTextRead).toBeDefined();
    expect(activity).toHaveLength(1);
    const [event] = activity;
    if (event === undefined) throw new Error("dev-lane-activation-log-missing");
    expect(event).toMatchObject({
      category: "process",
      op: "coding-runtime.dev-lane.activated",
      correlationId: UNKNOWN_CORRELATION_ID,
      extra: { lane: "dev-checkout", target: "windows-x64" },
    });
    expect(event.extra?.runtimeSupervisorSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("prefers an injected secure-read port over dev-lane construction", () => {
    const staged = devLaneFixture();
    const result = resolveProductionOpenCodeActivation(
      activationInput({ ...staged.env, KEIKO_UI_PORT: "1983" }, { withSecureRead: true }),
    );
    expect(result.ports?.secureWorkspaceTextRead).toBe(secureRead);
  });
});
