// Issue #1388 — containerEngineDetector unit tests. Every probe outcome is exercised through an
// INJECTED fake runCommand returning canned CommandResult / throwing canned errors — NO real Docker.
// The matrix covers the 6 structured states (§5), the kill-switch (NO spawn), and never-throws.

import { describe, expect, it, vi } from "vitest";
import {
  CommandDeniedError,
  CommandTimeoutError,
  type CommandResult,
  type RunCommandDeps,
  type RunCommandInput,
} from "@oscharko-dev/keiko-tools";
import type { ContainerCapabilityResponse } from "@oscharko-dev/keiko-contracts";
import {
  detectContainerEngines,
  KEIKO_CONTAINERS_DISABLED_ENV,
  SUPPORTED_DOCKER_MAJOR,
  type ContainerProbeDeps,
} from "./containerEngineDetector.js";

type FakeRun = (input: RunCommandInput, deps: RunCommandDeps) => Promise<CommandResult>;

function result(overrides: Partial<CommandResult>): CommandResult {
  return {
    command: "docker",
    args: [],
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    truncated: false,
    ...overrides,
  };
}

function makeDeps(run: FakeRun, env: NodeJS.ProcessEnv = {}): ContainerProbeDeps {
  return {
    runCommand: run,
    processEnv: env,
    now: () => 1_700_000_000_000,
    engines: ["docker"],
  };
}

function dockerStatus(
  response: ContainerCapabilityResponse,
): ContainerCapabilityResponse["engines"][number] {
  const status = response.engines.find((entry) => entry.engine === "docker");
  if (status === undefined) {
    throw new Error("docker status missing");
  }
  return status;
}

describe("detectContainerEngines — structured states", () => {
  it("reports missing / executable-not-found when the binary is not on PATH", async () => {
    const run = vi.fn<FakeRun>(() =>
      Promise.reject(new CommandDeniedError("executable not found on PATH: docker", "docker")),
    );
    const response = await detectContainerEngines(makeDeps(run));
    const status = dockerStatus(response);
    expect(status.state).toBe("missing");
    expect(status.unavailableReason).toBe("executable-not-found");
    expect(status.remediationHint).toBeDefined();
    expect(response.anyAvailable).toBe(false);
  });

  it("reports not-running / daemon-not-running on a non-zero version exit", async () => {
    const run: FakeRun = () =>
      Promise.resolve(
        result({ exitCode: 1, stderr: "Cannot connect to the Docker daemon at unix:///var/run" }),
      );
    const status = dockerStatus(await detectContainerEngines(makeDeps(run)));
    expect(status.state).toBe("not-running");
    expect(status.unavailableReason).toBe("daemon-not-running");
  });

  it("reports permission-denied / executable-not-runnable on a permission signature", async () => {
    const run: FakeRun = () =>
      Promise.resolve(
        result({ exitCode: 1, stderr: "Got permission denied while trying to connect" }),
      );
    const status = dockerStatus(await detectContainerEngines(makeDeps(run)));
    expect(status.state).toBe("permission-denied");
    expect(status.unavailableReason).toBe("executable-not-runnable");
  });

  it("reports unsupported / unsupported-version below the version floor", async () => {
    const below = String(SUPPORTED_DOCKER_MAJOR - 1);
    const run: FakeRun = () => Promise.resolve(result({ exitCode: 0, stdout: `${below}.0.1\n` }));
    const status = dockerStatus(await detectContainerEngines(makeDeps(run)));
    expect(status.state).toBe("unsupported");
    expect(status.unavailableReason).toBe("unsupported-version");
    expect(status.version).toBe(`${below}.0.1`);
  });

  it("reports unsupported / probe-failed on an unparseable version", async () => {
    const run: FakeRun = () => Promise.resolve(result({ exitCode: 0, stdout: "not-a-version\n" }));
    const status = dockerStatus(await detectContainerEngines(makeDeps(run)));
    expect(status.state).toBe("unsupported");
    expect(status.unavailableReason).toBe("probe-failed");
  });

  it("reports available when version >= floor and info confirms the daemon", async () => {
    const good = String(SUPPORTED_DOCKER_MAJOR + 4);
    let call = 0;
    const run: FakeRun = (input) => {
      call += 1;
      if (input.args[0] === "version") {
        return Promise.resolve(result({ exitCode: 0, stdout: `${good}.0.7\n` }));
      }
      return Promise.resolve(result({ exitCode: 0, stdout: "[]\n" }));
    };
    const response = await detectContainerEngines(makeDeps(run));
    const status = dockerStatus(response);
    expect(status.state).toBe("available");
    expect(status.unavailableReason).toBeUndefined();
    expect(status.remediationHint).toBeUndefined();
    expect(response.anyAvailable).toBe(true);
    expect(call).toBe(2); // version + info both probed
  });

  it("downgrades to not-running when version is fine but the info daemon check fails", async () => {
    const good = String(SUPPORTED_DOCKER_MAJOR + 4);
    const run: FakeRun = (input) =>
      input.args[0] === "version"
        ? Promise.resolve(result({ exitCode: 0, stdout: `${good}.0.7\n` }))
        : Promise.resolve(result({ exitCode: 1, stderr: "is the docker daemon running?" }));
    const status = dockerStatus(await detectContainerEngines(makeDeps(run)));
    expect(status.state).toBe("not-running");
  });

  it("reports probe-timed-out on a version CommandTimeoutError and never throws", async () => {
    const run: FakeRun = () => Promise.reject(new CommandTimeoutError("timed out", 2_000));
    const status = dockerStatus(await detectContainerEngines(makeDeps(run)));
    expect(status.state).toBe("missing");
    expect(status.unavailableReason).toBe("probe-timed-out");
  });

  it("maps a non-not-found denial to policy-blocked", async () => {
    const run: FakeRun = () =>
      Promise.reject(new CommandDeniedError("subcommand not allowed: docker pull", "docker"));
    const status = dockerStatus(await detectContainerEngines(makeDeps(run)));
    expect(status.state).toBe("policy-blocked");
    expect(status.unavailableReason).toBe("policy-blocked");
  });
});

describe("detectContainerEngines — kill-switch + never-throws", () => {
  it("short-circuits to policy-blocked with NO spawn when KEIKO_CONTAINERS_DISABLED is set", async () => {
    const run = vi.fn<FakeRun>(() => Promise.resolve(result({})));
    const response = await detectContainerEngines(
      makeDeps(run, { [KEIKO_CONTAINERS_DISABLED_ENV]: "1" }),
    );
    const status = dockerStatus(response);
    expect(status.state).toBe("policy-blocked");
    expect(status.unavailableReason).toBe("policy-blocked");
    expect(response.anyAvailable).toBe(false);
    expect(run).not.toHaveBeenCalled(); // NO spawn
  });

  it("resolves a structured ContainerCapabilityResponse on every branch (never throws)", async () => {
    const runners: FakeRun[] = [
      (): Promise<CommandResult> =>
        Promise.reject(new CommandDeniedError("not found on PATH", "docker")),
      (): Promise<CommandResult> => Promise.reject(new Error("boom")),
      (): Promise<CommandResult> => Promise.resolve(result({ exitCode: 0, stdout: "garbage" })),
      (): Promise<CommandResult> => Promise.resolve(result({ exitCode: 137, stderr: "killed" })),
    ];
    for (const run of runners) {
      const response = await detectContainerEngines(makeDeps(run));
      expect(response.schemaVersion).toBe("1");
      expect(Array.isArray(response.engines)).toBe(true);
      expect(response.engines).toHaveLength(1);
      expect(typeof response.engines[0]?.state).toBe("string");
    }
  });

  it("probes both engines by default", async () => {
    const run: FakeRun = () =>
      Promise.reject(new CommandDeniedError("not found on PATH", "docker"));
    const response = await detectContainerEngines({
      runCommand: run,
      processEnv: {},
      now: () => 1,
    });
    expect(response.engines.map((entry) => entry.engine)).toEqual(["docker", "podman"]);
  });
});
