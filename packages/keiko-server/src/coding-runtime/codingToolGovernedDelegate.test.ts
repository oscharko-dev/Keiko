import { describe, expect, it, vi } from "vitest";

import {
  createCodingToolGovernedDelegate,
  type CodingToolActionOf,
  type CodingToolGovernedPorts,
  type GovernedCodingToolPort,
} from "./codingToolGovernedDelegate.js";
import type { CodingToolActionRequest } from "./codingToolIpc.js";
import type { CodingToolMutationGuard } from "./codingToolFacadePorts.js";

function governedPort<
  Kind extends CodingToolActionRequest["action"],
>(): GovernedCodingToolPort<Kind> {
  return {
    execute: vi.fn(
      (
        _request: CodingToolActionOf<Kind>,
        _signal: AbortSignal | undefined,
        mutationGuard: CodingToolMutationGuard,
      ) =>
        Promise.resolve({
          status: mutationGuard.check() ? ("completed" as const) : ("failed" as const),
        }),
    ),
  };
}

function governedPorts(): CodingToolGovernedPorts {
  return {
    repositoryRead: governedPort(),
    editorChangeset: governedPort(),
    commandRunner: governedPort(),
    verificationRunner: governedPort(),
    gitAuthority: governedPort(),
    deliveryAuthority: governedPort(),
    connectorAuthority: governedPort(),
    egressAuthority: governedPort(),
  };
}

const identity = { actionId: "action-1", idempotencyKey: "key-1" } as const;
const liveGuard = { check: (): true => true } as const;
const changeset = {
  patch: "--- a/src/file.ts\n+++ b/src/file.ts\n@@\n-old\n+new\n",
  files: [{ file: "src/file.ts", expectedContentHash: "a".repeat(64) }],
};

describe("CodingToolGovernedDelegate", () => {
  it("dispatches every action to exactly one named existing authority port", async () => {
    const ports = governedPorts();
    const delegate = createCodingToolGovernedDelegate(ports);
    const actions: readonly CodingToolActionRequest[] = [
      { ...identity, action: "read", relativePath: "src/a.ts" },
      { ...identity, action: "edit", changeset },
      { ...identity, action: "command", commandId: "command-1" },
      { ...identity, action: "verification", verifierId: "verification-1" },
      { ...identity, action: "git", operation: "read" },
      { ...identity, action: "delivery", intent: "pull-request" },
      { ...identity, action: "connector", scope: "source-control.read" },
      { ...identity, action: "egress", target: "approved-target" },
    ];

    for (const action of actions) {
      await expect(delegate.execute(action, undefined, liveGuard)).resolves.toEqual({
        outcome: "completed",
      });
    }
    expect(ports.repositoryRead.execute).toHaveBeenCalledTimes(1);
    expect(ports.editorChangeset.execute).toHaveBeenCalledTimes(1);
    expect(ports.commandRunner.execute).toHaveBeenCalledTimes(1);
    expect(ports.verificationRunner.execute).toHaveBeenCalledTimes(1);
    expect(ports.gitAuthority.execute).toHaveBeenCalledTimes(1);
    expect(ports.deliveryAuthority.execute).toHaveBeenCalledTimes(1);
    expect(ports.connectorAuthority.execute).toHaveBeenCalledTimes(1);
    expect(ports.egressAuthority.execute).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch an already-aborted action", async () => {
    const ports = governedPorts();
    const delegate = createCodingToolGovernedDelegate(ports);
    const controller = new AbortController();
    controller.abort();

    await expect(
      delegate.execute(
        { ...identity, action: "command", commandId: "command-1" },
        controller.signal,
        liveGuard,
      ),
    ).resolves.toEqual({ outcome: "failed" });
    expect(ports.editorChangeset.execute).not.toHaveBeenCalled();
    expect(ports.commandRunner.execute).not.toHaveBeenCalled();
    expect(ports.verificationRunner.execute).not.toHaveBeenCalled();
    expect(ports.gitAuthority.execute).not.toHaveBeenCalled();
    expect(ports.deliveryAuthority.execute).not.toHaveBeenCalled();
    expect(ports.connectorAuthority.execute).not.toHaveBeenCalled();
    expect(ports.egressAuthority.execute).not.toHaveBeenCalled();
  });

  it("routes a repository read only to its named secure-read adapter", async () => {
    const ports = governedPorts();
    const repositoryRead = ports.repositoryRead;
    const delegate = createCodingToolGovernedDelegate(ports);

    await expect(
      delegate.execute(
        {
          ...identity,
          action: "read",
          relativePath: "src/a.ts",
        },
        undefined,
        liveGuard,
      ),
    ).resolves.toEqual({ outcome: "completed" });
    expect(repositoryRead.execute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "read", relativePath: "src/a.ts" }),
      undefined,
      liveGuard,
    );
    expect(ports.editorChangeset.execute).not.toHaveBeenCalled();
  });

  it("fails a stop race at the governed port mutation boundary", async () => {
    const ports = governedPorts();
    const delegate = createCodingToolGovernedDelegate(ports);
    let checks = 0;
    const revokedBeforeMutation = {
      check: (): boolean => {
        checks += 1;
        return checks === 1;
      },
    };

    await expect(
      delegate.execute(
        { ...identity, action: "edit", changeset },
        undefined,
        revokedBeforeMutation,
      ),
    ).resolves.toEqual({ outcome: "failed" });
    expect(checks).toBe(2);
  });
});
