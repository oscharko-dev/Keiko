import type { FeedbackPublicationTargetPolicySnapshotV1 } from "@oscharko-dev/keiko-contracts/feedback-publication";
import { describe, expect, it } from "vitest";
import {
  FEEDBACK_ISSUE_BODY_MAX_BYTES_V1,
  digestFeedbackIssueProjectionV1,
  digestFeedbackTargetPolicyV1,
} from "./feedback-publication-projection.js";
import type { FeedbackPublicationWorkerLease } from "./feedback-publication-worker-types.js";
import { PostgresFeedbackPublicationWorkerStore } from "./feedback-publication-worker-store.js";
import type { GithubAppConfig, GithubAppTarget } from "./github-app-config.js";
import type { GithubAppSignerSnapshot } from "./github-app-key.js";
import type {
  GithubHttpOperation,
  GithubHttpResponse,
  GithubTransport,
  GithubTransportRequestOptions,
} from "./github-app-transport.js";
import { GithubTransportError } from "./github-app-transport.js";
import {
  GovernedGithubIssueAdapter,
  GithubIssueAdapterError,
  type GithubIssueAdapter,
  type GithubIssueProjection,
} from "./github-issue-adapter.js";

const marker = `<!-- keiko-feedback-reconciliation-v1:${"a".repeat(43)} -->`;
const now = new Date("2026-07-12T00:00:00Z");
const snapshot: FeedbackPublicationTargetPolicySnapshotV1 = {
  apiOrigin: "https://api.github.com",
  repositoryId: "456",
  installationId: "123",
  owner: "oscharko-dev",
  repository: "keiko",
  labels: ["user-finding", "source:keiko"],
  targetKey: "public-feedback",
  labelPolicyVersion: "labels-v1",
  targetPolicyVersion: "target-v1",
};
const target: GithubAppTarget = { snapshot, digest: digestFeedbackTargetPolicyV1(snapshot) };
const config: GithubAppConfig = {
  apiOrigin: "https://api.github.com",
  appId: "42",
  privateKeyFile: "/not-read-by-fake",
  privateKeyRotatedAt: "2026-07-01T00:00:00.000Z",
  targets: new Map([[snapshot.targetKey, target]]),
};

function response(status: number, value: unknown, committed = false): GithubHttpResponse {
  return {
    status,
    contentType: "application/json; charset=utf-8",
    body: Buffer.from(JSON.stringify(value)),
    requestCommitted: committed,
  };
}

function tokenResponse(overrides: Record<string, unknown> = {}): GithubHttpResponse {
  return response(201, {
    token: "variable-length-token",
    expires_at: "2026-07-12T00:59:00Z",
    permissions: { issues: "write" },
    repositories: [
      {
        id: 456,
        name: "keiko",
        full_name: "oscharko-dev/keiko",
        owner: { login: "oscharko-dev" },
      },
    ],
    ...overrides,
  });
}

function issue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repository_url: "https://api.github.com/repos/oscharko-dev/keiko",
    html_url: "https://github.com/oscharko-dev/keiko/issues/7",
    number: 7,
    node_id: "I_node",
    title: "Reviewed title",
    body: `Reviewed body\n\n${marker}`,
    labels: [{ name: "user-finding" }, { name: "source:keiko" }],
    ...overrides,
  };
}

function search(
  items: readonly unknown[],
  overrides: Record<string, unknown> = {},
): GithubHttpResponse {
  return response(200, {
    total_count: items.length,
    incomplete_results: false,
    items,
    ...overrides,
  });
}

function claimed(
  overrides: Partial<FeedbackPublicationWorkerLease> = {},
): FeedbackPublicationWorkerLease {
  const title = overrides.title ?? "Reviewed title";
  const body = overrides.body ?? `Reviewed body\n\n${marker}`;
  const targetPolicyDigest = overrides.targetPolicyDigest ?? target.digest;
  return {
    outboxId: "outbox-1",
    preparationId: "preparation-1",
    itemId: "item-1",
    title,
    body,
    projectionDigest:
      overrides.projectionDigest ??
      digestFeedbackIssueProjectionV1(title, body, targetPolicyDigest),
    reconciliationMarker: overrides.reconciliationMarker ?? marker,
    target: overrides.target ?? snapshot,
    targetPolicyDigest,
    leaseOwner: "worker-1",
    leaseExpiresAt: new Date("2026-07-12T00:01:00Z"),
    mode: "create-eligible",
    createAttemptCount: 0,
    ...overrides,
  };
}

const coordinatorStore = new PostgresFeedbackPublicationWorkerStore(
  {
    connect: (): Promise<import("./postgres-types.js").PgClientLike> =>
      Promise.reject(new Error("unused coordinator test pool")),
  },
  {
    connect: (): Promise<import("./postgres-types.js").PgClientLike> =>
      Promise.reject(new Error("unused coordinator installation-session pool")),
  },
  (_key: string): FeedbackPublicationTargetPolicySnapshotV1 => snapshot,
);
coordinatorStore.armCreate = (_lease: FeedbackPublicationWorkerLease): Promise<void> =>
  Promise.resolve();

function publish(
  governed: GovernedGithubIssueAdapter,
  projection: FeedbackPublicationWorkerLease = claimed(),
): Promise<GithubIssueProjection> {
  return governed.publishClaimedCandidate(coordinatorStore, projection);
}

function readinessResponse(operation: GithubHttpOperation): GithubHttpResponse | undefined {
  if (operation.kind === "inspect-app")
    return response(200, { permissions: { metadata: "read", issues: "write" } });
  if (operation.kind === "inspect-installation") {
    return response(200, {
      id: 123,
      repository_selection: "selected",
      permissions: { metadata: "read", issues: "write" },
    });
  }
  if (operation.kind === "inspect-repository-installation") return response(200, { id: 123 });
  return undefined;
}

class FakeTransport implements GithubTransport {
  readonly operations: GithubHttpOperation[] = [];
  readonly requestOptions: (GithubTransportRequestOptions | undefined)[] = [];
  constructor(
    private readonly run: (
      operation: GithubHttpOperation,
      options?: GithubTransportRequestOptions,
    ) => GithubHttpResponse | Promise<GithubHttpResponse>,
    private readonly automaticReadiness = true,
  ) {}
  execute(
    operation: GithubHttpOperation,
    options?: GithubTransportRequestOptions,
  ): Promise<GithubHttpResponse> {
    this.operations.push(operation);
    this.requestOptions.push(options);
    const automatic = this.automaticReadiness ? readinessResponse(operation) : undefined;
    return automatic === undefined
      ? Promise.resolve(this.run(operation, options))
      : Promise.resolve(automatic);
  }
}

function adapter(
  transport: GithubTransport,
  monotonicNow?: () => number,
): GovernedGithubIssueAdapter {
  return new GovernedGithubIssueAdapter({
    config,
    transport,
    trustedNow: () => now,
    ...(monotonicNow === undefined ? {} : { monotonicNow }),
    keyProvider: {
      snapshot: () => ({
        keyId: "test-key",
        rotatedAt: now,
        signRs256: () => Uint8Array.from([1, 2, 3]),
      }),
    },
  });
}

async function attested(
  transport: GithubTransport,
  monotonicNow?: () => number,
): Promise<GovernedGithubIssueAdapter> {
  const governed = adapter(transport, monotonicNow);
  await governed.inspectReadiness();
  return governed;
}

describe("governed GitHub issue adapter", () => {
  it("inspects exact app, selected installation, and repository binding", async () => {
    const transport = new FakeTransport((operation) => {
      if (operation.kind === "inspect-app")
        return response(200, { permissions: { issues: "write", metadata: "read" } });
      if (operation.kind === "inspect-installation") {
        return response(200, {
          id: 123,
          repository_selection: "selected",
          permissions: { issues: "write", metadata: "read" },
        });
      }
      return response(200, { id: 123 });
    }, false);
    await expect(adapter(transport).inspectReadiness()).resolves.toBeUndefined();
    expect(transport.operations.map((operation) => operation.kind)).toEqual([
      "inspect-app",
      "inspect-installation",
      "inspect-repository-installation",
    ]);
  });

  it("attests 64 targets with bounded concurrency under one aggregate budget", async () => {
    const targets = new Map<string, GithubAppTarget>();
    for (let index = 0; index < 64; index += 1) {
      const current = {
        ...snapshot,
        targetKey: `target-${String(index)}`,
        installationId: String(1_000 + index),
        repositoryId: String(2_000 + index),
        repository: `repository-${String(index)}`,
      };
      targets.set(current.targetKey, {
        snapshot: current,
        digest: digestFeedbackTargetPolicyV1(current),
      });
    }
    let active = 0;
    let maximum = 0;
    const transport: GithubTransport = {
      execute: async (operation): Promise<GithubHttpResponse> => {
        if (operation.kind === "inspect-app") {
          return response(200, { permissions: { issues: "write", metadata: "read" } });
        }
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 250));
        active -= 1;
        if (operation.kind === "inspect-installation") {
          return response(200, {
            id: Number(operation.installationId),
            repository_selection: "selected",
            permissions: { issues: "write", metadata: "read" },
          });
        }
        if (operation.kind !== "inspect-repository-installation") {
          throw new Error("Unexpected readiness operation");
        }
        const bound = [...targets.values()].find(
          (value) => value.snapshot.repositoryId === operation.repositoryId,
        );
        return response(200, { id: Number(bound?.snapshot.installationId) });
      },
    };
    const governed = new GovernedGithubIssueAdapter({
      config: { ...config, targets },
      transport,
      trustedNow: (): Date => now,
      keyProvider: {
        snapshot: (): GithubAppSignerSnapshot => ({
          keyId: "test-key",
          rotatedAt: now,
          signRs256: (): Uint8Array => Uint8Array.from([1, 2, 3]),
        }),
      },
    });
    await expect(governed.inspectReadiness()).resolves.toBeUndefined();
    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(6);
  }, 10_000);

  it("invalidates every target when any concurrent readiness inspection fails", async () => {
    const secondSnapshot = {
      ...snapshot,
      targetKey: "second",
      installationId: "124",
      repositoryId: "457",
      repository: "second",
    };
    const second = {
      snapshot: secondSnapshot,
      digest: digestFeedbackTargetPolicyV1(secondSnapshot),
    };
    let failSecond = false;
    const transport = new FakeTransport((operation) => {
      if (operation.kind === "inspect-app") {
        return response(200, { permissions: { issues: "write", metadata: "read" } });
      }
      if (operation.kind === "inspect-installation") {
        if (failSecond && operation.installationId === "124") return response(503, {});
        return response(200, {
          id: Number(operation.installationId),
          repository_selection: "selected",
          permissions: { issues: "write", metadata: "read" },
        });
      }
      if (operation.kind !== "inspect-repository-installation") {
        throw new Error("Unexpected readiness operation");
      }
      return response(200, { id: operation.repositoryId === "457" ? 124 : 123 });
    }, false);
    const governed = new GovernedGithubIssueAdapter({
      config: {
        ...config,
        targets: new Map([
          [snapshot.targetKey, target],
          ["second", second],
        ]),
      },
      transport,
      trustedNow: (): Date => now,
      keyProvider: {
        snapshot: (): GithubAppSignerSnapshot => ({
          keyId: "test-key",
          rotatedAt: now,
          signRs256: (): Uint8Array => Uint8Array.from([1, 2, 3]),
        }),
      },
    });
    await governed.inspectReadiness();
    failSecond = true;
    await expect(governed.inspectReadiness()).rejects.toBeInstanceOf(GithubIssueAdapterError);
    await expect(governed.reconcileIssue(claimed())).rejects.toMatchObject({
      code: "permission-denied",
    });
  });

  it("fails readiness for broader, missing, or all-repositories permissions", async () => {
    for (const permissions of [
      { issues: "write", metadata: "read", contents: "read" },
      { issues: "read", metadata: "read" },
    ]) {
      const transport = new FakeTransport(() => response(200, { permissions }), false);
      await expect(adapter(transport).inspectReadiness()).rejects.toMatchObject({
        code: "permission-denied",
      });
    }
    const transport = new FakeTransport(
      (operation) =>
        operation.kind === "inspect-app"
          ? response(200, { permissions: { issues: "write", metadata: "read" } })
          : response(200, {
              id: 123,
              repository_selection: "all",
              permissions: { issues: "write", metadata: "read" },
            }),
      false,
    );
    await expect(adapter(transport).inspectReadiness()).rejects.toMatchObject({
      code: "permission-denied",
    });
  });

  it("returns exact or non-authoritative not-observed without granting create authority", async () => {
    for (const issues of [[], [issue()]]) {
      const transport = new FakeTransport((operation) =>
        operation.kind === "mint-token" ? tokenResponse() : search(issues),
      );
      const found = await (await attested(transport)).reconcileIssue(claimed());
      expect(found.kind).toBe(issues.length === 0 ? "not-observed" : "exact");
      if (found.kind === "not-observed") {
        expect(found.createAuthority).toBe(
          "requires-create-eligible-with-no-possibly-committed-post",
        );
      }
      expect(transport.operations.at(-2)).toMatchObject({
        kind: "mint-token",
        installationId: "123",
        repositoryId: "456",
      });
      expect(transport.operations.at(-1)).toMatchObject({
        kind: "find-marker",
        owner: "oscharko-dev",
        repository: "keiko",
        marker,
        page: 1,
      });
    }
  });

  it("reconciles a reversed-order unique provider label set", async () => {
    const transport = new FakeTransport((operation) =>
      operation.kind === "mint-token"
        ? tokenResponse()
        : search([issue({ labels: [{ name: "source:keiko" }, { name: "user-finding" }] })]),
    );
    await expect((await attested(transport)).reconcileIssue(claimed())).resolves.toMatchObject({
      kind: "exact",
      issue: { number: 7 },
    });
  });

  it("validates two bounded search pages and rejects the second candidate immediately", async () => {
    const second = issue({
      number: 8,
      html_url: "https://github.com/oscharko-dev/keiko/issues/8",
    });
    const transport = new FakeTransport((operation) => {
      if (operation.kind === "mint-token") return tokenResponse();
      return operation.kind === "find-marker" && operation.page === 1
        ? search([issue()], { total_count: 2 })
        : search([second], { total_count: 2 });
    });
    await expect((await attested(transport)).reconcileIssue(claimed())).rejects.toMatchObject({
      code: "duplicate-candidate",
    });
    expect(
      transport.operations
        .filter((operation) => operation.kind === "find-marker")
        .map((operation) => operation.page),
    ).toEqual([1, 2]);
  });

  it.each([
    ["incomplete", search([], { incomplete_results: true })],
    ["overflow", search([issue()], { total_count: 3 })],
    [
      "wrong repository",
      search([issue({ repository_url: "https://api.github.com/repos/other/repository" })]),
    ],
    ["wrong projection", search([issue({ title: "different title" })])],
    [
      "duplicate labels",
      search([issue({ labels: [{ name: "user-finding" }, { name: "user-finding" }] })]),
    ],
  ] as const)("fails closed for %s search results", async (_case, searchResponse) => {
    const transport = new FakeTransport((operation) =>
      operation.kind === "mint-token" ? tokenResponse() : searchResponse,
    );
    await expect((await attested(transport)).reconcileIssue(claimed())).rejects.toMatchObject({
      code: "provider-unavailable",
      commitCertainty: "definite-pre-send",
    });
  });

  it("accepts one exact maximum-size projected body", async () => {
    const suffix = `\n\n${marker}`;
    const body = `${"x".repeat(FEEDBACK_ISSUE_BODY_MAX_BYTES_V1 - Buffer.byteLength(suffix))}${suffix}`;
    const projection = claimed({ body });
    const transport = new FakeTransport((operation) =>
      operation.kind === "mint-token" ? tokenResponse() : search([issue({ body })]),
    );
    await expect((await attested(transport)).reconcileIssue(projection)).resolves.toMatchObject({
      kind: "exact",
      issue: { body },
    });
  });

  it.each(["deadline", "abort"] as const)(
    "fails closed after the first search page on aggregate %s",
    async (kind) => {
      let monotonic = 0;
      const controller = new AbortController();
      const transport = new FakeTransport((operation) => {
        if (operation.kind === "mint-token") return tokenResponse();
        monotonic = kind === "deadline" ? 30_001 : monotonic;
        if (kind === "abort") controller.abort();
        return search([issue()], { total_count: 2 });
      });
      const governed = await attested(transport, () => monotonic);
      await expect(governed.reconcileIssue(claimed(), controller.signal)).rejects.toMatchObject({
        code: "provider-unavailable",
        commitCertainty: "definite-pre-send",
      });
      expect(
        transport.operations.filter((operation) => operation.kind === "find-marker"),
      ).toHaveLength(1);
    },
  );

  it("bounds aggregate readiness and starts no later request after expiry", async () => {
    let monotonic = 0;
    const transport = new FakeTransport((operation) => {
      if (operation.kind === "inspect-app") {
        monotonic = 30_001;
        return readinessResponse(operation) ?? response(500, {});
      }
      return readinessResponse(operation) ?? response(500, {});
    }, false);
    const governed = adapter(transport, () => monotonic);
    await expect(governed.inspectReadiness()).rejects.toMatchObject({
      code: "provider-unavailable",
      commitCertainty: "definite-pre-send",
    });
    expect(transport.operations.map((operation) => operation.kind)).toEqual(["inspect-app"]);
    await expect(publish(governed)).rejects.toMatchObject({
      code: "permission-denied",
    });
  });

  it("requires an explicit successful readiness attestation before find or create", async () => {
    const transport = new FakeTransport((operation) =>
      operation.kind === "mint-token" ? tokenResponse() : search([]),
    );
    const governed = adapter(transport);
    await expect(governed.reconcileIssue(claimed())).rejects.toMatchObject({
      code: "permission-denied",
      commitCertainty: "definite-pre-send",
    });
    await expect(publish(governed)).rejects.toMatchObject({
      code: "permission-denied",
      commitCertainty: "definite-pre-send",
    });
    expect(transport.operations).toEqual([]);
  });

  it("does not let an older readiness success resurrect a newer failed generation", async () => {
    let releaseOlder: ((value: GithubHttpResponse) => void) | undefined;
    const olderApp = new Promise<GithubHttpResponse>((resolve) => {
      releaseOlder = resolve;
    });
    let appCalls = 0;
    const transport = new FakeTransport((operation) => {
      if (operation.kind === "inspect-app") {
        appCalls += 1;
        return appCalls === 1 ? olderApp : Promise.reject(new GithubTransportError(true));
      }
      const ready = readinessResponse(operation);
      if (ready === undefined) throw new Error("unexpected operation");
      return ready;
    }, false);
    const governed = adapter(transport);
    const older = governed.inspectReadiness();
    const newer = governed.inspectReadiness();
    await expect(newer).rejects.toMatchObject({ commitCertainty: "definite-pre-send" });
    releaseOlder?.(response(200, { permissions: { metadata: "read", issues: "write" } }));
    await expect(older).rejects.toMatchObject({ commitCertainty: "definite-pre-send" });
    await expect(governed.reconcileIssue(claimed())).rejects.toMatchObject({
      code: "permission-denied",
    });
    await expect(publish(governed)).rejects.toMatchObject({
      code: "permission-denied",
    });
  });

  it("binds equivalent target snapshots independently of property insertion order", async () => {
    const reordered = {
      targetPolicyVersion: snapshot.targetPolicyVersion,
      labels: snapshot.labels,
      repository: snapshot.repository,
      apiOrigin: snapshot.apiOrigin,
      installationId: snapshot.installationId,
      targetKey: snapshot.targetKey,
      owner: snapshot.owner,
      repositoryId: snapshot.repositoryId,
      labelPolicyVersion: snapshot.labelPolicyVersion,
    } satisfies FeedbackPublicationTargetPolicySnapshotV1;
    const transport = new FakeTransport((operation) =>
      operation.kind === "mint-token" ? tokenResponse() : search([]),
    );
    await expect(
      (await attested(transport)).reconcileIssue(claimed({ target: reordered })),
    ).resolves.toMatchObject({ kind: "not-observed" });
  });

  it("rejects duplicate candidates and unexpected token scope, permission, or expiry", async () => {
    const duplicate = new FakeTransport((operation) => {
      if (operation.kind === "mint-token") return tokenResponse();
      const candidate = issue({
        number: operation.kind === "find-marker" ? operation.page + 6 : 7,
        html_url: `https://github.com/oscharko-dev/keiko/issues/${String(operation.kind === "find-marker" ? operation.page + 6 : 7)}`,
      });
      return search([candidate], { total_count: 2 });
    });
    await expect((await attested(duplicate)).reconcileIssue(claimed())).rejects.toMatchObject({
      code: "duplicate-candidate",
    });
    for (const invalid of [
      tokenResponse({ permissions: { issues: "read" } }),
      tokenResponse({ expires_at: "2026-07-12T02:00:00Z" }),
      tokenResponse({ repositories: [{ id: 999 }] }),
    ]) {
      const transport = new FakeTransport(() => invalid);
      await expect((await attested(transport)).reconcileIssue(claimed())).rejects.toBeInstanceOf(
        GithubIssueAdapterError,
      );
    }
  });

  it("creates only exact approved bytes and fixed labels", async () => {
    const transport = new FakeTransport((operation) =>
      operation.kind === "mint-token" ? tokenResponse() : response(201, issue(), true),
    );
    const governed = await attested(transport);
    await expect(publish(governed)).resolves.toMatchObject({
      number: 7,
      nodeId: "I_node",
    });
    await expect(
      publish(governed, claimed({ projectionDigest: "0".repeat(64) })),
    ).rejects.toMatchObject({ code: "validation-error", commitCertainty: "definite-pre-send" });
  });

  it("accepts reversed provider labels after create while preserving ordered request labels", async () => {
    const transport = new FakeTransport((operation) =>
      operation.kind === "mint-token"
        ? tokenResponse()
        : response(
            201,
            issue({ labels: [{ name: "source:keiko" }, { name: "user-finding" }] }),
            true,
          ),
    );
    const governed = await attested(transport);
    await expect(publish(governed)).resolves.toMatchObject({ number: 7 });
    expect(transport.operations.at(-1)).toMatchObject({
      kind: "create-issue",
      labels: ["user-finding", "source:keiko"],
    });
  });

  it("exposes no raw create operation", () => {
    const governed = adapter(new FakeTransport(() => tokenResponse()));
    type HasRawCreate = "createIssue" extends keyof GithubIssueAdapter ? true : false;
    const hasRawCreate: HasRawCreate = false;
    expect(hasRawCreate).toBe(false);
    expect("createIssue" in governed).toBe(false);
  });

  it.each([
    [401, "permission-denied"],
    [403, "permission-denied"],
    [404, "repository-unavailable"],
    [410, "repository-unavailable"],
    [400, "validation-error"],
    [422, "validation-error"],
    [429, "rate-limited"],
    [500, "provider-unavailable"],
  ] as const)(
    "classifies provider status %i without provider-body disclosure",
    async (status, code) => {
      const sentinel = "SENTINEL_PROVIDER_BODY_SECRET";
      const transport = new FakeTransport((operation) =>
        operation.kind === "mint-token"
          ? tokenResponse()
          : response(status, { message: sentinel }, true),
      );
      const result = publish(await attested(transport));
      await expect(result).rejects.toMatchObject({ code, commitCertainty: "may-have-committed" });
      await expect(result).rejects.not.toThrow(sentinel);
    },
  );

  it("classifies an evidence-backed 403 as rate limited with a bounded retry hint", async () => {
    const transport = new FakeTransport((operation) => {
      if (operation.kind === "mint-token") return tokenResponse();
      return {
        ...response(403, { message: "provider detail" }, true),
        rateLimitRemaining: "0",
        retryAfter: "15",
      };
    });
    await expect(publish(await attested(transport))).rejects.toMatchObject({
      code: "rate-limited",
      commitCertainty: "may-have-committed",
      retryAfterSeconds: 15,
    });
  });

  it.each(["readiness", "token", "get"] as const)(
    "keeps %s transport failures definitely pre-send",
    async (stage) => {
      const transport = new FakeTransport((operation) => {
        if (stage === "get" && operation.kind === "mint-token") return tokenResponse();
        return Promise.reject(new GithubTransportError(true));
      }, stage !== "readiness");
      const governed = adapter(transport);
      const operation =
        stage === "readiness"
          ? governed.inspectReadiness()
          : (async (): Promise<unknown> => {
              await governed.inspectReadiness();
              if (stage === "token") return publish(governed);
              return governed.reconcileIssue(claimed());
            })();
      await expect(operation).rejects.toMatchObject({
        code: "provider-unavailable",
        commitCertainty: "definite-pre-send",
      });
    },
  );

  it.each([false, true] as const)(
    "keeps transport loss reconciliation-only after durable arm with committed=%s",
    async (committed) => {
      const transport = new FakeTransport((operation) =>
        operation.kind === "mint-token"
          ? Promise.resolve(tokenResponse())
          : Promise.reject(new GithubTransportError(committed)),
      );
      const result = publish(await attested(transport));
      await expect(result).rejects.toMatchObject({
        code: "provider-unavailable",
        commitCertainty: "may-have-committed",
      });
      await expect(result).rejects.not.toThrow("SENTINEL_JWT_TOKEN_KEY");
    },
  );

  it.each([
    { contentType: "text/html", body: Buffer.from("not-json") },
    { contentType: "application/json", body: Buffer.from("{") },
    { contentType: "application/json", body: Buffer.alloc(256 * 1024 + 1) },
  ])("rejects malformed, wrong-content-type, or oversized responses", async (invalid) => {
    const transport = new FakeTransport((operation) =>
      operation.kind === "mint-token"
        ? tokenResponse()
        : {
            status: 201,
            requestCommitted: true,
            ...invalid,
          },
    );
    await expect(publish(await attested(transport))).rejects.toMatchObject({
      code: "provider-unavailable",
      commitCertainty: "may-have-committed",
    });
  });

  it("treats post-create response schema and projection failures as possibly committed", async () => {
    for (const invalidIssue of [
      issue({ repository_url: "https://api.github.com/repositories/456" }),
      issue({ labels: "not-an-array" }),
      issue({ labels: [{ name: "user-finding" }, { name: "user-finding" }] }),
      issue({ title: "provider-mutated-title" }),
    ]) {
      const transport = new FakeTransport((operation) =>
        operation.kind === "mint-token" ? tokenResponse() : response(201, invalidIssue, true),
      );
      await expect(publish(await attested(transport))).rejects.toMatchObject({
        code: "provider-unavailable",
        commitCertainty: "may-have-committed",
      });
    }
  });
});
