import { describe, expect, it, vi } from "vitest";
import type { ServerLogEvent } from "../observability/server-log.js";
import { redactLogFields } from "../observability/log-redaction.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";

import {
  createCodingToolGovernedDelegate,
  type CodingToolActionOf,
  type CodingToolGovernedPorts,
  type GovernedCodingToolPort,
} from "./codingToolGovernedDelegate.js";
import type { CodingToolActionRequest } from "./codingToolIpc.js";
import type { CodingToolMutationGuard } from "./codingToolFacadePorts.js";
import type { SkillDiscoveryResultV1 } from "@oscharko-dev/keiko-contracts";

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
    repositoryDiscover: governedPort(),
    repositorySearch: governedPort(),
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
  it.each([
    [true, true, true],
    [true, false, false],
    [false, true, false],
  ] as const)(
    "#3417: a delegated read fits only when the run authority (%s) and the repair budget (%s) both hold it",
    async (authorityFits, budgetFits, expected) => {
      const seen: boolean[] = [];
      const ports: CodingToolGovernedPorts = {
        ...governedPorts(),
        skillAuthority: {
          execute: (_request, _signal, guard) => {
            seen.push(guard.canChargeDelegatedRead?.() === true);
            return Promise.resolve({ status: "completed" as const });
          },
        },
      };
      const budget = {
        admitTool: vi.fn(() => ({ check: (): boolean => true, settle: vi.fn() })),
        canChargePrompt: vi.fn(() => true),
        chargePrompt: vi.fn(() => true),
        canChargeDelegatedRead: vi.fn(() => budgetFits),
        observed: vi.fn(),
      };
      const delegate = createCodingToolGovernedDelegate(ports, budget);
      await delegate.execute({ ...identity, action: "skill", skillId: "skl_a@1" }, undefined, {
        check: () => true,
        canChargeDelegatedRead: () => authorityFits,
      });
      expect(seen).toEqual([expected]);
    },
  );

  it("#3417: returns a skill discovery's listing, and fails a discovery no port serves", async () => {
    const skills = {
      schemaVersion: 1,
      catalogDigest: "a".repeat(64),
      skills: [],
    } as unknown as SkillDiscoveryResultV1;
    const ports: CodingToolGovernedPorts = {
      ...governedPorts(),
      skillDiscovery: { execute: () => Promise.resolve({ status: "completed" as const, skills }) },
    };
    const request = { ...identity, action: "skill-discover" as const };
    expect(
      await createCodingToolGovernedDelegate(ports).execute(request, undefined, liveGuard),
    ).toEqual({ outcome: "completed", skills });
    expect(
      await createCodingToolGovernedDelegate(governedPorts()).execute(
        request,
        undefined,
        liveGuard,
      ),
    ).toEqual({ outcome: "failed" });
  });

  it("does not call a handler when the cumulative repair budget rejects admitted work", async () => {
    const ports = governedPorts();
    const budget = {
      admitTool: vi.fn(() => undefined),
      canChargePrompt: vi.fn(() => false),
      chargePrompt: vi.fn(() => false),
      observed: vi.fn(),
    };
    const delegate = createCodingToolGovernedDelegate(ports, budget);
    expect(
      await delegate.execute(
        { ...identity, action: "verification", verifierId: "test" },
        undefined,
        liveGuard,
      ),
    ).toMatchObject({ outcome: "failed", reasonCode: "ci-repair-budget-blocked" });
    expect(ports.verificationRunner.execute).not.toHaveBeenCalled();
    expect(budget.admitTool).toHaveBeenCalledOnce();
  });
  it("tells the model to refresh CI when post-PR work lacks a fresh observation", async () => {
    const ports = governedPorts();
    const budget = {
      admitTool: vi.fn(() => undefined),
      canChargePrompt: vi.fn(() => false),
      chargePrompt: vi.fn(() => false),
      observed: vi.fn(),
      ciObservationRequired: vi.fn(() => true),
    };
    const delegate = createCodingToolGovernedDelegate(ports, budget);

    await expect(
      delegate.execute({ ...identity, action: "edit", changeset }, undefined, liveGuard),
    ).resolves.toEqual({ outcome: "failed", reasonCode: "ci-observation-required" });
    expect(ports.editorChangeset.execute).not.toHaveBeenCalled();
    expect(budget.ciObservationRequired).toHaveBeenCalledOnce();
  });
  it("checks repair liveness at the existing handler boundary and settles the actual outcome once", async () => {
    const settle = vi.fn();
    let allowed = true;
    const verificationRunner: GovernedCodingToolPort<"verification"> = {
      execute: vi.fn(
        (
          _request: CodingToolActionOf<"verification">,
          _signal: AbortSignal | undefined,
          guard: CodingToolMutationGuard,
        ) => {
          allowed = false;
          return Promise.resolve({
            status: guard.check() ? ("completed" as const) : ("failed" as const),
          });
        },
      ),
    };
    const ports = { ...governedPorts(), verificationRunner };
    const budget = {
      admitTool: vi.fn(() => ({ check: (): boolean => allowed, settle })),
      canChargePrompt: vi.fn(() => true),
      chargePrompt: vi.fn(() => true),
      observed: vi.fn(),
    };
    const delegate = createCodingToolGovernedDelegate(ports, budget);
    expect(
      await delegate.execute(
        { ...identity, action: "verification", verifierId: "test" },
        undefined,
        liveGuard,
      ),
    ).toMatchObject({ outcome: "failed" });
    expect(settle).toHaveBeenCalledExactlyOnceWith({ status: "failed" });
  });
  it.each(["repair-expired", "authority-revoked", "cancelled"] as const)(
    "discards completed async payloads after %s without changing the actual settlement",
    async (reason) => {
      let repairLive = true;
      let authorityLive = true;
      const abort = new AbortController();
      const settle = vi.fn();
      const result = {
        status: "completed" as const,
        read: { text: "transient result", totalLines: 1, byteCount: 16, digest: "a".repeat(64) },
      };
      const repositoryRead: GovernedCodingToolPort<"read"> = {
        execute: async (_request, _signal, guard) => {
          expect(guard.check()).toBe(true);
          await Promise.resolve();
          if (reason === "repair-expired") repairLive = false;
          if (reason === "authority-revoked") authorityLive = false;
          if (reason === "cancelled") abort.abort();
          return result;
        },
      };
      const budget = {
        admitTool: vi.fn(() => ({ check: (): boolean => repairLive, settle })),
        canChargePrompt: (): boolean => true,
        chargePrompt: (): boolean => true,
        observed: vi.fn(),
      };
      const events: ServerLogEvent[] = [];
      const delegate = createCodingToolGovernedDelegate(
        { ...governedPorts(), repositoryRead },
        budget,
        {
          write: (event): void => {
            events.push(event);
          },
        },
      );
      const outcome = await delegate.execute(
        { ...identity, action: "read", relativePath: "src.ts" },
        abort.signal,
        { check: (): boolean => authorityLive },
      );
      expect(outcome).toMatchObject({ outcome: "failed" });
      expect(JSON.stringify(outcome)).not.toContain("transient result");
      expect(budget.admitTool).toHaveBeenCalledOnce();
      expect(settle).toHaveBeenCalledExactlyOnceWith(result);
      expect(events).toEqual([
        {
          category: "process",
          op: "coding-runtime.tool-result",
          correlationId: UNKNOWN_CORRELATION_ID,
          extra: { actionKind: "read", state: "discarded", reason: "authority-denied" },
        },
      ]);
      expect(redactLogFields(events[0]?.extra ?? {})).toEqual(events[0]?.extra);
    },
  );
  it("dispatches every action to exactly one named existing authority port", async () => {
    const ports = governedPorts();
    const delegate = createCodingToolGovernedDelegate(ports);
    const actions: readonly CodingToolActionRequest[] = [
      { ...identity, action: "read", relativePath: "src/a.ts" },
      { ...identity, action: "discover", query: "safeActivity", maxResults: 20 },
      {
        ...identity,
        action: "search",
        repositoryRequest: {
          kind: "search",
          mode: "literal",
          query: "safeActivity",
          caseSensitive: false,
          includeGlobs: [],
          excludeGlobs: [],
          maxResults: 20,
        },
      },
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
    expect(ports.repositoryDiscover.execute).toHaveBeenCalledTimes(1);
    expect(ports.repositorySearch.execute).toHaveBeenCalledTimes(1);
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

  it("carries a search port's CodingRepositoryResult through to the outcome unchanged (#3386 H1)", async () => {
    const search = {
      ok: true as const,
      kind: "search" as const,
      hits: [],
      metrics: {
        candidatesDiscovered: 0,
        filesScanned: 0,
        skippedFiles: 0,
        durationMs: 1,
      },
      truncationReasons: [],
    };
    const ports = {
      ...governedPorts(),
      repositorySearch: {
        execute: vi.fn(() => Promise.resolve({ status: "completed" as const, search })),
      },
    };
    const delegate = createCodingToolGovernedDelegate(ports);

    await expect(
      delegate.execute(
        {
          ...identity,
          action: "search",
          repositoryRequest: {
            kind: "search",
            mode: "literal",
            query: "safeActivity",
            caseSensitive: false,
            includeGlobs: [],
            excludeGlobs: [],
            maxResults: 20,
          },
        },
        undefined,
        liveGuard,
      ),
    ).resolves.toEqual({ outcome: "completed", search });
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

  it("carries an editor-changeset port's reasonCode through to the outcome", async () => {
    const ports: CodingToolGovernedPorts = {
      ...governedPorts(),
      editorChangeset: {
        execute: vi.fn(() =>
          Promise.resolve({ status: "failed" as const, reasonCode: "CONTENT_HASH_MISMATCH" }),
        ),
      },
    };
    const delegate = createCodingToolGovernedDelegate(ports);

    await expect(
      delegate.execute({ ...identity, action: "edit", changeset }, undefined, liveGuard),
    ).resolves.toEqual({ outcome: "failed", reasonCode: "CONTENT_HASH_MISMATCH" });
  });

  // #3390: the editor route's sentence for a refused edit reaches the facade; a non-edit failure
  // never carries one, whatever its port returned.
  it("forwards a refused edit's route message and drops it for every other action", async () => {
    const refusal = {
      status: "failed" as const,
      reasonCode: "INVALID_EDITS",
      message: "context mismatch at original line 12",
    };
    const ports: CodingToolGovernedPorts = {
      ...governedPorts(),
      editorChangeset: { execute: vi.fn(() => Promise.resolve(refusal)) },
      commandRunner: { execute: vi.fn(() => Promise.resolve(refusal)) },
    };
    const delegate = createCodingToolGovernedDelegate(ports);

    await expect(
      delegate.execute({ ...identity, action: "edit", changeset }, undefined, liveGuard),
    ).resolves.toEqual({
      outcome: "failed",
      reasonCode: "INVALID_EDITS",
      message: "context mismatch at original line 12",
    });
    await expect(
      delegate.execute({ ...identity, action: "command", commandId: "test" }, undefined, liveGuard),
    ).resolves.toEqual({ outcome: "failed", reasonCode: "INVALID_EDITS" });
  });

  it("omits reasonCode for a failure that did not carry one", async () => {
    const ports: CodingToolGovernedPorts = {
      ...governedPorts(),
      commandRunner: {
        execute: vi.fn(() => Promise.resolve({ status: "failed" as const })),
      },
    };
    const delegate = createCodingToolGovernedDelegate(ports);

    await expect(
      delegate.execute({ ...identity, action: "command", commandId: "test" }, undefined, liveGuard),
    ).resolves.toEqual({ outcome: "failed" });
  });
});
