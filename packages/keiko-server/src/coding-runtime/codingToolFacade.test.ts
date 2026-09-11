import {
  EDITOR_AGENT_CONFLICT_CODES,
  EDITOR_AGENT_FAILURE_CODES,
} from "@oscharko-dev/keiko-contracts/runtime/editor-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultServerDiagnosticSink } from "../diagnostics-log.js";
import { VERIFICATION_RUNNER_ERROR_CODES } from "../editor/verificationRunnerErrors.js";
import { DraftDeliveryFixture } from "../gitDelivery/draftDeliveryServiceTestSupport.js";
import { createBufferedServerLogSink } from "../observability/server-log.js";
import {
  createCanonicalCatalogFacadeBridge,
  type CanonicalCatalogContext,
} from "../tool-catalog/catalogToolFacadeBridge.js";
import { createCodingToolFacade } from "./codingToolFacade.js";
import type {
  CodingToolAuthorityPort,
  CodingToolDelegatePort,
  CodingToolFacade,
} from "./codingToolFacadePorts.js";
import { createCodingToolInvocationRegistry } from "./codingToolInvocationRegistry.js";
import type { CodingToolActionRequest } from "./codingToolIpc.js";
import { VERIFIED_COMMIT_BLOCKING_PATHS_MAX } from "../gitDelivery/verifiedCommitTypes.js";

const capability = "capability-1-opaque-runtime-secret";
const deliveryFixtures: DraftDeliveryFixture[] = [];
afterEach(() => {
  for (const fixture of deliveryFixtures.splice(0)) fixture.close();
});
const changeset = {
  patch: "--- a/src/file.ts\n+++ b/src/file.ts\n@@\n-old\n+new\n",
  files: [{ file: "src/file.ts", expectedContentHash: "a".repeat(64) }],
};

function requestBody(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ actionId: "action-1", idempotencyKey: "idempotency-1", ...value });
}

function sparseVerificationLocations(): readonly unknown[] {
  const locations: unknown[] = [];
  locations.length = 1;
  return locations;
}

// The three runner codes only the HTTP verification routes can mint (a malformed body, an oversized
// body, a run id naming no in-flight run). `runToReport` — the single runner entry point the
// governed verification port calls — cannot answer one, so the facade deliberately keeps them out
// of the model-facing vocabulary.
const HTTP_ONLY_VERIFICATION_RUNNER_CODES = ["BAD_REQUEST", "PAYLOAD_TOO_LARGE", "RUN_NOT_FOUND"];
// Derived from the runner's OWN closed vocabulary, never a restated copy: the whole point of the
// facade sourcing `VERIFICATION_RUNNER_ERROR_CODES` is that a code added there reaches the model
// without a coordinated edit, and a fixture that restated the five known codes could not fail for
// the sixth (AGENTS.md §7; PR #3381 review).
const FORWARDED_VERIFICATION_RUNNER_CODES = Object.values(VERIFICATION_RUNNER_ERROR_CODES).filter(
  (code) => !HTTP_ONLY_VERIFICATION_RUNNER_CODES.includes(code),
);

interface MutableFacadePorts {
  authority: { admit: CodingToolAuthorityPort["admit"] };
  delegate: { execute: CodingToolDelegatePort["execute"] };
}

// A valid CodingRepositoryResult (#3386 H1), included on every stub outcome so the exhaustive
// "one delegate call per action" test's blanket mock also satisfies the search action's own
// projection without a special case; other actions ignore the unrelated field.
const stubSearchResult = {
  ok: true as const,
  kind: "search" as const,
  hits: [],
  metrics: { candidatesDiscovered: 0, filesScanned: 0, skippedFiles: 0, durationMs: 0 },
  truncationReasons: [],
};

function facade(admitted = true): MutableFacadePorts {
  return {
    authority: {
      admit: vi.fn(() =>
        admitted
          ? { ok: true as const, mutationGuard: { check: (): true => true } }
          : { ok: false as const },
      ),
    },
    delegate: {
      execute: vi.fn(() =>
        Promise.resolve({ outcome: "completed", evidence: [], search: stubSearchResult }),
      ),
    },
  };
}

describe("CodingToolFacade", () => {
  it("admits an exact edit request before making exactly one governed delegate call", async () => {
    const ports = facade();
    const subject = createCodingToolFacade(ports);

    const result = await subject.execute({
      body: requestBody({ action: "edit", changeset }),
      capability,
    });

    expect(result).toEqual({
      status: "completed",
      evidence: [{ kind: "governed-delegate", code: "completed" }],
    });
    expect(ports.authority.admit).toHaveBeenCalledTimes(1);
    expect(ports.delegate.execute).toHaveBeenCalledTimes(1);
    expect(ports.authority.admit).toHaveBeenCalledBefore(
      ports.delegate.execute as ReturnType<typeof vi.fn>,
    );
  });

  it("#3417: returns a discovery's closed listing and fails any that leaves the contract", async () => {
    const listing = {
      schemaVersion: 1,
      catalogDigest: "a".repeat(64),
      skills: [
        {
          skillId: "skl_repo-structure-summary@1",
          version: "1",
          sourceDigest: "b".repeat(64),
          category: "repository-analysis",
          capabilities: ["keiko.workspace.read"],
          compatibility: { profile: "opencode", minVersion: 1, maxVersion: 1 },
          readiness: { state: "ready" },
        },
      ],
    };
    const withSummary = {
      ...listing,
      skills: listing.skills.map((skill) => ({ ...skill, summary: "reads every file" })),
    };
    const cases: readonly (readonly [unknown, "listing" | "failed"])[] = [
      [{ outcome: "completed", skills: listing }, "listing"],
      [{ outcome: "completed", skills: withSummary }, "failed"],
      [{ outcome: "completed" }, "failed"],
    ];
    for (const [delegated, expected] of cases) {
      const ports = facade();
      ports.delegate.execute = vi.fn(() => Promise.resolve(delegated));
      const result = await createCodingToolFacade(ports).execute({
        body: requestBody({ action: "skill-discover" }),
        capability,
      });
      if (expected === "failed") expect(result).toMatchObject({ status: "failed" });
      else
        expect(result).toEqual({
          status: "completed",
          evidence: [{ kind: "governed-delegate", code: "completed" }],
          skills: listing,
        });
    }
  });

  it("passes the whole-file digest and window facts through instead of recomputing them (#2473)", async () => {
    const ports = facade();
    const wholeFileDigest = "b".repeat(64);
    ports.delegate.execute = vi.fn(() =>
      Promise.resolve({
        outcome: "completed",
        read: {
          text: "line two\n",
          byteCount: 9,
          digest: wholeFileDigest,
          totalLines: 40,
          nextStartLine: 3,
        },
      }),
    );
    const subject = createCodingToolFacade(ports);

    const result = await subject.execute({
      body: requestBody({ action: "read", relativePath: "src/a.ts", startLine: 2, maxLines: 1 }),
      capability,
    });

    expect(result).toEqual({
      status: "completed",
      evidence: [{ kind: "governed-delegate", code: "completed" }],
      read: {
        text: "line two\n",
        byteCount: Buffer.byteLength("line two\n", "utf8"),
        digest: wholeFileDigest,
        totalLines: 40,
        nextStartLine: 3,
      },
    });
  });

  it.each([
    ["a malformed digest", { digest: "not-a-digest", totalLines: 4 }],
    ["a missing totalLines", { digest: "b".repeat(64) }],
    ["a negative totalLines", { digest: "b".repeat(64), totalLines: -1 }],
    ["a nextStartLine below two", { digest: "b".repeat(64), totalLines: 4, nextStartLine: 1 }],
  ])("fails closed when the delegate read carries %s", async (_name, readFacts) => {
    const ports = facade();
    ports.delegate.execute = vi.fn(() =>
      Promise.resolve({
        outcome: "completed",
        read: { text: "line\n", byteCount: 5, ...readFacts },
      }),
    );
    const subject = createCodingToolFacade(ports);

    const result = await subject.execute({
      body: requestBody({ action: "read", relativePath: "src/a.ts" }),
      capability,
    });

    expect(result).toEqual({
      status: "completed",
      evidence: [{ kind: "governed-delegate", code: "completed" }],
    });
  });

  it("denies forged and missing capabilities without calling a delegate", async () => {
    const ports = facade(false);
    const subject = createCodingToolFacade(ports);
    const body = requestBody({ action: "command", commandId: "test" });

    await expect(subject.execute({ body, capability })).resolves.toMatchObject({
      status: "denied",
    });
    await expect(subject.execute({ body })).resolves.toMatchObject({ status: "denied" });
    expect(ports.authority.admit).toHaveBeenCalledTimes(2);
    expect(ports.delegate.execute).not.toHaveBeenCalled();
  });

  it("carries replay identities to authoritative admission and never re-executes a replay", async () => {
    const ports = facade();
    const admitted = new Set<string>();
    ports.authority.admit = vi.fn(
      (_capability: string | undefined, request: CodingToolActionRequest) => {
        const replayKey = `${request.actionId}:${request.idempotencyKey}`;
        if (admitted.has(replayKey)) {
          return { ok: false as const, reason: "authority-replayed" };
        }
        admitted.add(replayKey);
        return { ok: true as const, mutationGuard: { check: (): true => true } };
      },
    );
    const subject = createCodingToolFacade(ports);
    const body = requestBody({ action: "command", commandId: "test" });

    await expect(subject.execute({ body, capability })).resolves.toMatchObject({
      status: "completed",
    });
    await expect(subject.execute({ body, capability })).resolves.toMatchObject({
      status: "denied",
    });
    expect(ports.delegate.execute).toHaveBeenCalledTimes(1);
  });

  it("rejects every Origin header, including same-origin", async () => {
    const ports = facade();
    const subject = createCodingToolFacade(ports);

    await expect(
      subject.execute({
        body: requestBody({ action: "command", commandId: "test" }),
        capability,
        headers: { Origin: "http://127.0.0.1" },
      }),
    ).resolves.toMatchObject({ status: "denied" });
    expect(ports.authority.admit).not.toHaveBeenCalled();
    expect(ports.delegate.execute).not.toHaveBeenCalled();
  });

  it("fails closed for unknown actions and extra request keys", async () => {
    const ports = facade();
    const subject = createCodingToolFacade(ports);

    await expect(
      subject.execute({ body: requestBody({ action: "shell" }), capability }),
    ).resolves.toMatchObject({ status: "invalid" });
    await expect(
      subject.execute({
        body: requestBody({ action: "command", commandId: "test", extra: true }),
        capability,
      }),
    ).resolves.toMatchObject({ status: "invalid" });
    await expect(
      subject.execute({
        body: requestBody({ action: "command", commandId: "test", capability: "forged" }),
        capability,
      }),
    ).resolves.toMatchObject({ status: "invalid" });
    expect(ports.authority.admit).not.toHaveBeenCalled();
    expect(ports.delegate.execute).not.toHaveBeenCalled();
  });

  it("enforces bounded body and in-flight limits", async () => {
    const ports = facade();
    let release: (() => void) | undefined;
    ports.delegate.execute = vi.fn(
      () =>
        new Promise((resolve) => {
          release = (): void => {
            resolve({ outcome: "completed" });
          };
        }),
    );
    const subject = createCodingToolFacade(ports, { maxBodyBytes: 256, maxInFlight: 1 });
    const body = requestBody({ action: "command", commandId: "test" });

    await expect(subject.execute({ body: "x".repeat(257), capability })).resolves.toMatchObject({
      status: "invalid",
    });
    const first = subject.execute({ body, capability });
    await expect(subject.execute({ body, capability })).resolves.toMatchObject({ status: "busy" });
    release?.();
    await expect(first).resolves.toMatchObject({ status: "completed" });
  });

  it("does not delegate denied or cancelled actions", async () => {
    const ports = facade();
    const controller = new AbortController();
    controller.abort();
    const subject = createCodingToolFacade(ports);

    await expect(
      subject.execute({
        body: requestBody({ action: "command", commandId: "test" }),
        capability,
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ status: "cancelled" });
    expect(ports.authority.admit).not.toHaveBeenCalled();
    expect(ports.delegate.execute).not.toHaveBeenCalled();
  });

  it("treats permission observation as non-executable", async () => {
    const ports = facade();
    const subject = createCodingToolFacade(ports);

    await expect(
      subject.execute({
        body: JSON.stringify({ action: "permission-event", requestId: "request-1" }),
        capability,
      }),
    ).resolves.toMatchObject({ status: "observed" });
    expect(ports.authority.admit).not.toHaveBeenCalled();
    expect(ports.delegate.execute).not.toHaveBeenCalled();
  });

  it("delegates each closed governed action exactly once", async () => {
    const ports = facade();
    const subject = createCodingToolFacade(ports);
    const bodies = [
      { action: "edit", changeset },
      {
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
      { action: "command", commandId: "test" },
      { action: "verification", verifierId: "unit" },
      { action: "git", operation: "read" },
      { action: "delivery", intent: "push" },
      { action: "connector", scope: "source-control.read" },
      { action: "egress", target: "https://example.test" },
    ];

    for (const body of bodies)
      await expect(subject.execute({ body: requestBody(body), capability })).resolves.toMatchObject(
        { status: "completed" },
      );
    expect(ports.authority.admit).toHaveBeenCalledTimes(bodies.length);
    expect(ports.delegate.execute).toHaveBeenCalledTimes(bodies.length);
  });

  it("rechecks revocation immediately before dispatch", async () => {
    const ports = facade();
    ports.authority.admit = vi.fn(() => ({
      ok: true as const,
      mutationGuard: { check: (): false => false },
    }));
    const subject = createCodingToolFacade(ports);

    await expect(
      subject.execute({
        body: requestBody({ action: "command", commandId: "test" }),
        capability,
      }),
    ).resolves.toMatchObject({ status: "denied" });
    expect(ports.authority.admit).toHaveBeenCalledTimes(1);
    expect(ports.delegate.execute).not.toHaveBeenCalled();
  });

  it("replaces delegate evidence with fixed server-owned labels", async () => {
    const ports = facade();
    ports.delegate.execute = vi.fn(() =>
      Promise.resolve({
        outcome: "completed",
        stdout: "SECRET-SENTINEL",
        evidence: [
          {
            kind: "/private/SECRET-SENTINEL",
            code: "curl https://SECRET-SENTINEL.example",
            content: "SECRET-SENTINEL",
          },
        ],
      }),
    );
    const subject = createCodingToolFacade(ports);

    const result = await subject.execute({
      body: requestBody({ action: "verification", verifierId: "unit" }),
      capability,
    });
    expect(result).toEqual({
      status: "completed",
      evidence: [{ kind: "governed-delegate", code: "completed" }],
    });
    expect(JSON.stringify(result)).not.toContain("SECRET-SENTINEL");
  });

  it("rejects rollback and accepts only existing safe delivery intents", async () => {
    const ports = facade();
    const subject = createCodingToolFacade(ports);

    await expect(
      subject.execute({
        body: requestBody({ action: "delivery", operation: "rollback" }),
        capability,
      }),
    ).resolves.toMatchObject({ status: "invalid" });
    await expect(
      subject.execute({
        body: requestBody({ action: "delivery", intent: "merge" }),
        capability,
      }),
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("contains delegate failures without exposing their content", async () => {
    const ports = facade();
    ports.delegate.execute = vi.fn(() => Promise.reject(new Error("SECRET-SENTINEL")));
    const subject = createCodingToolFacade(ports);

    await expect(
      subject.execute({
        body: requestBody({ action: "command", commandId: "test" }),
        capability,
      }),
    ).resolves.toEqual({
      status: "failed",
      evidence: [{ kind: "governed-delegate", code: "failed" }],
    });
  });

  // Owner audit finding b2-5: a draft-delivery attempt (push/pull-request, propose/execute/reconcile)
  // whose delegate outcome carries `draftDelivery: { status: "unavailable", reason }` — no lease
  // granted, or a busy delivery service — must never report "completed": nothing was recorded.
  it("fails closed when a draft delivery attempt could not be recorded", async () => {
    const ports = facade();
    ports.delegate.execute = vi.fn(() =>
      Promise.resolve({
        outcome: "completed",
        evidence: [],
        draftDelivery: { status: "unavailable", reason: "provider-unavailable" },
      }),
    );
    const subject = createCodingToolFacade(ports);

    await expect(
      subject.execute({
        body: requestBody({ action: "delivery", intent: "push", phase: "reconcile" }),
        capability,
      }),
    ).resolves.toEqual({
      status: "failed",
      evidence: [{ kind: "governed-delegate", code: "provider-unavailable" }],
      reasonCode: "provider-unavailable",
    });
  });

  it("reports a recorded draft delivery as completed", async () => {
    const ports = facade();
    const fixture = new DraftDeliveryFixture();
    deliveryFixtures.push(fixture);
    await fixture.recordVerifiedCommit();
    const draftDelivery = await fixture.service.proposePush();
    expect(draftDelivery.status).toBe("recorded");
    ports.delegate.execute = vi.fn(() =>
      Promise.resolve({ outcome: "completed", evidence: [], draftDelivery }),
    );
    const subject = createCodingToolFacade(ports);

    await expect(
      subject.execute({
        body: requestBody({ action: "delivery", intent: "push", phase: "reconcile" }),
        capability,
      }),
    ).resolves.toEqual({
      status: "completed",
      evidence: [{ kind: "governed-delegate", code: "completed" }],
      draftDelivery,
    });
  });

  it("rejects a recorded delivery whose payload is not a validated delivery record", async () => {
    const ports = facade();
    ports.delegate.execute = vi.fn(() =>
      Promise.resolve({
        outcome: "completed",
        draftDelivery: { status: "recorded", record: { phase: "push-proposed", runId: "run-1" } },
      }),
    );
    await expect(
      createCodingToolFacade(ports).execute({
        body: requestBody({ action: "delivery", intent: "push", phase: "reconcile" }),
        capability,
      }),
    ).resolves.toEqual({
      status: "failed",
      evidence: [{ kind: "governed-delegate", code: "failed" }],
    });
  });

  it("accepts only the exact bounded repository-read shape and never trusts a runtime root or authority", async () => {
    const ports = facade();
    const subject = createCodingToolFacade(ports);
    const read = { action: "read", relativePath: "src/a.ts" };

    await expect(subject.execute({ body: requestBody(read), capability })).resolves.toMatchObject({
      status: "completed",
    });
    for (const forged of [
      { ...read, relativePath: "../outside.ts" },
      { ...read, relativePath: "/workspace/a.ts" },
      { ...read, workspaceRoot: "/forged" },
      { ...read, authorityRef: { runId: "forged" } },
      { ...read, approvalRef: "forged" },
      { ...read, byteCount: 1 },
    ]) {
      await expect(
        subject.execute({ body: requestBody(forged), capability }),
      ).resolves.toMatchObject({ status: "invalid" });
    }
    expect(ports.delegate.execute).toHaveBeenCalledTimes(1);
    expect(ports.delegate.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "read", relativePath: "src/a.ts" }),
      undefined,
      expect.anything(),
    );
  });

  it.each([".env", ".ENV", "services/.env", "secrets/.ENV"])(
    "rejects canonical deny-listed repository reads for %s before authority admission",
    async (relativePath) => {
      const ports = facade();
      const subject = createCodingToolFacade(ports);

      await expect(
        subject.execute({ body: requestBody({ action: "read", relativePath }), capability }),
      ).resolves.toMatchObject({ status: "invalid" });

      expect(ports.authority.admit).not.toHaveBeenCalled();
      expect(ports.delegate.execute).not.toHaveBeenCalled();
    },
  );

  it("aligns the raw invocation body cap with the 256 KiB registry entry cap while retaining changeset validation", async () => {
    const ports = facade();
    const subject = createCodingToolFacade(ports);
    const largeButValidChangeset = {
      action: "edit",
      changeset: {
        patch: "x".repeat(16_385),
        files: [{ file: "src/a.ts", expectedContentHash: "a".repeat(64) }],
      },
    };

    await expect(
      subject.execute({ body: requestBody(largeButValidChangeset), capability }),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(subject.execute({ body: "x".repeat(262_145), capability })).resolves.toMatchObject(
      { status: "invalid" },
    );
    expect(ports.delegate.execute).toHaveBeenCalledOnce();
  });

  it("keeps no legacy targetPath/patchBytes request type or parser lane", async () => {
    const legacy: CodingToolActionRequest = {
      action: "edit",
      actionId: "legacy-action",
      idempotencyKey: "legacy-key",
      // @ts-expect-error Issue #2332 removes the metadata-only edit request variant entirely.
      targetPath: "src/a.ts",
      patchBytes: 1,
    };
    const ports = facade();
    const subject = createCodingToolFacade(ports);

    await expect(
      subject.execute({ body: JSON.stringify(legacy), capability }),
    ).resolves.toMatchObject({ status: "invalid" });
    expect(ports.authority.admit).not.toHaveBeenCalled();
    expect(ports.delegate.execute).not.toHaveBeenCalled();
  });

  it("accepts only an exact validated changeset edit and never projects its raw payload into facade results", async () => {
    const ports = facade();
    ports.delegate.execute = vi.fn(() =>
      Promise.resolve({
        outcome: "completed",
        patch: "SENTINEL_RAW_PATCH",
        capability: "SENTINEL_RUNTIME_CAPABILITY",
      }),
    );
    const subject = createCodingToolFacade(ports);
    const edit = {
      action: "edit",
      changeset: {
        patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-old\n+new\n",
        files: [{ file: "src/a.ts", expectedContentHash: "a".repeat(64) }],
      },
    };

    const result = await subject.execute({ body: requestBody(edit), capability });
    await expect(
      subject.execute({ body: requestBody({ ...edit, patchBytes: 1 }), capability }),
    ).resolves.toMatchObject({ status: "invalid" });
    await expect(
      subject.execute({
        body: requestBody({ ...edit, changeset: { patch: "x", files: [] } }),
        capability,
      }),
    ).resolves.toMatchObject({ status: "invalid" });

    expect(result).toEqual({
      status: "completed",
      evidence: [{ kind: "governed-delegate", code: "completed" }],
    });
    expect(JSON.stringify(result)).not.toContain("SENTINEL_");
  });

  it("forwards a closed-vocabulary edit reasonCode to the model instead of a bare failed status", async () => {
    const ports = facade();
    ports.delegate.execute = vi.fn(() =>
      Promise.resolve({ outcome: "failed", reasonCode: "CONTENT_HASH_MISMATCH" }),
    );
    const subject = createCodingToolFacade(ports);

    const result = await subject.execute({
      body: requestBody({ action: "edit", changeset }),
      capability,
    });

    expect(result).toEqual({
      status: "failed",
      evidence: [{ kind: "governed-delegate", code: "CONTENT_HASH_MISMATCH" }],
      guidance: expect.stringContaining("Re-read the file with keiko_workspace_read") as unknown,
    });
  });

  // ADR-0147 D3 (Coding Workbench run 8, 2026-09-10): a verification the runner refused for want of
  // package-script trust is the operator's decision, not the model's. The fixed guidance says so and
  // names the one place it can change, so the model reports the blocker instead of retrying the
  // verifier or routing around it.
  it("tells the model that a trust-refused verification is the operator's decision", async () => {
    const ports = facade();
    ports.delegate.execute = vi.fn(() =>
      Promise.resolve({ outcome: "failed", reasonCode: "WORKSPACE_TRUST_REQUIRED" }),
    );
    const subject = createCodingToolFacade(ports);

    await expect(
      subject.execute({
        body: requestBody({ action: "verification", verifierId: "unit" }),
        capability,
      }),
    ).resolves.toEqual({
      status: "failed",
      evidence: [{ kind: "governed-delegate", code: "WORKSPACE_TRUST_REQUIRED" }],
      reasonCode: "WORKSPACE_TRUST_REQUIRED",
      guidance: expect.stringContaining("Only the operator can allow them") as unknown as string,
    });
  });

  // F74 (Coding Workbench run 24): a verifier with nothing to run answered a bare code, so the model
  // picked another verifier at once without knowing why. The steps that did not run are named with
  // their closed reasons, and a step the facade cannot recognise is not forwarded.
  it("tells the model which verification steps did not run and why", async () => {
    const ports = facade();
    ports.delegate.execute = vi.fn(() =>
      Promise.resolve({
        outcome: "failed",
        reasonCode: "VERIFICATION_NOT_RUN",
        notRun: [
          { kind: "typecheck", reason: "script-missing" },
          { kind: "test", reason: "dependencies-unavailable" },
          { kind: "../../etc", reason: "script-missing" },
          { kind: "lint", reason: "made-up" },
        ],
      }),
    );
    const subject = createCodingToolFacade(ports);

    await expect(
      subject.execute({
        body: requestBody({ action: "verification", verifierId: "unit" }),
        capability,
      }),
    ).resolves.toEqual({
      status: "failed",
      evidence: [{ kind: "governed-delegate", code: "VERIFICATION_NOT_RUN" }],
      reasonCode: "VERIFICATION_NOT_RUN",
      detail:
        "These verification steps did not run: typecheck (no such script in package.json), test (dependencies did not install).",
      guidance: expect.stringContaining("Not every verification step ran") as unknown as string,
    });
  });

  // PR #3452 review: every closed reason reaches the model in its own words; a cancelled or denied
  // step is never called skipped.
  it("words every reason a verification step did not run", async () => {
    const ports = facade();
    ports.delegate.execute = vi.fn(() =>
      Promise.resolve({
        outcome: "failed",
        reasonCode: "VERIFICATION_NOT_RUN",
        notRun: [
          { kind: "typecheck", reason: "script-missing" },
          { kind: "test", reason: "dependencies-unavailable" },
          { kind: "lint", reason: "denied" },
          { kind: "build", reason: "cancelled" },
          { kind: "targeted-test", reason: "skipped" },
        ],
      }),
    );
    const subject = createCodingToolFacade(ports);

    await expect(
      subject.execute({
        body: requestBody({ action: "verification", verifierId: "unit" }),
        capability,
      }),
    ).resolves.toMatchObject({
      reasonCode: "VERIFICATION_NOT_RUN",
      detail:
        "These verification steps did not run: typecheck (no such script in package.json), test (dependencies did not install), lint (denied by policy), build (cancelled), targeted-test (skipped).",
    });
  });

  // An empty not-run list names no step, so the facade forwards no detail; the guidance still stands
  // (PR #3452 review).
  it("forwards no detail for an empty not-run list", async () => {
    const ports = facade();
    ports.delegate.execute = vi.fn(() =>
      Promise.resolve({ outcome: "failed", reasonCode: "VERIFICATION_NOT_RUN", notRun: [] }),
    );
    const subject = createCodingToolFacade(ports);

    await expect(
      subject.execute({
        body: requestBody({ action: "verification", verifierId: "unit" }),
        capability,
      }),
    ).resolves.toEqual({
      status: "failed",
      evidence: [{ kind: "governed-delegate", code: "VERIFICATION_NOT_RUN" }],
      reasonCode: "VERIFICATION_NOT_RUN",
      guidance: expect.stringContaining("Not every verification step ran") as unknown as string,
    });
  });

  // Coding Workbench run 13 (2026-09-10): a stage proposal the runtime Git service blocks is a
  // completed Git result, not a failure — but its closed reason alone left the model guessing. The
  // admission reasons carry the one recovery the model can perform itself.
  it("tells the model how to recover from a blocked stage proposal", async () => {
    const ports = facade();
    ports.delegate.execute = vi.fn(() =>
      Promise.resolve({
        outcome: "completed",
        evidence: [],
        git: {
          kind: "stage",
          proposalId: "stage-13",
          status: "blocked",
          reason: "selection-unreviewed",
          pathCount: 1,
        },
      }),
    );
    const subject = createCodingToolFacade(ports);

    await expect(
      subject.execute({
        body: requestBody({ action: "git", operation: "stage", phase: "propose", paths: ["src"] }),
        capability,
      }),
    ).resolves.toEqual({
      status: "completed",
      evidence: [{ kind: "governed-delegate", code: "completed" }],
      git: {
        kind: "stage",
        proposalId: "stage-13",
        status: "blocked",
        reason: "selection-unreviewed",
        pathCount: 1,
      },
      guidance: expect.stringContaining("keiko_git_status") as unknown as string,
    });
  });

  it("keeps a ready stage proposal free of guidance", async () => {
    const ports = facade();
    const git = {
      kind: "stage",
      proposalId: "stage-14",
      status: "ready",
      reason: "none",
      pathCount: 2,
    };
    ports.delegate.execute = vi.fn(() =>
      Promise.resolve({ outcome: "completed", evidence: [], git }),
    );
    const subject = createCodingToolFacade(ports);

    await expect(
      subject.execute({
        body: requestBody({
          action: "git",
          operation: "stage",
          phase: "propose",
          paths: ["a.js", "b.js"],
        }),
        capability,
      }),
    ).resolves.toEqual({
      status: "completed",
      evidence: [{ kind: "governed-delegate", code: "completed" }],
      git,
    });
  });

  it.each([
    ["git-proposal-unknown", "Propose the change again"],
    ["git-execution-failed", "keiko_git_status"],
  ])("forwards a %s Git refusal with its recovery guidance", async (reasonCode, coaching) => {
    const ports = facade();
    ports.delegate.execute = vi.fn(() => Promise.resolve({ outcome: "failed", reasonCode }));
    const subject = createCodingToolFacade(ports);

    await expect(
      subject.execute({
        body: requestBody({
          action: "git",
          operation: "stage",
          phase: "execute",
          proposalId: "stage-15",
        }),
        capability,
      }),
    ).resolves.toEqual({
      status: "failed",
      evidence: [{ kind: "governed-delegate", code: reasonCode }],
      reasonCode,
      guidance: expect.stringContaining(coaching) as unknown as string,
    });
  });

  // #3390: a structural refusal carries the route's sentence and a fixed recovery instruction, so
  // the model repairs the patch instead of resending it. The sentence is admitted only as one
  // bounded printable-ASCII line, and only for the structural codes.
  it("tells the model why a structural edit refusal happened and how to recover", async () => {
    const ports = facade();
    ports.delegate.execute = vi.fn(() =>
      Promise.resolve({
        outcome: "failed",
        reasonCode: "INVALID_EDITS",
        message: "context mismatch at original line 12",
      }),
    );
    const subject = createCodingToolFacade(ports);

    await expect(
      subject.execute({ body: requestBody({ action: "edit", changeset }), capability }),
    ).resolves.toEqual({
      status: "failed",
      evidence: [{ kind: "governed-delegate", code: "INVALID_EDITS" }],
      detail: "context mismatch at original line 12",
      guidance: expect.stringContaining(
        "does not apply to the file as it is now",
      ) as unknown as string,
    });
  });

  it.each([
    ["a multi-line message", "line one\nline two"],
    ["a non-ASCII message", "kontext stimmt nicht überein"],
    ["an over-long message", "x".repeat(241)],
    ["a non-string message", 12],
  ])("drops %s from an edit refusal's detail", async (_label, message) => {
    const ports = facade();
    ports.delegate.execute = vi.fn(() =>
      Promise.resolve({ outcome: "failed", reasonCode: "INVALID_EDITS", message }),
    );
    const subject = createCodingToolFacade(ports);

    const result = await subject.execute({
      body: requestBody({ action: "edit", changeset }),
      capability,
    });

    expect(result).not.toHaveProperty("detail");
    expect(result).toHaveProperty("guidance");
  });

  it("keeps a transport refusal to its code: no detail, no guidance", async () => {
    const ports = facade();
    ports.delegate.execute = vi.fn(() =>
      Promise.resolve({
        outcome: "failed",
        reasonCode: "EDIT_TRANSPORT_ERROR",
        message: "socket hang up at 10.0.0.7",
      }),
    );
    const subject = createCodingToolFacade(ports);

    await expect(
      subject.execute({ body: requestBody({ action: "edit", changeset }), capability }),
    ).resolves.toEqual({
      status: "failed",
      evidence: [{ kind: "governed-delegate", code: "EDIT_TRANSPORT_ERROR" }],
    });
  });

  it("forwards the recoverable CI observation requirement on an edit refusal", async () => {
    const ports = facade();
    ports.delegate.execute = vi.fn(() =>
      Promise.resolve({ outcome: "failed", reasonCode: "ci-observation-required" }),
    );
    const subject = createCodingToolFacade(ports);

    await expect(
      subject.execute({
        body: requestBody({ action: "edit", changeset }),
        capability,
      }),
    ).resolves.toEqual({
      status: "failed",
      reasonCode: "ci-observation-required",
      evidence: [{ kind: "governed-delegate", code: "ci-observation-required" }],
    });
  });

  it("drops an edit reasonCode outside the closed vocabulary instead of forwarding it verbatim", async () => {
    const ports = facade();
    ports.delegate.execute = vi.fn(() =>
      Promise.resolve({ outcome: "failed", reasonCode: "SENTINEL_UNVETTED_CODE" }),
    );
    const subject = createCodingToolFacade(ports);

    const result = await subject.execute({
      body: requestBody({ action: "edit", changeset }),
      capability,
    });

    expect(result).toEqual({
      status: "failed",
      evidence: [{ kind: "governed-delegate", code: "failed" }],
    });
    expect(JSON.stringify(result)).not.toContain("SENTINEL_");
  });

  // Regression: KEIKO-0292. The facade's closed vocabulary must remain the union of the two
  // contract-owned enums (EDITOR_AGENT_CONFLICT_CODES ∪ EDITOR_AGENT_FAILURE_CODES) plus this
  // port's own transport markers. Iterating the exported enums proves that a future addition to
  // either canonical list reaches this facade without a coordinated edit — the previous
  // hand-restated 21-entry Set silently drifted on every new contract code.
  const EDIT_FAILURE_GUIDANCE_CODES: ReadonlySet<string> = new Set([
    "CONTENT_HASH_MISMATCH",
    "INVALID_EDITS",
    "PRECONDITION_REQUIRED",
    "OUT_OF_SCOPE",
  ]);
  it("forwards every canonical contract EditorAgent conflict and failure code", async () => {
    const canonical = [...EDITOR_AGENT_CONFLICT_CODES, ...EDITOR_AGENT_FAILURE_CODES];
    expect(canonical.length).toBeGreaterThanOrEqual(11 + 6);

    for (const code of canonical) {
      const ports = facade();
      ports.delegate.execute = vi.fn(() =>
        Promise.resolve({ outcome: "failed", reasonCode: code }),
      );
      const subject = createCodingToolFacade(ports);

      const result = await subject.execute({
        body: requestBody({ action: "edit", changeset }),
        capability,
      });

      expect(result).toMatchObject({
        status: "failed",
        evidence: [{ kind: "governed-delegate", code }],
      });
      // #3390: only the four structural refusals carry a recovery instruction; a route sentence
      // was not supplied here, so no code carries a detail.
      expect("guidance" in result).toBe(EDIT_FAILURE_GUIDANCE_CODES.has(code));
      expect(result).not.toHaveProperty("detail");
    }
  });

  // The read/edit port's own pre-dispatch refusals: an edit the prepare stage rejected, and one
  // whose workspace access stopped resolving while the port waited for a live editor session. Both
  // reached the model as a bare "failed" before the cursor review of PR #3381, so a revoked
  // workspace authority looked exactly like a retryable editor conflict.
  it.each(["EDIT_PREPARE_FAILED", "WORKSPACE_ACCESS_LOST"])(
    "forwards the read/edit port's closed %s refusal",
    async (code) => {
      const ports = facade();
      ports.delegate.execute = vi.fn(() =>
        Promise.resolve({ outcome: "failed", reasonCode: code }),
      );
      const subject = createCodingToolFacade(ports);

      const result = await subject.execute({
        body: requestBody({ action: "edit", changeset }),
        capability,
      });

      expect(result).toEqual({
        status: "failed",
        evidence: [{ kind: "governed-delegate", code }],
      });
    },
  );

  it("never forwards a reasonCode for a non-edit action's failure", async () => {
    const ports = facade();
    ports.delegate.execute = vi.fn(() =>
      Promise.resolve({ outcome: "failed", reasonCode: "TIMED_OUT" }),
    );
    const subject = createCodingToolFacade(ports);

    const result = await subject.execute({
      body: requestBody({ action: "command", commandId: "test" }),
      capability,
    });

    expect(result).toEqual({
      status: "failed",
      evidence: [{ kind: "governed-delegate", code: "failed" }],
    });
  });

  it("forwards the closed command backend unavailable reason", async () => {
    const ports = facade();
    ports.delegate.execute = vi.fn(() =>
      Promise.resolve({ outcome: "failed", reasonCode: "command-backend-unavailable" }),
    );
    const subject = createCodingToolFacade(ports);

    const result = await subject.execute({
      body: requestBody({ action: "command", commandId: "test" }),
      capability,
    });

    expect(result).toEqual({
      status: "failed",
      reasonCode: "command-backend-unavailable",
      evidence: [{ kind: "governed-delegate", code: "command-backend-unavailable" }],
    });
  });

  // Every closed verification code reaches the model: a refusal must be told apart from a red run
  // (end-to-end run, 2026-09-03). The last two are the PORT's own pre-run refusals — the run's
  // authority or managed-workspace liveness already gone, and an unimplemented verifier id — which
  // returned a bare "failed" until the cursor review of PR #3381.
  it.each([
    ...FORWARDED_VERIFICATION_RUNNER_CODES,
    // The port's own markers: two pre-run refusals, and the four codes a finished run earns —
    // VERIFICATION_FAILED is reserved for a RED run, so a timeout, a resource ceiling and a run
    // that never executed each keep their own signal (PR #3381 review).
    "VERIFICATION_FAILED",
    "VERIFICATION_TIMED_OUT",
    "VERIFICATION_RESOURCE_EXCEEDED",
    "VERIFICATION_NOT_RUN",
    "verification-authority-revoked",
    "verification-verifier-unsupported",
  ])("forwards the closed verification %s refusal", async (code) => {
    const ports = facade();
    ports.delegate.execute = vi.fn(() => Promise.resolve({ outcome: "failed", reasonCode: code }));
    const subject = createCodingToolFacade(ports);

    const result = await subject.execute({
      body: requestBody({ action: "verification", verifierId: "unit" }),
      capability,
    });

    expect(result).toEqual({
      status: "failed",
      reasonCode: code,
      evidence: [{ kind: "governed-delegate", code }],
      // Two refusals carry guidance: the trust refusal is the operator's decision to change, not the
      // model's (ADR-0147 D3, 2026-09-10), and a run that left a step unexecuted tells the model
      // what that means for its next step (F74). Every other code stays bare.
      ...(code === "WORKSPACE_TRUST_REQUIRED"
        ? { guidance: expect.stringContaining("Only the operator can allow them") as unknown }
        : {}),
      ...(code === "VERIFICATION_NOT_RUN"
        ? { guidance: expect.stringContaining("Not every verification step ran") as unknown }
        : {}),
    });
  });

  it("forwards only the bounded structured diagnostics of a failed verifier", async () => {
    const ports = facade();
    ports.delegate.execute = vi.fn(() =>
      Promise.resolve({
        outcome: "failed",
        reasonCode: "VERIFICATION_FAILED",
        verificationFailure: {
          summary: "test failed; 1 structured failure location",
          locations: [
            {
              file: "ci/numerical-stability.test.js",
              line: 19,
              column: 5,
              message: "expected the stable average to remain finite",
            },
          ],
          truncated: false,
        },
      }),
    );
    const subject = createCodingToolFacade(ports);

    await expect(
      subject.execute({
        body: requestBody({ action: "verification", verifierId: "test" }),
        capability,
      }),
    ).resolves.toEqual({
      status: "failed",
      reasonCode: "VERIFICATION_FAILED",
      evidence: [{ kind: "governed-delegate", code: "VERIFICATION_FAILED" }],
      verificationFailure: {
        summary: "test failed; 1 structured failure location",
        locations: [
          {
            file: "ci/numerical-stability.test.js",
            line: 19,
            column: 5,
            message: "expected the stable average to remain finite",
          },
        ],
        truncated: false,
      },
    });
  });

  it.each([
    {
      summary: "test failed; 1 structured failure location",
      locations: [{ file: "/private/customer.test.js", message: "PRIVATE_FAILURE_CANARY" }],
      truncated: false,
    },
    {
      summary: "PRIVATE_FAILURE_CANARY",
      locations: [],
      truncated: false,
      rawOutput: "PRIVATE_FAILURE_CANARY",
    },
    {
      summary: "test failed; 1 structured failure location",
      locations: sparseVerificationLocations(),
      truncated: false,
    },
  ])("drops malformed verification diagnostics instead of exposing them", async (diagnostics) => {
    const ports = facade();
    ports.delegate.execute = vi.fn(() =>
      Promise.resolve({
        outcome: "failed",
        reasonCode: "VERIFICATION_FAILED",
        verificationFailure: diagnostics,
      }),
    );
    const subject = createCodingToolFacade(ports);

    const result = await subject.execute({
      body: requestBody({ action: "verification", verifierId: "test" }),
      capability,
    });

    expect(result).toEqual({
      status: "failed",
      reasonCode: "VERIFICATION_FAILED",
      evidence: [{ kind: "governed-delegate", code: "VERIFICATION_FAILED" }],
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_FAILURE_CANARY");
  });

  it.each([
    { commitProof: "recorded", unexpected: true },
    { commitProof: "unavailable", reasonCode: "candidate-not-staged", nextAction: "verify-again" },
  ])("strips a malformed verification proof payload", async (verification) => {
    const ports = facade();
    ports.delegate.execute = vi.fn(() => Promise.resolve({ outcome: "completed", verification }));
    const subject = createCodingToolFacade(ports);

    await expect(
      subject.execute({
        body: requestBody({ action: "verification", verifierId: "unit" }),
        capability,
      }),
    ).resolves.toEqual({
      status: "completed",
      evidence: [{ kind: "governed-delegate", code: "completed" }],
    });
  });

  // isVerifiedCommitBlockingPaths/isBlockingPathList: bounded, workspace-relative, exact-keyed.
  const validBlocking = {
    unstagedCount: 1,
    untrackedCount: 1,
    unstaged: ["src/a.ts"],
    untracked: ["src/b.ts"],
  };
  function candidateNotStagedVerification(
    blocking: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>> {
    return {
      commitProof: "unavailable",
      reasonCode: "candidate-not-staged",
      nextAction: "stage-then-verify",
      blocking,
    };
  }

  it("accepts a candidate-not-staged verification proof with a well-formed blocking payload", async () => {
    const ports = facade();
    const verification = candidateNotStagedVerification(validBlocking);
    ports.delegate.execute = vi.fn(() => Promise.resolve({ outcome: "completed", verification }));
    const subject = createCodingToolFacade(ports);

    await expect(
      subject.execute({
        body: requestBody({ action: "verification", verifierId: "unit" }),
        capability,
      }),
    ).resolves.toEqual({
      status: "completed",
      evidence: [{ kind: "governed-delegate", code: "completed" }],
      verification,
    });
  });

  it.each([
    ["an absolute unstaged path", { ...validBlocking, unstaged: ["/etc/passwd"] }],
    [
      "an untracked path escaping the workspace with ..",
      { ...validBlocking, untracked: ["../secrets.env"] },
    ],
    // The canonical root-relative identifier contract (isRootRelativeFileIdentifier), not a
    // POSIX-only approximation of it: Windows drive, rooted and backslash forms are foreign too.
    ["a drive-absolute unstaged path", { ...validBlocking, unstaged: [String.raw`C:\repo\file`] }],
    ["a drive-relative untracked path", { ...validBlocking, untracked: ["C:file"] }],
    ["a backslash-rooted unstaged path", { ...validBlocking, unstaged: [String.raw`\repo\file`] }],
    [
      "a backslash traversal in an untracked path",
      { ...validBlocking, untracked: [String.raw`..\file`] },
    ],
    ["a NUL byte in an unstaged path", { ...validBlocking, unstaged: ["src/a\u0000.ts"] }],
    [
      `more than ${String(VERIFIED_COMMIT_BLOCKING_PATHS_MAX)} unstaged paths`,
      {
        ...validBlocking,
        unstagedCount: VERIFIED_COMMIT_BLOCKING_PATHS_MAX + 1,
        unstaged: Array.from(
          { length: VERIFIED_COMMIT_BLOCKING_PATHS_MAX + 1 },
          (_, index) => `src/file-${String(index)}.ts`,
        ),
      },
    ],
  ])(
    "strips a candidate-not-staged verification proof whose blocking payload has %s",
    async (_label, blocking) => {
      const ports = facade();
      ports.delegate.execute = vi.fn(() =>
        Promise.resolve({
          outcome: "completed",
          verification: candidateNotStagedVerification(blocking),
        }),
      );
      const subject = createCodingToolFacade(ports);

      await expect(
        subject.execute({
          body: requestBody({ action: "verification", verifierId: "unit" }),
          capability,
        }),
      ).resolves.toEqual({
        status: "completed",
        evidence: [{ kind: "governed-delegate", code: "completed" }],
      });
    },
  );

  // The other half of sourcing the runner vocabulary: the exclusion is a decision, not an accident.
  // A route-only code has no meaning for a tool call, so it collapses to the bare status instead of
  // being handed to the model as if the runner had refused.
  it.each(HTTP_ONLY_VERIFICATION_RUNNER_CODES)(
    "never forwards the HTTP-only runner code %s",
    async (code) => {
      const ports = facade();
      ports.delegate.execute = vi.fn(() =>
        Promise.resolve({ outcome: "failed", reasonCode: code }),
      );
      const subject = createCodingToolFacade(ports);

      const result = await subject.execute({
        body: requestBody({ action: "verification", verifierId: "unit" }),
        capability,
      });

      expect(result).toEqual({
        status: "failed",
        evidence: [{ kind: "governed-delegate", code: "failed" }],
      });
    },
  );

  it("forwards a search domain outcome, including its own ok:false reason, as evidence (#3386 H1)", async () => {
    const ports = facade();
    const denied = { ok: false as const, reason: "scope-denied" as const };
    ports.delegate.execute = vi.fn(() =>
      Promise.resolve({ outcome: "completed", evidence: [], search: denied }),
    );
    const subject = createCodingToolFacade(ports);
    const body = requestBody({
      action: "search",
      repositoryRequest: {
        kind: "read",
        path: ".env",
        startLine: 1,
        endLine: 1,
        maxBytes: 4096,
      },
    });

    const result = await subject.execute({ body, capability });

    expect(result).toEqual({
      status: "completed",
      evidence: [{ kind: "governed-delegate", code: "scope-denied" }],
      search: denied,
    });
  });

  it("fails closed for a malformed search delegate outcome instead of trusting an unvalidated shape", async () => {
    const ports = facade();
    ports.delegate.execute = vi.fn(() =>
      Promise.resolve({ outcome: "completed", evidence: [], search: { ok: "not-a-boolean" } }),
    );
    const subject = createCodingToolFacade(ports);
    const body = requestBody({
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
    });

    await expect(subject.execute({ body, capability })).resolves.toEqual({
      status: "failed",
      evidence: [{ kind: "governed-delegate", code: "failed" }],
    });
  });

  it("fails closed for blocked, denied, and malformed delegate outcomes", async () => {
    const ports = facade();
    const subject = createCodingToolFacade(ports);
    const body = requestBody({ action: "command", commandId: "test" });

    for (const outcome of [{ outcome: "blocked" }, { outcome: "denied" }, {}, null]) {
      ports.delegate.execute = vi.fn(() => Promise.resolve(outcome));
      await expect(subject.execute({ body, capability })).resolves.toEqual({
        status: "failed",
        evidence: [{ kind: "governed-delegate", code: "failed" }],
      });
    }
  });

  // #3390 rubric: the coding model must observe the RED state (which check failed and why) before
  // it may claim a fix. `keiko_verification` is bound through the governed catalog in production
  // (catalogToolFacadeBridge.ts), which settles ANY `status: "failed"` handler result -- a genuine
  // dispatch fault AND a verifier that ran and reported failing tests alike -- as a
  // `CatalogDispatchFault` for its own governance bookkeeping (tool-catalog.invocation-settled,
  // errorKind "CatalogDispatchFault", empty data). `catalogToolFacadeBridge.ts`'s
  // `preservedExecutedResult` rescues the original executed result for the first case; these tests
  // pin that the rescued payload actually survives THIS file's own catalog composition
  // (`executeCatalogRequest`'s `delegateState.threw` guard) all the way to the value returned to
  // the caller -- the same value `opencodeRuntimeComposition.ts` JSON-serializes as the HTTP 200
  // body the coding model's tool call receives -- and that a handler which never ran at all still
  // collapses to the pre-existing opaque marker.
  describe("catalog-bound verification failure delivery", () => {
    const catalogContext: CanonicalCatalogContext = {
      runId: "run-1",
      correlationId: "c".repeat(36),
      workspaceRoot: "/workspace",
      workspaceIdentity: "workspace-1",
      workspaceRevision: "d".repeat(64),
      authorityExpiresAt: "2030-01-01T00:00:00.000Z",
      now: 0,
    };

    function catalogBoundFacade(): {
      readonly subject: CodingToolFacade;
      readonly ports: MutableFacadePorts;
      readonly log: ReturnType<typeof createBufferedServerLogSink>;
    } {
      const ports = facade();
      const log = createBufferedServerLogSink();
      const bridge = createCanonicalCatalogFacadeBridge({
        authority: {
          admit: (): {
            readonly ok: true;
            readonly mutationGuard: { readonly check: () => boolean };
          } => ({ ok: true, mutationGuard: { check: () => true } }),
        },
        previewAuthority: () => ({ ok: true }),
        invocationRegistry: createCodingToolInvocationRegistry({ now: () => 0 }),
        context: () => catalogContext,
        elapsedNow: () => catalogContext.now,
        logPort: { primary: log, diagnostics: defaultServerDiagnosticSink },
        approvalAvailable: true,
      });
      return { subject: createCodingToolFacade(ports, { catalogBridge: bridge }), ports, log };
    }

    it("carries the structured failure payload through a red run instead of a bare dispatch fault", async () => {
      const { subject, ports, log } = catalogBoundFacade();
      const verificationFailure = {
        summary: "test failed; 1 structured failure location",
        locations: [
          {
            file: "ci/numerical-stability.test.js",
            line: 19,
            column: 5,
            message: "expected the stable average to remain finite",
          },
        ],
        truncated: false,
      };
      ports.delegate.execute = vi.fn(() =>
        Promise.resolve({
          outcome: "failed",
          reasonCode: "VERIFICATION_FAILED",
          verificationFailure,
        }),
      );

      const result = await subject.execute({
        body: requestBody({ action: "verification", verifierId: "test" }),
        capability,
      });

      expect(result).toEqual({
        status: "failed",
        reasonCode: "VERIFICATION_FAILED",
        evidence: [{ kind: "governed-delegate", code: "VERIFICATION_FAILED" }],
        verificationFailure,
      });
      // The catalog's own settlement log records this as a dispatch fault for its governance
      // accounting (budget commit, effectStarted) -- an internal audit artifact of that layer, not
      // evidence the payload asserted above was lost to the caller.
      expect(log.events.at(-1)).toMatchObject({
        op: "tool-catalog.invocation-settled",
        extra: { status: "failed", reason: "handler-failed", errorKind: "CatalogDispatchFault" },
      });
    });

    it("keeps a handler that never ran the opaque failure marker, never a fabricated payload", async () => {
      const { subject, ports, log } = catalogBoundFacade();
      ports.delegate.execute = vi.fn(() => Promise.reject(new Error("workspace gone")));

      const result = await subject.execute({
        body: requestBody({ action: "verification", verifierId: "test" }),
        capability,
      });

      expect(result).toEqual({
        status: "failed",
        evidence: [{ kind: "governed-delegate", code: "failed" }],
      });
      expect(log.events.at(-1)).toMatchObject({
        op: "tool-catalog.invocation-settled",
        extra: { status: "failed", reason: "handler-failed" },
      });
    });
  });
});
